// Stable SHA256 is the existing record evidence contract, not a secret operation.
// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { ExistingRecordContext, SettingsBindingRecord } from "./HostBindings.ts";

export const SETTINGS_ITEM_PREFIX = "throughline-settings:";
export const SETTINGS_COMMAND_TYPE = "throughline.settings.record";
export interface SettingsRecordEvidence {
  readonly commandId: string;
  readonly itemId: string;
  readonly context: ExistingRecordContext;
  readonly kind: string;
  readonly tone: string;
  readonly summary: string;
  readonly createdAt: string;
  readonly recordJson: string;
  readonly evidenceSha256: string;
}
export const CurrentSettingsRecord = Context.Reference<SettingsRecordEvidence | undefined>(
  "t3/throughline/settings-intent/SettingsRecord/CurrentSettingsRecord",
  { defaultValue: () => undefined },
);
export function copySettingsRecord(record: SettingsBindingRecord): SettingsBindingRecord {
  const common = {
    bindings: {
      source: record.bindings.source,
      revision: record.bindings.revision,
      hosts: record.bindings.hosts.map(({ role, environmentId }) => ({ role, environmentId })),
    },
    event: {
      setting: record.event.setting,
      value: record.event.value,
      hosts: record.event.hosts.map(({ host, before, effective, status }) => ({
        host,
        before,
        effective,
        status,
      })),
    },
  };
  return record.operation === "apply"
    ? { operation: "apply", ...common }
    : {
        operation: "rollback",
        ...common,
        hosts: record.hosts.map(({ host, effective, status }) => ({ host, effective, status })),
      };
}
export const recordJson = (record: SettingsBindingRecord) =>
  JSON.stringify(copySettingsRecord(record));
export const evidenceSha256 = (json: string) => createHash("sha256").update(json).digest("hex");

export const stampSettingsRecord = (itemId: string) =>
  Effect.gen(function* () {
    const evidence = yield* CurrentSettingsRecord;
    if (evidence === undefined) return; // rebuild preserves the durable side row
    if (itemId !== evidence.itemId || !itemId.startsWith(SETTINGS_ITEM_PREFIX))
      throw new Error("Settings evidence/item mismatch");
    const sql = yield* SqlClient.SqlClient;
    const existing = yield* sql<{
      record_json: string;
      evidence_sha256: string;
      item_id: string;
      thread_id: string;
      environment_id: string;
      owner: string;
      kind: string;
      tone: string;
      created_at: string;
    }>`
    SELECT record_json,evidence_sha256,item_id,thread_id,environment_id,owner,kind,tone,created_at
    FROM throughline_settings_record WHERE command_id=${evidence.commandId}`;
    if (existing.length > 0) {
      const row = existing[0]!;
      if (
        row.record_json !== evidence.recordJson ||
        row.evidence_sha256 !== evidence.evidenceSha256 ||
        row.item_id !== itemId ||
        row.thread_id !== evidence.context.threadId ||
        row.environment_id !== evidence.context.environmentId ||
        row.owner !== evidence.context.owner ||
        row.kind !== evidence.kind ||
        row.tone !== evidence.tone ||
        row.created_at !== evidence.createdAt
      )
        throw new Error("Settings command id reused with different evidence");
      return;
    }
    yield* sql`INSERT INTO throughline_settings_record
    (command_id,thread_id,item_id,environment_id,owner,kind,tone,record_json,evidence_sha256,created_at)
    VALUES (${evidence.commandId},${evidence.context.threadId},${itemId},${evidence.context.environmentId},${evidence.context.owner},
      ${evidence.kind},${evidence.tone},${evidence.recordJson},${evidence.evidenceSha256},${evidence.createdAt})`;
  });
