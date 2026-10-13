import { expect, it } from "vite-plus/test";
import { nativeMenuSessionUuid } from "./threadMenuIdentity";
const projection = {
  thread: { id: "app-thread", activeProviderThreadId: "provider-row" },
  providerThreads: [
    {
      id: "provider-row",
      appThreadId: "app-thread",
      nativeThreadRef: { strength: "strong", nativeId: "actual-native-uuid" },
    },
  ],
};
it("copies the actual strong native UUID, never the provider row identity", () => {
  expect(nativeMenuSessionUuid("app-thread", projection)).toBe("actual-native-uuid");
});
it("refuses wrong-thread projections, weak refs and provider rows belonging to another thread", () => {
  expect(nativeMenuSessionUuid("different-thread", projection)).toBeNull();
  expect(
    nativeMenuSessionUuid("app-thread", {
      ...projection,
      providerThreads: [
        {
          ...projection.providerThreads[0]!,
          nativeThreadRef: { strength: "weak", nativeId: "not-copyable" },
        },
      ],
    }),
  ).toBeNull();
  expect(
    nativeMenuSessionUuid("app-thread", {
      ...projection,
      providerThreads: [{ ...projection.providerThreads[0]!, appThreadId: "other-app" }],
    }),
  ).toBeNull();
  expect(nativeMenuSessionUuid("app-thread", null)).toBeNull();
});
