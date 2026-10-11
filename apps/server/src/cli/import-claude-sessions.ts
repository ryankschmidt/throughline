/** Offline historical Claude importer. Public V2 services only; no provider graph.
 * Clean configured-profile TCP refusal precedes all writable construction.
 * Native UUID/head are preserved; deletion cleanup is queued for the live server.
 */
import { parseArgs } from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Runtime from "../persistence/ProviderSessionRuntime.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  makeLegacySessionReader,
  assertPortUnbound,
  readOfflineProfileProbe,
  offlineLayer,
  storesLayer,
  sinkLayer,
  importSelectedSessions,
  deleteImportedThread,
  OfflineHistoryImportRefusal,
} from "../throughline/history-import/OfflineHistoryImport.ts";

// ── CLI args ───────────────────────────────────────────────────────────

const HOME = process.env["HOME"] ?? "/Users/Admin";

const { values: args } = parseArgs({
  options: {
    source: { type: "string", default: `${HOME}/.claude/projects/-Users-Admin` },
    "base-dir": { type: "string", default: `${HOME}/.t3` },
    profile: { type: "string", default: "dev" }, // dev | desktop
    limit: { type: "string", default: "30" },
    "min-user-turns": { type: "string", default: "3" },
    exclude: { type: "string", multiple: true, default: [] },
    "project-root": { type: "string", default: HOME },
    "project-title": { type: "string", default: "Claude Code History" },
    model: { type: "string", default: "claude-fable-5" },
    instance: { type: "string" }, // provider instance override
    "dry-run": { type: "boolean", default: false },
    // Maintenance: delete one thread (by id) before importing — recovery path
    // for a partially-imported session (thread.create is otherwise idempotent
    // and would skip it forever).
    "delete-thread": { type: "string" },
    // Maintenance: reuse an existing import project instead of creating one
    // (recovery reruns would otherwise mint a duplicate project shell).
    "project-id": { type: "string" },
    // Maintenance: re-import ONE session under a FRESH threadId — recovery for
    // a burned thread identity (thread.create identity survives deletion, so
    // the deterministic threadId=sessionId can never be reused). Selection is
    // narrowed to exactly this session; the resume cursor still carries the
    // real session uuid, so provider resumption is unaffected.
    "remap-thread": { type: "string" },
  },
});

const LIMIT = Number(args.limit);
const MIN_USER_TURNS = Number(args["min-user-turns"]);
const PROFILE = args.profile === "desktop" ? "desktop" : "dev";
/** Per-message safety cap; imported history is for reading, not archiving. */
const MAX_MESSAGE_CHARS = 120_000;

// CLI output helpers writing the process streams directly — the effect
// language-service forbids the global console in this package, and this
// standalone maintenance script is not an Effect logging context.
const logLine = (line: string): void => {
  process.stderr.write(`${line}\n`);
};
const printLine = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const { selectSessions, toTurns } = makeLegacySessionReader({
  source: args.source!,
  limit: args.limit!,
  "min-user-turns": args["min-user-turns"]!,
  exclude: args.exclude ?? [],
});

const makeConfig = Effect.fn(function* (baseDir: string, profile: "dev" | "desktop") {
  const devUrl = profile === "dev" ? new URL("http://localhost:5733") : undefined;
  const derived = yield* ServerConfig.deriveServerPaths(baseDir, devUrl);
  return ServerConfig.make({
    ...derived,
    logLevel: "Warn",
    traceMinLevel: "Warn",
    traceTimingEnabled: false,
    traceBatchWindowMs: 1_000,
    traceMaxBytes: 8_000_000,
    traceMaxFiles: 2,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpLogsUrl: undefined,
    otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
    otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
    otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
    otelEnvironment: OtelEnvironment.none,
    mode: "web",
    port: 0,
    host: undefined,
    cwd: process.cwd(),
    baseDir,
    staticDir: undefined,
    devUrl,
    devAllowedOrigins: [],
    noBrowser: true,
    startupPresentation: "headless",
    desktopBootstrapToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: 0,
  });
});

// V2 offline execution
const main = Effect.gen(function* () {
  const paths = yield* ServerConfig.deriveServerPaths(
    args["base-dir"]!,
    PROFILE === "dev" ? new URL("http://localhost:5733") : undefined,
  );
  const probe = yield* readOfflineProfileProbe(
    paths.serverRuntimeStatePath,
    PROFILE === "dev" ? 13773 : ServerConfig.DEFAULT_PORT,
  );
  yield* Effect.tryPromise({
    try: () => assertPortUnbound(probe),
    catch: (cause) =>
      Schema.is(OfflineHistoryImportRefusal)(cause)
        ? cause
        : new OfflineHistoryImportRefusal({
            message: "REFUSED: configured profile probe is uncertain.",
          }),
  });
  const selected = yield* selectSessions();
  // Remap recovery narrows the run to exactly the burned session — nothing
  // else imports, no matter what else the selection window picked up.
  const sessions = args["remap-thread"]
    ? selected.filter((session) => session.sessionId === args["remap-thread"])
    : selected;
  if (args["remap-thread"] && sessions.length === 0) {
    logLine(
      `[import] remap target ${args["remap-thread"]} not in the selection window — ` +
        `raise --limit (selection is most-recent-first)`,
    );
  }
  logLine(
    `[import] selected ${sessions.length} meaningful sessions (limit ${LIMIT}, ` +
      `min user turns ${MIN_USER_TURNS}, profile ${PROFILE})`,
  );
  for (const session of sessions) {
    logLine(
      `  ${session.sessionId}  turns=${session.userTurnCount}  ` +
        `last=${session.lastTimestamp ?? "?"}  "${(session.summary ?? "").slice(0, 50)}"`,
    );
  }
  if (args["remap-thread"] && sessions.length === 0)
    return yield* new OfflineHistoryImportRefusal({
      message: "remap-thread target not in the selection window",
    });
  if (args["dry-run"] && !args["delete-thread"]) {
    printLine(`{"ok":true,"dryRun":true,"selected":${sessions.length}}`);
    return;
  }
  const config = yield* makeConfig(args["base-dir"]!, PROFILE);
  if (args["dry-run"] && !(yield* (yield* FileSystem.FileSystem).exists(config.dbPath)))
    return yield* new OfflineHistoryImportRefusal({
      message: "delete-thread requires an existing database; dry-run creates nothing",
    });
  if (args["dry-run"]) {
    const dryLayer = Layer.mergeAll(storesLayer, sinkLayer, IdAllocator.layer).pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: config.dbPath, readonly: true })),
      Layer.provideMerge(NodeServices.layer),
    );
    const deletion = yield* deleteImportedThread({
      threadId: ThreadId.make(args["delete-thread"]!),
      dryRun: true,
    }).pipe(Effect.provide(dryLayer));
    printLine(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(deletion));
    return;
  }
  const runtimeLayer = offlineLayer.pipe(
    Layer.provideMerge(Sqlite.layerConfig),
    Layer.provide(ServerConfig.layer(config)),
    Layer.provideMerge(NodeServices.layer),
  );
  const result = yield* Effect.gen(function* () {
    if (args["delete-thread"]) {
      const deletion = yield* deleteImportedThread({
        threadId: ThreadId.make(args["delete-thread"]),
        dryRun: args["dry-run"]!,
      });
      printLine(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(deletion));
    }
    const runtimeRepo = yield* Runtime.ProviderSessionRuntimeRepository;
    const existingRows = yield* runtimeRepo.list();
    const template = existingRows.find((row) => /claude/i.test(row.providerName));
    const instanceId = ProviderInstanceId.make(
      args.instance ?? template?.providerInstanceId ?? "claude",
    );
    const projects = yield* ProjectService.ProjectService;
    const ids = yield* IdAllocator.IdAllocatorV2;
    let projectId: ProjectId;
    if (args["project-id"]) projectId = ProjectId.make(args["project-id"]);
    else {
      const existing = yield* projects.getByWorkspaceRoot(args["project-root"]!);
      if (Option.isSome(existing)) projectId = existing.value.id;
      else {
        projectId = yield* ids.allocate.project({ fixtureName: "throughline.history-import" });
        const commandId = yield* ids.allocate.command({
          fixtureName: "throughline.history-import",
          commandName: "project.create",
        });
        yield* projects.create({
          commandId,
          projectId,
          title: args["project-title"]!,
          workspaceRoot: args["project-root"]!,
        });
      }
    }
    const prepared = sessions.map((session) => ({
      ...session,
      messages: toTurns(session.messages).flatMap((turn) => [
        turn.user,
        ...(turn.assistant ? [turn.assistant] : []),
      ]),
    }));
    const imported = yield* importSelectedSessions({
      sessions: prepared,
      projectId,
      projectRoot: args["project-root"]!,
      instanceId,
      model: args.model!,
      ...(args["remap-thread"] ? { remapSessionId: args["remap-thread"] } : {}),
    });
    return { ...imported, projectId };
  }).pipe(Effect.provide(runtimeLayer));
  printLine(
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      ok: true,
      profile: PROFILE,
      ...result,
    }),
  );
});

await Effect.runPromise(main.pipe(Effect.provide(NodeServices.layer))).catch((error: unknown) => {
  logLine(`[import] FAILED: ${String(error)}`);
  process.exitCode = 1;
});
