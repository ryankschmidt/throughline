// @effect-diagnostics nodeBuiltinImport:off -- Process-isolated production-server regression.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeSqlite from "node:sqlite";
import { it, expect } from "vite-plus/test";
import { start, reportEvidence, type Server } from "./AttachmentPreservationServer.testkit.ts";

const repo = NodePath.resolve(import.meta.dirname, "../../../../..");
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6eT8AAAAASUVORK5CYII=",
  "base64",
);
const threadId = "attachment-preservation";
const providerId = "attachment-provider";
const time = "2026-10-11T00:00:00.000Z";
const modelSelection = { instanceId: "codex", model: "gpt-6.1-sol" };
const sha = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

function database(root: string) {
  const file = NodePath.join(root, "state/userdata/statev2.sqlite");
  if (!file.startsWith(root + NodePath.sep)) throw new Error("Scratch database boundary");
  return new NodeSqlite.DatabaseSync(file);
}

function seed(root: string) {
  const db = database(root);
  try {
    db.prepare(
      "INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    ).run("attachment-project", "Attachment preservation", root, "[]", time, time);
    const thread = {
      id: threadId,
      projectId: "attachment-project",
      title: "Attachment preservation",
      providerInstanceId: "codex",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: root,
      activeProviderThreadId: providerId,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: time,
      updatedAt: time,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    db.prepare(
      "INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,active_provider_thread_id,created_at,updated_at,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      threadId,
      thread.projectId,
      thread.title,
      "codex",
      "codex",
      thread.runtimeMode,
      thread.interactionMode,
      providerId,
      time,
      time,
      JSON.stringify(thread),
    );
    const provider = {
      id: providerId,
      driver: "codex",
      providerInstanceId: "codex",
      providerSessionId: "attachment-session",
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver: "codex", nativeId: NodeCrypto.randomUUID(), strength: "strong" },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: time,
      updatedAt: time,
    };
    db.prepare(
      "INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,driver,provider_instance_id,provider_session_id,status,first_run_ordinal,last_run_ordinal,updated_at,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      providerId,
      threadId,
      "codex",
      "codex",
      "codex",
      provider.providerSessionId,
      "idle",
      1,
      1,
      time,
      JSON.stringify(provider),
    );
    addRun(db, 1);
  } finally {
    db.close();
  }
  const attachments = NodePath.join(root, "state/userdata/attachments");
  const names = [
    "attachment-preservation-00000000-0000-4000-8000-000000000001.png",
    "attachment-preservation-00000000-0000-4000-8000-000000000002.png",
    "other-thread-00000000-0000-4000-8000-000000000003.png",
  ];
  for (const name of names) NodeFS.writeFileSync(NodePath.join(attachments, name), image);
  return names.map((name) => NodePath.join(attachments, name));
}

function addRun(db: NodeSqlite.DatabaseSync, ordinal: number) {
  const id = `attachment-run-${ordinal}`;
  const messageId = `attachment-message-${ordinal}`;
  const run = {
    id,
    threadId,
    ordinal,
    providerInstanceId: "codex",
    modelSelection,
    providerThreadId: providerId,
    userMessageId: messageId,
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: time,
    startedAt: time,
    completedAt: time,
    checkpointId: null,
    contextHandoffId: null,
  };
  db.prepare(
    "INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,provider_thread_id,status,requested_at,completed_at,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(
    id,
    threadId,
    ordinal,
    "codex",
    "codex",
    providerId,
    "completed",
    time,
    time,
    JSON.stringify(run),
  );
  const message = {
    id: messageId,
    threadId,
    runId: id,
    nodeId: null,
    role: "user",
    text: "Scratch image boundary",
    createdBy: "user",
    creationSource: "web",
    streaming: false,
    createdAt: time,
    updatedAt: time,
    attachments: [
      {
        type: "image",
        id: "attachment-preservation-00000000-0000-4000-8000-000000000001",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: image.length,
      },
    ],
  };
  db.prepare(
    "INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,run_id,node_id,role,streaming,created_at,updated_at,payload_json) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(messageId, threadId, id, null, "user", 0, time, time, JSON.stringify(message));
}

function assertImages(files: string[]) {
  for (const file of files) expect(sha(NodeFS.readFileSync(file))).toBe(sha(image));
}

it("real scratch HTTP rewind and server restart keep image bytes, including unreferenced and other-thread images", async () => {
  // Always rebuild this checkout: a cached bundle must not conceal a regression.
  NodeChildProcess.execFileSync(NodePath.join(repo, "node_modules/.bin/vp"), ["pack"], {
    cwd: NodePath.join(repo, "apps/server"),
    stdio: "pipe",
    timeout: 120_000,
  });
  const root = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "throughline-attachment-preservation-"),
  );
  let server: Server | undefined;
  const observations: unknown[] = [];
  try {
    server = await start(root);
    await server.stop();
    server = undefined;
    const files = seed(root);
    assertImages(files);
    server = await start(root);
    const response = await server.request(`/throughline/threads/${threadId}/rewind`, {
      messageId: "attachment-message-1",
    });
    const result = await response.text();
    observations.push({ stage: "rewind", status: response.status, result });
    expect(response.status, result).toBe(200);
    assertImages(files);
    await server.stop();
    server = undefined;
    const db = database(root);
    try {
      expect(
        db
          .prepare("SELECT status FROM orchestration_v2_projection_runs WHERE run_id=?")
          .get("attachment-run-1")?.status,
      ).toBe("rolled_back");
      // Codex does not journal a transcript cursor. Seed the real journal to
      // exercise the production pending-cut recovery path after a crash.
      const row = db
        .prepare(
          "SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?",
        )
        .get(providerId)!;
      const provider = JSON.parse(row.payload_json as string);
      const sequence = db
        .prepare("SELECT coalesce(max(sequence),0) AS sequence FROM orchestration_v2_events")
        .get()!.sequence;
      if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) {
        throw new Error("Scratch event sequence must be a nonnegative safe integer");
      }
      db.prepare(
        "INSERT INTO throughline_rewind_cut(thread_id,provider_thread_id,native_session_id,resume_at,target_message_id,target_run_ordinal,source_tip_run_ordinal,source_tip_sequence,recovery_state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(
        threadId,
        providerId,
        provider.nativeThreadRef.nativeId,
        "fixture-parent",
        "attachment-message-1",
        0,
        1,
        sequence,
        "pending",
        time,
      );
    } finally {
      db.close();
    }
    assertImages(files);
    server = await start(root);
    assertImages(files);
    await server.stop();
    server = undefined;
    const recovered = database(root);
    try {
      expect(
        recovered
          .prepare("SELECT recovery_state FROM throughline_rewind_cut WHERE thread_id=?")
          .get(threadId)?.recovery_state,
      ).toBe("recovered");
      addRun(recovered, 2);
    } finally {
      recovered.close();
    }
    server = await start(root);
    const repeated = await server.request(`/throughline/threads/${threadId}/rewind`, {
      messageId: "attachment-message-2",
    });
    const repeatedBody = await repeated.text();
    observations.push({
      stage: "repeat-after-restart",
      status: repeated.status,
      result: repeatedBody,
    });
    expect(repeated.status, repeatedBody).toBe(200);
    assertImages(files);
    observations.push({
      stage: "preserved",
      files: files.map((file) => ({
        path: file,
        bytes: NodeFS.statSync(file).size,
        sha256: sha(NodeFS.readFileSync(file)),
      })),
    });
  } finally {
    await server?.stop();
    NodeFS.writeFileSync(
      NodePath.join(root, "Observation.json"),
      JSON.stringify(
        {
          observations,
          scope:
            "Real production HTTP, SQLite, filesystem and rollback implementation; seeded application records with zero terminal native provider turns. No provider runtime/service mocks or LLM requests.",
          root,
        },
        null,
        2,
      ),
    );
    await reportEvidence(NodePath.join(root, "Observation.json"));
  }
}, 120_000);
