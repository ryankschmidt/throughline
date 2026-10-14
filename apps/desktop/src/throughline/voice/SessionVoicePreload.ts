import type { Session } from "electron";

type SessionPreloads = Pick<Session, "registerPreloadScript" | "unregisterPreloadScript">;

/** The main process supplies an owned compiled path; renderers never choose it. */
export function registerSessionVoicePreload(
  session: SessionPreloads,
  filePath: string,
): () => void {
  if (!filePath.startsWith("/")) throw new Error("Voice preload requires an absolute owned path");
  const id = session.registerPreloadScript({ type: "frame", filePath });
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    session.unregisterPreloadScript(id);
  };
}
