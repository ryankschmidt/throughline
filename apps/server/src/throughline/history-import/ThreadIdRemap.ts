import {
  CommandId,
  EventId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import type * as SchemaAST from "effect/SchemaAST";
import type * as EventSink from "../../orchestration-v2/EventSink.ts";
import type * as Runtime from "../../persistence/ProviderSessionRuntime.ts";

export const APP_ID_SCHEMA_FIELDS: readonly string[] = [
  "payload.appThreadId",
  "payload.basePoint.threadId",
  "payload.context.records[].threadId",
  "payload.forkedFrom.providerThreadId",
  "payload.forkedFrom.threadId",
  "payload.history.messages[].providerThreadId",
  "payload.history.messages[].threadId",
  "payload.lineage.rootThreadId",
  "payload.providerThreadId",
  "payload.source.providerThreadId",
  "payload.source.threadId",
  "payload.sourcePlanRef.threadId",
  "payload.sourcePoint.threadId",
  "payload.threadId",
  "threadId",
];
const names = new Set(["threadId", "appThreadId", "rootThreadId", "providerThreadId"]);
export function collectAppIdentityFields(ast: SchemaAST.AST): string[] {
  const fields = new Set<string>();
  const walk = (value: unknown, path: string, seen: Set<object>) => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    const next = new Set(seen).add(value);
    const node = value as {
      propertySignatures?: readonly { name: PropertyKey; type: unknown }[];
      types?: readonly unknown[];
      elements?: readonly unknown[];
      rest?: readonly unknown[];
      f?: () => unknown;
    };
    for (const property of node.propertySignatures ?? []) {
      const name = String(property.name),
        field = path ? `${path}.${name}` : name;
      if (names.has(name)) fields.add(field);
      walk(property.type, field, next);
    }
    for (const member of node.types ?? []) walk(member, path, next);
    for (const member of [...(node.elements ?? []), ...(node.rest ?? [])])
      walk(member, `${path}[]`, next);
    if (node.f) walk(node.f(), path, next);
  };
  walk(ast, "", new Set());
  return [...fields].sort();
}

export interface ThreadIdRemap {
  readonly from: ThreadId;
  readonly to: ThreadId;
  readonly providerFrom: ProviderThreadId;
  readonly providerTo: ProviderThreadId;
}
export const makeThreadIdRemap = (
  from: ThreadId,
  to: ThreadId,
  nativeId: string,
  providerFrom: ProviderThreadId,
): ThreadIdRemap => ({
  from,
  to,
  providerFrom,
  providerTo: ProviderThreadId.make(`throughline:history-import:${to.length}:${to}:${nativeId}`),
});
const mapThread = (id: ThreadId, pair: ThreadIdRemap) => (id === pair.from ? pair.to : id);
const mapCommand = (id: CommandId, pair: ThreadIdRemap) =>
  CommandId.make(
    String(id).replaceAll(pair.from, pair.to).replaceAll(pair.providerFrom, pair.providerTo),
  );

/** Known schema fields are inventoried independently; only import events cross this wrapper. */
export function remapEvent(
  event: OrchestrationV2DomainEvent,
  pair: ThreadIdRemap,
): OrchestrationV2DomainEvent {
  if (event.threadId !== pair.from) return event;
  if (
    !["thread.created", "provider-thread.updated", "message.updated", "turn-item.updated"].includes(
      event.type,
    )
  )
    throw new Error(`Offline remap refuses event ${event.type}`);
  const rewrite = (value: unknown, path: string): unknown => {
    if (value === null || typeof value !== "object" || DateTime.isDateTime(value)) return value;
    if (Array.isArray(value)) return value.map((item) => rewrite(item, `${path}[]`));
    // Preserve DateTime and all native identity objects byte-for-byte.
    if (
      path.endsWith("nativeThreadRef") ||
      path.endsWith("nativeConversationHeadRef") ||
      path === "occurredAt"
    )
      return value;
    const result: Record<string, unknown> = { ...value };
    for (const [key, item] of Object.entries(value)) {
      const field = path ? `${path}.${key}` : key;
      if (names.has(key)) {
        if (!APP_ID_SCHEMA_FIELDS.includes(field))
          throw new Error(`Offline remap refuses unknown app identity field ${field}`);
        result[key] =
          item === pair.from ? pair.to : item === pair.providerFrom ? pair.providerTo : item;
      } else if (field === "payload.id" && event.type === "thread.created") result[key] = pair.to;
      else if (field === "payload.id" && event.type === "provider-thread.updated")
        result[key] = pair.providerTo;
      else if (field === "payload.activeProviderThreadId" && item === pair.providerFrom)
        result[key] = pair.providerTo;
      else if (
        (field === "payload.id" || field === "payload.messageId") &&
        typeof item === "string"
      )
        result[key] = item
          .replaceAll(pair.from, pair.to)
          .replaceAll(pair.providerFrom, pair.providerTo);
      else if (
        key === "nativeThreadRef" ||
        key === "nativeConversationHeadRef" ||
        key === "providerSessionId"
      )
        result[key] = item;
      else result[key] = rewrite(item, field);
    }
    return result;
  };
  const mapped = rewrite(event, "") as OrchestrationV2DomainEvent;
  return {
    ...mapped,
    id: EventId.make(
      String(event.id)
        .replaceAll(pair.from, pair.to)
        .replaceAll(pair.providerFrom, pair.providerTo),
    ),
  };
}

export function remapRuntime(
  runtime: Runtime.ProviderSessionRuntime,
  pair: ThreadIdRemap,
): Runtime.ProviderSessionRuntime {
  if (runtime.threadId !== pair.from) return runtime;
  const cursor = runtime.resumeCursor;
  return {
    ...runtime,
    threadId: pair.to,
    resumeCursor:
      typeof cursor === "object" && cursor !== null && "threadId" in cursor
        ? { ...cursor, threadId: cursor.threadId === pair.from ? pair.to : cursor.threadId }
        : cursor,
  };
}

export const wrapRuntime = (
  base: Runtime.ProviderSessionRuntimeRepository["Service"],
  pair: ThreadIdRemap,
): Runtime.ProviderSessionRuntimeRepository["Service"] => ({
  ...base,
  upsert: (input, options) => base.upsert(remapRuntime(input, pair), options),
  recordImportedTranscript: (input) =>
    base.recordImportedTranscript({ ...input, threadId: mapThread(input.threadId, pair) }),
});
export const wrapEventSink = (
  base: EventSink.EventSinkV2Shape,
  pair: ThreadIdRemap,
): EventSink.EventSinkV2Shape => ({
  ...base,
  write: (input) =>
    Effect.sync(() => ({
      ...input,
      events: input.events.map((event) => remapEvent(event, pair)),
    })).pipe(Effect.flatMap(base.write)),
  commitCommand: (input) =>
    Effect.sync(() => ({
      ...input,
      commandId: mapCommand(input.commandId, pair),
      threadId: mapThread(input.threadId, pair),
      events: input.events.map((event) => remapEvent(event, pair)),
    })).pipe(Effect.flatMap(base.commitCommand)),
});
