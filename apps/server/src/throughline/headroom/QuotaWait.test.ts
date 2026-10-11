import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { waitForQuota, type QuotaWaitObservation } from "./QuotaWait.ts";

const nowMillis = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
const iso = (epoch: number) => DateTime.formatIso(DateTime.makeUnsafe(epoch));
const empty = (now: number, resetMs = 60_000): QuotaWaitObservation => ({
  configured: [{ provider: "codex", identity: "account" }],
  freshnessMs: 120_000,
  receivedAt: now,
  snapshot: {
    identities: [
      {
        provider: "codex",
        identity: "account",
        credential_loaded: true,
        quota: { state: "empty", observed_at: iso(now), reset_at: iso(now + resetMs) },
      },
    ],
  },
});

describe("namespace quota waiting (no admission mount or broker)", () => {
  const admits: Array<[string, (now: number) => QuotaWaitObservation | undefined]> = [
    ["missing observation", () => undefined],
    ["no identities", () => ({ freshnessMs: 120_000 })],
    [
      "missing quota",
      () => ({ freshnessMs: 120_000, configured: [{ identity: "unseen", provider: "codex" }] }),
    ],
    [
      "unknown quota",
      (now) => ({
        ...empty(now),
        snapshot: {
          identities: [
            {
              identity: "account",
              provider: "codex",
              credential_loaded: true,
              quota: { state: "unknown" },
            },
          ],
        },
      }),
    ],
    ["stale quota", (now) => empty(now - 120_000, 300_000)],
    ["future quota clock", (now) => empty(now + 1, 60_000)],
    [
      "missing reset",
      (now) => ({
        ...empty(now),
        snapshot: {
          identities: [
            {
              identity: "account",
              provider: "codex",
              credential_loaded: true,
              quota: { state: "empty", observed_at: iso(now) },
            },
          ],
        },
      }),
    ],
    [
      "invalid reset",
      (now) => ({
        ...empty(now),
        snapshot: {
          identities: [
            {
              identity: "account",
              provider: "codex",
              credential_loaded: true,
              quota: { state: "empty", observed_at: iso(now), reset_at: "invalid" },
            },
          ],
        },
      }),
    ],
    ["passed reset", (now) => empty(now, 0)],
    ["invalid freshness", (now) => ({ ...empty(now), freshnessMs: 0 })],
    [
      "expired transport despite recent quota",
      (now) => ({ ...empty(now), receivedAt: now - 120_000 }),
    ],
    ["future transport clock", (now) => ({ ...empty(now), receivedAt: now + 1 })],
    [
      "one available row among empty rows",
      (now) => ({
        ...empty(now),
        snapshot: {
          identities: [
            ...empty(now).snapshot!.identities,
            {
              identity: "other",
              provider: "codex",
              credential_loaded: false,
              quota: { state: "available", observed_at: iso(now) },
            },
          ],
        },
      }),
    ],
    [
      "one configured unobserved row",
      (now) => ({
        ...empty(now),
        configured: [...empty(now).configured!, { identity: "unseen", provider: "codex" }],
      }),
    ],
  ];
  for (const [name, observation] of admits) {
    it.effect(`${name} admits without publishing waiting`, () =>
      Effect.gen(function* () {
        const now = yield* nowMillis;
        let publications = 0;
        yield* waitForQuota({
          readHeadroomSnapshot: () => observation(now),
          publishWaiting: Effect.sync(() => {
            publications++;
          }),
        });
        expect(publications).toBe(0);
      }),
    );
  }
  it.effect("reader failure admits without leaking or publishing", () =>
    Effect.gen(function* () {
      let publications = 0;
      yield* waitForQuota({
        readHeadroomSnapshot: () => {
          throw new Error("controlled failure");
        },
        publishWaiting: Effect.sync(() => {
          publications++;
        }),
      });
      expect(publications).toBe(0);
    }),
  );

  for (const boundary of [
    "reset",
    "quota-staleness",
    "transport-staleness",
    "earliest-row-reset",
  ] as const) {
    it.effect(`fresh known-empty holds until ${boundary}, not one millisecond earlier`, () =>
      Effect.gen(function* () {
        const now = yield* nowMillis;
        let observation = empty(now, boundary === "reset" ? 60_000 : 300_000);
        let deadline = 120_000;
        if (boundary === "reset") deadline = 60_000;
        if (boundary === "transport-staleness") {
          observation = { ...observation, receivedAt: now - 90_000 };
          deadline = 30_000;
        }
        if (boundary === "earliest-row-reset") {
          observation = {
            ...observation,
            snapshot: {
              identities: [
                ...observation.snapshot!.identities,
                {
                  identity: "other",
                  provider: "codex",
                  credential_loaded: false,
                  quota: { state: "empty", observed_at: iso(now), reset_at: iso(now + 20_000) },
                },
              ],
            },
          };
          deadline = 20_000;
        }
        const announced = yield* Deferred.make<void>();
        let publications = 0;
        let dispatches = 0;
        const sending = yield* waitForQuota({
          readHeadroomSnapshot: () => observation,
          publishWaiting: Effect.sync(() => {
            publications++;
          }).pipe(Effect.andThen(Deferred.succeed(announced, undefined)), Effect.asVoid),
        }).pipe(
          Effect.andThen(
            Effect.sync(() => {
              dispatches++;
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(announced);
        yield* TestClock.adjust(`${deadline - 1} millis`);
        expect(dispatches).toBe(0);
        expect(publications).toBe(1);
        yield* TestClock.adjust("1 millis");
        yield* Fiber.join(sending);
        expect(dispatches).toBe(1);
        expect(publications).toBe(1);
      }),
    );
  }

  it.effect(
    "refresh completion re-reads cache, waits again without duplicate waiting, then admits",
    () =>
      Effect.gen(function* () {
        const now = yield* nowMillis;
        const observation = empty(now, 300_000);
        let current: QuotaWaitObservation | undefined = observation;
        let refresh = yield* Deferred.make<void>();
        let reads = 0;
        const readAgain = yield* Deferred.make<void>();
        const announced = yield* Deferred.make<void>();
        let publications = 0;
        let dispatches = 0;
        const sending = yield* waitForQuota({
          readHeadroomSnapshot: () => {
            reads++;
            return current;
          },
          nextHeadroomRefresh: () =>
            Deferred.await(refresh).pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  reads === 1 ? Deferred.succeed(readAgain, undefined) : Effect.void,
                ),
              ),
              Effect.asVoid,
            ),
          publishWaiting: Effect.sync(() => {
            publications++;
          }).pipe(Effect.andThen(Deferred.succeed(announced, undefined)), Effect.asVoid),
        }).pipe(
          Effect.andThen(
            Effect.sync(() => {
              dispatches++;
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(announced);
        const first = refresh;
        refresh = yield* Deferred.make<void>();
        yield* Deferred.succeed(first, undefined);
        yield* Deferred.await(readAgain);
        yield* TestClock.adjust("1 millis");
        expect(reads).toBe(2);
        expect(publications).toBe(1);
        expect(dispatches).toBe(0);
        current = undefined;
        yield* Deferred.succeed(refresh, undefined);
        yield* Fiber.join(sending);
        expect(reads).toBe(3);
        expect(dispatches).toBe(1);
        expect(publications).toBe(1);
      }),
  );

  it.effect("interruption cancels a wait and cannot dispatch later", () =>
    Effect.gen(function* () {
      const now = yield* nowMillis;
      const announced = yield* Deferred.make<void>();
      let dispatches = 0;
      const sending = yield* waitForQuota({
        readHeadroomSnapshot: () => empty(now),
        publishWaiting: Deferred.succeed(announced, undefined).pipe(Effect.asVoid),
      }).pipe(
        Effect.andThen(
          Effect.sync(() => {
            dispatches++;
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(announced);
      yield* Fiber.interrupt(sending);
      yield* TestClock.adjust("120000 millis");
      expect(dispatches).toBe(0);
    }),
  );

  it.effect("refreshing the receipt never renews an old quota observation", () =>
    Effect.gen(function* () {
      const now = yield* nowMillis;
      let current = empty(now, 300_000);
      let refresh = yield* Deferred.make<void>();
      const announced = yield* Deferred.make<void>();
      let publications = 0;
      let dispatches = 0;
      const sending = yield* waitForQuota({
        readHeadroomSnapshot: () => current,
        nextHeadroomRefresh: () => Deferred.await(refresh),
        publishWaiting: Effect.sync(() => {
          publications++;
        }).pipe(Effect.andThen(Deferred.succeed(announced, undefined)), Effect.asVoid),
      }).pipe(
        Effect.andThen(
          Effect.sync(() => {
            dispatches++;
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(announced);
      yield* TestClock.adjust("50000 millis");
      current = { ...current, receivedAt: yield* nowMillis };
      const first = refresh;
      refresh = yield* Deferred.make<void>();
      yield* Deferred.succeed(first, undefined);
      yield* TestClock.adjust("69999 millis");
      expect(dispatches).toBe(0);
      yield* TestClock.adjust("1 millis");
      yield* Fiber.join(sending);
      expect(dispatches).toBe(1);
      expect(publications).toBe(1);
    }),
  );

  it.effect("publication time cannot extend the reset deadline", () =>
    Effect.gen(function* () {
      const now = yield* nowMillis;
      const announced = yield* Deferred.make<void>();
      let dispatches = 0;
      const sending = yield* waitForQuota({
        readHeadroomSnapshot: () => empty(now, 100),
        publishWaiting: Deferred.succeed(announced, undefined).pipe(
          Effect.andThen(Effect.sleep("200 millis")),
          Effect.asVoid,
        ),
      }).pipe(
        Effect.andThen(
          Effect.sync(() => {
            dispatches++;
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(announced);
      yield* TestClock.adjust("200 millis");
      expect(dispatches).toBe(1);
      yield* Fiber.join(sending);
    }),
  );

  it.effect("publication failure propagates and never releases a dispatch", () =>
    Effect.gen(function* () {
      const now = yield* nowMillis;
      let dispatches = 0;
      const result = yield* waitForQuota({
        readHeadroomSnapshot: () => empty(now),
        publishWaiting: Effect.fail("controlled publication failure"),
      }).pipe(
        Effect.andThen(
          Effect.sync(() => {
            dispatches++;
          }),
        ),
        Effect.result,
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: "controlled publication failure" });
      expect(dispatches).toBe(0);
    }),
  );
});
