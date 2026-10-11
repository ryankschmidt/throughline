import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { restoreSender, stableStepId, decodePreservedTurn } from "./AbsurdRuntimeInProcess.ts";
import { senderFromAppSession, assertSenderClaims } from "../identity/sender-stamp.ts";

it.effect(
  "restores reviewed sender at dispatch and refuses forged context without payload fallback",
  () =>
    Effect.gen(function* () {
      const sender = senderFromAppSession({ subject: "trusted", sessionId: "generation" });
      assert.deepStrictEqual(
        yield* restoreSender(JSON.parse(JSON.stringify({ sender, claims: [] }))),
        { _tag: "available", sender, claims: [] },
      );
      assert.equal((yield* restoreSender(undefined))._tag, "SenderContextUnavailable");
      const restored = yield* restoreSender({
        sender,
        claims: [{ field: "publicAgentId", value: "forged" }],
      });
      const refusal = yield* Effect.flip(assertSenderClaims(restored.sender, restored.claims));
      assert.strictEqual(refusal._tag, "SenderIdentityMismatch");
    }),
);
it("durable task and step identities replay the same command and separate different steps", () => {
  const step = { taskId: "task", step: "dispatch-turn" };
  assert.strictEqual(stableStepId(step, "command"), stableStepId({ ...step }, "command"));
  assert.notStrictEqual(
    stableStepId(step, "command"),
    stableStepId({ ...step, step: "resolve-thread" }, "command"),
  );
});
it.effect(
  "preserved V1 queue commands retain actual message identity and refuse unknown command kinds",
  () =>
    Effect.gen(function* () {
      const command = yield* decodePreservedTurn({
        type: "thread.turn.start",
        commandId: "old-command",
        threadId: "thread",
        message: { messageId: "actual-message", text: "unchanged", attachments: [] },
      });
      assert.strictEqual(command.type, "message.dispatch");
      if (command.type === "message.dispatch") {
        assert.strictEqual(command.messageId, "actual-message");
        assert.strictEqual(command.text, "unchanged");
      }
      const failure = yield* Effect.flip(
        decodePreservedTurn({ type: "unknown", message: { text: "must not be executed" } }),
      );
      assert.strictEqual(failure._tag, "SchemaError");
    }),
);
