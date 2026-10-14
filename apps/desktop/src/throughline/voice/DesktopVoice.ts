import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Electron from "electron";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopAssets from "../../app/DesktopAssets.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as ElectronProtocol from "../../electron/ElectronProtocol.ts";
import * as DesktopIpc from "../../ipc/DesktopIpc.ts";
import { registerSessionVoicePreload } from "./SessionVoicePreload.ts";
import { startNativeVoiceSession, type ControlledVoiceFile } from "./NativeVoiceSession.ts";
import { probeNativeVoice } from "./NativeVoiceProbe.ts";
import { VoiceSessionController } from "./VoiceSessionController.ts";
import {
  VOICE_IPC_CHANNEL,
  VOICE_NATIVE_RESOURCE,
  VOICE_PRELOAD_RESOURCE,
  VoiceReply,
  readVoiceRequest,
  trustedVoiceSender,
} from "./VoiceBridgeContract.ts";

/** Fixture-built context only; no settings, environment or renderer input. */
export const ControlledVoiceInput = Context.Reference<ControlledVoiceFile | undefined>(
  "throughline/voice/ControlledVoiceInput",
  { defaultValue: () => undefined },
);

/** Owns the Mac native capability + private renderer bridge. Does not own
 * the app window, provider defaults, draft commits, optimizer or installation.
 */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (environment.platform !== "darwin") return;
  const assets = yield* DesktopAssets.DesktopAssets;
  const app = yield* ElectronApp.ElectronApp;
  const windows = yield* ElectronWindow.ElectronWindow;
  const ipc = yield* DesktopIpc.DesktopIpc;
  const executable = yield* assets.resolveResourcePath(VOICE_NATIVE_RESOURCE);
  const preload = yield* assets.resolveResourcePath(VOICE_PRELOAD_RESOURCE);
  // No provider/default fallback and no unbuilt-development executable path.
  if (Option.isNone(executable) || Option.isNone(preload)) return;
  yield* app.whenReady;
  const available = yield* Effect.promise(() => probeNativeVoice(executable.value));
  const controlledInput = yield* ControlledVoiceInput;
  const controller = new VoiceSessionController(available, () =>
    startNativeVoiceSession(executable.value, controlledInput),
  );
  const watched = new Map<number, () => void>();
  let cleanupFailures = 0;
  const watch = (contents: Electron.WebContents) => {
    if (watched.has(contents.id)) return;
    const owner = contents.id;
    const cancel = () => {
      void controller.closeOwner(owner).catch(() => {
        cleanupFailures++;
      });
    };
    const navigate = (
      details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (details.isMainFrame && !details.isSameDocument) cancel();
    };
    contents.on("destroyed", cancel);
    contents.on("render-process-gone", cancel);
    contents.on("did-start-navigation", navigate);
    watched.set(owner, () => {
      contents.removeListener("destroyed", cancel);
      contents.removeListener("render-process-gone", cancel);
      contents.removeListener("did-start-navigation", navigate);
    });
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => registerSessionVoicePreload(Electron.session.defaultSession, preload.value)),
    (remove) => Effect.sync(remove),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => controller.closeOwner()).pipe(
      Effect.catchCause(() => Effect.logWarning("Desktop voice owned-child cleanup failed")),
    ),
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const remove of watched.values()) remove();
      watched.clear();
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: VOICE_IPC_CHANNEL,
      // Validate in our safe decoder so malformed fields never become a thrown
      // SchemaError carrying user input into logs or an IPC error string.
      payload: Schema.Unknown,
      result: VoiceReply,
      handler: (raw, event) =>
        Effect.gen(function* () {
          const request = readVoiceRequest(raw);
          if (!request) return { kind: "error", code: "invalid-request" };
          const main = yield* windows.main;
          if (Option.isNone(main) || main.value.isDestroyed())
            return { kind: "error", code: "forbidden" };
          const owner = trustedVoiceSender(
            event,
            main.value.webContents.id,
            ElectronProtocol.getDesktopUrl(environment.isDevelopment),
          );
          if (owner === null) return { kind: "error", code: "forbidden" };
          watch(main.value.webContents);
          if (cleanupFailures > 0) return { kind: "error", code: "cleanup-failed" };
          return yield* Effect.promise(() => controller.invoke(owner, request));
        }),
    }),
  );
});

export const layer = Layer.effectDiscard(make);
