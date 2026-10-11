import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import { clientHelloFromMetadata } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import { Connection } from "@t3tools/client-runtime/connection";
import { ShellSnapshotLoader } from "@t3tools/client-runtime/state/shell";
import {
  BoundedThreadSnapshotLoader,
  ThreadHistoryController,
} from "@t3tools/client-runtime/state/threads";
import { PullRequestDiffLoader } from "@t3tools/client-runtime/state/pull-requests";
import * as Layer from "effect/Layer";
import { Atom } from "effect/reactivity";

import * as Runtime from "../lib/runtime";
import * as BackgroundActivityReporter from "../lib/backgroundActivityReporter";
import * as ConnectionPlatform from "./platform";

const layerProvidedConnectionPlatform = ConnectionPlatform.layer.pipe(Layer.provide(Runtime.layer));

const layerSnapshotLoader = Layer.mergeAll(
  BoundedThreadSnapshotLoader.layer,
  ShellSnapshotLoader.layer,
  ThreadHistoryController.layer,
  PullRequestDiffLoader.layer,
);

// ThroughLine: retain optional hello negotiation on the upstream connection layer.
const negotiatedConnectionLayer = Layer.unwrap(
  Effect.gen(function* () {
    const { metadata } = yield* ClientCapabilities.ClientPresentation;
    const hello = clientHelloFromMetadata(
      {
        // Unlike branding.APP_VERSION, this is the injected value without a fallback.
        release: import.meta.env.APP_VERSION,
        platform: metadata.os ?? metadata.surface,
        commit: null,
      },
      ["environmentThemes", "usageLimitSources", "usageLimitsCommand"],
    );
    if (hello === undefined)
      yield* Effect.logWarning(
        "Optional hello omitted: app release/platform metadata is unavailable.",
      );
    return Connection.layerWithOptions({
      environmentThemes: true,
      usageLimitSources: true,
      usageLimitsCommand: true,
      ...(hello === undefined ? {} : { hello }),
    });
  }),
);

type ConnectionLayerSource =
  | typeof Connection.layer
  | typeof layerSnapshotLoader
  | typeof Runtime.layer
  | typeof ConnectionPlatform.layer
  | typeof BackgroundActivityReporter.layerObserver
  | typeof BackgroundActivityReporter.layer;

const layerProvidedClientConnection = layerSnapshotLoader.pipe(
  Layer.provideMerge(negotiatedConnectionLayer),
  Layer.provideMerge(
    Layer.mergeAll(
      Runtime.layer,
      layerProvidedConnectionPlatform,
      BackgroundActivityReporter.layerObserver,
    ),
  ),
);

const layerConnection = BackgroundActivityReporter.layer.pipe(
  Layer.provideMerge(layerProvidedClientConnection),
);

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = Atom.runtime(layerConnection);
