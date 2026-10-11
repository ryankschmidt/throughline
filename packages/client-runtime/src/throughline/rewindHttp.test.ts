import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { sendExactMessageRewind } from "./rewindHttp.ts";

const threadId = ThreadId.make("rewind-thread");
const messageId = MessageId.make("chosen-message");
const prepared: PreparedConnection = {
  environmentId: EnvironmentId.make("fixture-environment"),
  label: "fixture",
  httpBaseUrl: "https://fixture.example.test",
  socketUrl: "wss://fixture.example.test/ws",
  httpAuthorization: null,
  target: new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("fixture-environment"),
    label: "fixture",
    httpBaseUrl: "https://fixture.example.test",
    wsBaseUrl: "wss://fixture.example.test",
  }),
};
describe("exact-message HTTP rewind", () => {
  it.effect(
    "sends exact-message rewind through a command older hosts cannot mistake for file restore",
    () =>
      Effect.gen(function* () {
        const calls: Array<{ url: string; init: RequestInit }> = [];
        const fetchFn: typeof fetch = async (url, init) => {
          calls.push({ url: String(url), init: init ?? {} });
          return Response.json({ threadId, messageId, sequence: 3 });
        };
        const result = yield* sendExactMessageRewind({
          prepared,
          threadId,
          messageId,
          fetch: fetchFn,
          signer: Option.none(),
          remoteAuthorization: Option.none(),
        });
        expect(result.sequence).toBe(3);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe(
          "https://fixture.example.test/throughline/threads/rewind-thread/rewind",
        );
        expect(calls[0]?.init).toMatchObject({ method: "POST", credentials: "include" });
        expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ messageId });
      }),
  );
  it.effect("refuses an older host without falling back to file rollback", () =>
    Effect.gen(function* () {
      let calls = 0;
      const result = yield* Effect.exit(
        sendExactMessageRewind({
          prepared,
          threadId,
          messageId,
          fetch: async () => {
            calls++;
            return new Response("not found", { status: 404 });
          },
          signer: Option.none(),
          remoteAuthorization: Option.none(),
        }),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(calls).toBe(1);
    }),
  );
  it.effect("refuses a mismatched acknowledgement", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        sendExactMessageRewind({
          prepared,
          threadId,
          messageId,
          fetch: async () => Response.json({ threadId: "other", messageId, sequence: 3 }),
          signer: Option.none(),
          remoteAuthorization: Option.none(),
        }),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );
  it.effect("retains previous-cut recovery metadata on a successful replacement", () =>
    Effect.gen(function* () {
      const previous_cut = { recovery_state: "refused", refusal_reason: "active-provider-changed" };
      const result = yield* sendExactMessageRewind({
        prepared,
        threadId,
        messageId,
        fetch: async () => Response.json({ threadId, messageId, sequence: 3, previous_cut }),
        signer: Option.none(),
        remoteAuthorization: Option.none(),
      });
      expect(result).toMatchObject({ threadId, messageId, sequence: 3, previous_cut });
    }),
  );
  it.effect("retains new refusal and previous-cut reason without retrying the command", () =>
    Effect.gen(function* () {
      const previous_cut = { recovery_state: "refused", refusal_reason: "active-provider-changed" };
      let calls = 0;
      const result = yield* sendExactMessageRewind({
        prepared,
        threadId,
        messageId,
        fetch: async () => {
          calls++;
          return Response.json(
            { error: "rewind_refused", reason: "native-parent-unavailable", previous_cut },
            { status: 409 },
          );
        },
        signer: Option.none(),
        remoteAuthorization: Option.none(),
      }).pipe(Effect.flip);
      expect(result).toMatchObject({ reason: "native-parent-unavailable", previous_cut });
      expect(calls).toBe(1);
    }),
  );
});
