import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({}));

import { MobileDatabase, type StoredPreferencesJson } from "../persistence/mobile-database";
import { MobileSecureStorage } from "../persistence/mobile-secure-storage";
import { make } from "../persistence/mobile-preferences";

describe("remembered composer height", () => {
  it.effect.each([
    { height: 96, expected: 96 },
    { height: 200, expected: 200 },
    { height: 480, expected: 480 },
    { height: -1, expected: undefined },
    { height: Infinity, expected: undefined },
    { height: NaN, expected: undefined },
  ])("round-trips or rejects height $height after reopening", ({ height, expected }) =>
    Effect.gen(function* () {
      let saved: StoredPreferencesJson = {
        payload: JSON.stringify({ baseFontSize: 18 }),
        updatedAt: 1,
      };
      // This focused store test exercises only the preference database contract.
      const unused = () => Effect.die("Outside the preference test contract");
      const database = MobileDatabase.of({
        loadCache: unused,
        listCache: unused,
        saveCache: unused,
        removeCache: unused,
        clearCacheKind: unused,
        clearEnvironmentCache: unused,
        clearAllCaches: unused(),
        inspectCaches: unused(),
        loadPreferencesJson: Effect.sync(() => Option.some(saved)),
        savePreferencesJson: (payload: string, updatedAt: number) =>
          Effect.sync(() => {
            saved = { payload, updatedAt };
          }),
      });
      const secureStorage = MobileSecureStorage.of({
        getItem: () => Effect.succeed(null),
        setItem: () => Effect.void,
        removeItem: () => Effect.void,
      });
      const open = make().pipe(
        Effect.provideService(MobileDatabase, database),
        Effect.provideService(MobileSecureStorage, secureStorage),
      );
      const first = yield* open;
      yield* first.savePatch({ composerEditorHeight: height });
      const reopened = yield* open;
      expect(yield* reopened.load).toEqual({
        baseFontSize: 18,
        ...(expected === undefined ? {} : { composerEditorHeight: expected }),
      });
    }),
  );
});
