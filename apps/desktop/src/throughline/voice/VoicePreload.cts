import type { DesktopVoiceBridge, VoiceReply, VoiceRequest } from "./VoiceBridgeContract.ts";

const Electron: typeof import("electron") = require("electron");
// A registered session preload also sees other frames. Export no bridge to
// subframes; DesktopVoice's platform service registers this only on macOS.
// The main handler independently verifies frame + origin.
if (Electron.webFrame.parent === null) {
  const channel: typeof import("./VoiceBridgeContract.ts").VOICE_IPC_CHANNEL =
    "throughline:local-voice";
  const invoke = (request: VoiceRequest): Promise<VoiceReply> =>
    Electron.ipcRenderer.invoke(channel, request);
  const bridge: DesktopVoiceBridge = {
    capabilities: () => invoke({ op: "capabilities" }),
    start: (requestId) => invoke({ op: "start", requestId }),
    record: (requestId) => invoke({ op: "record", requestId }),
    stop: (requestId) => invoke({ op: "stop", requestId }),
    cancel: (requestId) => invoke({ op: "cancel", requestId }),
  };
  Electron.contextBridge.exposeInMainWorld("throughlineVoice", bridge);
}
