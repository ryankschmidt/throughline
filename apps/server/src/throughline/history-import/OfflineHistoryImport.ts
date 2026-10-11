// @effect-diagnostics nodeBuiltinImport:off - This offline maintenance boundary owns the TCP refusal probe.
import { createConnection } from "node:net";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AgentSessionImportSource,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { PersistedServerRuntimeState } from "../../serverRuntimeState.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as AgentSessionImporter from "../../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../../project/AgentSessionScanner.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectEnrichment from "../../project/ProjectEnrichmentService.ts";
import * as Favicon from "../../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../../project/T3ProjectFileLoader.ts";
import * as RepositoryIdentity from "../../project/RepositoryIdentityResolver.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as CommandReceipts from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as TurnPositions from "../../orchestration-v2/TurnItemPositionStore.ts";
import * as ApplicationEvents from "../../persistence/OrchestrationEventStore.ts";
import * as ApplicationReceipts from "../../persistence/OrchestrationCommandReceipts.ts";
import * as Runtime from "../../persistence/ProviderSessionRuntime.ts";
import * as LegacyImporter from "../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ThreadExecutor from "../../orchestration-v2/ThreadCommandExecutor.ts";
import { planThreadDeletion } from "../../orchestration-v2/ThreadDeletion.ts";
import * as ProjectionObservation from "../observation/ProjectionObservation.ts";
import * as OfflineRead from "./OfflineOrchestratorRead.ts";
import { makeThreadIdRemap, wrapEventSink, wrapRuntime } from "./ThreadIdRemap.ts";

export class OfflineHistoryImportRefusal extends Schema.TaggedError<OfflineHistoryImportRefusal>()(
  "OfflineHistoryImportRefusal",
  { message: Schema.String },
) {}

export const assertPortUnbound = (profile: {
  port: number;
  host?: string;
  timeoutMs?: number;
}): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) {
      reject(
        new OfflineHistoryImportRefusal({
          message: "REFUSED: configured profile port is uncertain.",
        }),
      );
      return;
    }
    const host = profile.host ?? "127.0.0.1";
    const socket = createConnection({ host, port: profile.port });
    let settled = false;
    const finish = (error?: OfflineHistoryImportRefusal) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.once("connect", () =>
      finish(
        new OfflineHistoryImportRefusal({
          message: `REFUSED: ${host}:${profile.port} is listening — live server holds state.`,
        }),
      ),
    );
    socket.once("error", (error) =>
      finish(
        (error as NodeJS.ErrnoException).code === "ECONNREFUSED"
          ? undefined
          : new OfflineHistoryImportRefusal({
              message: `REFUSED: ${host}:${profile.port} is uncertain (${(error as NodeJS.ErrnoException).code ?? "network error"}).`,
            }),
      ),
    );
    socket.setTimeout(profile.timeoutMs ?? 1500, () =>
      finish(
        new OfflineHistoryImportRefusal({
          message: `REFUSED: ${host}:${profile.port} is uncertain (timeout).`,
        }),
      ),
    );
  });
export const afterOfflineSafetyCheck = async <A>(
  profile: { port: number; host?: string },
  construct: () => Promise<A>,
): Promise<A> => {
  await assertPortUnbound(profile);
  return construct();
};

export const readOfflineProfileProbe = Effect.fn("throughline.history-import.profile")(function* (
  statePath: string,
  fallbackPort: number,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(statePath))) return { port: fallbackPort, host: "127.0.0.1" };
  const state = yield* fs.readFileString(statePath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(PersistedServerRuntimeState))),
    Effect.mapError(
      () =>
        new OfflineHistoryImportRefusal({
          message: "REFUSED: configured profile port is uncertain (runtime state unreadable).",
        }),
    ),
  );
  return {
    port: state.port,
    host:
      state.host === undefined || state.host === "0.0.0.0" || state.host === "::"
        ? "127.0.0.1"
        : state.host,
  };
});

/** SQL stores and projection observation only; no provider graph or effect worker layer. */
const applicationLayer = Layer.mergeAll(ApplicationEvents.layer, ApplicationReceipts.layer);
const observedProjection = ProjectionObservation.layer.pipe(Layer.provide(ProjectionStore.layer));
export const storesLayer = Layer.mergeAll(
  applicationLayer,
  EventStore.layerFromOrchestrationEventStore.pipe(Layer.provide(applicationLayer)),
  CommandReceipts.layerFromApplicationReceipts.pipe(Layer.provide(applicationLayer)),
  observedProjection,
  ProjectStore.layer,
  EffectOutbox.layer,
  TurnPositions.layer,
);
export const sinkLayer = EventSink.layerFromStores.pipe(Layer.provide(storesLayer));
const enrichmentLayer = ProjectEnrichment.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      RepositoryIdentity.layer,
      Favicon.layer.pipe(Layer.provide(T3ProjectFileLoader.layer)),
    ),
  ),
);
const projectLayer = ProjectService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectStore.layer,
      observedProjection,
      sinkLayer,
      IdAllocator.layer,
      LegacyImporter.layer.pipe(Layer.provide(sinkLayer)),
      ThreadExecutor.layer,
      enrichmentLayer,
    ),
  ),
);
export const offlineLayer = Layer.mergeAll(
  storesLayer,
  sinkLayer,
  Runtime.layer,
  IdAllocator.layer,
  OfflineRead.layer.pipe(Layer.provide(observedProjection)),
  projectLayer,
).pipe(Layer.provideMerge(WorkspacePaths.layer));

export interface SelectedSession {
  readonly sessionId: string;
  readonly filePath: string;
  readonly mtimeMs: number;
  readonly summary: string | null;
  readonly lastAssistantUuid: string | null;
  readonly messages: readonly {
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly timestamp: string;
  }[];
}
export const importSelectedSessions = Effect.fn("throughline.history-import.selected")(
  function* (input: {
    readonly sessions: readonly SelectedSession[];
    readonly projectId: ProjectId;
    readonly projectRoot: string;
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
    readonly remapSessionId?: string;
  }) {
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const runtimes = yield* Runtime.ProviderSessionRuntimeRepository;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const fs = yield* FileSystem.FileSystem;
    let imported = 0,
      skipped = 0;
    const heads: Array<{ threadId: ThreadId; committed: boolean }> = [];
    for (const session of input.sessions) {
      const derived = ThreadId.make(`import:${input.instanceId}:${session.sessionId}`);
      let target = derived;
      let pair: ReturnType<typeof makeThreadIdRemap> | undefined;
      if (input.remapSessionId === session.sessionId) {
        const original = yield* projection.getThreadRecords(derived, ["providerThreads"]).pipe(
          Effect.mapError(
            () =>
              new OfflineHistoryImportRefusal({
                message: "remap-thread requires an existing imported thread",
              }),
          ),
        );
        if (
          original.thread.historyOrigin !== "v1_import" ||
          original.thread.projectId !== input.projectId
        )
          return yield* new OfflineHistoryImportRefusal({
            message: "remap-thread requires the existing import in this project",
          });
        const provider = original.providerThreads.find(
          (row) => row.id === original.thread.activeProviderThreadId,
        );
        if (!provider || provider.nativeThreadRef?.nativeId !== session.sessionId)
          return yield* new OfflineHistoryImportRefusal({
            message: "remap-thread requires matching native identity",
          });
        target = yield* ids.allocate.thread({ projectId: input.projectId });
        pair = makeThreadIdRemap(derived, target, session.sessionId, provider.id);
      }
      const metadata = yield* fs.stat(session.filePath);
      const source: AgentSessionImportSource = {
        provider: "claudeAgent",
        providerInstanceId: input.instanceId,
        providerSessionId: session.sessionId,
        filePath: session.filePath,
        size: Number(metadata.size),
        mtimeMs: session.mtimeMs,
        device: Number(metadata.dev),
        inode: Number(metadata.ino),
        birthtimeMs: Option.match(metadata.birthtime, {
          onNone: () => 0,
          onSome: (date) => date.getTime(),
        }),
      };
      const messages = session.messages;
      const outcome: AgentSessionScanner.AgentSessionRecentThread = {
        _tag: "Importable",
        source,
        thread: {
          source: "claudeAgent",
          providerInstanceId: input.instanceId,
          providerSessionId: session.sessionId,
          title: (
            session.summary ??
            messages.find((m) => m.role === "user")?.text ??
            "Imported session"
          )
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80),
          model: input.model,
          createdAt: messages[0]?.timestamp ?? DateTime.formatIso(yield* DateTime.now),
          updatedAt: messages.at(-1)?.timestamp ?? DateTime.formatIso(yield* DateTime.now),
          messages: messages.map((m) => ({ role: m.role, text: m.text, createdAt: m.timestamp })),
        },
      };
      const scanner = AgentSessionScanner.AgentSessionScanner.of({
        scan: Effect.die("offline import never scans private history"),
        recentThreads: () => Stream.succeed(outcome),
      });
      const readProjection: ProjectionStore.ProjectionStoreV2Shape = pair
        ? {
            ...projection,
            getThreadRecords: (id, fields, filter) =>
              projection.getThreadRecords(id === derived ? target : id, fields, filter),
          }
        : projection;
      const importerEffect = Effect.gen(function* () {
        const importer = yield* AgentSessionImporter.AgentSessionImporter;
        return yield* importer.importRecentAgentThreads({
          projectId: input.projectId,
          expectedWorkspaceRoot: input.projectRoot,
        });
      }).pipe(
        Effect.provide(AgentSessionImporter.layer),
        Effect.provideService(AgentSessionScanner.AgentSessionScanner, scanner),
        Effect.provideService(
          Orchestrator.OrchestratorV2,
          OfflineRead.makeOfflineOrchestratorRead(readProjection),
        ),
        Effect.provideService(EventSink.EventSinkV2, pair ? wrapEventSink(sink, pair) : sink),
        Effect.provideService(
          Runtime.ProviderSessionRuntimeRepository,
          pair ? wrapRuntime(runtimes, pair) : runtimes,
        ),
      );
      const result = yield* importerEffect;
      imported += result.importedCount;
      skipped += result.skippedCount;
      if (result.importedCount === 0 || session.lastAssistantUuid === null) continue;
      const records = yield* projection.getThreadRecords(target, ["providerThreads"]);
      const provider = records.providerThreads.find(
        (row) => row.id === records.thread.activeProviderThreadId,
      );
      if (!provider || provider.nativeThreadRef?.nativeId !== session.sessionId)
        return yield* new OfflineHistoryImportRefusal({
          message: "import head requires matching native provider identity",
        });
      const now = yield* DateTime.now;
      const commandId = CommandId.make(
        `throughline.history-import.head:${target}:${session.lastAssistantUuid}`,
      );
      const head = yield* sink.commitCommand({
        commandId,
        threadId: target,
        commandType: "throughline.history-import.head",
        acceptedAt: now,
        effects: [],
        events: [
          {
            id: EventId.make(`event:${commandId}`),
            type: "provider-thread.updated",
            threadId: target,
            driver: provider.driver,
            providerInstanceId: provider.providerInstanceId,
            occurredAt: now,
            payload: {
              ...provider,
              nativeConversationHeadRef: {
                driver: provider.driver,
                nativeId: session.lastAssistantUuid,
                strength: "strong",
              },
              updatedAt: now,
            },
          },
        ],
      });
      heads.push({ threadId: target, committed: head.committed });
    }
    return { imported, skipped, heads };
  },
);

export const validateOfflineDeletionEffects = (
  effects: readonly EffectOutbox.PendingOrchestrationEffectV2[],
): string | undefined => {
  for (const effect of effects) {
    if (
      (EffectOutbox.PROCESS_BOUND_EFFECT_TYPES as readonly string[]).includes(effect.request.type)
    )
      return `PROCESS_BOUND effect ${effect.request.type}`;
    if (
      !(EffectOutbox.REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS as readonly string[]).includes(
        effect.request.type,
      )
    )
      return `unknown replay safety ${effect.request.type}`;
  }
  return undefined;
};
export const deleteImportedThread = Effect.fn("throughline.history-import.delete")(
  function* (input: { threadId: ThreadId; dryRun: boolean }) {
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const refusal = (condition: string) =>
      new OfflineHistoryImportRefusal({
        message: `delete-thread requires the live server for this thread: ${condition}; filesystem cleanup is live-server maintenance.`,
      });
    const records = yield* projection
      .getThreadRecords(input.threadId, [
        "runs",
        "attempts",
        "nodes",
        "runtimeRequests",
        "subagents",
        "providerSessions",
      ])
      .pipe(Effect.mapError(() => refusal("thread must exist")));
    if (records.thread.historyOrigin !== "v1_import")
      return yield* refusal("historyOrigin must be v1_import");
    if (
      records.providerSessions.some(
        (session) => session.status !== "stopped" && session.status !== "error",
      )
    )
      return yield* refusal("active provider session");
    if (
      records.runs.some((run) =>
        ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
      )
    )
      return yield* refusal("active or queued run");
    const now = yield* DateTime.now;
    const commandId = CommandId.make(`throughline.history-import.delete:${input.threadId}`);
    const attachments = yield* projection.getThreadAttachmentIds(input.threadId);
    const plan = yield* planThreadDeletion({
      command: { type: "thread.delete", commandId, threadId: input.threadId },
      projection: records,
      attachmentIds: attachments,
      now,
      idAllocator: ids,
    });
    const unsafeEffect = validateOfflineDeletionEffects(plan.effects);
    if (unsafeEffect) return yield* refusal(unsafeEffect);
    const summary = {
      eventTypes: plan.events.map((event) => event.type),
      effectTypes: plan.effects.map((effect) => effect.request.type),
      message:
        "Cleanup effects are queued for the live server; no filesystem deletion executed offline.",
    };
    if (input.dryRun) return { ...summary, committed: false };
    const result = yield* sink.commitCommand({
      commandId,
      threadId: input.threadId,
      commandType: "thread.delete",
      acceptedAt: now,
      events: plan.events,
      effects: plan.effects,
    });
    return { ...summary, committed: result.committed };
  },
);

/** Original 0.0.60 parser and selection bodies retained byte-for-byte. */
// prettier-ignore
export function makeLegacySessionReader(args: {
  source: string;
  limit: string;
  "min-user-turns": string;
  exclude: readonly string[];
}) {
  const LIMIT = Number(args.limit);
  const MIN_USER_TURNS = Number(args["min-user-turns"]);
  const MAX_MESSAGE_CHARS = 120_000;
  const logLine = (line: string): void => {
    process.stderr.write(line + "\n");
  };
  // ── JSONL session parsing ──────────────────────────────────────────────

type ParsedMessage = {
  readonly role: "user" | "assistant";
  readonly uuid: string;
  readonly text: string;
  readonly timestamp: string;
};

type ParsedSession = {
  readonly sessionId: string;
  readonly filePath: string;
  readonly mtimeMs: number;
  readonly cwd: string | null;
  readonly summary: string | null;
  readonly messages: ReadonlyArray<ParsedMessage>;
  readonly userTurnCount: number;
  readonly lastAssistantUuid: string | null;
  readonly lastTimestamp: string | null;
};

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

/** Noise wrappers that are transcripts of local command plumbing, not prompts. */
function isNoiseUserText(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.length === 0 ||
    trimmed.startsWith("<local-command-stdout>") ||
    trimmed.startsWith("<command-name>") ||
    trimmed.startsWith("<local-command-caveat>") ||
    trimmed.startsWith("Caveat: The messages below were generated")
  );
}

/** Pure line-set parser; the caller owns file IO. */
function parseSessionLines(
  sessionId: string,
  filePath: string,
  mtimeMs: number,
  lines: ReadonlyArray<string>,
): ParsedSession | null {
  const messages: ParsedMessage[] = [];
  let cwd: string | null = null;
  let summary: string | null = null;
  let userTurnCount = 0;
  let lastAssistantUuid: string | null = null;
  let lastTimestamp: string | null = null;

  for (const line of lines) {
    if (line.length === 0) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = entry["type"];
    if (type === "summary" && typeof entry["summary"] === "string" && summary === null) {
      summary = entry["summary"];
      continue;
    }
    if (type !== "user" && type !== "assistant") continue;
    if (entry["isMeta"] === true) continue;
    const message = entry["message"] as { role?: string; content?: unknown } | undefined;
    const uuid = typeof entry["uuid"] === "string" ? entry["uuid"] : null;
    const timestamp = typeof entry["timestamp"] === "string" ? entry["timestamp"] : null;
    if (!message || !uuid || !timestamp) continue;
    if (cwd === null && typeof entry["cwd"] === "string") cwd = entry["cwd"];

    if (type === "user" && message.role === "user") {
      const text = extractText(message.content);
      if (isNoiseUserText(text)) continue;
      messages.push({ role: "user", uuid, text: text.slice(0, MAX_MESSAGE_CHARS), timestamp });
      userTurnCount += 1;
      lastTimestamp = timestamp;
    } else if (type === "assistant" && message.role === "assistant") {
      const text = extractText(message.content);
      if (text.trim().length === 0) continue;
      messages.push({ role: "assistant", uuid, text, timestamp });
      lastAssistantUuid = uuid;
      lastTimestamp = timestamp;
    }
  }

  if (userTurnCount < MIN_USER_TURNS) return null;
  return {
    sessionId,
    filePath,
    mtimeMs,
    cwd,
    summary,
    messages,
    userTurnCount,
    lastAssistantUuid,
    lastTimestamp,
  };
}

/**
 * Collapse the raw message stream into turns: each user message opens a turn;
 * every assistant message until the next user message merges into ONE reply
 * (id + timestamp of the LAST fragment, so resume anchors stay real uuids).
 */
type Turn = {
  readonly user: ParsedMessage;
  readonly assistant: ParsedMessage | null;
};

function toTurns(messages: ReadonlyArray<ParsedMessage>): Turn[] {
  const turns: Turn[] = [];
  let currentUser: ParsedMessage | null = null;
  let assistantParts: ParsedMessage[] = [];
  const flush = () => {
    if (currentUser === null) return;
    const last = assistantParts.at(-1);
    const assistant: ParsedMessage | null = last
      ? {
          role: "assistant",
          uuid: last.uuid,
          timestamp: last.timestamp,
          text: assistantParts
            .map((part) => part.text)
            .join("\n\n")
            .slice(0, MAX_MESSAGE_CHARS),
        }
      : null;
    turns.push({ user: currentUser, assistant });
  };
  for (const message of messages) {
    if (message.role === "user") {
      flush();
      currentUser = message;
      assistantParts = [];
    } else if (currentUser !== null) {
      assistantParts.push(message);
    }
  }
  flush();
  return turns;
}

// ── Selection (FileSystem service) ─────────────────────────────────────

const selectSessions = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = args.source!;

  const excluded = new Set<string>([...(args.exclude ?? [])]);
  const envSession = process.env["CLAUDE_CODE_SESSION_ID"];
  if (envSession) excluded.add(envSession);

  const names = yield* fs.readDirectory(source);
  const candidates: Array<{ filePath: string; sessionId: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const sessionId = name.replace(/\.jsonl$/, "");
    if (excluded.has(sessionId)) continue;
    const filePath = path.join(source, name);
    const info = yield* fs.stat(filePath).pipe(
      Effect.map(Option.some),
      Effect.catch(() => Effect.succeed(Option.none<FileSystem.File.Info>())),
    );
    if (Option.isNone(info)) continue;
    const mtimeMs = Option.match(info.value.mtime, {
      onNone: () => 0,
      onSome: (mtime) => mtime.getTime(),
    });
    candidates.push({ filePath, sessionId, mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const selected: ParsedSession[] = [];
  for (const candidate of candidates) {
    if (selected.length >= LIMIT) break;
    const parsed = yield* fs.readFileString(candidate.filePath).pipe(
      Effect.map((content) =>
        parseSessionLines(
          candidate.sessionId,
          candidate.filePath,
          candidate.mtimeMs,
          content.split(/\r?\n/),
        ),
      ),
      Effect.catch((error) =>
        Effect.sync(() => {
          logLine(`[import] skipping unreadable ${candidate.filePath}: ${String(error)}`);
          return null;
        }),
      ),
    );
    if (parsed) selected.push(parsed);
  }
  return selected;
});


return {parseSessionLines,toTurns,selectSessions};
}
