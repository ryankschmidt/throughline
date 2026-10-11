import { expect, it } from "@effect/vitest";
import { ThreadId, ProviderThreadId, OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Runtime from "../../persistence/ProviderSessionRuntime.ts";
import {
  collectAppIdentityFields,
  APP_ID_SCHEMA_FIELDS,
  remapEvent,
  remapRuntime,
  makeThreadIdRemap,
} from "./ThreadIdRemap.ts";

it("schema inventory pins every app identity field, including new-field negative control", () => {
  const actual = collectAppIdentityFields(OrchestrationV2DomainEvent.ast);
  expect(actual).toEqual(APP_ID_SCHEMA_FIELDS);
  expect(collectAppIdentityFields(Runtime.ProviderSessionRuntime.ast)).toEqual(["threadId"]);
  const extended = Schema.Struct({
    threadId: Schema.String,
    unknown: Schema.Struct({ appThreadId: Schema.String }),
  });
  expect(
    collectAppIdentityFields(extended.ast).filter((path) => !APP_ID_SCHEMA_FIELDS.includes(path)),
  ).toEqual(["unknown.appThreadId"]);
});

const pair = makeThreadIdRemap(
  ThreadId.make("import:claude:native"),
  ThreadId.make("fresh"),
  "native",
  ProviderThreadId.make("old-provider"),
);
it("remaps app-local provider identity without touching native identity or original input", () => {
  const native = { driver: "claudeAgent", nativeId: "native", strength: "strong" };
  const event = {
    id: "agent-session-import:v2:provider-thread:old-provider",
    threadId: pair.from,
    type: "provider-thread.updated",
    occurredAt: DateTime.makeUnsafe("2026-10-11"),
    payload: {
      id: "old-provider",
      appThreadId: pair.from,
      nativeThreadRef: native,
      nativeConversationHeadRef: { ...native, nativeId: "assistant" },
      providerSessionId: null,
    },
  } as unknown as typeof OrchestrationV2DomainEvent.Type;
  const mapped = remapEvent(event, pair);
  expect(mapped.threadId).toBe("fresh");
  expect(mapped.payload).toMatchObject({
    id: pair.providerTo,
    appThreadId: "fresh",
    nativeThreadRef: native,
    nativeConversationHeadRef: { ...native, nativeId: "assistant" },
    providerSessionId: null,
  });
  expect(event.payload).toMatchObject({ id: "old-provider", appThreadId: pair.from });
  expect(pair.providerTo).not.toBe(pair.providerFrom);
});

it("remaps runtime app/cursor ids but never native resume UUID", () => {
  const runtime = {
    threadId: pair.from,
    resumeCursor: { threadId: pair.from, resume: "native" },
  } as Runtime.ProviderSessionRuntime;
  expect(remapRuntime(runtime, pair)).toMatchObject({
    threadId: "fresh",
    resumeCursor: { threadId: "fresh", resume: "native" },
  });
  expect(runtime.threadId).toBe(pair.from);
});

it("unknown app identity fields refuse rather than silently escaping remap", () => {
  const event = {
    threadId: pair.from,
    type: "message.updated",
    payload: { threadId: pair.from, unexpected: { appThreadId: pair.from } },
  } as unknown as typeof OrchestrationV2DomainEvent.Type;
  expect(() => remapEvent(event, pair)).toThrow("unexpected.appThreadId");
});
