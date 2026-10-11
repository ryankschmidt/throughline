// @effect-diagnostics nodeBuiltinImport:off - controlled fixture metadata, not operator state.
// Preparatory checks and source integration. No full native-intake acceptance is claimed until
// the actual production composition has qualified external-leaf fixture seams.
import { describe, expect, test } from "vite-plus/test";
import {
  validateFixtureAddress,
  validateFixtureDirectory,
  withDisposableDatabase,
} from "./server-v2.testkit.ts";
import {
  fixtureBoundary,
  withPreparedFixture,
  withActualServer,
  assertNoGitAncestor,
} from "./server-v2.testkit.ts";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import { helloFixtures } from "./hello-fixtures.ts";
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  CommandId,
  ProjectId,
  ThreadId,
  MessageId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as NodeHttp from "node:http";
import * as Effect from "effect/Effect";
import { countFixtureAuthLeaks, makeFixtureGitInventory } from "./server-v2.testkit.ts";

describe("server V2 fixture pre-start safety (not integration acceptance)", () => {
  test("fixture Git inventory permits only allocated owned repositories and cleans them", async () => {
    let created = "";
    await withPreparedFixture(async (prepared) => {
      const git = await makeFixtureGitInventory(prepared);
      created = await git.createRepository();
      expect(git.repositories).toContain(created);
      await expect(git.assertOwned(created)).resolves.toBeUndefined();
      await expect(git.assertOwned("/Users/Admin/throughline")).rejects.toThrow();
      const unregistered = await NodeFS.mkdtemp(NodePath.join(prepared.root, "not-owned-"));
      await NodeFS.mkdir(NodePath.join(unregistered, ".git"));
      await expect(git.assertOwned(unregistered)).rejects.toThrow();
      await NodeFS.mkdir(NodePath.join(created, "src"));
      await git.assertOwned(NodePath.join(created, "src"));
      const redirected = NodePath.join(prepared.root, "repo-link");
      await NodeFS.symlink(created, redirected);
      await expect(git.assertOwned(redirected)).rejects.toThrow();
      expect(await git.run(created, ["rev-parse", "--is-inside-work-tree"])).toBe("true");
    });
    expect(
      await NodeFS.lstat(created).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });
  test("auth output comparison detects an opaque leak and accepts safe diagnostics", () => {
    expect(countFixtureAuthLeaks(["worker closed"], ["fixture-auth-canary"])).toBe(0);
    expect(countFixtureAuthLeaks(["fixture-auth-canary"], ["fixture-auth-canary"])).toBe(1);
    expect(countFixtureAuthLeaks(["Pairing URL: omitted"], [])).toBe(1);
  });
  test("fixture startup does not issue headless pairing output", async () => {
    await withPreparedFixture(async ({ config }) => {
      expect(config.startupPresentation).toBe("browser");
      expect(config.noBrowser).toBe(true);
    });
  });
  test("ancestor preflight accepts clean physical parent and rejects real Git ancestors without writes", async () => {
    expect(await assertNoGitAncestor("/Users/Admin/throughline-worktrees")).toBe(
      "/Users/Admin/throughline-worktrees",
    );
    await expect(
      assertNoGitAncestor("/Users/Admin/core-root/vault/01_Projects/workbench/infra/throughline"),
    ).rejects.toThrow("Git repository");
    await expect(
      assertNoGitAncestor(
        "/Users/Admin/throughline-worktrees/upstream-reconcile-20261010/apps/server",
      ),
    ).rejects.toThrow("Git repository");
  });

  test("ancestor preflight follows physical symlink ancestry and rejects a live-repo target", async () => {
    const probe = await NodeFS.mkdtemp("/Users/Admin/throughline-worktrees/git-guard-");
    const link = NodePath.join(probe, "repo-link");
    try {
      await NodeFS.symlink(
        "/Users/Admin/core-root/vault/01_Projects/workbench/infra/throughline",
        link,
      );
      await expect(assertNoGitAncestor(link)).rejects.toThrow("Git repository");
    } finally {
      await NodeFS.unlink(link);
      await NodeFS.rmdir(probe);
    }
  });

  test("accepts only the declared IPv4 port-zero listener", () => {
    expect(() => validateFixtureAddress({ host: "127.0.0.1", port: 0 })).not.toThrow();
    for (const address of [
      { host: "0.0.0.0", port: 0 },
      { host: "::", port: 0 },
      { host: "127.0.0.1", port: 3773 },
    ])
      expect(() => validateFixtureAddress(address)).toThrow();
  });

  test("rejects paths outside the supplied fixture boundary before any filesystem write", () => {
    const boundary = "/fixture-owned-root";
    expect(() => validateFixtureDirectory(boundary, "/fixture-owned-root/run-1")).not.toThrow();
    for (const directory of [
      "/Users/Admin/.t3/userdata",
      "/Users/Admin/throughline",
      boundary,
      "/fixture-owned-root/../outside",
      "/fixture-owned-root-neighbor/run-1",
    ])
      expect(() => validateFixtureDirectory(boundary, directory)).toThrow();
  });

  test("disposable fixture Postgres owns its database and installed Absurd schema", async () => {
    await withDisposableDatabase(async (database) => {
      expect(database.name).toMatch(/^tl_v2_fixture_[a-f0-9]{32}$/);
      expect(await database.query("SELECT current_database()")).toBe(database.name);
      expect(await database.query("SELECT count(*) FROM pg_namespace WHERE nspname='absurd'")).toBe(
        "1",
      );
    });
  }, 30_000);

  test("physical fixture configuration confines state and disables real provider homes", async () => {
    let created = "";
    await withPreparedFixture(async ({ root, config }) => {
      created = root;
      expect(await NodeFS.realpath(root)).toBe(root);
      expect(root.startsWith(`${fixtureBoundary}${NodePath.sep}`)).toBe(true);
      for (const path of [config.secretsDir, config.dbPath, config.settingsPath, config.logsDir])
        expect(NodePath.relative(root, path).startsWith("..")).toBe(false);
      expect(config.port).toBe(0);
      expect(config.host).toBe("127.0.0.1");
      expect(config.noBrowser).toBe(true);
      expect(config.shellEnvironmentPrepared).toBe(true);
      const settings = JSON.parse(await NodeFS.readFile(config.settingsPath, "utf8"));
      expect(settings.providerInstances.codex.config.homePath.startsWith(root)).toBe(true);
      expect(settings.providerInstances.codex.config.customModels).toContain("gpt-5-codex");
      for (const [name, instance] of Object.entries(settings.providerInstances))
        if (name !== "codex") expect((instance as { enabled: boolean }).enabled).toBe(false);
    });
    expect(
      await NodeFS.stat(created).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });
});

describe("actual isolated production graph (no store or admission mocks)", () => {
  test("native readiness uses the actual owned SDK and SQL queue inventory", async () => {
    await withActualServer(async (fixture) => {
      const inventory = await fixture.queueInventory();
      await Effect.runPromise(Effect.logInfo("FIXTURE_QUEUE_INVENTORY", { inventory }));
      expect(inventory.databaseName).toMatch(/^tl_v2_fixture_[a-f0-9]{32}$/);
      expect(inventory.sdkQueues).toContain(inventory.queueName);
      expect(inventory.sqlQueues.split("\n")).toContain(inventory.queueName);
      expect([...inventory.sdkQueues].sort()).toEqual([
        "t3-agent-queue",
        "t3-interactive-turns",
        "t3-symphony",
      ]);
      expect(inventory.sqlQueues.split("\n")).toEqual([
        "t3-agent-queue",
        "t3-interactive-turns",
        "t3-symphony",
      ]);
      expect(fixture.brokerAttempts()).toBe(0);
    });
  }, 30_000);
  test("native bootstrap retry reuses the original existing thread without duplicate creation", async () => {
    await withActualServer(async (fixture) => {
      await fixture.seedProject();
      const threadId = ThreadId.make("thread-bootstrap-existing");
      const base = {
        threadId,
        projectId: ProjectId.make("project-default"),
        title: "Bootstrap Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        workspaceStrategy: { type: "root" as const, branch: "main" },
      };
      await fixture.launch({
        ...base,
        commandId: CommandId.make("fixture-existing-thread-create"),
      });
      const result = await fixture.launch({
        ...base,
        reuseExistingThread: true,
        commandId: CommandId.make("cmd-bootstrap-turn-start-existing"),
        initialMessage: {
          messageId: MessageId.make("msg-bootstrap-existing"),
          text: "retry after an uncertain first send",
          attachments: [],
        },
      });
      expect(result.threadId).toBe(threadId);
      expect(result.resumed).toBe(true);
      expect(result.projection.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "msg-bootstrap-existing",
            text: "retry after an uncertain first send",
          }),
        ]),
      );
      expect(result.projection.runs).toHaveLength(1);
      expect(await fixture.waitForRun(threadId)).toEqual({ status: "completed", timedOut: false });
      const journal = fixture.events(threadId);
      expect(journal.filter((event) => event.type === "thread.created")).toHaveLength(1);
      expect(fixture.brokerAttempts()).toBe(0);
    });
  }, 30_000);

  test("native bootstrap materializes the original thread before starting its durable turn", async () => {
    await withActualServer(async (fixture) => {
      await fixture.seedProject();
      const result = await fixture.launch({
        commandId: CommandId.make("cmd-bootstrap-materialization-race"),
        threadId: ThreadId.make("thread-bootstrap-materialization-race"),
        projectId: ProjectId.make("project-default"),
        title: "Materialization Race",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root", branch: "main" },
        initialMessage: {
          messageId: MessageId.make("msg-bootstrap-materialization-race"),
          text: "start only after the thread exists",
          attachments: [],
        },
      });
      expect(result.threadId).toBe("thread-bootstrap-materialization-race");
      expect(result.projection.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "msg-bootstrap-materialization-race",
            text: "start only after the thread exists",
          }),
        ]),
      );
      expect(result.projection.runs).toHaveLength(1);
      expect(await fixture.waitForRun(result.threadId)).toEqual({
        status: "completed",
        timedOut: false,
      });
      const journal = fixture.events(result.threadId);
      expect(journal.findIndex((event) => event.type === "thread.created")).toBeLessThan(
        journal.findIndex((event) => event.type === "run.created"),
      );
      expect(fixture.brokerAttempts()).toBe(0);
    });
  }, 30_000);

  test("actual listener reserves the same IPv4 namespace as its clients", async () => {
    await withActualServer(async (fixture) => {
      const probe = NodeHttp.createServer((_request, response) => response.end("foreign listener"));
      try {
        const result = await new Promise<string>((resolve) => {
          probe.once("error", (error) =>
            resolve("code" in error ? String(error.code) : error.message),
          );
          probe.listen(Number(new URL(fixture.baseUrl).port), "127.0.0.1", () =>
            resolve("listened"),
          );
        });
        expect(result).toBe("EADDRINUSE");
      } finally {
        if (probe.listening)
          await new Promise<void>((resolve, reject) =>
            probe.close((error) => (error ? reject(error) : resolve())),
          );
      }
    });
  }, 30_000);

  test.skipIf(process.env.APP_COMMIT !== "0123456789abcdef0123456789abcdef01234567")(
    "actual compiled commit identity agrees across HTTP and authenticated WS hello",
    async () => {
      await withActualServer(async (fixture) => {
        const response = await fixture.request("/.well-known/t3/environment");
        expect(response.status).toBe(200);
        const descriptor = Schema.decodeUnknownSync(
          Schema.Struct({ serverCommit: Schema.NullOr(Schema.String) }),
        )(await response.json());
        expect(descriptor.serverCommit).toBe("0123456789abcdef0123456789abcdef01234567");
        const hello = await fixture.wireHello({
          protocol_version: 1,
          release: "0.0.56",
          commit: null,
          platform: "test",
          capabilities: [],
          last_cursor: null,
        });
        expect(hello.server_commit).toBe("0123456789abcdef0123456789abcdef01234567");
      });
    },
    30_000,
  );

  test("actual absent commit identity agrees across HTTP and authenticated WS hello", async () => {
    await withActualServer(async (fixture) => {
      const response = await fixture.request("/.well-known/t3/environment");
      expect(response.status).toBe(200);
      const descriptor = Schema.decodeUnknownSync(
        Schema.Struct({ serverCommit: Schema.NullOr(Schema.String) }),
      )(await response.json());
      expect(descriptor.serverCommit).toBe(null);
      const hello = await fixture.wireHello({
        protocol_version: 1,
        release: "0.0.56",
        commit: null,
        platform: "test",
        capabilities: [],
        last_cursor: null,
      });
      expect(hello.server_commit).toBe(null);
      expect(fixture.brokerAttempts()).toBe(0);
    });
  }, 30_000);

  test.each(helloFixtures)(
    "actual hello wire: $name",
    async (wire) => {
      await withActualServer(async (fixture) => {
        const reply = await fixture.wireHello(wire.client);
        expect(reply.outcome).toBe(wire.outcome);
        expect(reply.capabilities).toEqual(wire.capabilities);
        expect(reply.protocol_version).toBe(1);
        expect(reply.server_commit).toBe(null);
        expect(reply.min_supported_client).toBe("0.0.0");
        const snapshot = await fixture.legacySnapshot();
        expect(snapshot).toMatchObject({ type: "snapshot" });
        expect(reply.server_release).toBe(
          (snapshot as { config: { environment: { serverVersion: string } } }).config.environment
            .serverVersion,
        );
        expect(fixture.brokerAttempts()).toBe(0);
      });
    },
    30_000,
  );

  test("actual shared-client session negotiates and probes", async () => {
    await withActualServer(async (fixture) => {
      expect(await fixture.sharedSessionProbe()).toMatchObject({
        kind: "negotiated",
        hello: { outcome: "compatible" },
      });
      expect(fixture.brokerAttempts()).toBe(0);
    });
  }, 30_000);

  test("actual legacy no-hello client receives snapshot; absent credentials refuse the WS door", async () => {
    await withActualServer(async (fixture) => {
      expect(await fixture.legacySnapshot()).toMatchObject({ type: "snapshot" });
      const refused = await fixture.request(
        `/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`,
        { authenticated: false },
      );
      expect(refused.status).toBe(401);
      expect(fixture.brokerAttempts()).toBe(0);
    });
  }, 30_000);
});
