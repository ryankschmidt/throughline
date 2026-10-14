// @effect-diagnostics nodeBuiltinImport:off -- Isolated Electron SDK qualification owns private fixture IO; never mounted in the product.
import { app, BrowserWindow, session } from "electron";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { registerSessionVoicePreload } from "./SessionVoicePreload.ts";

// Isolated foreground Electron qualification, never the installed ThroughLine
// app. All paths belong to its caller-owned fixture; no app/backend is loaded.
const fixtureArgument = process.argv[2];
if (!fixtureArgument || !NodePath.isAbsolute(fixtureArgument))
  throw new Error("Owned fixture required");
const fixture: string = fixtureArgument;
app.setName("ThroughLine Voice Preload Qualification");
app.setPath("userData", NodePath.join(fixture, "user-data"));

const windows = new Set<BrowserWindow>();
app.on("window-all-closed", () => {}); // Preserve only this fixture between its two frames.
async function frame(name: string) {
  const window = new BrowserWindow({
    width: 840,
    height: 620,
    show: true,
    title: "ThroughLine Voice Preload Qualification",
    webPreferences: {
      preload: NodePath.join(fixture!, "existing-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      webviewTag: true,
      disableHtmlFullscreenWindowResize: true,
    },
  });
  windows.add(window);
  await window.loadURL(
    "data:text/html," +
      encodeURIComponent(
        "<h1>Session preload qualification only</h1><p>Existing preload + fork voice namespace. No recording or product acceptance.</p><pre id=result></pre>",
      ),
  );
  const observed: unknown = await window.webContents.executeJavaScript(`(() => {
    const value = { existing: window.existingPreloadQualification ?? null, voice: window.throughlineVoiceQualification ?? null, nodeVisible: typeof require !== "undefined" };
    document.getElementById("result").textContent = JSON.stringify(value, null, 2);
    return value;
  })()`);
  // The bridge read above proves values, not painted pixels. Capture only
  // after the DOM mutation has crossed the renderer's paint boundary.
  await window.webContents.executeJavaScript(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  const png = await window.webContents.capturePage();
  await NodeFSP.writeFile(NodePath.join(fixture!, `${name}.png`), png.toPNG());
  window.close();
  windows.delete(window);
  return observed;
}

async function run() {
  let remove: (() => void) | undefined;
  try {
    await app.whenReady();
    const before = await frame("before");
    remove = registerSessionVoicePreload(
      session.defaultSession,
      NodePath.join(fixture, "voice-preload.cjs"),
    );
    const after = await frame("after");
    remove();
    remove = undefined;
    await NodeFSP.writeFile(
      NodePath.join(fixture, "result.json"),
      JSON.stringify(
        {
          before,
          after,
          electron: process.versions.electron,
          contextIsolation: true,
          sandbox: true,
          stockPreloadChanged: false,
          nativeOperations: 0,
        },
        null,
        2,
      ),
    );
  } finally {
    remove?.();
    for (const window of windows) window.close();
    app.quit(); // Only this explicitly launched, isolated qualification process.
  }
}
void run();
