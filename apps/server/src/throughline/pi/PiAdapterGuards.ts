import { TurnItemId, type OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";
import { ProviderAdapterRegistryV2 } from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import {
  makePiMeridianRouteGuard,
  type PiMeridianRouteGuardShape,
  type PiMeridianRouteGuardOptions,
} from "./PiMeridianRoute.ts";

/** Guards only; upstream owns process/protocol/orchestration. No model, sender or authority is invented. */
export function guardPiAdapter(
  base: ProviderAdapter.ProviderAdapterV2["Service"],
  guard: PiMeridianRouteGuardShape,
): ProviderAdapter.ProviderAdapterV2["Service"] {
  if (base.driver !== "pi") return base;
  const admit = (model: string) =>
    guard.guardAnthropicTurn(model).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapter.ProviderAdapterProtocolError({
            driver: base.driver,
            detail: cause.detail,
          }),
      ),
    );
  return {
    ...base,
    openSession: (input) =>
      Effect.gen(function* () {
        yield* admit(input.modelSelection.model);
        const runtime = yield* base.openSession(input);
        const turns = new Map<
          string,
          {
            input: ProviderAdapter.ProviderAdapterV2TurnInput;
            hasText: boolean;
            ordinal: number;
            latestTurn?: OrchestrationV2ProviderTurn;
          }
        >();
        const observe = (
          event: ProviderAdapter.ProviderAdapterV2Event,
          now: DateTime.Utc,
        ): ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> => {
          if (event.type === "provider_turn.updated") {
            const current = turns.get(event.providerTurn.providerThreadId);
            if (current) current.latestTurn = event.providerTurn;
          }
          if (event.type === "turn_item.updated" && event.turnItem.providerThreadId != null) {
            const current = turns.get(event.turnItem.providerThreadId);
            if (current && current.input.runId === event.turnItem.runId) {
              current.ordinal = Math.max(current.ordinal, event.turnItem.ordinal);
              if (
                event.turnItem.type === "assistant_message" &&
                event.turnItem.text.trim().length > 0
              )
                current.hasText = true;
            }
          }
          if (event.type !== "turn.terminal") return [event];
          const current = turns.get(event.providerThreadId);
          turns.delete(event.providerThreadId);
          if (event.status !== "completed" || current === undefined || current.hasText)
            return [event];
          const failure = makeProviderFailure({
            class: "provider_error",
            message: "Pi turn completed with no output; silent success is refused.",
          });
          const ordinal = current.ordinal + 1;
          const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
          if (current.latestTurn)
            events.push({
              type: "provider_turn.updated",
              driver: base.driver,
              threadId: current.input.threadId,
              providerTurn: { ...current.latestTurn, status: "failed", completedAt: now },
            });
          events.push({
            type: "turn_item.updated",
            driver: base.driver,
            turnItem: {
              id: TurnItemId.make(`throughline-no-output:${event.providerTurnId}`),
              type: "error",
              threadId: current.input.threadId,
              runId: current.input.runId,
              nodeId: current.input.rootNodeId,
              providerThreadId: event.providerThreadId,
              providerTurnId: event.providerTurnId,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "failed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure,
            },
          });
          events.push({ ...event, status: "failed", failure, failureItemOrdinal: ordinal });
          return events;
        };
        return {
          ...runtime,
          events: runtime.events.pipe(
            Stream.mapEffect((event) =>
              DateTime.now.pipe(Effect.map((now) => observe(event, now))),
            ),
            Stream.flatMap((events) => Stream.fromIterable(events)),
          ),
          startTurn: (turn) =>
            Effect.gen(function* () {
              yield* admit(turn.modelSelection.model);
              turns.set(turn.providerThread.id, { input: turn, hasText: false, ordinal: 0 });
              yield* runtime.startTurn(turn).pipe(
                Effect.tapError(() =>
                  Effect.sync(() => {
                    turns.delete(turn.providerThread.id);
                  }),
                ),
              );
            }),
        };
      }),
  };
}

/** Wrap each lookup dynamically, so provider hot reloads and removal stay upstream-owned. */
export const registryLayer = (options?: PiMeridianRouteGuardOptions) =>
  Layer.effect(
    ProviderAdapterRegistryV2,
    Effect.gen(function* () {
      const base = yield* ProviderAdapterRegistryV2;
      const fs = yield* FileSystem.FileSystem;
      const guard = makePiMeridianRouteGuard(fs, options);
      return {
        ...base,
        get: (instanceId) =>
          base.get(instanceId).pipe(Effect.map((adapter) => guardPiAdapter(adapter, guard))),
      };
    }),
  );
