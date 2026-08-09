import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import {
  hasValidSpeechSamples,
  SPEECH_FEED_MAX_SAMPLES,
  SpeechWorkerRequest,
  type SpeechWorkerFailureCode,
  type SpeechWorkerRequest as SpeechWorkerRequestMessage,
  type SpeechWorkerResponse,
  type SpeechWorkerResult,
} from "../speechWorkerProtocol.ts";

type TranscribeCpp = typeof import("transcribe-cpp");
type NativeModel = Awaited<ReturnType<TranscribeCpp["TranscribeModel"]["load"]>>;
type NativeSession = ReturnType<NativeModel["createSession"]>;
type NativeStream = Awaited<ReturnType<NativeSession["stream"]>>;

const MAX_QUEUED_COMMANDS = 32;
const decodeSpeechWorkerRequest = Schema.decodeUnknownSync(SpeechWorkerRequest);

function success(requestId: string, result: SpeechWorkerResult): SpeechWorkerResponse {
  return { requestId, type: "success", result };
}

function failure(
  requestId: string,
  code: SpeechWorkerFailureCode,
  message: string,
): SpeechWorkerResponse {
  return { requestId, type: "failure", code, message };
}

function requestIdFromUnknown(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("requestId" in value)) return null;
  const requestId = value.requestId;
  return typeof requestId === "string" && requestId.length > 0 && requestId.length <= 128
    ? requestId
    : null;
}

const program = Effect.scoped(
  Effect.gen(function* () {
    const parentPort = process.parentPort;
    if (!parentPort) {
      return yield* Effect.fail("Speech inference worker requires an Electron parent port.");
    }

    const commands = yield* Queue.bounded<SpeechWorkerRequestMessage>(MAX_QUEUED_COMMANDS);
    let binding: TranscribeCpp | null = null;
    let model: NativeModel | null = null;
    let session: NativeSession | null = null;
    let stream: NativeStream | null = null;
    let lastPreview: { committed: string; tentative: string } | null = null;

    const post = (response: SpeechWorkerResponse) =>
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron ParentPort is not Window.postMessage.
      Effect.sync(() => parentPort.postMessage(response));
    const postUnsafe = (response: SpeechWorkerResponse) => {
      try {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron ParentPort is not Window.postMessage.
        parentPort.postMessage(response);
      } catch {
        // The process is already exiting; the scoped finalizer owns cleanup.
      }
    };

    const resetStream = Effect.try({
      try: () => {
        const currentStream = stream;
        stream = null;
        lastPreview = null;
        if (currentStream) currentStream.reset();
      },
      catch: () => "native" as const,
    }).pipe(Effect.ignore);

    const resetSession = Effect.try({
      try: () => {
        const currentSession = session;
        session = null;
        if (currentSession) currentSession.dispose();
        session = model?.createSession() ?? null;
      },
      catch: () => "native" as const,
    });

    const disposeNative = Effect.try({
      try: () => {
        const currentStream = stream;
        const currentSession = session;
        const currentModel = model;
        stream = null;
        lastPreview = null;
        session = null;
        model = null;
        try {
          currentStream?.reset();
        } finally {
          try {
            currentSession?.dispose();
          } finally {
            currentModel?.dispose();
          }
        }
      },
      catch: () => "native" as const,
    }).pipe(Effect.ignore);

    yield* Effect.addFinalizer(() => disposeNative);

    const onMessage = (event: { readonly data: unknown }) => {
      const raw = event.data;
      let command: SpeechWorkerRequestMessage;
      try {
        command = decodeSpeechWorkerRequest(raw);
      } catch {
        const requestId = requestIdFromUnknown(raw);
        if (requestId) {
          postUnsafe(
            failure(
              requestId,
              "invalid-message",
              "Speech inference worker received an invalid command.",
            ),
          );
        }
        return;
      }

      const samplesAreValid =
        command.type !== "feed" || hasValidSpeechSamples(command.samples, SPEECH_FEED_MAX_SAMPLES);
      if (!samplesAreValid) {
        postUnsafe(
          failure(
            command.requestId,
            "invalid-message",
            "Speech inference worker received invalid audio samples.",
          ),
        );
        return;
      }

      if (!Queue.offerUnsafe(commands, command)) {
        postUnsafe(
          failure(command.requestId, "capacity", "Speech inference worker command queue is full."),
        );
        return;
      }
    };

    yield* Effect.acquireRelease(
      Effect.sync(() => parentPort.on("message", onMessage)),
      () => Effect.sync(() => parentPort.off("message", onMessage)),
    );

    const invalidState = (requestId: string, operation: string) =>
      failure(
        requestId,
        "invalid-state",
        `Speech inference ${operation} is not valid in the current worker state.`,
      );

    const handle = Effect.fn("SpeechInferenceWorker.handle")(function* (
      command: SpeechWorkerRequestMessage,
    ) {
      switch (command.type) {
        case "load": {
          if (stream) return invalidState(command.requestId, "load");
          yield* disposeNative;
          const loaded = yield* Effect.tryPromise({
            try: async () => {
              binding ??= await import("transcribe-cpp");
              const nextModel = await binding.TranscribeModel.load(command.modelPath);
              try {
                return { model: nextModel, session: nextModel.createSession() };
              } catch (cause) {
                nextModel.dispose();
                throw cause;
              }
            },
            catch: () => "native" as const,
          });
          model = loaded.model;
          session = loaded.session;
          return success(command.requestId, { type: "loaded" });
        }
        case "start": {
          if (!model || !session || stream) {
            return invalidState(command.requestId, "start");
          }
          stream = yield* Effect.tryPromise({
            // No options means transcribe.cpp selects the model family's
            // documented default streaming and commit policy.
            try: () => session!.stream(),
            catch: () => "native" as const,
          });
          lastPreview = null;
          return success(command.requestId, { type: "started" });
        }
        case "feed": {
          if (!stream) return invalidState(command.requestId, "feed");
          const currentStream = stream;
          const preview = yield* Effect.tryPromise({
            try: async () => {
              // Native code borrows this array. The serial loop cannot advance
              // or mutate/reuse it until the awaited feed has completed.
              const update = await currentStream.feed(command.samples);
              const text = currentStream.text;
              if (
                (!update.committedChanged && !update.tentativeChanged) ||
                (lastPreview?.committed === text.committed &&
                  lastPreview.tentative === text.tentative)
              ) {
                return null;
              }
              lastPreview = { committed: text.committed, tentative: text.tentative };
              return {
                committed: text.committed,
                tentative: text.tentative,
                revision: update.revision,
              };
            },
            catch: () => "native" as const,
          });
          return success(command.requestId, { type: "feed", preview });
        }
        case "finalize": {
          if (!stream) return invalidState(command.requestId, "finalize");
          const currentStream = stream;
          const text = yield* Effect.tryPromise({
            try: async () => {
              await currentStream.finalize();
              return currentStream.text.full;
            },
            catch: () => "native" as const,
          }).pipe(Effect.ensuring(resetStream));
          return success(command.requestId, { type: "finalized", text });
        }
        case "cancel": {
          yield* resetStream;
          yield* resetSession;
          return success(command.requestId, { type: "cancelled" });
        }
      }
    });

    return yield* Effect.forever(
      Effect.gen(function* () {
        const command = yield* Queue.take(commands);
        const response = yield* handle(command).pipe(
          Effect.catch((code: "native" | "cancelled") =>
            Effect.succeed(
              failure(
                command.requestId,
                code,
                code === "cancelled"
                  ? "Speech inference was cancelled."
                  : "Native speech inference failed.",
              ),
            ),
          ),
        );
        yield* post(response);
      }),
    );
  }),
);

NodeRuntime.runMain(program, {
  disableErrorReporting: true,
});
