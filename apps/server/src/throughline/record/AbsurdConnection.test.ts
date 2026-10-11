import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { AbsurdConnection } from "./AbsurdConnection.ts";

it.effect("unset AbsurdConnection remains undefined without changing any shared environment", () =>
  Effect.gen(function* () {
    assert.isUndefined(yield* AbsurdConnection);
  }),
);
it.effect("fixture connection is fiber-local and disappears outside its supplied context", () =>
  Effect.gen(function* () {
    const connection = "postgresql://localhost/throughline_fixture_only";
    assert.equal(
      yield* AbsurdConnection.pipe(Effect.provideService(AbsurdConnection, connection)),
      connection,
    );
    assert.isUndefined(yield* AbsurdConnection);
  }),
);
