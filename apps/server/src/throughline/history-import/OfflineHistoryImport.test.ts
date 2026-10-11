// @effect-diagnostics nodeBuiltinImport:off - Disposable TCP fixtures only; no live history or host state.
import { createServer } from "node:net";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  utimesSync,
  copyFileSync,
  chmodSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Runtime from "../../persistence/ProviderSessionRuntime.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as Projection from "../../orchestration-v2/ProjectionStore.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import { makeClaudeQueryOptions } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  assertPortUnbound,
  afterOfflineSafetyCheck,
  storesLayer,
  sinkLayer,
  offlineLayer,
  importSelectedSessions,
  deleteImportedThread,
  validateOfflineDeletionEffects,
  makeLegacySessionReader,
  readOfflineProfileProbe,
} from "./OfflineHistoryImport.ts";

it("allows only an actual clean connection refusal before the write callback", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  let constructed = false;
  await afterOfflineSafetyCheck({ port }, async () => {
    constructed = true;
  });
  expect(constructed).toBe(true);
});

it("a listening non-HTTP server refuses before any database can be opened", async () => {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const directory = mkdtempSync(join(tmpdir(), "offline-import-test-"));
  const database = join(directory, "statev2.sqlite");
  let constructed = false;
  try {
    await expect(
      afterOfflineSafetyCheck({ port }, async () => {
        constructed = true;
        writeFileSync(database, "would-open");
      }),
    ).rejects.toThrow("listening");
    expect(constructed).toBe(false);
    expect(existsSync(database)).toBe(false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true });
  }
});

it.each([0, -1, 65536, Number.NaN])(
  "uncertain invalid port %s refuses before writes",
  async (port) => {
    let constructed = false;
    await expect(
      afterOfflineSafetyCheck({ port }, async () => {
        constructed = true;
      }),
    ).rejects.toThrow("uncertain");
    expect(constructed).toBe(false);
  },
);

it("non-refusal network failure is uncertainty, never a safe unbound signal", async () => {
  await expect(assertPortUnbound({ port: 13773, host: "invalid host name" })).rejects.toThrow(
    "uncertain",
  );
});

const projectId = ProjectId.make("offline-test-project");
const instanceId = ProviderInstanceId.make("claude");
const layer = Layer.mergeAll(
  storesLayer,
  sinkLayer,
  Runtime.layer,
  IdAllocator.layer,
  Layer.mock(ProjectService.ProjectService)({
    getById: () =>
      Effect.succeed(Option.some({ id: projectId, workspaceRoot: "/workspace" } as never)),
  }),
).pipe(Layer.provideMerge(Sqlite.layerMemory), Layer.provideMerge(NodeServices.layer));

it("public importer + real SQL stores preserve no-turn/head receipt replay and remap leaves original untouched", async () => {
  const directory = mkdtempSync(join(tmpdir(), "offline-synthetic-"));
  const filePath = join(directory, "fixture.jsonl");
  writeFileSync(filePath, "synthetic fixture only");
  const native = "01a12822-d830-7533-872e-dc7eb754ad4e";
  const session = {
    sessionId: native,
    filePath,
    mtimeMs: 1,
    summary: "Synthetic history",
    lastAssistantUuid: "last-assistant-uuid",
    messages: [
      { role: "user" as const, text: "Fix it", timestamp: "2026-10-11T10:00:00Z" },
      { role: "assistant" as const, text: "Fixed", timestamp: "2026-10-11T10:01:00Z" },
    ],
  };
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const input = {
          sessions: [session],
          projectId,
          projectRoot: "/workspace",
          instanceId,
          model: "claude-fable-5",
        };
        const first = yield* importSelectedSessions(input);
        expect(first).toMatchObject({ imported: 1, skipped: 0, heads: [{ committed: true }] });
        const repeat = yield* importSelectedSessions(input);
        expect(repeat).toMatchObject({ imported: 1, skipped: 0, heads: [{ committed: false }] });
        const events = yield* EventStore.EventStoreV2;
        const before = yield* events.read().pipe(Stream.runCollect);
        expect(before).toHaveLength(7);
        expect(before.some((stored) => stored.event.type === "run.created")).toBe(false);
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT * FROM orchestration_v2_effect_outbox`).toHaveLength(0);
        const projections = yield* Projection.ProjectionStoreV2;
        const original = yield* projections.getThreadRecords(first.heads[0]!.threadId, [
          "providerThreads",
          "messages",
          "turnItems",
        ]);
        const remapped = yield* importSelectedSessions({ ...input, remapSessionId: native });
        expect(remapped.imported).toBe(1);
        const fresh = yield* projections.getThreadRecords(remapped.heads[0]!.threadId, [
          "providerThreads",
          "messages",
          "turnItems",
        ]);
        expect(fresh.thread.id).not.toBe(original.thread.id);
        expect(fresh.thread.lineage.rootThreadId).toBe(fresh.thread.id);
        expect(fresh.providerThreads[0]?.id).not.toBe(original.providerThreads[0]?.id);
        expect(fresh.providerThreads[0]?.nativeThreadRef).toEqual(
          original.providerThreads[0]?.nativeThreadRef,
        );
        expect(fresh.providerThreads[0]?.nativeConversationHeadRef).toEqual(
          original.providerThreads[0]?.nativeConversationHeadRef,
        );
        expect(fresh.messages.every((message) => message.threadId === fresh.thread.id)).toBe(true);
        expect(fresh.turnItems.every((item) => item.threadId === fresh.thread.id)).toBe(true);
        expect(
          yield* projections.getThreadRecords(original.thread.id, [
            "providerThreads",
            "messages",
            "turnItems",
          ]),
        ).toEqual(original);
        const runtime = yield* Runtime.ProviderSessionRuntimeRepository;
        expect(yield* runtime.getByThreadId({ threadId: fresh.thread.id })).toMatchObject({
          value: {
            threadId: fresh.thread.id,
            resumeCursor: { threadId: fresh.thread.id, resume: native },
          },
        });
        const dry = yield* deleteImportedThread({ threadId: fresh.thread.id, dryRun: true });
        expect(dry).toMatchObject({
          committed: false,
          eventTypes: ["thread.deleted"],
          effectTypes: ["terminal.cleanup", "preview.cleanup"],
        });
        expect(yield* sql`SELECT * FROM orchestration_v2_effect_outbox`).toHaveLength(0);
        const removed = yield* deleteImportedThread({ threadId: fresh.thread.id, dryRun: false });
        expect(removed.committed).toBe(true);
        const pending = yield* sql<{
          status: string;
        }>`SELECT status FROM orchestration_v2_effect_outbox`;
        expect(pending).toEqual([{ status: "pending" }, { status: "pending" }]);
        const again = yield* deleteImportedThread({ threadId: fresh.thread.id, dryRun: false });
        expect(again.committed).toBe(false);
        expect(existsSync(filePath)).toBe(true);
      }).pipe(Effect.provide(layer)),
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
}, 30000);

it("deletion refuses process-bound effects by name; cleanup effects remain replay-safe", () => {
  const pending = (type: string) =>
    ({ request: { type } }) as EffectOutbox.PendingOrchestrationEffectV2;
  expect(
    validateOfflineDeletionEffects([pending("terminal.cleanup"), pending("preview.cleanup")]),
  ).toBeUndefined();
  expect(validateOfflineDeletionEffects([pending("provider-turn.start")])).toBe(
    "PROCESS_BOUND effect provider-turn.start",
  );
  expect(validateOfflineDeletionEffects([pending("new-unknown-effect")])).toContain(
    "unknown replay safety",
  );
});

it("retains exact source parser/selection bytes and actual CLI flags", () => {
  const namespace = readFileSync(new URL("./OfflineHistoryImport.ts", import.meta.url), "utf8");
  const block = namespace.slice(
    namespace.indexOf("// ── JSONL session parsing"),
    namespace.lastIndexOf("\nreturn {parseSessionLines,toTurns,selectSessions};"),
  );
  expect(createHash("sha256").update(block).digest("hex")).toBe(
    "68f438c95d5d71879d4138a29aba2b8d310550e87a8fab61b55c29a47af0fe7a",
  );
  const cli = readFileSync(new URL("../../cli/import-claude-sessions.ts", import.meta.url), "utf8");
  const flags = cli.slice(cli.indexOf("const { values: args }"), cli.indexOf("const LIMIT ="));
  expect(createHash("sha256").update(flags).digest("hex")).toBe(
    "edc17047fd92db0a9c5ccb12e669a1a2ee4ef60430546c343f4c72d998b38979",
  );
  expect(cli).not.toContain("OrchestrationLayerLive");
  expect(cli).not.toContain("OrchestrationEngineService");
});

const syntheticLines = () =>
  [
    {
      type: "user",
      uuid: "noise",
      timestamp: "2026-10-11T00:00:00Z",
      message: { role: "user", content: "<command-name>ignore" },
    },
    {
      type: "user",
      uuid: "meta",
      timestamp: "2026-10-11T00:00:00Z",
      isMeta: true,
      message: { role: "user", content: "Ignore metadata" },
    },
    {
      type: "user",
      uuid: "u",
      timestamp: "2026-10-11T00:00:00Z",
      message: { role: "user", content: "Recognizable synthetic prompt" },
    },
    {
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-10-11T00:00:01Z",
      message: { role: "assistant", content: [{ type: "text", text: "First fragment" }] },
    },
    {
      type: "assistant",
      uuid: "a2",
      timestamp: "2026-10-11T00:00:02Z",
      message: { role: "assistant", content: "Final fragment" },
    },
  ].map((value) => JSON.stringify(value));
it("unchanged parser filters meta/noise, retains last assistant UUID and merges fragments", () => {
  const reader = makeLegacySessionReader({
    source: "unused",
    limit: "1",
    "min-user-turns": "1",
    exclude: [],
  });
  const session = reader.parseSessionLines("native", "unused", 1, [
    "malformed JSON",
    ...syntheticLines(),
  ])!;
  expect(session.userTurnCount).toBe(1);
  expect(session.lastAssistantUuid).toBe("a2");
  expect(reader.toTurns(session.messages)).toMatchObject([
    {
      user: { text: "Recognizable synthetic prompt" },
      assistant: { uuid: "a2", text: "First fragment\n\nFinal fragment" },
    },
  ]);
  expect(
    makeLegacySessionReader({
      source: "unused",
      limit: "1",
      "min-user-turns": "2",
      exclude: [],
    }).parseSessionLines("native", "unused", 1, syntheticLines()),
  ).toBeNull();
});

it("unchanged selector obeys exclusion and newest-first limit before remap filtering", async () => {
  const source = mkdtempSync(join(tmpdir(), "offline-selection-"));
  try {
    for (const [name, seconds] of [
      ["older", 1],
      ["newer", 2],
      ["excluded", 3],
    ] as const) {
      const path = join(source, `${name}.jsonl`);
      writeFileSync(path, syntheticLines().join("\n"));
      utimesSync(path, seconds, seconds);
    }
    const reader = makeLegacySessionReader({
      source,
      limit: "1",
      "min-user-turns": "1",
      exclude: ["excluded"],
    });
    const sessions = await Effect.runPromise(
      reader.selectSessions().pipe(Effect.provide(NodeServices.layer)),
    );
    expect(sessions.map((session) => session.sessionId)).toEqual(["newer"]);
    expect(sessions.filter((session) => session.sessionId === "older")).toHaveLength(0);
  } finally {
    rmSync(source, { recursive: true });
  }
});

it("configured profile port comes from its persisted state; malformed state is uncertainty", async () => {
  const source = mkdtempSync(join(tmpdir(), "offline-profile-"));
  const path = join(source, "runtime.json");
  try {
    expect(
      await Effect.runPromise(
        readOfflineProfileProbe(path, 13773).pipe(Effect.provide(NodeServices.layer)),
      ),
    ).toEqual({ port: 13773, host: "127.0.0.1" });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        pid: 0,
        port: 45211,
        host: "0.0.0.0",
        origin: "http://localhost:45211",
        startedAt: "2026-10-11",
      }),
    );
    expect(
      await Effect.runPromise(
        readOfflineProfileProbe(path, 13773).pipe(Effect.provide(NodeServices.layer)),
      ),
    ).toEqual({ port: 45211, host: "127.0.0.1" });
    writeFileSync(path, "malformed");
    await expect(
      Effect.runPromise(
        readOfflineProfileProbe(path, 13773).pipe(Effect.provide(NodeServices.layer)),
      ),
    ).rejects.toThrow("uncertain");
  } finally {
    rmSync(source, { recursive: true });
  }
});

it.each([
  "missing",
  "origin",
  "session",
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
] as const)("offline deletion refuses %s before any write", async (condition) => {
  let writes = 0;
  const record = {
    thread: { historyOrigin: condition === "origin" ? "app" : "v1_import" },
    runs: ["preparing", "queued", "starting", "running", "waiting"].includes(condition)
      ? [{ status: condition }]
      : [],
    providerSessions: condition === "session" ? [{ status: "running" }] : [],
  } as never;
  const guardLayer = Layer.mergeAll(
    Layer.mock(Projection.ProjectionStoreV2)({
      getThreadRecords: () =>
        condition === "missing"
          ? Effect.fail(
              new Projection.ProjectionStoreReadError({ threadId: ThreadId.make("missing") }),
            )
          : Effect.succeed(record),
    }),
    Layer.mock(EventSink.EventSinkV2)({
      commitCommand: () =>
        Effect.sync(() => {
          writes++;
          return {} as never;
        }),
    }),
    IdAllocator.layer,
  );
  await expect(
    Effect.runPromise(
      deleteImportedThread({ threadId: ThreadId.make("guard"), dryRun: false }).pipe(
        Effect.provide(guardLayer),
      ),
    ),
  ).rejects.toThrow("delete-thread requires the live server for this thread");
  expect(writes).toBe(0);
});

it("constructs the actual offline service graph and creates a project with no provider/effect worker dependency", async () => {
  const directory = mkdtempSync(join(tmpdir(), "offline-graph-"));
  try {
    const actual = offlineLayer.pipe(
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provideMerge(NodeServices.layer),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const projects = yield* ProjectService.ProjectService;
        const project = yield* projects.create({
          commandId: CommandId.make("offline-graph-project"),
          projectId: ProjectId.make("offline-graph-project"),
          title: "Synthetic offline project",
          workspaceRoot: directory,
        });
        expect(project.title).toBe("Synthetic offline project");
      }).pipe(Effect.provide(actual)),
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});

// Explicit opt-in only: approved scrubbed copy, never the original private transcript.
const approvedCopy = process.env["THROUGHLINE_SCRUBBED_CLAUDE_COPY"];
it.skipIf(approvedCopy === undefined)(
  "approved real Claude copy carries its last assistant UUID into native resumeSessionAt",
  async () => {
    const native = "5e57c8c7-fc11-4899-9fd1-02cf90aa3131";
    const approvedSha = "002e2d455e51e8bb967478d48a510288494ee8e7eea63c032f24effaa8b5cad4";
    const expectedHead =
      process.env["THROUGHLINE_SCRUBBED_CLAUDE_EXPECTED_HEAD"] ??
      "dc099545-c52c-4ed9-9662-24250e1c769d";
    const expectedSha = process.env["THROUGHLINE_SCRUBBED_CLAUDE_EXPECTED_SHA"] ?? approvedSha;
    const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    const originalCopySha = hash(approvedCopy!);
    // Custody is checked before copying/parsing/importing; a wrong artifact refuses.
    expect(originalCopySha, "approved scrubbed-copy SHA").toBe(expectedSha);
    const directory = mkdtempSync(join(tmpdir(), "offline-approved-real-"));
    const disposable = join(directory, `${native}.jsonl`);
    try {
      copyFileSync(approvedCopy!, disposable);
      chmodSync(disposable, 0o400);
      expect(hash(disposable)).toBe(approvedSha);
      const lines = readFileSync(disposable, "utf8").trimEnd().split(/\r?\n/);
      expect(lines).toHaveLength(208);
      // This real fixture has one textual user turn plus tool-result records;
      // exercise the existing explicit flag, never weaken the parser/default.
      const reader = makeLegacySessionReader({
        source: directory,
        limit: "1",
        "min-user-turns": "1",
        exclude: [],
      });
      const selected = await Effect.runPromise(
        reader.selectSessions().pipe(Effect.provide(NodeServices.layer)),
      );
      expect(selected).toHaveLength(1);
      const session = selected[0]!;
      expect(session.sessionId).toBe(native);
      expect(session.lastAssistantUuid, "last assistant UUID from unchanged parser").toBe(
        expectedHead,
      );
      const prepared = {
        ...session,
        messages: reader
          .toTurns(session.messages)
          .flatMap((turn) => [turn.user, ...(turn.assistant ? [turn.assistant] : [])]),
      };
      await Effect.runPromise(
        Effect.gen(function* () {
          const input = {
            sessions: [prepared],
            projectId,
            projectRoot: "/workspace",
            instanceId,
            model: "claude-fable-5",
          };
          const result = yield* importSelectedSessions(input);
          expect(result.imported).toBe(1);
          const projections = yield* Projection.ProjectionStoreV2;
          const records = yield* projections.getThreadRecords(result.heads[0]!.threadId, [
            "providerThreads",
            "runs",
          ]);
          expect(records.runs).toHaveLength(0);
          const provider = records.providerThreads.find(
            (row) => row.id === records.thread.activeProviderThreadId,
          )!;
          expect(provider.nativeThreadRef?.nativeId).toBe(native);
          expect(provider.nativeConversationHeadRef).toMatchObject({
            driver: "claudeAgent",
            nativeId: expectedHead,
            strength: "strong",
          });
          // The exported pure adapter seam is executed, not a reimplementation of its options.
          const options = makeClaudeQueryOptions({
            modelSelection: records.thread.modelSelection,
            nativeThreadId: provider.nativeThreadRef!.nativeId!,
            resume: true,
            resumeSessionAt: provider.nativeConversationHeadRef!.nativeId!,
            cwd: "/workspace",
            environment: {},
          });
          expect(options.resume).toBe(native);
          expect(options.resumeSessionAt, "actual Claude query options").toBe(expectedHead);
          const replay = yield* importSelectedSessions(input);
          expect(replay.heads).toMatchObject([{ committed: false }]);
          const sql = yield* SqlClient.SqlClient;
          expect(yield* sql`SELECT * FROM orchestration_v2_effect_outbox`).toHaveLength(0);
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      if (existsSync(disposable)) unlinkSync(disposable);
      rmdirSync(directory);
      expect(existsSync(disposable), "disposable copy removed").toBe(false);
      expect(hash(approvedCopy!), "approved source copy unchanged").toBe(originalCopySha);
    }
  },
  30000,
);
