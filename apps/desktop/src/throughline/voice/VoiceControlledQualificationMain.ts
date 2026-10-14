// @effect-diagnostics nodeBuiltinImport:off -- Isolated native Electron qualification owns fixture IO, never product state.
import * as Electron from "electron";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopAssets from "../../app/DesktopAssets.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as ElectronProtocol from "../../electron/ElectronProtocol.ts";
import * as DesktopIpc from "../../ipc/DesktopIpc.ts";
import * as DesktopVoice from "./DesktopVoice.ts";

const input = process.argv[2];
if (!input || !NodePath.isAbsolute(input)) throw new Error("Owned absolute fixture required");
const fixture: string = input;
Electron.app.setName("ThroughLine Controlled Speech Qualification");
Electron.app.setPath("userData", NodePath.join(fixture, "user-data"));
Electron.protocol.registerSchemesAsPrivileged([
  { scheme: "t3code", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
Electron.app.on("window-all-closed", () => {});
const ownedWindows = new Set<Electron.BrowserWindow>();
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
class ControlledVoiceQualificationFailure extends Schema.TaggedError<ControlledVoiceQualificationFailure>()(
  "ControlledVoiceQualificationFailure",
  {},
) {}

const program = Effect.gen(function* () {
  yield* Effect.promise(() => Electron.app.whenReady());
  const dirname = NodePath.join(fixture, "app/apps/desktop/dist-electron");
  const assetsDirectory = NodePath.join(fixture, "html");
  const environment = DesktopEnvironment.layer({
    dirname,
    homeDirectory: NodePath.join(fixture, "home"),
    platform: "darwin",
    processArch: "arm64",
    appVersion: "0.0.61",
    appPath: NodePath.join(fixture, "app"),
    isPackaged: false,
    resourcesPath: NodePath.join(fixture, "app/Contents/Resources"),
    runningUnderArm64Translation: false,
  });
  const base = Layer.mergeAll(
    DesktopAssets.layer,
    ElectronApp.layer,
    ElectronWindow.layer,
    ElectronProtocol.layer,
    DesktopIpc.layer(Electron.ipcMain),
  ).pipe(
    Layer.provideMerge(environment),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(DesktopConfig.layerTest({ T3CODE_HOME: NodePath.join(fixture, "home") })),
  );
  const services = yield* Layer.build(base);
  const windows = Context.get(services, ElectronWindow.ElectronWindow);
  const protocol = Context.get(services, ElectronProtocol.ElectronProtocol);
  yield* protocol.registerDesktopProtocol({
    scheme: "t3code",
    assetDirectory: assetsDirectory,
    clerkFrontendApiHostname: undefined,
  });

  const inputDirectory = NodePath.join(fixture, "throughline-voice-input-known");
  const hash = (yield* Effect.promise(() =>
    NodeFSP.readFile(NodePath.join(inputDirectory, "sha256.txt"), "utf8"),
  )).trim();
  yield* Layer.build(
    DesktopVoice.layer.pipe(
      Layer.provide(
        Layer.succeed(DesktopVoice.ControlledVoiceInput, {
          directory: inputDirectory,
          sha256: hash,
        }),
      ),
    ),
  ).pipe(Effect.provideContext(services));
  const window = yield* windows.create({
    width: 1000,
    height: 760,
    show: true,
    title: "ThroughLine Controlled Speech Qualification",
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
  });
  ownedWindows.add(window);
  yield* windows.setMain(window);
  yield* Effect.promise(() => window.loadURL("t3code://app/"));
  const snapshot = (name: string) =>
    Effect.promise(async () => {
      const png = await window.webContents.capturePage();
      await NodeFSP.writeFile(NodePath.join(fixture, name + ".png"), png.toPNG());
    });
  const wait = (condition: string) =>
    Effect.promise(() =>
      window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    let timer;
    const read = () => {
      const node = document.getElementById("observed");
      if (!node) return false;
      const result = JSON.parse(node.textContent);
      if (result.phase === "error") { cleanup(); reject(new Error("Controlled native voice failed")); return true; }
      if (${condition}) { cleanup(); resolve(result); return true; }
      return false;
    };
    const observer = new MutationObserver(read);
    const cleanup = () => { observer.disconnect(); clearTimeout(timer); };
    observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
    timer = setTimeout(() => { cleanup(); reject(new Error("Controlled native voice deadline")); }, 120000);
    read();
  })`),
    );
  let failed = false;
  const outcome = yield* Effect.gen(function* () {
    yield* wait("result.available === true");
    yield* snapshot("before");
    yield* Effect.promise(() =>
      window.webContents.executeJavaScript(
        `document.querySelector('[aria-label="Start dictation"]').click()`,
      ),
    );
    yield* wait('result.phase === "recording"');
    yield* snapshot("recording");
    yield* Effect.promise(() =>
      window.webContents.executeJavaScript(
        `document.querySelector('[aria-label="Finish dictation"]').click()`,
      ),
    );
    const result = yield* wait('result.phase === "idle" && result.raw !== null');
    yield* snapshot("after");
    return result;
  }).pipe(
    Effect.catchCause(() =>
      Effect.gen(function* () {
        failed = true;
        yield* snapshot("failure");
        return yield* Effect.promise(() =>
          window.webContents.executeJavaScript(
            'document.getElementById("observed")?.textContent ?? "fixture did not mount"',
          ),
        );
      }),
    ),
  );
  yield* Effect.promise(() =>
    NodeFSP.writeFile(
      NodePath.join(fixture, "result.json"),
      encodeJson({
        failed,
        outcome,
        realMicrophoneOpened: false,
        input: "controlled-macos-say-file",
        fullProductMainGraph: false,
        fullChatComposer: false,
        installedAcceptance: false,
      }),
    ),
  );
  if (failed) return yield* Effect.fail(new ControlledVoiceQualificationFailure());
});

NodeRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.ensuring(
      Effect.sync(() => {
        for (const window of ownedWindows) if (!window.isDestroyed()) window.close();
        Electron.app.quit(); // This explicitly launched owned qualification child only.
      }),
    ),
  ),
);
