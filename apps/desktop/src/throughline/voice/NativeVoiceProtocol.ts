import * as Schema from "effect/Schema";

const NativeVoiceEvent = Schema.Union([
  Schema.Struct({ event: Schema.Literal("ready"), locale: Schema.String }),
  Schema.Struct({ event: Schema.Literal("recording") }),
  Schema.Struct({ event: Schema.Literal("result"), text: Schema.String }),
  Schema.Struct({ event: Schema.Literal("cancelled") }),
  Schema.Struct({
    event: Schema.Literal("error"),
    code: Schema.Literals([
      "unsupported",
      "permission-denied",
      "preparation-failed",
      "recording-failed",
      "transcription-failed",
    ]),
  }),
]);
export type NativeVoiceEvent = typeof NativeVoiceEvent.Type;
export type NativeVoicePhase =
  | "preparing"
  | "prepared"
  | "starting"
  | "capturing"
  | "finishing"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed";
const decode = Schema.decodeUnknownSync(NativeVoiceEvent);

function decodePrivateLine(line: string): NativeVoiceEvent {
  try {
    if (line.length > 262_144) throw new Error();
    const value: unknown = JSON.parse(line);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const event: unknown = Reflect.get(value, "event");
    const keys =
      event === "ready"
        ? ["event", "locale"]
        : event === "result"
          ? ["event", "text"]
          : event === "error"
            ? ["event", "code"]
            : ["event"];
    if (
      Object.keys(value).length !== keys.length ||
      Object.keys(value).some((key) => !keys.includes(key))
    )
      throw new Error();
    return decode(value);
  } catch {
    // Schema/JSON diagnostic messages may include the input. Export no cause.
    throw new Error("Invalid private voice protocol message");
  }
}

/** Private child stdio only. Never include received bytes in an error/log. */
export class NativeVoiceProtocol {
  phase: NativeVoicePhase = "preparing";

  accept(line: string): NativeVoiceEvent {
    const event = decodePrivateLine(line);
    if (this.phase === "completed" || this.phase === "cancelled" || this.phase === "failed")
      throw new Error("Voice session already settled");
    switch (event.event) {
      case "ready":
        if (this.phase !== "preparing") throw new Error("Unexpected capture acknowledgement");
        if (!event.locale.trim()) throw new Error("Invalid native locale");
        this.phase = "prepared";
        break;
      case "recording":
        if (this.phase !== "starting") throw new Error("Unexpected recording acknowledgement");
        this.phase = "capturing";
        break;
      case "result":
        if (this.phase !== "finishing") throw new Error("Unexpected transcription result");
        this.phase = "completed";
        break;
      case "cancelled":
        if (this.phase !== "cancelling") throw new Error("Unexpected cancellation acknowledgement");
        this.phase = "cancelled";
        break;
      case "error":
        this.phase = "failed";
        break;
    }
    return event;
  }
  record(): void {
    if (this.phase !== "prepared") throw new Error("Voice session is not prepared");
    this.phase = "starting";
  }
  stop(): void {
    if (this.phase !== "capturing") throw new Error("Voice session is not capturing");
    this.phase = "finishing";
  }
  cancel(): void {
    if (this.phase === "completed" || this.phase === "cancelled" || this.phase === "failed") return;
    this.phase = "cancelling";
  }
}
