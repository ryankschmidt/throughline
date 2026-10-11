import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Transport from "../../mcp/ComsNetTransport.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import { completeCommittedRun } from "./CompletionObserver.ts";

const threadId = ThreadId.make("receiver");
const runId = RunId.make("receiver-run");
const requestId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const at = DateTime.makeUnsafe("2026-10-11T12:00:00Z");
const message = (role: "user" | "assistant", text: string): OrchestrationV2ConversationMessage => ({
  id: MessageId.make(role),
  threadId,
  runId,
  nodeId: null,
  role,
  text,
  attachments: [],
  streaming: false,
  createdAt: at,
  updatedAt: at,
  createdBy: role === "user" ? "user" : "agent",
  creationSource: "mcp",
});
const event = (status: "completed" | "failed" | "cancelled"): OrchestrationV2DomainEvent => ({
  id: EventId.make(`terminal-${status}`),
  type: "run.updated",
  threadId,
  occurredAt: at,
  payload: {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    providerThreadId: null,
    userMessageId: MessageId.make("user"),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: at,
    startedAt: at,
    completedAt: at,
    checkpointId: null,
    contextHandoffId: null,
  },
});
const originalMessages = [
  message("user", `<!-- comsnet-request:${requestId} -->\nDo the work`),
  message("assistant", "Actual ordinary answer"),
];

it.effect("terminates both successful and failed ordinary receiver turns", () =>
  Effect.gen(function* () {
    const completed: Array<unknown> = [],
      failed: Array<unknown> = [];
    const layer = Layer.mergeAll(
      Layer.mock(Threads.ThreadManagementService)({
        getThreadRecords: () =>
          Effect.succeed({ messages: originalMessages, turnItems: [] } as never),
      }),
      Layer.mock(Transport.ComsNetTransport)({
        listFinishedTurnRequests: () => Effect.succeed([]),
        completeFinishedTurn: (thread, id, result) =>
          Effect.sync(() => {
            completed.push({ thread, id, result });
            return {} as never;
          }),
        failFinishedTurn: (thread, id, error) =>
          Effect.sync(() => {
            failed.push({ thread, id, error });
            return {} as never;
          }),
      }),
    );
    yield* Effect.gen(function* () {
      yield* completeCommittedRun(event("completed"));
      yield* completeCommittedRun(event("failed"));
      yield* completeCommittedRun(event("cancelled"));
    }).pipe(Effect.provide(layer));
    assert.deepEqual(completed, [
      {
        thread: threadId,
        id: requestId,
        result: { text: "Actual ordinary answer", assistantMessageId: "assistant", turnId: runId },
      },
    ]);
    assert.lengthOf(failed, 2);
  }),
);

it.effect(
  "ambiguous markers fail every candidate; missing final response never becomes success",
  () =>
    Effect.gen(function* () {
      let messages = [
        message(
          "user",
          `<!-- comsnet-request:${requestId} -->\n<!-- comsnet-request:${secondId} -->`,
        ),
      ];
      const failed: string[] = [],
        completed: string[] = [];
      const layer = Layer.mergeAll(
        Layer.mock(Threads.ThreadManagementService)({
          getThreadRecords: () => Effect.sync(() => ({ messages, turnItems: [] }) as never),
        }),
        Layer.mock(Transport.ComsNetTransport)({
          listFinishedTurnRequests: () => Effect.succeed([]),
          completeFinishedTurn: (_thread, id) =>
            Effect.sync(() => {
              completed.push(id);
              return {} as never;
            }),
          failFinishedTurn: (_thread, id) =>
            Effect.sync(() => {
              failed.push(id);
              return {} as never;
            }),
        }),
      );
      yield* Effect.gen(function* () {
        yield* completeCommittedRun(event("completed"));
        messages = [originalMessages[0]!];
        yield* completeCommittedRun(event("completed"));
      }).pipe(Effect.provide(layer));
      assert.deepEqual(failed, [requestId, secondId, requestId]);
      assert.deepEqual(completed, []);
    }),
);

it.effect("a replayed terminal request is idempotent and does not fail the observer", () =>
  Effect.gen(function* () {
    const layer = Layer.mergeAll(
      Layer.mock(Threads.ThreadManagementService)({
        getThreadRecords: () =>
          Effect.succeed({ messages: originalMessages, turnItems: [] } as never),
      }),
      Layer.mock(Transport.ComsNetTransport)({
        listFinishedTurnRequests: () => Effect.succeed([]),
        completeFinishedTurn: () =>
          Effect.fail(
            new Transport.ComsNetTransportError({
              code: "ALREADY_TERMINAL",
              message: "already settled",
            }),
          ),
      }),
    );
    yield* completeCommittedRun(event("completed")).pipe(Effect.provide(layer));
  }),
);
