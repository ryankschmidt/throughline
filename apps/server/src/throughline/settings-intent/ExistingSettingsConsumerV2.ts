import { CommandId, EventId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Receipts from "../../orchestration-v2/CommandReceiptStore.ts";
import * as Projections from "../../orchestration-v2/ProjectionStore.ts";
import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import {
  UnconfirmedSettingsRecordError,
  type ExistingRecordContext,
  type ExistingSettingsConsumer,
  type SettingsBindingRecord,
} from "./HostBindings.ts";
import {
  CurrentSettingsRecord,
  SETTINGS_ITEM_PREFIX,
  SETTINGS_COMMAND_TYPE,
  copySettingsRecord,
  recordJson,
  evidenceSha256,
} from "./SettingsRecord.ts";

export interface ExistingSettingsConsumerOptions<E = never> {
  readonly context: ExistingRecordContext;
  readonly authorize: (context: ExistingRecordContext) => Effect.Effect<boolean, E>;
  readonly mapActivity: (
    record: SettingsBindingRecord,
    context: ExistingRecordContext,
  ) => {
    readonly commandId: CommandId;
    readonly createdAt: string;
    readonly activity: {
      readonly id: string;
      readonly tone: string;
      readonly kind: string;
      readonly summary: string;
      readonly createdAt: string;
    };
  };
}

/** The reviewed Promise port over the existing V2 SQL event/receipt owner. */
export const makeExistingSettingsConsumer = Effect.fn("makeExistingSettingsConsumerV2")(function* <
  E,
>(options: ExistingSettingsConsumerOptions<E>) {
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const identity = yield* ServerEnvironmentIdentity;
  const projections = yield* Projections.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const receipts = yield* Receipts.CommandReceiptStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const context = Object.freeze({ ...options.context });
  const verify = (candidate: ExistingRecordContext) =>
    Effect.gen(function* () {
      const environmentId = yield* identity.getEnvironmentId;
      if (
        candidate.owner !== "OrchestrationEngine" ||
        context.owner !== "OrchestrationEngine" ||
        candidate.environmentId !== environmentId ||
        context.environmentId !== environmentId ||
        candidate.threadId !== context.threadId ||
        !(yield* options.authorize(context))
      )
        return false;
      const thread = yield* projections.getThreadShell(ThreadId.make(context.threadId));
      return thread !== null && thread.id === context.threadId && thread.deletedAt === null;
    });
  return {
    context,
    verifyExistingContext: (candidate) =>
      runPromise(verify(candidate).pipe(Effect.catchCause(() => Effect.succeed(false)))),
    append: async (input, candidate) => {
      const record = copySettingsRecord(input);
      try {
        return await runPromise(
          Effect.gen(function* () {
            if (!(yield* verify(candidate))) throw new Error("DURABLE_CONTEXT_UNAVAILABLE");
            const mapped = options.mapActivity(record, context);
            if (!mapped.activity.id.startsWith(SETTINGS_ITEM_PREFIX))
              throw new Error("Settings item id requires its stable namespace prefix");
            const json = recordJson(record),
              sha = evidenceSha256(json);
            const rows = yield* sql<{
              evidence_sha256: string;
              record_json: string;
            }>`SELECT evidence_sha256,record_json FROM throughline_settings_record WHERE command_id=${mapped.commandId}`;
            if (
              rows.length > 0 &&
              (rows[0]!.evidence_sha256 !== sha || rows[0]!.record_json !== json)
            )
              throw new Error("Settings command id reused with different evidence");
            const at = DateTime.makeUnsafe(mapped.createdAt);
            const itemAt = DateTime.makeUnsafe(mapped.activity.createdAt);
            const committed = yield* sink
              .commitCommand({
                commandId: mapped.commandId,
                threadId: ThreadId.make(context.threadId),
                commandType: SETTINGS_COMMAND_TYPE,
                acceptedAt: at,
                effects: [],
                events: [
                  {
                    id: EventId.make(`throughline-settings-event:${mapped.commandId}`),
                    type: "turn-item.updated",
                    threadId: ThreadId.make(context.threadId),
                    occurredAt: at,
                    payload: {
                      id: TurnItemId.make(mapped.activity.id),
                      threadId: ThreadId.make(context.threadId),
                      runId: null,
                      nodeId: null,
                      providerThreadId: null,
                      providerTurnId: null,
                      nativeItemRef: null,
                      parentItemId: null,
                      ordinal: 0,
                      status: "completed",
                      title: null,
                      startedAt: null,
                      completedAt: itemAt,
                      updatedAt: itemAt,
                      type: "system_notice",
                      message: mapped.activity.summary,
                    },
                  },
                ],
              })
              .pipe(
                Effect.provideService(CurrentSettingsRecord, {
                  commandId: mapped.commandId,
                  itemId: mapped.activity.id,
                  context,
                  kind: mapped.activity.kind,
                  tone: mapped.activity.tone,
                  summary: mapped.activity.summary,
                  createdAt: mapped.activity.createdAt,
                  recordJson: json,
                  evidenceSha256: sha,
                }),
              );
            const receipt = yield* receipts.getByCommandId(mapped.commandId);
            if (
              Option.isNone(receipt) ||
              receipt.value.status !== "accepted" ||
              receipt.value.threadId !== context.threadId ||
              receipt.value.commandType !== SETTINGS_COMMAND_TYPE ||
              receipt.value.resultSequence !== committed.receipt.resultSequence ||
              receipt.value.resultSequence < 1
            )
              throw new Error("DURABLE_RECEIPT_UNCONFIRMED");
            const events = yield* sink
              .readByCommandId({ commandId: mapped.commandId })
              .pipe(Stream.runCollect);
            const saved = events[0];
            if (
              events.length !== 1 ||
              saved === undefined ||
              saved.sequence !== receipt.value.resultSequence ||
              saved.commandId !== mapped.commandId ||
              saved.event.type !== "turn-item.updated" ||
              saved.event.threadId !== context.threadId ||
              saved.event.payload.type !== "system_notice" ||
              saved.event.payload.id !== mapped.activity.id ||
              saved.event.payload.message !== mapped.activity.summary ||
              saved.event.payload.runId !== null ||
              DateTime.formatIso(saved.event.occurredAt) !== DateTime.formatIso(at)
            )
              throw new Error("DURABLE_RECEIPT_UNCONFIRMED");
            const evidence = yield* sql<{
              record_json: string;
              evidence_sha256: string;
              environment_id: string;
              thread_id: string;
              item_id: string;
              owner: string;
              kind: string;
              tone: string;
              created_at: string;
            }>`
            SELECT record_json,evidence_sha256,environment_id,thread_id,item_id,owner,kind,tone,created_at FROM throughline_settings_record WHERE command_id=${mapped.commandId}`;
            const row = evidence[0];
            if (
              evidence.length !== 1 ||
              row === undefined ||
              row.record_json !== json ||
              row.evidence_sha256 !== sha ||
              row.environment_id !== context.environmentId ||
              row.thread_id !== context.threadId ||
              row.item_id !== mapped.activity.id ||
              row.owner !== context.owner ||
              row.kind !== mapped.activity.kind ||
              row.tone !== mapped.activity.tone ||
              row.created_at !== mapped.activity.createdAt ||
              (yield* identity.getEnvironmentId) !== context.environmentId
            )
              throw new Error("DURABLE_RECEIPT_UNCONFIRMED");
            return {
              environmentId: row.environment_id,
              threadId: row.thread_id,
              commandId: mapped.commandId,
              sequence: receipt.value.resultSequence,
            };
          }),
        );
      } catch {
        // Host writes may already have happened. This port never retries.
        throw new UnconfirmedSettingsRecordError(record);
      }
    },
  } satisfies ExistingSettingsConsumer;
});
