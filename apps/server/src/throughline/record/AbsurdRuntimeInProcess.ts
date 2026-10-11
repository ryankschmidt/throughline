// Native Node APIs bridge the existing task transport and its file/stream contracts.
// @effect-diagnostics nodeBuiltinImport:off
import {
  AbsurdRuntime,
  startAbsurdRuntime,
  type ThreadTransport,
  type StepIdentity,
} from "@t3tools/absurd-runtime";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  RunId,
  ProviderInstanceId,
  ChatAttachment,
  ModelSelection,
  OrchestrationMessageContext,
  OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { createHash } from "node:crypto";
import { nativeKinds } from "../identity/identity-alias.ts";
import { CurrentAuthenticatedSender, CurrentSenderClaims } from "../identity/sender-stamp.ts";
import {
  DurableIntake,
  V2_INTAKE_TASK,
  runNativeIntake,
  runNativeIntakeTaskOutcome,
  CurrentSenderContextUnavailable,
  type IntakeCall,
  type IntakeRequirements,
  type ThreadRunSenderContext,
} from "../admission/IntakeAdmission.ts";
import { AbsurdConnection } from "./AbsurdConnection.ts";

const QUEUE_NAME = "t3-interactive-turns";
export const stableStepId = (step: StepIdentity, suffix: string) =>
  `throughline:${createHash("sha256")
    .update(JSON.stringify([step.taskId, step.step, suffix]))
    .digest("hex")}`;
const trustedCodec = Schema.Struct({
  sender: Schema.Struct({
    publicAgentId: Schema.NonEmptyString,
    generation: Schema.NonEmptyString,
    nativeKind: Schema.Literals(nativeKinds),
    nativeId: Schema.NonEmptyString,
  }),
  claims: Schema.Array(
    Schema.Struct({
      field: Schema.Literals(["publicAgentId", "generation"]),
      value: Schema.Unknown,
    }),
  ),
});
const preservedTurn = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
    context: Schema.optional(OrchestrationMessageContext),
  }),
  modelSelection: Schema.optional(ModelSelection),
  sourceProposedPlan: Schema.optional(Schema.Unknown),
});
/** Old queued commands keep their actual message ids, text and attachments during the cutover. */
export const decodePreservedTurn = (value: unknown) =>
  Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(preservedTurn)(value);
    return yield* Schema.decodeUnknownEffect(OrchestrationV2Command)({
      type: "message.dispatch",
      commandId: command.commandId,
      threadId: command.threadId,
      messageId: command.message.messageId,
      text: command.message.text,
      attachments: command.message.attachments,
      ...(command.message.context ? { context: command.message.context } : {}),
      ...(command.modelSelection ? { modelSelection: command.modelSelection } : {}),
      ...(command.sourceProposedPlan ? { sourcePlanRef: command.sourceProposedPlan } : {}),
      createdBy: "user",
      creationSource: "server",
      dispatchMode: { type: "start_immediately" },
    });
  });

export const restoreSender = (trusted: ThreadRunSenderContext | undefined) =>
  Effect.gen(function* () {
    if (trusted === undefined)
      return { _tag: "SenderContextUnavailable" as const, sender: undefined, claims: [] };
    return yield* Schema.decodeUnknownEffect(trustedCodec)(trusted).pipe(
      Effect.match({
        onFailure: () => ({
          _tag: "SenderContextUnavailable" as const,
          sender: undefined,
          claims: [],
        }),
        onSuccess: (decoded) => ({ _tag: "available" as const, ...decoded }),
      }),
    );
  });

/** Owns no orchestrator: every task enters the same published V2 intake as the clients. */
export const AbsurdRuntimeInProcessLive = Layer.effectContext(
  Effect.gen(function* () {
    const db = yield* AbsurdConnection;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const context = yield* Effect.context<IntakeRequirements | SqlClient.SqlClient>();
    const runPromise = Effect.runPromiseWith(context);
    const models = new Map<string, string>();
    const stepRequired = (step?: StepIdentity) => {
      if (!step)
        throw new Error("Durable task/step identity is required for a synthesized V2 command.");
      return step;
    };
    const transport: ThreadTransport = {
      async resolveThread(params, step?: StepIdentity) {
        if (params.model && params.threadId) models.set(params.threadId, params.model);
        if (params.threadId) return { threadId: params.threadId, created: false };
        const identity = stepRequired(step);
        if (!params.model)
          throw new Error("An explicit model is required for a durable thread launch.");
        const threadId = ThreadId.make(stableStepId(identity, "thread"));
        const projectId = process.env.T3_SYMPHONY_PROJECT_ID;
        if (!projectId)
          throw new Error("A configured project is required for a durable campaign launch.");
        const result = await runPromise(
          launches.launch({
            commandId: CommandId.make(stableStepId(identity, "command")),
            threadId,
            projectId: ProjectId.make(projectId),
            title: "Durable thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make(process.env.T3_SYMPHONY_INSTANCE_ID ?? "codex"),
              model: params.model,
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            createdBy: "system",
            creationSource: "server",
          }),
        );
        models.set(result.threadId, params.model);
        return { threadId: result.threadId, created: true };
      },
      async dispatchTurn(threadId, prompt, turnCommand, trusted, step?: StepIdentity) {
        const identity = stepRequired(step);
        const sender = await runPromise(restoreSender(trusted));
        const result = await runPromise(
          Effect.gen(function* () {
            const shell = yield* threads.getThreadShell(ThreadId.make(threadId));
            if (shell === null) throw new Error("Durable receiver thread is absent.");
            const call = turnCommand as IntakeCall | undefined;
            if (call?.kind === "dispatch" || call?.kind === "launch" || call?.kind === "send") {
              const encoded = yield* runNativeIntake(call);
              return encoded;
            }
            if (turnCommand !== undefined) {
              const command = yield* decodePreservedTurn(turnCommand);
              return yield* runNativeIntake({ kind: "dispatch", input: command });
            }
            // Campaign transport, not a lossy reconstruction of a client command.
            return yield* runNativeIntake({
              kind: "send",
              input: {
                commandId: CommandId.make(stableStepId(identity, "command")),
                projectId: shell.projectId,
                threadId: ThreadId.make(threadId),
                messageId: MessageId.make(stableStepId(identity, "message")),
                text: prompt,
                attachments: [],
                mode: "auto",
                createdBy: "system",
                creationSource: "server",
                ...(models.has(threadId)
                  ? {
                      modelSelection: {
                        instanceId: ProviderInstanceId.make(
                          process.env.T3_SYMPHONY_INSTANCE_ID ?? "codex",
                        ),
                        model: models.get(threadId)!,
                      },
                    }
                  : {}),
              },
            });
          }).pipe(
            Effect.provideService(CurrentAuthenticatedSender, sender?.sender),
            Effect.provideService(CurrentSenderClaims, sender?.claims ?? []),
            Effect.provideService(
              CurrentSenderContextUnavailable,
              sender._tag === "SenderContextUnavailable",
            ),
            // A legacy campaign's current task is cancelled on typed admission
            // refusal. It has no failure-data slot and must not retry five times.
            Effect.catchTags({
              IntakeRejected: (failure) =>
                Effect.promise(() => runtime.app.cancelTask(identity.taskId, QUEUE_NAME)).pipe(
                  Effect.andThen(Effect.fail(failure)),
                ),
            }),
          ),
        );
        const record =
          typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
        const run =
          typeof record.run === "object" && record.run !== null
            ? (record.run as { id?: string })
            : undefined;
        const stored = Array.isArray(record.storedEvents)
          ? (record.storedEvents as Array<{ event?: { type?: string; payload?: { id?: string } } }>)
          : [];
        const runId =
          run?.id ?? stored.find((row) => row.event?.type === "run.created")?.event?.payload?.id;
        if (!runId) throw new Error("V2 intake did not return an actual provider run id.");
        return {
          turnId: runId,
          dispatchedAt: await runPromise(DateTime.now.pipe(Effect.map(DateTime.formatIso))),
        };
      },
      async awaitTurnComplete(threadId, turnId, holdMs) {
        await runPromise(
          Effect.gen(function* () {
            const shell = yield* threads.getThreadShell(ThreadId.make(threadId));
            if (shell === null) throw new Error("Durable receiver thread is absent.");
            const result = yield* threads.waitForThread({
              projectId: shell.projectId,
              threadId: ThreadId.make(threadId),
              runId: RunId.make(turnId),
              timeoutMs: holdMs,
            });
            if (result.timedOut || result.run?.status !== "completed")
              throw new Error("Durable provider run is not completed.");
          }),
        );
        return { state: "completed", summary: "Provider run completed." };
      },
    };
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() =>
        startAbsurdRuntime({
          queueName: QUEUE_NAME,
          transport,
          concurrency: 16,
          ...(db === undefined ? {} : { db }),
        }),
      ),
      (handle) => Effect.promise(() => handle.close()),
    );
    runtime.app.registerTask<{ call: IntakeCall; trustedSenderContext?: ThreadRunSenderContext }>(
      { name: V2_INTAKE_TASK, defaultMaxAttempts: 5 },
      async (params, ctx) =>
        ctx.step("dispatch-turn", async () => {
          const sender = await runPromise(restoreSender(params.trustedSenderContext));
          return await runPromise(
            runNativeIntakeTaskOutcome(params.call).pipe(
              Effect.provideService(CurrentAuthenticatedSender, sender?.sender),
              Effect.provideService(CurrentSenderClaims, sender?.claims ?? []),
              Effect.provideService(
                CurrentSenderContextUnavailable,
                sender._tag === "SenderContextUnavailable",
              ),
            ),
          );
        }),
    );
    return Context.make(AbsurdRuntime, runtime).pipe(Context.add(DurableIntake, { runtime }));
  }),
);
