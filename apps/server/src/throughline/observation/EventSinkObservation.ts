import { type CommandId, type OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as EventSink from "../../orchestration-v2/EventSink.ts";

import {
  CurrentAuthenticatedSender,
  CurrentSenderClaims,
  assertSenderClaims,
} from "../identity/sender-stamp.ts";
export { observeEvents } from "./ProjectionObservation.ts";

export const makeObservedSink = (base: EventSink.EventSinkV2Shape): EventSink.EventSinkV2Shape => {
  const write = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    input: { events: readonly unknown[]; commandId?: CommandId },
    _events: (result: A) => readonly OrchestrationV2StoredEvent[],
  ) =>
    Effect.gen(function* () {
      const sender = yield* CurrentAuthenticatedSender;
      const claims = yield* CurrentSenderClaims;
      yield* assertSenderClaims(sender, claims);
      const result = yield* effect;
      return result;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new EventSink.EventSinkWriteError({
            eventCount: input.events.length,
            ...(input.commandId ? { commandId: input.commandId } : {}),
            cause,
          }),
      ),
    );
  return {
    ...base,
    write: (input) => write(base.write(input), input, (result) => result),
    writeWithEffects: (input) => write(base.writeWithEffects(input), input, (result) => result),
    writeIfRunCurrent: (input) =>
      write(base.writeIfRunCurrent(input), input, (result) =>
        result.committed ? result.storedEvents : [],
      ),
    writeIfProviderThreadOwner: (input) =>
      write(base.writeIfProviderThreadOwner(input), input, (result) =>
        result.committed ? result.storedEvents : [],
      ),
    commitCommand: (input) =>
      write(base.commitCommand(input), input, (result) =>
        result.committed ? result.storedEvents : [],
      ),
  };
};

export const layer = Layer.effect(
  EventSink.EventSinkV2,
  Effect.gen(function* () {
    const base = yield* EventSink.EventSinkV2;
    return makeObservedSink(base);
  }),
);
