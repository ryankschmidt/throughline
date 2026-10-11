import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Executor from "../../orchestration-v2/EffectWorker.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  layer,
  HeadroomAdmission,
  CurrentHeadroomStatusUrl,
  DEFAULT_HEADROOM_STATUS_URL,
} from "./HeadroomAdmission.ts";
import { afterAll, vi } from "vite-plus/test";

let calls = 0;
let started: () => void = () => {};
const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
  calls++;
  started();
  const now = Effect.runSync(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
  return new Response(
    JSON.stringify({
      schema: "throughline-provider-broker.observer-status.v1",
      last_sequence: 1,
      identities: [
        {
          identity: "fixture",
          provider: "codex",
          credential_loaded: false,
          configured: false,
          quota: { state: "unknown", observed_at: now },
        },
      ],
    }),
    { status: 200 },
  );
});
afterAll(() => fetch.mockRestore());
const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const runtime = layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      stores,
      EventSink.layer.pipe(Layer.provide(stores)),
      Layer.succeed(Executor.OrchestrationEffectExecutorV2, { execute: () => Effect.void }),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "undefined observer URL starts no poll, refresh, fiber or timer in its owned executor scope",
  () =>
    Effect.gen(function* () {
      const before = calls;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const admission = yield* HeadroomAdmission;
          assert.isFalse(admission.pollingStarted);
          yield* admission.recheck;
        }).pipe(
          Effect.provide(runtime),
          Effect.provideService(CurrentHeadroomStatusUrl, undefined),
        ),
      );
      assert.equal(calls, before);
    }),
);
it.effect("a supplied Reference layer also disables polling during layer construction", () =>
  Effect.gen(function* () {
    const before = calls;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const admission = yield* HeadroomAdmission;
        assert.isFalse(admission.pollingStarted);
      }).pipe(
        Effect.provide(
          runtime.pipe(Layer.provide(Layer.succeed(CurrentHeadroomStatusUrl, undefined))),
        ),
      ),
    );
    assert.equal(calls, before);
  }),
);
it.effect(
  "unset URL keeps existing endpoint and starts exactly one controlled initial observer request",
  () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      started = () => {
        Effect.runSync(Deferred.succeed(ready, undefined));
      };
      const before = calls;
      assert.equal(yield* CurrentHeadroomStatusUrl, DEFAULT_HEADROOM_STATUS_URL);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const admission = yield* HeadroomAdmission;
          assert.isTrue(admission.pollingStarted);
          yield* Deferred.await(ready);
          assert.equal(calls - before, 1);
        }).pipe(Effect.provide(runtime)),
      );
      started = () => {};
    }),
  { timeout: 10000 },
);
