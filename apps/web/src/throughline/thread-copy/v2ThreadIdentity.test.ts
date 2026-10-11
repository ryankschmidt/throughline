import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { identityFromV2Projection } from "./v2ThreadIdentity";

const ref = { environmentId: "environment-local", threadId: "thread" };
function projection(strength = "strong", appThreadId = "thread") {
  return {
    thread: { id: "thread", activeProviderThreadId: "provider-thread" },
    providerThreads: [
      {
        id: "provider-thread",
        appThreadId,
        providerSessionId: "provider-session",
        nativeThreadRef: { nativeId: "native-uuid", strength },
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
}

describe("v2 thread copy identity", () => {
  it("distinguishes provider and native identities and does not construct a transcript path", () => {
    expect(identityFromV2Projection(ref, projection())).toEqual({
      ...ref,
      session: {
        providerSessionId: "provider-session",
        nativeSessionId: "native-uuid",
        nativeTranscriptPath: null,
      },
    });
  });
  it("does not copy an uncertain native reference or another thread's identity", () => {
    expect(identityFromV2Projection(ref, projection("weak"))?.session?.nativeSessionId).toBeNull();
    expect(
      identityFromV2Projection(ref, projection("strong", "other-thread"))?.session?.nativeSessionId,
    ).toBeNull();
    expect(identityFromV2Projection({ ...ref, threadId: "other-thread" }, projection())).toBeNull();
    expect(identityFromV2Projection(ref, null)).toBeNull();
  });
});
