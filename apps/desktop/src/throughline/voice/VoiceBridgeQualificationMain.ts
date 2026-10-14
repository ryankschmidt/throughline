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
Electron.app.setName("ThroughLine Voice Bridge Qualification");
Electron.app.setPath("userData", NodePath.join(fixture, "user-data"));
Electron.protocol.registerSchemesAsPrivileged([
  { scheme: "t3code", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
Electron.app.on("window-all-closed", () => {});
const ownedWindows = new Set<Electron.BrowserWindow>();
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const program = Effect.gen(function* () {
  yield* Effect.promise(() => Electron.app.whenReady());
  const dirname = NodePath.join(fixture, "app/apps/desktop/dist-electron");
  const assetsDirectory = NodePath.join(fixture, "html");
  yield* Effect.promise(async () => {
    await NodeFSP.mkdir(assetsDirectory, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(assetsDirectory, "index.html"),
      '<h1>Actual local voice bridge qualification</h1><p>No recording, assets preparation or product acceptance.</p><pre id="result"></pre><iframe src="/iframe.html"></iframe>',
    );
    await NodeFSP.writeFile(
      NodePath.join(assetsDirectory, "iframe.html"),
      "<p>Owned same-origin child frame</p>",
    );
    await NodeFSP.writeFile(
      NodePath.join(fixture, "existing-preload.cjs"),
      'require("electron").contextBridge.exposeInMainWorld("existingVoiceFixtureMarker",{owned:true});',
    );
  });
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

  const frame = (name: string, external = false) =>
    Effect.gen(function* () {
      const window = yield* windows.create({
        width: 900,
        height: 700,
        show: true,
        title: "ThroughLine Voice Bridge Qualification",
        webPreferences: {
          preload: NodePath.join(fixture, "existing-preload.cjs"),
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
        },
      });
      ownedWindows.add(window);
      if (!external) yield* windows.setMain(window);
      yield* Effect.promise(() =>
        window.loadURL(
          external
            ? 'data:text/html,<h1>Untrusted external-frame control</h1><pre id="result"></pre>'
            : "t3code://app/",
        ),
      );
      const observed: unknown = yield* Effect.promise(() =>
        window.webContents.executeJavaScript(`(async () => {
      const bridge = window.throughlineVoice;
      const data = {
        existing: window.existingVoiceFixtureMarker?.owned === true,
        bridge: typeof bridge === "object",
        capabilities: bridge ? await bridge.capabilities() : null,
        refusedStart: bridge ? await bridge.start(${encodeJson(external ? "01234567-89ab-4def-8abc-0123456789ab" : "invalid")}) : null,
        iframeBridge: typeof document.querySelector("iframe")?.contentWindow?.throughlineVoice === "object",
        nodeVisible: typeof require !== "undefined"
      };
      document.getElementById("result").textContent = JSON.stringify(data, null, 2);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return data;
    })()`),
      );
      yield* Effect.promise(async () => {
        const png = await window.webContents.capturePage();
        await NodeFSP.writeFile(NodePath.join(fixture, `${name}.png`), png.toPNG());
      });
      return observed;
    });
  const before = yield* frame("before");
  // Supply the SAME real base service objects, especially ElectronWindow's
  // main-window reference. No duplicate graph client or fake admission/store.
  yield* Layer.build(DesktopVoice.layer).pipe(Effect.provideContext(services));
  const after = yield* frame("after");
  const external = yield* frame("external", true);
  yield* Effect.promise(() =>
    NodeFSP.writeFile(
      NodePath.join(fixture, "result.json"),
      encodeJson({
        before,
        after,
        external,
        nativeCaptureInvoked: false,
        existingServicesShared: true,
        fullProductMainGraph: false,
        acceptance: "component IPC qualification only",
      }),
    ),
  );
});

NodeRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.ensuring(
      Effect.sync(() => {
        for (const window of ownedWindows) if (!window.isDestroyed()) window.close();
        Electron.app.quit(); // Only this explicitly launched fixture child.
      }),
    ),
  ),
);
