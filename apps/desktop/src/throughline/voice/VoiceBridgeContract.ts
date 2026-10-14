import * as Schema from "effect/Schema";

export const VOICE_IPC_CHANNEL = "throughline:local-voice";
export const VOICE_PRELOAD_RESOURCE = "throughline-voice-preload.cjs";
export const VOICE_NATIVE_RESOURCE = "throughline-apple-speech";

export const VoiceRequest = Schema.Union([
  Schema.Struct({ op: Schema.Literal("capabilities") }),
  Schema.Struct({
    op: Schema.Literals(["start", "record", "stop", "cancel"]),
    requestId: Schema.String,
  }),
]);
export type VoiceRequest = typeof VoiceRequest.Type;
export const VoiceReply = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("capabilities"), available: Schema.Boolean }),
  Schema.Struct({
    kind: Schema.Literal("prepared"),
    requestId: Schema.String,
    locale: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literals(["started", "cancelled"]), requestId: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("transcribed"),
    requestId: Schema.String,
    text: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("error"),
    code: Schema.Literals([
      "invalid-request",
      "forbidden",
      "busy",
      "stale-request",
      "unavailable",
      "unsupported",
      "permission-denied",
      "preparation-failed",
      "recording-failed",
      "transcription-failed",
      "cancelled",
      "protocol-refused",
      "helper-failed",
      "cleanup-failed",
    ]),
  }),
]);
export type VoiceReply = typeof VoiceReply.Type;

/** Browser-visible contract only; no paths, raw IPC, audio or native handles. */
export interface DesktopVoiceBridge {
  capabilities(): Promise<VoiceReply>;
  start(requestId: string): Promise<VoiceReply>;
  record(requestId: string): Promise<VoiceReply>;
  stop(requestId: string): Promise<VoiceReply>;
  cancel(requestId: string): Promise<VoiceReply>;
}

const decodeRequest = Schema.decodeUnknownSync(VoiceRequest);
export function readVoiceRequest(raw: unknown): VoiceRequest | null {
  try {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const request = decodeRequest(raw);
    const keys = request.op === "capabilities" ? ["op"] : ["op", "requestId"];
    if (
      Object.keys(raw).length !== keys.length ||
      Object.keys(raw).some((key) => !keys.includes(key))
    )
      return null;
    if (
      request.op !== "capabilities" &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.requestId)
    )
      return null;
    return request;
  } catch {
    return null;
  }
}

/** Electron supplies the event, never the renderer. Read its extra public
 * senderFrame fields structurally without casting/changing DesktopIpc's seam.
 */
export function trustedVoiceSender(
  event: unknown,
  mainId: number,
  expectedUrl: string,
): number | null {
  try {
    if (typeof event !== "object" || event === null) return null;
    const sender: unknown = Reflect.get(event, "sender");
    if (typeof sender !== "object" || sender === null) return null;
    const id: unknown = Reflect.get(sender, "id");
    if (id !== mainId || !Number.isInteger(mainId) || mainId <= 0) return null;
    const frame: unknown = Reflect.get(event, "senderFrame");
    if (typeof frame !== "object" || frame === null || Reflect.get(frame, "parent") !== null)
      return null;
    const value: unknown = Reflect.get(frame, "url");
    if (typeof value !== "string") return null;
    const actual = new URL(value),
      expected = new URL(expectedUrl);
    if (!["t3code:", "t3code-dev:"].includes(expected.protocol)) return null;
    return actual.protocol === expected.protocol &&
      actual.hostname === expected.hostname &&
      actual.port === expected.port &&
      actual.username === "" &&
      actual.password === ""
      ? mainId
      : null;
  } catch {
    return null;
  }
}
