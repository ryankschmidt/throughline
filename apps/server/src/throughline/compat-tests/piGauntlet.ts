// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off -- hermetic native-protocol fixture, not runtime logic.
/** Only native wiring changes. The 12 original case bodies remain byte-exact in piGauntlet.test.ts. */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ThreadId,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RunAttemptId,
  NodeId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import { PiAdapterV2Driver } from "@t3tools/provider-pi/server";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as PubSub from "effect/PubSub";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { guardPiAdapter } from "../pi/PiAdapterGuards.ts";
import { makePiMeridianRouteGuard } from "../pi/PiMeridianRoute.ts";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";

export type ProviderRuntimeEvent =
  | { type: "session.started" | "session.configured" | "thread.started" | "turn.started" }
  | { type: "runtime.error"; payload: { message: string } }
  | { type: "turn.completed"; payload: { state: string; stopReason: null } }
  | {
      type: "item.started" | "item.updated" | "item.completed";
      itemId: string;
      payload: { itemType: string; title: string | null; status: string; detail: string };
    };
export interface PiRuntimeEvent {
  kind: "rpc-event";
  threadId: ThreadId;
  turnId: string;
  payload: Record<string, unknown>;
}
interface CompatAdapter {
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
  readonly startSession: (input: {
    threadId: ThreadId;
    provider: unknown;
    runtimeMode: string;
  }) => Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error>;
}
export class PiAdapter extends Context.Service<PiAdapter, CompatAdapter>()(
  "t3/throughline/compat-tests/piGauntlet/PiAdapter",
) {}
export const asThreadId = ThreadId.make;
export const asTurnId = (id: string) => id;
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** Real upstream adapter, real stdio RPC, fake child process. No providers or credentials contacted. */
class FakePiRuntime {
  readonly stdout = Effect.runSync(Queue.unbounded<Uint8Array>());
  readonly spawner = ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(999_999_999),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((bytes: Uint8Array) => this.receive(bytes)),
        stdout: Stream.fromQueue(this.stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );
  private buffer = "";
  private started = false;
  announceStart = false;
  start: Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error> =
    Effect.die("fixture not bound");
  private send(record: unknown) {
    return Queue.offer(this.stdout, new TextEncoder().encode(encode(record) + "\n")).pipe(
      Effect.asVoid,
    );
  }
  private receive(bytes: Uint8Array) {
    const self = this;
    return Effect.gen(function* () {
      self.buffer += new TextDecoder().decode(bytes);
      while (self.buffer.includes("\n")) {
        const index = self.buffer.indexOf("\n");
        const line = self.buffer.slice(0, index);
        self.buffer = self.buffer.slice(index + 1);
        if (!line) continue;
        const record = decode(line);
        if (typeof record.id !== "string") continue;
        const command = record.type;
        const data =
          command === "get_state"
            ? {
                thinkingLevel: "medium",
                isStreaming: false,
                isCompacting: false,
                sessionFile: "/fake/session.jsonl",
                sessionId: "pi-sess-gauntlet",
                autoCompactionEnabled: true,
                messageCount: 0,
                pendingMessageCount: 0,
                steeringMode: "one-at-a-time",
                followUpMode: "one-at-a-time",
              }
            : command === "get_available_models"
              ? { models: [] }
              : command === "get_entries"
                ? { entries: [], leafId: null }
                : command === "get_messages"
                  ? { messages: [] }
                  : {};
        yield* self.send({ type: "response", id: record.id, command, success: true, data });
      }
    });
  }
  emit(event: PiRuntimeEvent) {
    const self = this;
    return Effect.gen(function* () {
      const payload = event.payload;
      if (!self.started) {
        self.announceStart = payload.type === "turn_start";
        self.started = true;
        yield* self.start;
      }
      if (payload.type === "turn_start") {
        yield* self.send({ type: "agent_start" });
        return;
      }
      // Old cases express complete text; V2 consumes Pi's streaming frames. No text is added or altered.
      if (payload.type === "message_end") {
        const message = payload.message as {
          role?: string;
          content?: Array<{ type: string; text?: string }>;
        };
        const text =
          message.content
            ?.filter((block) => block.type === "text")
            .map((block) => block.text ?? "")
            .join("") ?? "";
        yield* self.send({ type: "message_start", message: { role: message.role, content: [] } });
        yield* self.send({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
        });
        yield* self.send({
          type: "message_update",
          assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text },
        });
      }
      if (payload.type === "agent_end") {
        yield* self.send({ type: "agent_settled" });
        return;
      }
      const field =
        payload.type === "tool_execution_end"
          ? "result"
          : payload.type === "tool_execution_update"
            ? "partialResult"
            : undefined;
      // Translate the old runtime's scalar text to the same text in Pi's content-block wire format.
      yield* self.send(
        field !== undefined && typeof payload[field] === "string"
          ? { ...payload, [field]: { content: [{ type: "text", text: payload[field] }] } }
          : payload,
      );
    });
  }
}

export function makeRuntimeFactory() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-pi-gauntlet-"));
  const configPath = NodePath.join(root, "models.json");
  NodeFS.writeFileSync(
    configPath,
    '{"providers":{"anthropic":{"baseUrl":"http://127.0.0.1:3456","apiKey":"x","headers":{"x-meridian-agent":"pi"}}}}',
  );
  const runtimes: Array<FakePiRuntime> = [];
  return {
    configPath,
    runtimes,
    get lastRuntime() {
      return runtimes.at(-1);
    },
  };
}

export const makeAdapterLayer = (factory: ReturnType<typeof makeRuntimeFactory>) =>
  Layer.effect(
    PiAdapter,
    Effect.gen(function* () {
      const output = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const captured = yield* Effect.context<
        | FileSystem.FileSystem
        | IdAllocator.IdAllocatorV2
        | McpProviderSessions.McpProviderSessions
        | ProviderHost.ProviderHost
        | Scope.Scope
      >();
      return PiAdapter.of({
        streamEvents: Stream.fromPubSub(output),
        startSession: (input) =>
          Effect.gen(function* () {
            const fake = new FakePiRuntime();
            factory.runtimes.push(fake);
            const instanceId = ProviderInstanceId.make("pi");
            const upstream = yield* PiAdapterV2Driver.create({
              instanceId,
              displayName: undefined,
              enabled: true,
              environment: [],
              config: { enabled: true, binaryPath: "ryan-pi", launchArgs: "", customModels: [] },
            }).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterProtocolError({
                    driver: "pi" as never,
                    detail: cause.detail,
                  }),
              ),
            );
            const fs = yield* FileSystem.FileSystem;
            const adapter = guardPiAdapter(
              upstream,
              makePiMeridianRouteGuard(fs, {
                configPath: factory.configPath,
                probe: () => Effect.succeed(true),
              }),
            );
            const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: null,
            });
            const modelSelection = { instanceId, model: "default" };
            const runtime = yield* adapter.openSession({
              threadId: input.threadId,
              providerSessionId: ProviderSessionId.make(`session:${input.threadId}`),
              modelSelection,
              runtimePolicy,
            });
            const providerThread = yield* runtime.ensureThread({
              threadId: input.threadId,
              modelSelection,
              runtimePolicy,
            });
            const now = yield* DateTime.now;
            const appThread = {
              id: input.threadId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: now,
              updatedAt: now,
            } as OrchestrationV2AppThread;
            const runId = RunId.make(`run:${input.threadId}`);
            fake.start = runtime.startTurn({
              appThread,
              threadId: input.threadId,
              runId,
              runOrdinal: 1,
              providerTurnOrdinal: 1,
              attemptId: RunAttemptId.make(`attempt:${input.threadId}`),
              rootNodeId: NodeId.make(`root:${input.threadId}`),
              providerThread,
              message: {
                messageId: "gauntlet" as never,
                text: "gauntlet fixture",
                attachments: [],
                createdBy: "user",
                creationSource: "web",
              },
              modelSelection,
              runtimePolicy,
            });
            const seenTools = new Set<string>();
            yield* runtime.events.pipe(
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  let view: ProviderRuntimeEvent | undefined;
                  if (
                    event.type === "provider_turn.updated" &&
                    event.providerTurn.status === "running" &&
                    fake.announceStart
                  )
                    view = { type: "turn.started" };
                  if (event.type === "turn_item.updated") {
                    const item = event.turnItem;
                    if (item.type === "assistant_message" && !item.streaming)
                      view = {
                        type: "item.completed",
                        itemId: item.id,
                        payload: {
                          itemType: "assistant_message",
                          title: item.title,
                          status: item.status,
                          detail: item.text,
                        },
                      };
                    const tool =
                      item.type === "dynamic_tool" ||
                      item.type === "command_execution" ||
                      item.type === "file_change";
                    if (tool) {
                      const nativeId = item.nativeItemRef?.nativeId ?? item.id;
                      const detail =
                        item.type === "command_execution"
                          ? (item.output ?? "")
                          : item.type === "file_change"
                            ? (item.diffStr ?? item.fileName)
                            : typeof item.output === "string"
                              ? item.output
                              : "";
                      const type =
                        item.status === "running"
                          ? seenTools.has(nativeId)
                            ? "item.updated"
                            : "item.started"
                          : "item.completed";
                      seenTools.add(nativeId);
                      view = {
                        type,
                        itemId: `pi-tool:${nativeId}`,
                        payload: {
                          itemType: "dynamic_tool_call",
                          title: item.title,
                          status: item.status,
                          detail,
                        },
                      };
                    }
                    if (item.type === "error")
                      view = { type: "runtime.error", payload: { message: item.failure.message } };
                  }
                  if (event.type === "turn.terminal")
                    view = {
                      type: "turn.completed",
                      payload: { state: event.status, stopReason: null },
                    };
                  if (view) yield* PubSub.publish(output, view);
                }),
              ),
              Effect.forkScoped,
            );
            for (const type of ["session.started", "session.configured", "thread.started"] as const)
              yield* PubSub.publish(output, { type });
          }).pipe(Effect.provide(captured)),
      });
    }),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        IdAllocator.layer,
        McpProviderSessions.layer,
        TestProviderHost.layer({ runBackgroundWork: false }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

export const drainStartupEvents = (adapter: CompatAdapter, threadId: ThreadId) =>
  Effect.gen(function* () {
    const collect = yield* adapter.streamEvents.pipe(
      Stream.take(3),
      Stream.runCollect,
      Effect.forkChild,
    );
    const session = yield* adapter.startSession({
      provider: "pi",
      threadId,
      runtimeMode: "full-access",
    });
    const startupEvents = yield* Fiber.join(collect);
    return { session, startupEvents };
  });
import * as Fiber from "effect/Fiber";
export const assistantEnd = (text: string) => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
export const scriptTurn = (
  runtime: FakePiRuntime,
  threadId: ThreadId,
  turnId: string,
  middle: ReadonlyArray<Record<string, unknown>>,
) =>
  Effect.gen(function* () {
    yield* runtime.emit({ kind: "rpc-event", threadId, turnId, payload: { type: "turn_start" } });
    for (const payload of middle)
      yield* runtime.emit({ kind: "rpc-event", threadId, turnId, payload });
    yield* runtime.emit({ kind: "rpc-event", threadId, turnId, payload: { type: "agent_end" } });
  });
export const isToolEvent = (
  event: ProviderRuntimeEvent,
): event is Extract<
  ProviderRuntimeEvent,
  { type: "item.started" | "item.updated" | "item.completed" }
> =>
  (event.type === "item.started" ||
    event.type === "item.updated" ||
    event.type === "item.completed") &&
  event.payload.itemType === "dynamic_tool_call";
