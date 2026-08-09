import type {
  DesktopSpeechModelId,
  DesktopSpeechPreviewRevision,
  DesktopSpeechSessionId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import type { SpeechInferenceWorker } from "./SpeechInferenceWorker.ts";
import type { SpeechMachineEvent } from "./speechMachine.ts";

export interface FeedCommand {
  readonly type: "feed";
  readonly samples: Float32Array<ArrayBuffer>;
  readonly bytes: number;
  readonly completed: Deferred.Deferred<void, DesktopSpeechSessionOperationError>;
}

export interface FinalizeCommand {
  readonly type: "finalize";
  readonly completed: Deferred.Deferred<string, DesktopSpeechSessionOperationError>;
}

export interface CancelCommand {
  readonly type: "cancel";
  readonly completed: Deferred.Deferred<void, DesktopSpeechSessionOperationError>;
}

export type SessionCommand = FeedCommand | FinalizeCommand | CancelCommand;

export interface ActiveSession {
  readonly sessionId: DesktopSpeechSessionId;
  readonly modelId: DesktopSpeechModelId;
  readonly commands: Queue.Queue<SessionCommand>;
  readonly startedAt: number;
  readonly acceptedBytes: Ref.Ref<number>;
  readonly currentCommand: Ref.Ref<Option.Option<SessionCommand>>;
  readonly done: Deferred.Deferred<void>;
}

export class DesktopSpeechSessionOperationError extends Schema.TaggedErrorClass<DesktopSpeechSessionOperationError>()(
  "DesktopSpeechSessionOperationError",
  {
    operation: Schema.Literals(["feed", "cancel", "finalize", "shutdown"]),
    cause: Schema.Defect(),
  },
) {}

interface SessionRuntimeOptions {
  readonly worker: SpeechInferenceWorker["Service"];
  readonly activeSession: Ref.Ref<Option.Option<ActiveSession>>;
  readonly failureMessage: string;
  readonly applyEvent: (event: SpeechMachineEvent) => Effect.Effect<unknown, never, never>;
  readonly invalidateLoadedModel: Effect.Effect<unknown, never, never>;
  readonly logInfo: (
    message: string,
    annotations: Record<string, unknown>,
  ) => Effect.Effect<void, never, never>;
  readonly logWarning: (
    message: string,
    annotations: Record<string, unknown>,
  ) => Effect.Effect<void, never, never>;
}

export function makeSpeechSessionRuntime(options: SessionRuntimeOptions) {
  const {
    worker,
    activeSession,
    failureMessage,
    applyEvent,
    invalidateLoadedModel,
    logInfo,
    logWarning,
  } = options;

  const clearActiveSession = (sessionId: DesktopSpeechSessionId) =>
    Ref.update(activeSession, (current) =>
      Option.filter(current, (session) => session.sessionId !== sessionId),
    );

  const failSessionCommand = (
    command: SessionCommand,
    error: DesktopSpeechSessionOperationError,
  ) => {
    switch (command.type) {
      case "feed":
      case "cancel":
        return Deferred.fail(command.completed, error).pipe(Effect.asVoid);
      case "finalize":
        return Deferred.fail(command.completed, error).pipe(Effect.asVoid);
    }
  };

  const failPendingSessionCommands = Effect.fn("DesktopSpeech.failPendingSessionCommands")(
    function* (session: ActiveSession, error: DesktopSpeechSessionOperationError) {
      const current = yield* Ref.get(session.currentCommand);
      if (Option.isSome(current)) yield* failSessionCommand(current.value, error);
      while (true) {
        const pending = yield* Queue.poll(session.commands);
        if (Option.isNone(pending)) return;
        yield* failSessionCommand(pending.value, error);
      }
    },
  );

  const runSession = Effect.fn("DesktopSpeech.runSession")(function* (session: ActiveSession) {
    const loop = Effect.gen(function* () {
      while (true) {
        const command = yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const taken = yield* restore(Queue.take(session.commands));
            yield* Ref.set(session.currentCommand, Option.some(taken));
            return taken;
          }),
        );

        if (command.type === "feed") {
          const outcome = yield* worker.feed(command.samples).pipe(
            Effect.tap((preview) =>
              preview
                ? applyEvent({
                    type: "session-previewed",
                    sessionId: session.sessionId,
                    preview: {
                      ...preview,
                      revision: preview.revision as DesktopSpeechPreviewRevision,
                    },
                  }).pipe(Effect.asVoid)
                : Effect.void,
            ),
            Effect.match({
              onFailure: (cause) =>
                ({
                  type: "failure",
                  error: new DesktopSpeechSessionOperationError({ operation: "feed", cause }),
                }) as const,
              onSuccess: () => ({ type: "success" }) as const,
            }),
          );
          yield* Ref.set(session.currentCommand, Option.none());
          if (outcome.type === "success") {
            yield* Ref.update(session.acceptedBytes, (bytes) => bytes + command.bytes);
            yield* Deferred.succeed(command.completed, undefined);
            continue;
          }

          yield* invalidateLoadedModel;
          yield* applyEvent({
            type: "session-failed",
            sessionId: session.sessionId,
            reason: failureMessage,
          });
          yield* logWarning("voice session failed", {
            modelId: session.modelId,
            backend: "transcribe-cpp",
            errorTag: outcome.error.operation,
          });
          yield* Deferred.fail(command.completed, outcome.error);
          return;
        }

        if (command.type === "cancel") {
          const outcome = yield* worker.cancel().pipe(
            Effect.mapError(
              (cause) => new DesktopSpeechSessionOperationError({ operation: "cancel", cause }),
            ),
            Effect.match({
              onFailure: (error) => ({ type: "failure", error }) as const,
              onSuccess: () => ({ type: "success" }) as const,
            }),
          );
          yield* clearActiveSession(session.sessionId);
          yield* Queue.shutdown(session.commands);
          yield* Ref.set(session.currentCommand, Option.none());
          if (outcome.type === "success") {
            yield* Deferred.succeed(command.completed, undefined);
          } else {
            yield* invalidateLoadedModel;
            yield* Deferred.fail(command.completed, outcome.error);
          }
          return;
        }

        const outcome = yield* worker.finalize().pipe(
          Effect.mapError(
            (cause) => new DesktopSpeechSessionOperationError({ operation: "finalize", cause }),
          ),
          Effect.match({
            onFailure: (error) => ({ type: "failure", error }) as const,
            onSuccess: (text) => ({ type: "success", text }) as const,
          }),
        );
        const completedAt = yield* Clock.currentTimeMillis;
        const acceptedBytes = yield* Ref.get(session.acceptedBytes);
        yield* clearActiveSession(session.sessionId);
        yield* Queue.shutdown(session.commands);
        yield* Ref.set(session.currentCommand, Option.none());
        if (outcome.type === "success") {
          yield* applyEvent({ type: "session-finalized", sessionId: session.sessionId });
          yield* logInfo("voice session finalized", {
            modelId: session.modelId,
            backend: "transcribe-cpp",
            elapsedMs: completedAt - session.startedAt,
            bufferedMs: Math.floor(acceptedBytes / 32),
          });
          yield* Deferred.succeed(command.completed, outcome.text);
        } else {
          yield* invalidateLoadedModel;
          yield* applyEvent({
            type: "session-failed",
            sessionId: session.sessionId,
            reason: failureMessage,
          });
          yield* logWarning("voice session failed", {
            modelId: session.modelId,
            backend: "transcribe-cpp",
            elapsedMs: completedAt - session.startedAt,
            bufferedMs: Math.floor(acceptedBytes / 32),
            errorTag: outcome.error.operation,
          });
          yield* Deferred.fail(command.completed, outcome.error);
        }
        return;
      }
    });

    yield* loop.pipe(
      Effect.onError(() => worker.cancel().pipe(Effect.ignore)),
      Effect.ensuring(
        clearActiveSession(session.sessionId).pipe(
          Effect.andThen(
            failPendingSessionCommands(
              session,
              new DesktopSpeechSessionOperationError({
                operation: "shutdown",
                cause: "Speech session stopped before its command completed.",
              }),
            ),
          ),
          Effect.andThen(Queue.shutdown(session.commands)),
          Effect.andThen(Ref.set(session.currentCommand, Option.none())),
          Effect.andThen(Deferred.succeed(session.done, undefined)),
          Effect.asVoid,
        ),
      ),
    );
  });

  return { clearActiveSession, failPendingSessionCommands, runSession };
}
