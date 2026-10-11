import type { OrchestrationV2DomainEvent, OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Transport from "../../mcp/ComsNetTransport.ts";
import { requestIdsForTurn } from "../../mcp/ComsNetCorrelation.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";

const isAlreadyTerminal = (error: Transport.ComsNetTransportError) =>
  error.code === "ALREADY_TERMINAL";

/** Existing marker/receiver-turn correlation, after the SQL commit, not inside apply. */
export const completeCommittedRun = (event: OrchestrationV2DomainEvent) =>
  Effect.gen(function* () {
    if (
      event.type !== "run.updated" ||
      !["completed", "failed", "interrupted", "cancelled"].includes(event.payload.status)
    )
      return;
    const run = event.payload;
    const threads = yield* Threads.ThreadManagementService;
    const transport = yield* Transport.ComsNetTransport;
    const projection = yield* threads.getThreadRecords(run.threadId, ["messages", "turnItems"], {
      runIds: [run.id],
    });
    const messages = projection.messages.filter((message) => message.runId === run.id);
    const markerIds = requestIdsForTurn(
      messages.map((message) => ({
        turnId: message.runId,
        role: message.role,
        text: message.text,
      })),
      run.id,
    );
    const bound = yield* transport.listFinishedTurnRequests(run.threadId, run.id);
    const ids = [...new Set([...markerIds, ...bound.map((request) => request.requestId)])];
    if (ids.length === 0) return;
    const terminal = <A>(effect: Effect.Effect<A, Transport.ComsNetTransportError>) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catch((error) => (isAlreadyTerminal(error) ? Effect.void : Effect.fail(error))),
      );
    if (ids.length > 1) {
      yield* Effect.forEach(
        ids,
        (id) =>
          terminal(
            transport.failFinishedTurn(
              run.threadId,
              id,
              `correlation ambiguous: turn ${run.id} carried ${ids.length} ComsNet markers`,
            ),
          ),
        { concurrency: 1, discard: true },
      );
      return;
    }
    const requestId = ids[0]!;
    if (run.status !== "completed") {
      yield* terminal(
        transport.failFinishedTurn(
          run.threadId,
          requestId,
          `Receiver turn ${run.id} ${run.status}.`,
        ),
      );
      return;
    }
    const assistant = messages.findLast(
      (message) =>
        message.role === "assistant" &&
        !message.streaming &&
        (message.nodeId === null || message.nodeId === run.rootNodeId),
    );
    if (assistant === undefined) {
      yield* terminal(
        transport.failFinishedTurn(
          run.threadId,
          requestId,
          `Completed receiver turn ${run.id} has no projected final assistant message.`,
        ),
      );
      return;
    }
    yield* terminal(
      transport.completeFinishedTurn(run.threadId, requestId, {
        text: assistant.text,
        assistantMessageId: assistant.id,
        turnId: run.id,
      }),
    );
  });

/** Shared stream consumer; callers supply the upstream committed stream, never apply's transaction. */
export const observeCommittedRuns = <E, R>(
  events: Stream.Stream<OrchestrationV2StoredEvent, E, R>,
) =>
  Stream.runForEach(events, (stored) =>
    completeCommittedRun(stored.event).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("ComsNet committed-run correlation failed", cause),
      ),
    ),
  );

/** Replay committed terminal events too, so restart is not a lost callback. */
export const startComsNetCompletionObserver = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* observeCommittedRuns(
    orchestrator.streamStoredEventsFrom({ afterSequence: 0, eventType: "run.updated" }),
  ).pipe(Effect.forkScoped);
});
