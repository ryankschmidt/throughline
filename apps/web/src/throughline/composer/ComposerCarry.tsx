import type { resolveThreadAnsweringModel } from "../../modelSelection";
import { resolveCarriedComposerMenu } from "./carriedComposerPolicy";

export function ChatComposerAnsweringModelNotice({
  observation,
}: {
  observation: ReturnType<typeof resolveThreadAnsweringModel>;
}) {
  return (
    <span className="text-xs text-muted-foreground" data-chat-answering-model="true">
      Answered: {observation.answeringModel ?? "unknown"}
      {observation.verdict === "mismatch" ? (
        <>
          {" "}
          · Substitution: {observation.requestedModel} → {observation.answeringModel}
        </>
      ) : null}
    </span>
  );
}

export function resolveChatComposerLocalMenu(
  input: Parameters<typeof resolveCarriedComposerMenu>[0] & {
    routeKind: string;
    hasPendingProgress: boolean;
  },
): "rewind" | "config" | null {
  return input.routeKind === "server" && !input.hasPendingProgress
    ? resolveCarriedComposerMenu(input)
    : null;
}
