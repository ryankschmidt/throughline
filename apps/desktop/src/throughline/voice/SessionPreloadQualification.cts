// Sandbox preload is CommonJS; erasableSyntaxOnly permits a public type
// annotation, not TypeScript's runtime import-assignment transform.
const Electron: typeof import("electron") = require("electron");

// Qualification marker only: no recorder, IPC operation, or speech permission.
Electron.contextBridge.exposeInMainWorld("throughlineVoiceQualification", {
  schema: "throughline.voice-session-preload-qualification.v1",
  nativeOperationsExposed: false,
});
