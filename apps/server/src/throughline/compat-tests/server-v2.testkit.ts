// @effect-diagnostics nodeBuiltinImport:off - pre-start path validation only.
// @effect-diagnostics globalFetch:off - refusing network interceptor at the test runtime boundary; never usage acquisition.
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../../config.ts";
import * as HttpServer from "effect/http/HttpServer";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Socket from "effect/socket/Socket";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  WS_METHODS,
  ServerConfig as ClientServerConfig,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2ThreadLaunchInput,
  OrchestrationV2ThreadLaunchResult,
  OrchestrationV2ThreadLaunchError,
  OrchestrationV2GetThreadProjectionInput,
  type ProjectScript,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ClientRpcSession from "../../../../../packages/client-runtime/src/rpc/session.ts";
import { PrimaryConnectionTarget } from "../../../../../packages/client-runtime/src/connection/model.ts";
import { helloFixtures } from "./hello-fixtures.ts";
import { defaultInstanceIdForDriver } from "@t3tools/contracts";
import { BUILT_IN_DRIVERS } from "../../provider/builtInDrivers.ts";

// Runtime fixture data, not source/deliverables. Outside every repository, so a
// native Git probe cannot walk upward into Ryan's actual monorepo or fork.
export const fixtureBoundary = "/Users/Admin/throughline-worktrees/_fixtures";

export class FixtureCallbackError extends Schema.TaggedError<FixtureCallbackError>()(
  "FixtureCallbackError",
  { message: Schema.String, cause: Schema.Defect() },
) {}
export class FixtureInvariantError extends Schema.TaggedError<FixtureInvariantError>()(
  "FixtureInvariantError",
  { message: Schema.String },
) {}

export function countFixtureAuthLeaks(
  messages: readonly string[],
  opaque: readonly string[],
): number {
  return messages.filter(
    (message) =>
      /Token:|Pairing URL:|[?#]token=|pairingUrl/i.test(message) ||
      opaque.some((value) => value.length > 0 && message.includes(value)),
  ).length;
}

export async function assertNoGitAncestor(directory: string): Promise<string> {
  const physical = await NodeFS.realpath(directory);
  for (let current = physical; ; current = NodePath.dirname(current)) {
    if (
      await NodeFS.lstat(NodePath.join(current, ".git")).then(
        () => true,
        () => false,
      )
    )
      throw new Error("Fixture path inherits a real Git repository.");
    if (NodePath.dirname(current) === current) return physical;
  }
}

export interface PreparedFixture {
  readonly root: string;
  readonly config: ServerConfig.ServerConfig["Service"];
}

export interface FixtureGitInventory {
  readonly repositories: readonly string[];
  readonly createRepository: (options?: { readonly bare?: boolean }) => Promise<string>;
  readonly assertOwned: (directory: string) => Promise<void>;
  readonly run: (directory: string, args: readonly string[]) => Promise<string>;
  readonly registerProducedWorktree: (directory: string, repository: string) => Promise<void>;
}

export async function makeFixtureGitInventory(
  prepared: PreparedFixture,
): Promise<FixtureGitInventory> {
  validateFixtureDirectory(fixtureBoundary, prepared.root);
  if ((await NodeFS.realpath(prepared.root)) !== prepared.root)
    throw new Error("Redirected fixture root.");
  await assertNoGitAncestor(prepared.root);
  const owned = new Map<
    string,
    { readonly marker: string; readonly inode: number; readonly signature: string }
  >();
  const env = {
    HOME: prepared.root,
    PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const physicalChild = async (directory: string) => {
    validateFixtureDirectory(prepared.root, directory);
    if ((await NodeFS.realpath(directory)) !== NodePath.resolve(directory))
      throw new Error("Fixture Git path is redirected.");
  };
  const record = async (directory: string, marker: string) => {
    await physicalChild(directory);
    const stat = await NodeFS.lstat(marker);
    if (stat.isSymbolicLink()) throw new Error("Fixture Git marker is redirected.");
    owned.set(directory, {
      marker,
      inode: stat.ino,
      signature: stat.isFile() ? await NodeFS.readFile(marker, "utf8") : "directory",
    });
  };
  const assertOwned = async (directory: string) => {
    await physicalChild(directory);
    let admitted = false;
    for (let current = directory; current !== prepared.root; current = NodePath.dirname(current)) {
      const candidate = owned.get(current);
      const marker = NodePath.join(current, ".git");
      const hasMarker = await NodeFS.lstat(marker).then(
        () => true,
        () => false,
      );
      if (hasMarker && candidate === undefined) throw new Error("Unregistered Git ancestor.");
      if (candidate !== undefined) {
        const stat = await NodeFS.lstat(candidate.marker);
        if (
          stat.isSymbolicLink() ||
          stat.ino !== candidate.inode ||
          (stat.isFile() &&
            (await NodeFS.readFile(candidate.marker, "utf8")) !== candidate.signature)
        )
          throw new Error("Owned Git marker changed identity.");
        admitted = true;
      }
    }
    if (!admitted) throw new Error("No allocated repository in exact fixture ownership inventory.");
    await assertNoGitAncestor(prepared.root);
  };
  const execute = (directory: string, args: readonly string[]) =>
    new Promise<string>((resolve, reject) => {
      NodeChildProcess.execFile(
        "/opt/homebrew/bin/git",
        ["-C", directory, ...args],
        { env, timeout: 30_000 },
        (error, stdout, stderr) =>
          error
            ? reject(new Error(`Owned fixture Git failed: ${stderr.trim()}`, { cause: error }))
            : resolve(stdout.trim()),
      );
    });
  return {
    get repositories() {
      return Array.from(owned.keys());
    },
    assertOwned,
    createRepository: async (options) => {
      const directory = await NodeFS.mkdtemp(NodePath.join(prepared.root, "git-owned-"));
      await physicalChild(directory);
      await assertNoGitAncestor(directory);
      const emptyTemplate = await NodeFS.mkdtemp(NodePath.join(prepared.root, "git-template-"));
      await execute(directory, [
        "init",
        "--initial-branch=main",
        `--template=${emptyTemplate}`,
        ...(options?.bare ? ["--bare"] : []),
      ]);
      await record(directory, options?.bare ? directory : NodePath.join(directory, ".git"));
      return directory;
    },
    run: async (directory, args) => {
      await assertOwned(directory);
      if (args.some((arg) => /^(?:--git-dir|--work-tree|-C|--exec-path)(?:=|$)/.test(arg)))
        throw new Error("Fixture Git command cannot redirect ownership.");
      for (const arg of args)
        if (NodePath.isAbsolute(arg)) validateFixtureDirectory(prepared.root, arg);
      return execute(directory, args);
    },
    registerProducedWorktree: async (directory, repository) => {
      await assertOwned(repository);
      await physicalChild(directory);
      const marker = NodePath.join(directory, ".git");
      const stat = await NodeFS.lstat(marker);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("Produced worktree must carry an actual Git file.");
      const content = await NodeFS.readFile(marker, "utf8");
      const gitdir = /^gitdir: (.+)\n?$/.exec(content)?.[1];
      if (!gitdir) throw new Error("Produced worktree Git file invalid.");
      const physicalGitdir = await NodeFS.realpath(NodePath.resolve(directory, gitdir));
      validateFixtureDirectory(NodePath.join(repository, ".git", "worktrees"), physicalGitdir);
      await record(directory, marker);
    },
  };
}

export interface ActualServerFixture {
  readonly prepared: PreparedFixture;
  readonly git: FixtureGitInventory;
  readonly baseUrl: string;
  readonly request: (
    path: string,
    options?: { readonly authenticated?: boolean },
  ) => Promise<Response>;
  readonly brokerAttempts: () => number;
  readonly wireHello: (input: unknown) => Promise<Record<string, unknown>>;
  readonly legacySnapshot: () => Promise<unknown>;
  readonly sharedSessionProbe: () => Promise<unknown>;
  readonly seedProject: (options?: {
    readonly workspaceRoot?: string;
    readonly scripts?: readonly ProjectScript[];
  }) => Promise<void>;
  readonly launch: (
    input: typeof OrchestrationV2ThreadLaunchInput.Type,
  ) => Promise<typeof OrchestrationV2ThreadLaunchResult.Type>;
  readonly projection: (threadId: string) => Promise<unknown>;
  readonly queueInventory: () => Promise<{
    readonly queueName: string;
    readonly sdkQueues: readonly string[];
    readonly sqlQueues: string;
    readonly databaseName: string;
  }>;
  readonly events: (
    threadId: string,
  ) => Promise<
    readonly { readonly sequence: number; readonly type: string; readonly payload: unknown }[]
  >;
  readonly waitForRun: (
    threadId: string,
  ) => Promise<{ readonly status: string | null; readonly timedOut: boolean }>;
  readonly nativeMilestones: () => Promise<readonly unknown[]>;
}

export async function withActualServer<A>(
  use: (fixture: ActualServerFixture) => Promise<A>,
): Promise<A> {
  return withPreparedFixture((prepared) =>
    withDisposableDatabase(async (database) => {
      const git = await makeFixtureGitInventory(prepared);
      const { layerMakeServer } = await import("../../server.ts");
      const { AbsurdConnection } = await import("../record/AbsurdConnection.ts");
      const { CurrentHeadroomStatusUrl } = await import("../headroom/HeadroomAdmission.ts");
      const { DurableIntake } = await import("../admission/IntakeAdmission.ts");
      const ThreadManagement = await import("../../orchestration-v2/ThreadManagementService.ts");
      const output: string[] = [];
      const opaque: string[] = [];
      const captures = (["log", "info", "warn", "error"] as const).map((method) => {
        const original = console[method].bind(console);
        const entries: string[] = [];
        const spy = vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          const message = args
            .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
            .join(" ");
          output.push(message);
          entries.push(message);
        });
        return { original, entries, spy };
      });
      const nativeFetch = globalThis.fetch;
      const origins = new Set<string>();
      let brokerAttempts = 0;
      const refusingFetch: typeof fetch = (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        if (url.hostname === "127.0.0.1" && url.port === "19444") {
          brokerAttempts++;
          return Promise.reject(
            new Error("Fixture refused broker access before sending a request."),
          );
        }
        if (!origins.has(url.origin))
          return Promise.reject(new Error("Fixture refused non-owned network access."));
        return nativeFetch(input, init);
      };
      globalThis.fetch = refusingFetch;
      try {
        const actual = layerMakeServer.pipe(
          Layer.provide(ServerConfig.layer(prepared.config)),
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(AbsurdConnection, database.connection),
              Layer.succeed(CurrentHeadroomStatusUrl, undefined),
              Layer.succeed(HostProcess.Environment, {
                HOME: prepared.root,
                PATH: "/opt/homebrew/bin:/usr/bin:/bin",
                XDG_CONFIG_HOME: NodePath.join(prepared.root, "xdg-config"),
                CODEX_HOME: NodePath.join(prepared.root, "homes", "codex"),
                SHELL: "/bin/zsh",
                USER: NodeOS.userInfo().username,
              }),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        );
        const retainedGraphSql: SqlClient.SqlClient extends Layer.Success<typeof actual>
          ? true
          : false = true;
        // The approved same-layer provideMerge now exposes the real sink.
        // Prior negative output-contract witness remains in the recorded red.
        const retainedGraphSink: EventSink.EventSinkV2 extends Layer.Success<typeof actual>
          ? true
          : false = true;
        void retainedGraphSql;
        void retainedGraphSink;
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const services = yield* Layer.build(actual);
              const server = Context.get(services, HttpServer.HttpServer);
              if (server.address._tag !== "InetAddressV4" || server.address.port <= 0)
                throw new FixtureInvariantError({
                  message: "Fixture did not receive an independently allocated TCP port.",
                });
              const baseUrl = `http://127.0.0.1:${server.address.port}`;
              origins.add(baseUrl);
              const sessions = Context.get(services, SessionStore.SessionStore);
              const { runtime } = Context.get(services, DurableIntake);
              // Test-owned scope awaits the actual public first-generation
              // conjunction once. No polling, sleep, fabricated flag or seeding.
              yield* Effect.promise(() => runtime.ready);
              // Public finite persisted reader on an independent connection to
              // this same fixture file. No migration, raw JSON guessing or store mock.
              const eventReaderServices = yield* Layer.build(
                EventStore.layer.pipe(
                  Layer.provide(
                    NodeSqliteClient.layer({ filename: prepared.config.dbPath }).pipe(
                      Layer.provide(NodeServices.layer),
                    ),
                  ),
                ),
              );
              const eventReader = Context.get(eventReaderServices, EventStore.EventStoreV2);
              const issued = yield* sessions.issue();
              // Opaque, fixture-issued cookie remains only in this callback closure.
              const cookie = `${sessions.cookieName}=${encodeURIComponent(issued.token)}`;
              opaque.push(issued.token, encodeURIComponent(issued.token), cookie);
              const socketUrl = `${baseUrl.replace(/^http:/, "ws:")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`;
              const constructor: Socket.WebSocketConstructor["Service"] = (url, options) => {
                const protocols =
                  typeof options === "string" || Array.isArray(options) ? options : undefined;
                return new NodeSocket.NodeWS.WebSocket(
                  url,
                  protocols as string | string[] | undefined,
                  { headers: { cookie } },
                ) as unknown as globalThis.WebSocket;
              };
              const protocol = RpcClient.layerProtocolSocket().pipe(
                Layer.provide(
                  Socket.layerWebSocket(socketUrl).pipe(
                    Layer.provide(Layer.succeed(Socket.WebSocketConstructor, constructor)),
                  ),
                ),
                Layer.provide(RpcSerialization.layerJson),
              );
              const group = RpcGroup.make(
                Rpc.make(WS_METHODS.throughlineHello, {
                  payload: Schema.Unknown,
                  success: Schema.Unknown,
                }),
                Rpc.make(WS_METHODS.serverGetConfig, {
                  payload: Schema.Unknown,
                  success: ClientServerConfig,
                }),
                Rpc.make(WS_METHODS.subscribeServerConfig, {
                  payload: Schema.Unknown,
                  success: Schema.Unknown,
                  stream: true,
                }),
                Rpc.make(ORCHESTRATION_V2_WS_METHODS.launchThread, {
                  payload: OrchestrationV2ThreadLaunchInput,
                  success: OrchestrationV2ThreadLaunchResult,
                  error: OrchestrationV2ThreadLaunchError,
                }),
                Rpc.make(ORCHESTRATION_V2_WS_METHODS.getThreadProjection, {
                  payload: OrchestrationV2GetThreadProjectionInput,
                  success: Schema.Unknown,
                }),
              );
              const makeRpc = RpcClient.make(group);
              const runRpc = <B, E>(
                f: (client: Effect.Success<typeof makeRpc>) => Effect.Effect<B, E>,
              ) =>
                Effect.runPromise(
                  Effect.scoped(makeRpc.pipe(Effect.flatMap(f), Effect.provide(protocol))),
                );
              return yield* Effect.tryPromise({
                try: () =>
                  use({
                    prepared,
                    git,
                    baseUrl,
                    request: (path, options) =>
                      globalThis.fetch(new URL(path, baseUrl), {
                        headers: {
                          ...(options?.authenticated === false ? {} : { cookie }),
                          [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
                        },
                      }),
                    brokerAttempts: () => brokerAttempts,
                    seedProject: async (options) => {
                      const workspaceRoot = options?.workspaceRoot ?? prepared.root;
                      if (workspaceRoot !== prepared.root) {
                        validateFixtureDirectory(prepared.root, workspaceRoot);
                        if ((await NodeFS.realpath(workspaceRoot)) !== workspaceRoot)
                          throw new Error("Project root redirected.");
                      }
                      return Effect.runPromiseWith(services)(
                        Context.get(services, ProjectService.ProjectService)
                          .create({
                            commandId: CommandId.make("fixture-project-create"),
                            projectId: ProjectId.make("project-default"),
                            title: "Default Project",
                            workspaceRoot,
                            ...(options?.scripts ? { scripts: [...options.scripts] } : {}),
                            defaultModelSelection: {
                              instanceId: ProviderInstanceId.make("codex"),
                              model: "gpt-5-codex",
                            },
                          })
                          .pipe(Effect.asVoid),
                      );
                    },
                    launch: (input) =>
                      runRpc((client) => client[ORCHESTRATION_V2_WS_METHODS.launchThread](input)),
                    projection: (threadId) =>
                      runRpc((client) =>
                        client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
                          threadId: ThreadId.make(threadId),
                        }),
                      ),
                    queueInventory: async () => ({
                      queueName: runtime.queueName,
                      sdkQueues: await runtime.app.listQueues(),
                      sqlQueues: await database.query(
                        "SELECT queue_name FROM absurd.list_queues() ORDER BY queue_name",
                      ),
                      databaseName: await database.query("SELECT current_database()"),
                    }),
                    events: async (threadId) => {
                      const stored = await Effect.runPromise(
                        eventReader
                          .read({ threadId: ThreadId.make(threadId) })
                          .pipe(Stream.runCollect),
                      );
                      return stored.map((row) => ({
                        sequence: row.sequence,
                        type: row.event.type,
                        payload: row.event.payload,
                      }));
                    },
                    waitForRun: async (threadId) => {
                      const result = await Effect.runPromiseWith(services)(
                        Context.get(
                          services,
                          ThreadManagement.ThreadManagementService,
                        ).waitForThread({
                          projectId: ProjectId.make("project-default"),
                          threadId: ThreadId.make(threadId),
                          timeoutMs: 10_000,
                        }),
                      );
                      return { status: result.run?.status ?? null, timedOut: result.timedOut };
                    },
                    nativeMilestones: async () => {
                      const text = await NodeFS.readFile(
                        NodePath.join(prepared.root, "native-milestones.jsonl"),
                        "utf8",
                      );
                      return text
                        .trim()
                        .split("\n")
                        .filter(Boolean)
                        .map((line) => JSON.parse(line) as unknown);
                    },
                    wireHello: (input) =>
                      runRpc((client) => client[WS_METHODS.throughlineHello](input)).then(
                        (value) => {
                          if (typeof value !== "object" || value === null)
                            throw new FixtureInvariantError({
                              message: "Hello reply is not an object.",
                            });
                          return value as Record<string, unknown>;
                        },
                      ),
                    legacySnapshot: () =>
                      runRpc((client) =>
                        client[WS_METHODS.subscribeServerConfig]({}).pipe(
                          Stream.take(1),
                          Stream.runCollect,
                          Effect.map((values) => Array.from(values)[0]),
                        ),
                      ),
                    sharedSessionProbe: () =>
                      Effect.runPromise(
                        Effect.scoped(
                          Effect.gen(function* () {
                            const config = yield* RpcClient.make(group).pipe(
                              Effect.flatMap((client) => client[WS_METHODS.serverGetConfig]({})),
                              Effect.provide(protocol),
                            );
                            // Only the environment id is consumed; auth values remain inside closures.
                            const environmentId = config.environment.environmentId;
                            const target = new PrimaryConnectionTarget({
                              environmentId,
                              label: "real compatibility fixture",
                              httpBaseUrl: baseUrl,
                              wsBaseUrl: socketUrl,
                            });
                            const factory = yield* ClientRpcSession.make({
                              hello: helloFixtures[0]!.client,
                            }).pipe(
                              Effect.provideService(Socket.WebSocketConstructor, constructor),
                            );
                            const session = yield* factory.connect({
                              environmentId,
                              label: target.label,
                              httpBaseUrl: baseUrl,
                              socketUrl,
                              httpAuthorization: null,
                              target,
                            });
                            yield* session.ready;
                            if (session.compatibility === undefined)
                              throw new FixtureInvariantError({
                                message: "Shared-client hello compatibility API missing.",
                              });
                            const compatibility = yield* session.compatibility;
                            yield* session.probe;
                            return compatibility;
                          }),
                        ),
                      ),
                  }),
                catch: (cause) => {
                  let message =
                    cause instanceof Error
                      ? cause.message
                      : "Fixture callback failed with a non-error value.";
                  for (const value of opaque)
                    message = message.replaceAll(value, "[fixture auth withheld]");
                  message = message.replace(
                    /(?:Token:|Pairing URL:|[?#]token=|pairingUrl)[^\n]*/gi,
                    "[fixture auth withheld]",
                  );
                  return new FixtureCallbackError({ message, cause });
                },
              });
            }),
          ).pipe(
            Effect.provideService(References.MinimumLogLevel, "Warn"),
            Effect.timeout("20 seconds"),
          ),
        );
        if (brokerAttempts !== 0)
          throw new Error("Broker request attempted during fixture lifecycle.");
        // Inspect filenames only, never secret bytes.
        for (const name of await NodeFS.readdir(prepared.config.secretsDir))
          validateFixtureDirectory(prepared.root, NodePath.join(prepared.config.secretsDir, name));
        return result;
      } finally {
        globalThis.fetch = nativeFetch;
        for (const capture of captures) capture.spy.mockRestore();
        const leaks = countFixtureAuthLeaks(output, opaque);
        // Compare opaque values in memory only. Preserve all non-auth diagnostic
        // output, including worker shutdown errors, without writing auth bytes.
        for (const capture of captures)
          for (const entry of capture.entries)
            capture.original(
              countFixtureAuthLeaks([entry], opaque) === 0
                ? entry
                : "[fixture authentication output withheld]",
            );
        await Effect.runPromise(
          Effect.logInfo("FIXTURE_AUTH_OUTPUT", {
            entries: output.length,
            leaks,
            safe: leaks === 0,
          }),
        );
        if (leaks !== 0)
          throw new FixtureInvariantError({
            message: "Fixture auth entered captured output; values withheld.",
          });
      }
    }),
  );
}

export async function withPreparedFixture<A>(
  use: (fixture: PreparedFixture) => Promise<A>,
): Promise<A> {
  await assertNoGitAncestor(NodePath.dirname(fixtureBoundary));
  await NodeFS.mkdir(fixtureBoundary, { recursive: true });
  const physicalBoundary = await NodeFS.realpath(fixtureBoundary);
  if (physicalBoundary !== fixtureBoundary)
    throw new Error("Fixture boundary is physically redirected.");
  for (let directory = physicalBoundary; ; directory = NodePath.dirname(directory)) {
    if (
      await NodeFS.lstat(NodePath.join(directory, ".git")).then(
        () => true,
        () => false,
      )
    )
      throw new Error("Fixture boundary inherits a real Git repository; no native work allowed.");
    if (NodePath.dirname(directory) === directory) break;
  }
  const root = await NodeFS.mkdtemp(NodePath.join(physicalBoundary, "server-v2-"));
  try {
    validateFixtureDirectory(physicalBoundary, await NodeFS.realpath(root));
    const services = await Effect.runPromise(
      Effect.scoped(
        Layer.build(ServerConfig.layerTest(root, root).pipe(Layer.provide(NodeServices.layer))),
      ),
    );
    const raw = Context.get(services, ServerConfig.ServerConfig);
    const config = ServerConfig.make({
      ...raw,
      host: "127.0.0.1",
      port: 0,
      noBrowser: true,
      startupPresentation: "browser",
      shellEnvironmentPrepared: true,
    });
    for (const path of [config.secretsDir, config.dbPath, config.settingsPath, config.logsDir])
      validateFixtureDirectory(root, path);
    const binary = NodePath.join(root, "fixture-codex");
    const peer = NodePath.join(root, "codex-peer.ts");
    // The existing native client decodes these frames against its current
    // generated protocol. Only this external fixture executable is controlled;
    // admission, projections, SQL and the provider adapter remain the real graph.
    await NodeFS.writeFile(
      peer,
      String.raw`
import { DatabaseSync } from "node:sqlite";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const database = ${JSON.stringify(config.dbPath)};
const root = ${JSON.stringify(root)};
let nativeId = "fixture-native-thread";
let appThreadId = "";
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
const respond = (id: unknown, result: unknown) => write({ id, result });
const refuse = (id: unknown, message: string) => write({ id, error: { code: -32601, message } });
const current = () => {
  const sql = new DatabaseSync(database, { readOnly: true });
  try {
    const row = sql.prepare("SELECT t.thread_id,r.run_id,m.message_id,t.payload_json AS thread_json,m.payload_json AS message_json FROM orchestration_v2_projection_threads t JOIN orchestration_v2_projection_runs r ON r.thread_id=t.thread_id JOIN orchestration_v2_projection_messages m ON m.run_id=r.run_id WHERE m.role='user' ORDER BY r.ordinal DESC LIMIT 1").get();
    if (!row || typeof row.thread_id !== "string" || typeof row.run_id !== "string" || typeof row.message_id !== "string" || typeof row.thread_json !== "string" || typeof row.message_json !== "string") throw new Error("Fixture materialization absent before native request.");
    return { ...row, thread: JSON.parse(row.thread_json), message: JSON.parse(row.message_json) };
  } finally { sql.close(); }
};
const turn = (status: "inProgress" | "completed") => ({ id: "fixture-native-turn", items: [], itemsView: "notLoaded", status, error: null, startedAt: 1782622440, completedAt: status === "completed" ? 1782622450 : null, durationMs: null });
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  const params = message.params ?? {};
  try {
    switch (message.method) {
      case "initialize": respond(message.id, { userAgent: "fixture-codex-app-server", codexHome: root, platformFamily: "unix", platformOs: "macos" }); return;
      case "initialized": return;
      case "account/read": respond(message.id, { account: { type: "chatgpt", email: "fixture@example.invalid", planType: "plus" }, requiresOpenaiAuth: false }); return;
      case "skills/list": respond(message.id, { data: [{ cwd: root, errors: [], skills: [] }] }); return;
      case "thread/start": {
        const row = current(); appThreadId = row.thread_id; nativeId = "fixture-native-" + appThreadId;
        if (params.model !== "gpt-5-codex") throw new Error("Fixture refused changed native model.");
        respond(message.id, { thread: { id: nativeId, sessionId: nativeId, projectId: null, forkedFromId: null, preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1782622440, updatedAt: 1782622440, status: { type: "idle" }, path: root + "/fixture-native.jsonl", cwd: root, cliVersion: "0.144.0", source: "vscode", threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [] }, model: "gpt-5-codex", modelProvider: "openai", serviceTier: null, cwd: root, instructionSources: [], approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" }, reasoningEffort: "medium" }); return;
      }
      case "turn/start": {
        const row = current();
        if (row.thread_id !== appThreadId || params.threadId !== nativeId || params.model !== "gpt-5-codex") throw new Error("Fixture native turn identity/model mismatch.");
        const expected = row.thread_id === "thread-bootstrap-existing" ? "retry after an uncertain first send" : "start only after the thread exists";
        const expectedId = row.thread_id === "thread-bootstrap-existing" ? "msg-bootstrap-existing" : "msg-bootstrap-materialization-race";
        if (row.message_id !== expectedId || row.message.text !== expected || !(params.input ?? []).some((item: { type: string; text?: string }) => item.type === "text" && item.text === expected)) throw new Error("Fixture refused changed original message.");
        // Actual committed state is checked BEFORE the native acknowledgement.
        appendFileSync(root + "/native-milestones.jsonl", JSON.stringify({ method: "turn/start", model: params.model, threadId: row.thread_id, messageId: row.message_id, runId: row.run_id, materializedBeforeAck: true }) + "\n");
        respond(message.id, { turn: turn("inProgress") });
        write({ method: "turn/started", params: { threadId: nativeId, turn: turn("inProgress") } });
        setImmediate(() => write({ method: "turn/completed", params: { threadId: nativeId, turn: turn("completed") } })); return;
      }
      default: if (message.id !== undefined) refuse(message.id, "Unsupported controlled fixture method.");
    }
  } catch { refuse(message.id, "Fixture native contract or materialization check refused."); }
});
`,
    );
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await NodeFS.writeFile(
      binary,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'codex-cli 0.999.0 (fixture)\\n'; exit 0; fi\nexec ${quote(process.execPath)} --experimental-strip-types ${quote(peer)} "$@"\n`,
      { mode: 0o700 },
    );
    const disabled = Object.fromEntries(
      BUILT_IN_DRIVERS.filter((driver) => driver.metadata.hasDefaultInstance !== false).map(
        (driver) => [
          defaultInstanceIdForDriver(driver.driverKind),
          {
            driver: driver.driverKind,
            enabled: false,
            config: {
              enabled: false,
              binaryPath: binary,
              homePath: NodePath.join(root, "homes", driver.driverKind),
            },
          },
        ],
      ),
    );
    const instances = {
      ...disabled,
      codex: {
        driver: "codex",
        enabled: true,
        config: {
          enabled: true,
          binaryPath: binary,
          homePath: NodePath.join(root, "homes", "codex"),
          setupMode: "existing",
          shadowHomePath: NodePath.join(root, "shadow-codex"),
          launchArgs: "",
          customModels: ["gpt-5-codex"],
        },
      },
    };
    for (const instance of Object.values(instances))
      await NodeFS.mkdir(instance.config.homePath, { recursive: true });
    await NodeFS.writeFile(
      config.settingsPath,
      JSON.stringify({
        providerInstances: instances,
        cursorKeychainUsageEnabled: false,
        enableProviderUpdateChecks: false,
        autoResumeLimitedThreads: false,
        usageLimitSources: {},
      }),
    );
    validateFixtureAddress({ host: config.host ?? "", port: config.port });
    return await use({ root, config });
  } finally {
    // Do not follow links, and delete only the newly allocated, physically owned tree.
    const remove = async (path: string): Promise<void> => {
      validateFixtureDirectory(physicalBoundary, path);
      const stat = await NodeFS.lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return NodeFS.unlink(path);
      for (const name of await NodeFS.readdir(path)) await remove(NodePath.join(path, name));
      await NodeFS.rmdir(path);
    };
    await remove(root);
  }
}

export interface DisposableDatabase {
  readonly connection: string;
  readonly name: string;
  readonly query: (sql: string) => Promise<string>;
}

export async function withDisposableDatabase<A>(
  use: (database: DisposableDatabase) => Promise<A>,
): Promise<A> {
  const name = `tl_v2_fixture_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
  const user = NodeOS.userInfo().username;
  const connection = `postgresql://${encodeURIComponent(user)}@127.0.0.1:5432/${name}`;
  // No inherited DB URL, password, .pgpass, broker environment or user config.
  const env = {
    PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    HOME: "/nonexistent",
    PGPASSFILE: "/dev/null",
  };
  const execute = (binary: string, args: readonly string[]) =>
    new Promise<string>((resolve, reject) => {
      NodeChildProcess.execFile(binary, [...args], { env, timeout: 30_000 }, (error, stdout) => {
        if (error)
          reject(
            new Error(
              "Fixture-only PostgreSQL operation failed; no inherited credentials were used.",
            ),
          );
        else resolve(stdout.trim());
      });
    });
  const query = (database: string, sql: string) =>
    execute("/opt/homebrew/bin/psql", [
      "-X",
      "-w",
      "-h",
      "127.0.0.1",
      "-p",
      "5432",
      "-U",
      user,
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-c",
      sql,
    ]);
  // The only identifier used by the admin connection is generated here, not input.
  await query("postgres", `CREATE DATABASE ${name}`);
  try {
    await execute("/Users/Admin/.local/bin/absurdctl", [
      "init",
      "-d",
      connection,
      "--ref",
      "0.4.0",
    ]);
    return await use({ connection, name, query: (sql) => query(name, sql) });
  } finally {
    await query("postgres", `DROP DATABASE ${name} WITH (FORCE)`);
    const remains = await query(
      "postgres",
      `SELECT count(*) FROM pg_database WHERE datname='${name}'`,
    );
    if (remains !== "0") throw new Error("Owned fixture database was not removed.");
  }
}

/** Pre-start guards. These do not substitute for real graph/route consumption. */
export function validateFixtureAddress(address: { readonly host: string; readonly port: number }) {
  if (address.host !== "127.0.0.1" || address.port !== 0)
    throw new Error("Fixture requires IPv4 loopback and an independently allocated port.");
}

/** Lexical guard only; the completed factory must also verify physical path
 * containment before opening state, so symlinks cannot redirect to live data. */
export function validateFixtureDirectory(boundary: string, directory: string) {
  if (!NodePath.isAbsolute(boundary) || !NodePath.isAbsolute(directory))
    throw new Error("Fixture directories must be absolute.");
  const root = NodePath.resolve(boundary);
  const target = NodePath.resolve(directory);
  const relative = NodePath.relative(root, target);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative)
  )
    throw new Error("Fixture state must be a new child of its owned boundary.");
}
