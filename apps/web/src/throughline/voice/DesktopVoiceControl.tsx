import { MicIcon, XIcon } from "lucide-react";
import { Button } from "../../components/ui/button";
import type { useDesktopVoiceInput } from "./useDesktopVoiceInput";

/** Phone microphone parity, immediately before Send. Never the running-turn
 * circle, browser SpeechRecognition, or a Linux engine substitute. */
export function DesktopVoiceControl({
  voice,
  disabled,
}: {
  voice: ReturnType<typeof useDesktopVoiceInput>;
  disabled: boolean;
}) {
  if (!voice.available) return null;
  const recording = voice.state.phase === "recording";
  const preparing = voice.state.phase === "preparing";
  const transcribing = voice.state.phase === "transcribing";
  return (
    <>
      {voice.state.error ? <span role="status">{voice.state.error}</span> : null}
      {preparing || recording || transcribing ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Cancel dictation"
          onPointerDown={(event) => event.preventDefault()}
          onClick={voice.cancel}
        >
          <XIcon className="size-4" />
        </Button>
      ) : null}
      {voice.canUndo ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label="Undo voice optimization"
          disabled={voice.blocksSubmission}
          onClick={voice.undo}
        >
          Undo
        </Button>
      ) : null}
      {voice.rawTranscript ? (
        <details>
          <summary>Original</summary>
          <pre className="whitespace-pre-wrap">{voice.rawTranscript}</pre>
        </details>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={
          recording
            ? "Finish dictation"
            : preparing
              ? "Preparing voice input"
              : transcribing
                ? "Transcribing voice input"
                : "Start dictation"
        }
        aria-pressed={recording}
        disabled={preparing || transcribing || (!recording && disabled)}
        onPointerDown={(event) => event.preventDefault()}
        onClick={recording ? voice.stop : voice.start}
      >
        <MicIcon className="size-4" />
      </Button>
    </>
  );
}
