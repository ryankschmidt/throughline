import * as React from "react";
import { createRoot } from "react-dom/client";
import { DesktopVoiceControl } from "./DesktopVoiceControl";
import { useDesktopVoiceInput } from "./useDesktopVoiceInput";

/** Owned native fixture, never a production route. Uses the actual mounted
 * control/hook, native bridge and public phone controller; draft ports are
 * fixture-owned, so this is not full ChatComposer/native install acceptance. */
function Qualification() {
  const [text, setText] = React.useState("");
  const draft = React.useRef({ text: "", revision: 0 });
  const selection = React.useRef({ start: 0, end: 0 });
  const voice = useDesktopVoiceInput({
    ownerKey: "owned-controlled-voice-fixture",
    disabled: false,
    readDraft: () => ({
      ownerKey: "owned-controlled-voice-fixture",
      ...draft.current,
      selection: selection.current,
    }),
    commitDraft: (text, nextSelection) => {
      draft.current = { text, revision: draft.current.revision + 1 };
      selection.current = nextSelection;
      setText(text);
    },
  });
  const observed = {
    available: voice.available,
    phase: voice.state.phase,
    error: voice.state.error,
    text,
    raw: voice.rawTranscript,
    outcome: voice.outcome,
  };
  return (
    <main>
      <h1>Controlled desktop speech qualification</h1>
      <p>
        Known macOS say file. Real Mac microphone disabled. Actual local engine and optimizer.
        Fixture draft, not full product or installed acceptance.
      </p>
      <textarea
        aria-label="Owned controlled draft"
        value={text}
        disabled={voice.freezesEditor}
        onChange={(event) => {
          const next = event.target.value;
          draft.current = { text: next, revision: draft.current.revision + 1 };
          setText(next);
        }}
      />
      <div>
        <DesktopVoiceControl voice={voice} disabled={false} />
        <button disabled={voice.blocksSubmission}>Send (not invoked)</button>
      </div>
      <pre
        id="observed"
        data-phase={voice.state.phase}
        data-available={voice.available ? "true" : "false"}
      >
        {JSON.stringify(observed, null, 2)}
      </pre>
    </main>
  );
}
const root = document.getElementById("voice-root");
if (!root) throw new Error("Owned fixture root missing");
createRoot(root).render(<Qualification />);
