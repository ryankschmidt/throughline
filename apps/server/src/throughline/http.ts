import * as Layer from "effect/Layer";
import { operatorProfileRouteLayer } from "./operatorProfile/http.ts";
import { rewindRouteLayer, recoveryLayer } from "./rewind/http.ts";
import { layer as exactMessageRewindLayer } from "./rewind/ExactMessageRewindRuntime.ts";
import { observationRouteLayer } from "./observation/http.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProjectionObservation from "./observation/ProjectionObservation.ts";
import { headroomRouteLayer } from "./headroom/http.ts";

// Reuse upstream's public stores and command-lock layer, not another orchestrator.
const rewindDependencies = Layer.mergeAll(
  RuntimeLayer.layerEventSink,
  EventStore.layerFromOrchestrationEventStore.pipe(
    Layer.provide(RuntimeLayer.layerEventInfrastructure),
  ),
  ProjectionObservation.layer.pipe(Layer.provide(ProjectionStore.layer)),
  RuntimePolicy.layerFromProjectStore.pipe(Layer.provide(ProjectStore.layer)),
  ThreadCommandExecutor.layer,
  IdAllocator.layer,
);
const rewindRuntime = exactMessageRewindLayer.pipe(Layer.provide(rewindDependencies));

/** One existing stock mount hosts fork-owned routes; stock orchestration stays upstream. */
export const throughlineRouteLayer = Layer.mergeAll(
  operatorProfileRouteLayer,
  rewindRouteLayer,
  observationRouteLayer,
  headroomRouteLayer,
  recoveryLayer,
).pipe(Layer.provideMerge(rewindRuntime));
