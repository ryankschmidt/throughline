// @effect-diagnostics nodeBuiltinImport:off - a controlled localhost HTTP fixture, not a broker/model deployment.
import * as NodeHttp from "node:http";
import { beforeAll, afterAll, describe, expect, test, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import { BrokerStatusClient } from "./BrokerStatusClient.ts";
import { waitForQuota } from "./QuotaWait.ts";

let body: unknown;
let httpStatus = 200;
let url = "";
let holdResponse = false;
const requests: Array<{
  method: string | undefined;
  path: string | undefined;
  authorized: boolean;
}> = [];
const clients: BrokerStatusClient[] = [];
const server = NodeHttp.createServer((request, response) => {
  requests.push({
    method: request.method,
    path: request.url,
    authorized: request.headers.authorization !== undefined,
  });
  if (holdResponse) return;
  response.writeHead(httpStatus, { "content-type": "application/json" });
  response.end(typeof body === "string" ? body : JSON.stringify(body));
});
beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address missing");
  url = `http://127.0.0.1:${address.port}/v1/status`;
});
afterAll(async () => {
  clients.forEach((client) => client.close());
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
const iso = (epoch: number) => DateTime.formatIso(DateTime.makeUnsafe(epoch));
const payload = (identities: unknown[]) => ({
  schema: "throughline-provider-broker.observer-status.v1",
  last_sequence: 1,
  identities,
});
const account = (
  identity: string,
  now: number,
  state: "unknown" | "available" | "empty" = "empty",
) => ({
  identity,
  provider: "codex",
  credential_loaded: identity !== "unloaded",
  quota: { state, observed_at: iso(now), reset_at: iso(now + 60_000) },
});
function client(
  now: () => number,
  options: { requestTimeoutMs?: number; maxResponseBytes?: number } = {},
) {
  const value = new BrokerStatusClient({ statusUrl: url, now, freshnessMs: 120_000, ...options });
  clients.push(value);
  return value;
}

describe("existing observer HTTP to synchronous typed cache", () => {
  test("GET does not refresh quota time and loaded is not quota availability", async () => {
    let now = Date.parse("2026-10-09T16:00:00Z");
    const oldQuotaTime = iso(now - 180_000);
    body = payload([
      {
        ...account("unloaded", now),
        quota: { state: "empty", observed_at: oldQuotaTime, reset_at: "2099-01-01T00:00:00Z" },
      },
    ]);
    httpStatus = 200;
    const cached = client(() => now);
    const before = requests.length;
    await cached.refresh();
    expect(requests.slice(before)).toEqual([
      { method: "GET", path: "/v1/status", authorized: false },
    ]);
    expect(cached.read().state).toBe("fresh");
    expect(cached.read().snapshot?.identities[0]?.quota?.observed_at).toBe(oldQuotaTime);
    expect(cached.read().identities[0]).toMatchObject({
      configured: null,
      loaded: false,
      available: null,
    });
    now += 1_000;
    await cached.refresh();
    expect(cached.read().snapshot?.identities[0]?.quota?.observed_at).toBe(oldQuotaTime);
    expect(requests.length).toBe(before + 2);
  });

  test("all reported identities survive stale, HTTP failure and malformed responses as unknown", async () => {
    let now = Date.parse("2026-10-09T16:00:00Z");
    body = payload(
      Array.from({ length: 19 }, (_, index) => account(`account-${index}`, now, "available")),
    );
    httpStatus = 200;
    const cached = client(() => now);
    await cached.refresh();
    expect(cached.read().identities).toHaveLength(19);
    now += 120_000;
    expect(cached.read().state).toBe("stale");
    expect(cached.read().snapshot).toBeUndefined();
    expect(
      cached.read().identities.every((row) => row.loaded === null && row.available === null),
    ).toBe(true);
    httpStatus = 503;
    await cached.refresh();
    expect(cached.read().state).toBe("failed");
    expect(cached.read().snapshot).toBeUndefined();
    expect(cached.read().identities).toHaveLength(19);
    httpStatus = 200;
    body = "not-json";
    await cached.refresh();
    expect(cached.read().snapshot).toBeUndefined();
    expect(cached.read().identities).toHaveLength(19);
    body = payload([{ ...account("loaded", now), credential_loaded: "not-a-boolean" }]);
    await cached.refresh();
    expect(cached.read().state).toBe("failed");
    expect(cached.read().snapshot).toBeUndefined();
    expect(cached.read().identities).toHaveLength(19);
  });

  test("unknown configuration never becomes false, reads are isolated, and bodies are bounded", async () => {
    const now = Date.parse("2026-10-09T16:00:00Z");
    body = payload([account("unloaded", now, "available")]);
    httpStatus = 200;
    const cached = client(() => now);
    await cached.refresh();
    expect(cached.read().identities[0]).toMatchObject({
      configured: null,
      loaded: false,
      available: true,
    });
    const first = cached.read().snapshot;
    if (!first) throw new Error("HTTP snapshot missing");
    Object.assign(first.identities[0]!, { credential_loaded: true });
    expect(cached.read().snapshot?.identities[0]?.credential_loaded).toBe(false);
    const bounded = client(() => now, { maxResponseBytes: 32 });
    await bounded.refresh();
    expect(bounded.read().snapshot).toBeUndefined();
    cached.close();
    expect(cached.read().state).toBe("closed");
    expect(cached.read().snapshot).toBeUndefined();
  });
  test("real HTTP timeout becomes unknown without a quota or credential operation", async () => {
    const cached = client(() => 0, { requestTimeoutMs: 1_000 });
    const before = requests.length;
    holdResponse = true;
    try {
      await cached.refresh();
      expect(requests.slice(before)).toEqual([
        { method: "GET", path: "/v1/status", authorized: false },
      ]);
      expect(cached.read().state).toBe("failed");
      expect(cached.read().snapshot).toBeUndefined();
    } finally {
      holdResponse = false;
      cached.close();
    }
  });
});

// Same HTTP inputs and dispatch outcomes as the old V1 consumer tests, now through
// the namespace wait helper. This does not prove the V2 admission mount or a provider adapter.
const sendTurn = vi.fn((input: string) => Effect.succeed(input));
let activeCache: BrokerStatusClient | undefined;
const configured = [
  { identity: "loaded", provider: "codex" },
  { identity: "unloaded", provider: "codex" },
];
const dispatch = (input: string, publishWaiting: Effect.Effect<void> = Effect.void) =>
  waitForQuota({
    readHeadroomSnapshot: () => {
      const cached = activeCache?.read();
      return {
        configured,
        ...(cached?.snapshot ? { snapshot: cached.snapshot } : {}),
        receivedAt: cached?.receivedAt ?? null,
        freshnessMs: 120_000,
      };
    },
    publishWaiting,
  }).pipe(Effect.andThen(() => sendTurn(input)));

describe("real HTTP cache to namespace quota wait", () => {
  const it = effectIt;
  it.effect(
    "absent, old, failed, malformed and reset-unknown HTTP observations admit controlled consumer dispatch",
    () =>
      Effect.gen(function* () {
        sendTurn.mockClear();
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        activeCache = client(() => now);
        yield* dispatch("absent");
        const responses = [
          payload(
            configured.map((row) => ({
              ...account(row.identity, now),
              quota: {
                state: "empty",
                observed_at: iso(now - 180_000),
                reset_at: "2099-01-01T00:00:00Z",
              },
            })),
          ),
          "not-json",
          payload(
            configured.map((row) => ({
              ...account(row.identity, now),
              quota: { state: "empty", observed_at: iso(now) },
            })),
          ),
        ];
        httpStatus = 200;
        for (const value of responses) {
          body = value;
          yield* Effect.promise(() => activeCache!.refresh());
          yield* dispatch("controlled unknown");
        }
        httpStatus = 503;
        yield* Effect.promise(() => activeCache!.refresh());
        yield* dispatch("failed");
        expect(sendTurn).toHaveBeenCalledTimes(5);
      }),
  );
  it.effect("fresh known-empty HTTP observations hold the controlled consumer until reset", () =>
    Effect.gen(function* () {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      activeCache = client(() => now);
      httpStatus = 200;
      body = payload(configured.map((row) => account(row.identity, now)));
      yield* Effect.promise(() => activeCache!.refresh());
      sendTurn.mockClear();
      const waiting = yield* Deferred.make<readonly { state: "waiting" }[]>();
      const sending = yield* dispatch(
        "controlled empty",
        Deferred.succeed(waiting, [{ state: "waiting" }]).pipe(Effect.asVoid),
      ).pipe(Effect.forkScoped);
      yield* TestClock.adjust("1 millis");
      expect(sendTurn).toHaveBeenCalledTimes(0);
      expect((yield* Deferred.await(waiting)).length).toBe(1);
      yield* TestClock.adjust("59999 millis");
      yield* Fiber.join(sending);
      expect(sendTurn).toHaveBeenCalledTimes(1);
    }),
  );
  it.effect("expired transport does not revive a future-clock quota observation into a hold", () =>
    Effect.gen(function* () {
      let now = DateTime.toEpochMillis(yield* DateTime.now);
      activeCache = client(() => now);
      httpStatus = 200;
      body = payload(
        configured.map((row) => ({
          ...account(row.identity, now),
          quota: {
            state: "empty",
            observed_at: iso(now + 120_000),
            reset_at: iso(now + 180_000),
          },
        })),
      );
      yield* Effect.promise(() => activeCache!.refresh());
      sendTurn.mockClear();
      yield* TestClock.adjust("120000 millis");
      now = DateTime.toEpochMillis(yield* DateTime.now);
      expect(activeCache.read().state).toBe("stale");
      expect(activeCache.read().snapshot).toBeUndefined();
      yield* dispatch("expired transport");
      expect(sendTurn).toHaveBeenCalledTimes(1);
    }),
  );
});
