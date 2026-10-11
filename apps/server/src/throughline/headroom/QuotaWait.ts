import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { readHeadroom } from "./observer.ts";

export type QuotaWaitObservation = Omit<Parameters<typeof readHeadroom>[0], "now"> & {
  readonly receivedAt?: number | null;
};

export interface QuotaWaitOptions<E = never, R = never> {
  readonly readHeadroomSnapshot: () => QuotaWaitObservation | undefined;
  readonly nextHeadroomRefresh?: () => Effect.Effect<void> | undefined;
  readonly publishWaiting: Effect.Effect<void, E, R>;
}

function timestamp(value: string | null): number {
  if (!value) return NaN;
  try {
    return DateTime.toEpochMillis(DateTime.makeUnsafe(value));
  } catch {
    return NaN;
  }
}

function readObservation(
  read: QuotaWaitOptions["readHeadroomSnapshot"],
): QuotaWaitObservation | undefined {
  try {
    return read();
  } catch {
    // A failed synchronous reader is unknown; its error payload stays private.
    return undefined;
  }
}

/** Wait mechanics only. The caller owns cache refresh, identity selection, events,
 * and admission. This helper never fetches usage or dispatches/resumes a turn.
 * Pass the cache's receivedAt without replacing the quota's observed_at. */
export const waitForQuota = Effect.fnUntraced(function* <E, R>(options: QuotaWaitOptions<E, R>) {
  let announcedWait = false;
  while (true) {
    // Subscribe before the read, so a refresh completed between read and sleep is not lost.
    const refreshCompleted = options.nextHeadroomRefresh?.();
    const observation = readObservation(options.readHeadroomSnapshot);
    if (observation === undefined) return;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    let transportExpiry = Infinity;
    if (observation.receivedAt !== undefined) {
      const receivedAt = observation.receivedAt;
      if (receivedAt === null || !Number.isFinite(receivedAt) || receivedAt > now) return;
      transportExpiry = receivedAt + observation.freshnessMs;
      if (!Number.isFinite(transportExpiry) || transportExpiry <= now) return;
    }
    const rows = readHeadroom({ ...observation, now });
    if (
      rows.length === 0 ||
      rows.some((row) => row.admit || !Number.isFinite(timestamp(row.reset_at)))
    )
      return;
    let nextChange = transportExpiry;
    for (const row of rows) {
      nextChange = Math.min(
        nextChange,
        timestamp(row.reset_at),
        timestamp(row.observed_at) + observation.freshnessMs,
      );
    }
    if (!Number.isFinite(nextChange) || nextChange <= now) return;
    if (!announcedWait) {
      yield* options.publishWaiting;
      announcedWait = true;
    }
    // Publishing can take time. It must not move the observer's absolute deadline.
    const afterPublish = DateTime.toEpochMillis(yield* DateTime.now);
    if (nextChange <= afterPublish) continue;
    const expires = Effect.sleep(`${nextChange - afterPublish} millis`);
    yield* refreshCompleted ? Effect.raceFirst(expires, refreshCompleted) : expires;
  }
});
