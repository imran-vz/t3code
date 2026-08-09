import { DesktopSpeechCatalog } from "@t3tools/contracts";
import type {
  DesktopSpeechActionRejected,
  DesktopSpeechActionResult,
  DesktopSpeechAudioInput,
  DesktopSpeechAudioResult,
  DesktopSpeechCancelResult,
  DesktopSpeechCatalogEntry,
  DesktopSpeechDownloadModelResult,
  DesktopSpeechModelId,
  DesktopSpeechPreviewDelta,
  DesktopSpeechRemoveModelResult,
  DesktopSpeechSelectModelResult,
  DesktopSpeechSessionId,
  DesktopSpeechStartResult,
  DesktopSpeechState,
  DesktopSpeechStopResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as StreamRuntime from "effect/Stream";
import type * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpClient } from "effect/unstable/http";
import { resolveTranscribeCppNativeSupport } from "@t3tools/shared/transcribeCppArtifacts";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import { SpeechInferenceWorker } from "./SpeechInferenceWorker.ts";
import {
  DesktopSpeechSessionOperationError,
  makeSpeechSessionRuntime,
  type ActiveSession,
  type SessionCommand,
} from "./DesktopSpeechSession.ts";
import { pcm16ToFloat32 } from "./speechWorkerProtocol.ts";
import * as DesktopSpeechPlatform from "./DesktopSpeechPlatform.ts";
import {
  DesktopSpeechDownloadCancelled,
  DesktopSpeechDownloadError,
  DOWNLOAD_DISK_MESSAGE,
  DOWNLOAD_FAILURE_MESSAGE,
  DOWNLOAD_VALIDATION_MESSAGE,
  desktopSpeechDownloadFailureMessage,
  desktopSpeechModelDownloadUrl,
  makeSpeechDownloadRuntime,
  resolveDesktopSpeechArtifactPaths,
  updateDesktopSpeechDownloadProgressGate,
  type ActiveDownload,
  type DesktopSpeechDownloadProgressGate,
} from "./DesktopSpeechDownload.ts";
import {
  createSpeechMachine,
  decideSpeechMachine,
  getDesktopSpeechState,
  reduceSpeechMachine,
  type SpeechMachineCommand,
  type SpeechMachineEvent,
} from "./speechMachine.ts";

const DEFAULT_AUDIO_QUEUE_CAPACITY = 8;
const DEFAULT_SHUTDOWN_TIMEOUT = "5 seconds";
const SESSION_FAILURE_MESSAGE = "Voice transcription failed. Cancel and try again.";
const STORAGE_UNAVAILABLE_MESSAGE =
  "Voice input is unavailable because its local storage could not be initialized.";
const DesktopSpeechVerificationMarker = Schema.fromJsonString(
  Schema.Struct({
    sha256: Schema.String,
    bytes: Schema.Number,
    mtimeMs: Schema.Number,
  }),
);
const decodeVerificationMarker = Schema.decodeUnknownEffect(DesktopSpeechVerificationMarker);
const encodeVerificationMarker = Schema.encodeUnknownEffect(DesktopSpeechVerificationMarker);
const { logInfo: logSpeechInfo, logWarning: logSpeechWarning } =
  DesktopObservability.makeComponentLogger("desktop-speech");

const DESKTOP_SPEECH_CATALOG = Schema.decodeUnknownSync(DesktopSpeechCatalog)([
  {
    id: "moonshine-streaming-tiny-q8",
    title: "Moonshine Streaming Tiny",
    description: "Fast, lightweight English live transcription.",
    languages: [{ code: "en", label: "English" }],
    capabilities: { supportsStreaming: true },
    artifact: {
      repository: "handy-computer/moonshine-streaming-tiny-gguf",
      revision: "85ddff612fa3a2cf40b2f745abcfa90ef82f293b",
      filename: "moonshine-streaming-tiny-Q8_0.gguf",
      format: "gguf",
      quantization: "Q8_0",
      bytes: 50_462_816,
      sha256: "930e4622ad3a24158b91406c30c977fa6a26b34cb32d6ac3e57cfb23383a869e",
    },
    license: {
      name: "MIT",
      sourceUrl:
        "https://huggingface.co/handy-computer/moonshine-streaming-tiny-gguf/blob/85ddff612fa3a2cf40b2f745abcfa90ef82f293b/README.md#license",
    },
    accuracyRating: 3,
    speedRating: 5,
    recommended: true,
  },
]);

const DesktopSpeechInfrastructureOperation = Schema.Literals([
  "initialize",
  "persist-selection",
  "create-session",
]);

export class DesktopSpeechInfrastructureError extends Schema.TaggedErrorClass<DesktopSpeechInfrastructureError>()(
  "DesktopSpeechInfrastructureError",
  { operation: DesktopSpeechInfrastructureOperation, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Desktop speech infrastructure failed during ${this.operation}.`;
  }
}

function speechOperationFailed(message: string): DesktopSpeechActionRejected {
  return { type: "rejected", reason: "operation-failed", message };
}

export interface DesktopSpeechOptions {
  readonly catalog?: ReadonlyArray<DesktopSpeechCatalogEntry>;
  readonly audioQueueCapacity?: number;
  readonly shutdownTimeout?: Duration.Input;
}

export class DesktopSpeech extends Context.Service<
  DesktopSpeech,
  {
    readonly getState: Effect.Effect<DesktopSpeechState>;
    readonly restoreSelection: Effect.Effect<void, DesktopSpeechInfrastructureError>;
    readonly changes: Stream.Stream<DesktopSpeechState>;
    readonly previews: Stream.Stream<DesktopSpeechPreviewDelta>;
    readonly selectModel: (
      modelId: DesktopSpeechModelId,
    ) => Effect.Effect<DesktopSpeechSelectModelResult, DesktopSpeechInfrastructureError>;
    readonly downloadModel: (
      modelId: DesktopSpeechModelId,
    ) => Effect.Effect<DesktopSpeechDownloadModelResult>;
    readonly cancelDownload: (
      modelId: DesktopSpeechModelId,
    ) => Effect.Effect<DesktopSpeechActionResult>;
    readonly removeModel: (
      modelId: DesktopSpeechModelId,
    ) => Effect.Effect<DesktopSpeechRemoveModelResult>;
    readonly start: () => Effect.Effect<DesktopSpeechStartResult, DesktopSpeechInfrastructureError>;
    readonly acceptAudio: (
      input: DesktopSpeechAudioInput,
    ) => Effect.Effect<DesktopSpeechAudioResult>;
    readonly stop: (sessionId: DesktopSpeechSessionId) => Effect.Effect<DesktopSpeechStopResult>;
    readonly cancel: (
      sessionId: DesktopSpeechSessionId,
    ) => Effect.Effect<DesktopSpeechCancelResult>;
  }
>()("@t3tools/desktop/speech/DesktopSpeech") {}

export {
  desktopSpeechModelDownloadUrl,
  resolveDesktopSpeechArtifactPaths,
  updateDesktopSpeechDownloadProgressGate,
  type DesktopSpeechDownloadProgressGate,
};

export const make = Effect.fn("DesktopSpeech.make")(function* (options: DesktopSpeechOptions = {}) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const worker = yield* SpeechInferenceWorker;
  const platform = yield* DesktopSpeechPlatform.DesktopSpeechPlatform;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.followRedirects(5));
  const serviceScope = yield* Scope.Scope;
  const catalog = options.catalog ?? DESKTOP_SPEECH_CATALOG;
  const audioQueueCapacity = Math.max(
    1,
    options.audioQueueCapacity ?? DEFAULT_AUDIO_QUEUE_CAPACITY,
  );
  const shutdownTimeout = options.shutdownTimeout ?? DEFAULT_SHUTDOWN_TIMEOUT;

  const storageReady = yield* fileSystem
    .makeDirectory(environment.speechModelsDir, { recursive: true })
    .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));

  const installedModelIds = new Set<DesktopSpeechModelId>();
  const verifiedModelIds = new Set<DesktopSpeechModelId>();
  if (storageReady) {
    for (const entry of catalog) {
      const paths = resolveDesktopSpeechArtifactPaths(path, environment.speechModelsDir, entry);
      if (!paths) continue;
      const info = yield* fileSystem.stat(paths.final).pipe(Effect.option);
      if (
        Option.isNone(info) ||
        info.value.type !== "File" ||
        info.value.size !== BigInt(entry.artifact.bytes)
      ) {
        continue;
      }
      installedModelIds.add(entry.id);
      const marker = yield* fileSystem
        .readFileString(paths.verification)
        .pipe(Effect.flatMap(decodeVerificationMarker), Effect.option);
      const mtime = info.value.mtime;
      if (
        Option.isSome(marker) &&
        Option.isSome(mtime) &&
        marker.value.sha256 === entry.artifact.sha256 &&
        marker.value.bytes === entry.artifact.bytes &&
        marker.value.mtimeMs === mtime.value.getTime()
      ) {
        verifiedModelIds.add(entry.id);
      }
    }
  }

  const writeVerificationMarker = Effect.fn("DesktopSpeech.writeVerificationMarker")(function* (
    entry: (typeof catalog)[number],
    finalPath: string,
    verificationPath: string,
  ) {
    const info = yield* fileSystem.stat(finalPath);
    if (Option.isNone(info.mtime)) return;
    const encoded = yield* encodeVerificationMarker({
      sha256: entry.artifact.sha256,
      bytes: entry.artifact.bytes,
      mtimeMs: info.mtime.value.getTime(),
    });
    yield* fileSystem.writeFileString(verificationPath, encoded);
  });

  const workerAlive = yield* worker.isAlive;
  const nativeSupport = resolveTranscribeCppNativeSupport(
    environment.platform,
    environment.processArch,
  );
  const nativeArtifactAvailable = yield* platform.nativeArtifactAvailable(
    environment.platform,
    environment.processArch,
  );
  const availability = !nativeSupport.supported
    ? ({ type: "unsupported", reason: nativeSupport.reason } as const)
    : !storageReady
      ? ({ type: "unsupported", reason: STORAGE_UNAVAILABLE_MESSAGE } as const)
      : !nativeArtifactAvailable
        ? ({
            type: "unsupported",
            reason: "Voice input is unavailable because local inference is not installed.",
          } as const)
        : !workerAlive
          ? ({
              type: "unsupported",
              reason: "Voice input is unavailable because local inference is not running.",
            } as const)
          : ({ type: "supported" } as const);
  const initialMachine = createSpeechMachine({
    availability,
    catalog,
    installedModelIds,
    selectedModelId: null,
  });
  const machine = yield* SynchronizedRef.make(initialMachine);
  const changes = yield* PubSub.sliding<DesktopSpeechState>({ capacity: 1, replay: 1 });
  const previews = yield* PubSub.sliding<DesktopSpeechPreviewDelta>({ capacity: 1 });
  yield* PubSub.publish(changes, initialMachine.snapshot);
  const activeDownload = yield* Ref.make<Option.Option<ActiveDownload>>(Option.none());
  const activeSession = yield* Ref.make<Option.Option<ActiveSession>>(Option.none());
  const downloadIngress = yield* Semaphore.make(1);
  const sessionIngress = yield* Semaphore.make(1);

  const publish = (state: DesktopSpeechState) => PubSub.publish(changes, state).pipe(Effect.asVoid);
  const publishPreview = (preview: DesktopSpeechPreviewDelta) =>
    PubSub.publish(previews, preview).pipe(Effect.asVoid);

  const applyCommand = Effect.fn("DesktopSpeech.applyCommand")(function* (
    command: SpeechMachineCommand,
  ) {
    return yield* SynchronizedRef.modifyEffect(machine, (current) => {
      const decision = decideSpeechMachine(current, command);
      const announce = decision.state === current ? Effect.void : publish(decision.state.snapshot);
      return announce.pipe(Effect.as([decision.result, decision.state] as const));
    });
  });

  const applyEvent = Effect.fn("DesktopSpeech.applyEvent")(function* (event: SpeechMachineEvent) {
    return yield* SynchronizedRef.modifyEffect(machine, (current) => {
      const next = reduceSpeechMachine(current, event);
      const announce =
        next === current
          ? Effect.void
          : event.type === "session-previewed"
            ? publishPreview({ sessionId: event.sessionId, ...event.preview })
            : publish(next.snapshot);
      return announce.pipe(Effect.as([next, next] as const));
    });
  });

  const restoreSelection = Effect.gen(function* () {
    const persistedSettings = yield* settings.get;
    const current = yield* SynchronizedRef.get(machine);
    const selectedModelId =
      current.snapshot.models.find((model) => model.installation.type === "installed")?.catalogEntry
        .id ?? null;

    if (persistedSettings.speechModelId !== selectedModelId) {
      yield* settings
        .setSpeechModelId(selectedModelId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new DesktopSpeechInfrastructureError({ operation: "persist-selection", cause }),
          ),
        );
    }

    yield* applyEvent({ type: "model-selection-restored", modelId: selectedModelId });
  }).pipe(Effect.withSpan("desktop.speech.restore-selection"));

  const modelById = (modelId: DesktopSpeechModelId) =>
    catalog.find((entry) => entry.id === modelId);

  const verifyInstalledModel = Effect.fn("DesktopSpeech.verifyInstalledModel")(function* (
    entry: (typeof catalog)[number],
    finalPath: string,
    verificationPath: string,
  ) {
    if (verifiedModelIds.has(entry.id)) return true;
    const digest = yield* platform.hashFileSha256(finalPath).pipe(
      Effect.match({
        onFailure: () => null,
        onSuccess: (value) => value,
      }),
    );
    if (digest === entry.artifact.sha256) {
      verifiedModelIds.add(entry.id);
      yield* writeVerificationMarker(entry, finalPath, verificationPath).pipe(Effect.ignore);
      return true;
    }

    verifiedModelIds.delete(entry.id);
    if (digest !== null) {
      yield* fileSystem.remove(finalPath, { force: true }).pipe(Effect.ignore);
    }
    yield* fileSystem.remove(verificationPath, { force: true }).pipe(Effect.ignore);
    yield* settings.setSpeechModelId(null).pipe(Effect.ignore);
    yield* applyEvent({ type: "model-invalidated", modelId: entry.id });
    return false;
  });

  const { performDownload, resetProgress } = yield* makeSpeechDownloadRuntime({
    fileSystem,
    platform,
    httpClient,
    modelsDirectory: environment.speechModelsDir,
    applyEvent,
  });

  const invalidateLoadedModel = applyEvent({ type: "loaded-model-invalidated" });

  const abandonStartingSession = Effect.fn("DesktopSpeech.abandonStartingSession")(function* (
    sessionId: DesktopSpeechSessionId,
  ) {
    yield* applyEvent({ type: "session-failed", sessionId, reason: SESSION_FAILURE_MESSAGE });
    yield* applyCommand({ type: "session-cancel", sessionId });
  });

  const { clearActiveSession, failPendingSessionCommands, runSession } = makeSpeechSessionRuntime({
    worker,
    activeSession,
    failureMessage: SESSION_FAILURE_MESSAGE,
    applyEvent,
    invalidateLoadedModel,
    logInfo: logSpeechInfo,
    logWarning: logSpeechWarning,
  });

  if (availability.type === "supported") {
    yield* Effect.forkIn(
      worker.awaitCrash.pipe(
        Effect.flatMap((crash) =>
          Effect.gen(function* () {
            yield* applyEvent({ type: "worker-crashed", reason: crash.message });
          }),
        ),
        Effect.forever,
      ),
      serviceScope,
    );
  }

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const download = yield* Ref.get(activeDownload);
        if (Option.isSome(download)) {
          yield* Deferred.fail(
            download.value.cancelled,
            new DesktopSpeechDownloadCancelled({ modelId: download.value.modelId }),
          );
          yield* Deferred.await(download.value.done);
          yield* fileSystem.remove(download.value.partialPath, { force: true }).pipe(Effect.ignore);
        }
        const session = yield* Ref.get(activeSession);
        if (Option.isSome(session)) {
          const shutdownError = new DesktopSpeechSessionOperationError({
            operation: "shutdown",
            cause: "Desktop speech service is shutting down.",
          });
          yield* failPendingSessionCommands(session.value, shutdownError);
          yield* Queue.shutdown(session.value.commands);
          yield* worker.cancel().pipe(Effect.ignore);
          yield* Deferred.await(session.value.done);
        }
      }).pipe(Effect.timeout(shutdownTimeout), Effect.ignore);
      yield* PubSub.shutdown(changes);
    }),
  );

  const selectModel: DesktopSpeech["Service"]["selectModel"] = (modelId) =>
    SynchronizedRef.modifyEffect(machine, (current) => {
      const decision = decideSpeechMachine(current, { type: "model-select", modelId });
      if (decision.result.type === "rejected") {
        return Effect.succeed([
          decision.result as DesktopSpeechSelectModelResult,
          current,
        ] as const);
      }
      return settings.setSpeechModelId(modelId).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopSpeechInfrastructureError({ operation: "persist-selection", cause }),
        ),
        Effect.andThen(publish(decision.state.snapshot)),
        Effect.as([decision.result as DesktopSpeechSelectModelResult, decision.state] as const),
      );
    });

  const downloadModel: DesktopSpeech["Service"]["downloadModel"] = (modelId) =>
    downloadIngress
      .withPermit(
        Effect.gen(function* () {
          const entry = modelById(modelId);
          const result = yield* applyCommand({ type: "download-start", modelId });
          if (result.type === "rejected" || !entry) return result;
          const paths = resolveDesktopSpeechArtifactPaths(path, environment.speechModelsDir, entry);
          if (!paths) {
            yield* applyEvent({
              type: "download-failed",
              modelId,
              reason: DOWNLOAD_VALIDATION_MESSAGE,
            });
            return result;
          }

          const cancelled = yield* Deferred.make<never, DesktopSpeechDownloadCancelled>();
          const done = yield* Deferred.make<void>();
          const startedAt = yield* Clock.currentTimeMillis;
          const download: ActiveDownload = {
            modelId,
            partialPath: paths.partial,
            cancelled,
            done,
          };
          yield* Ref.set(activeDownload, Option.some(download));
          yield* resetProgress(startedAt);

          const promote = downloadIngress.withPermit(
            Effect.gen(function* () {
              const state = yield* SynchronizedRef.get(machine);
              const model = state.snapshot.models.find(
                (candidate) => candidate.catalogEntry.id === modelId,
              );
              if (model?.download.type !== "downloading") {
                return yield* new DesktopSpeechDownloadCancelled({ modelId });
              }
              yield* fileSystem
                .rename(paths.partial, paths.final)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new DesktopSpeechDownloadError({ modelId, reason: "promotion", cause }),
                  ),
                );
              verifiedModelIds.add(modelId);
              yield* writeVerificationMarker(entry, paths.final, paths.verification).pipe(
                Effect.ignore,
              );
              yield* settings.setSpeechModelId(modelId).pipe(Effect.ignore);
              yield* applyEvent({ type: "download-completed", modelId });
              const completedAt = yield* Clock.currentTimeMillis;
              yield* logSpeechInfo("voice model download completed", {
                modelId,
                elapsedMs: completedAt - startedAt,
              });
            }),
          );

          const job = Effect.raceFirst(
            performDownload(entry, paths).pipe(Effect.andThen(promote)),
            Deferred.await(cancelled),
          ).pipe(
            Effect.catchTags({
              DesktopSpeechDownloadCancelled: () =>
                fileSystem.remove(paths.partial, { force: true }).pipe(
                  Effect.matchEffect({
                    onFailure: () =>
                      applyEvent({
                        type: "download-failed",
                        modelId,
                        reason: DOWNLOAD_DISK_MESSAGE,
                      }),
                    onSuccess: () => applyEvent({ type: "download-canceled", modelId }),
                  }),
                ),
              DesktopSpeechDownloadError: (error) =>
                logSpeechWarning("voice model download failed", {
                  modelId,
                  errorTag: error.reason,
                }).pipe(
                  Effect.andThen(
                    applyEvent({
                      type: "download-failed",
                      modelId,
                      reason: desktopSpeechDownloadFailureMessage(error),
                    }),
                  ),
                ),
            }),
            Effect.ensuring(
              Ref.update(activeDownload, (current) =>
                Option.filter(current, (active) => active.cancelled !== cancelled),
              ).pipe(Effect.andThen(Deferred.succeed(done, undefined)), Effect.asVoid),
            ),
          );
          yield* Effect.forkIn(job, serviceScope);
          return result;
        }).pipe(Effect.uninterruptible),
      )
      .pipe(Effect.withSpan("desktop.speech.downloadModel", { attributes: { modelId } }));

  const cancelDownload: DesktopSpeech["Service"]["cancelDownload"] = (modelId) =>
    downloadIngress.withPermit(
      Effect.gen(function* () {
        const result = yield* applyCommand({ type: "download-cancel", modelId });
        if (result.type === "rejected") return result;
        const active = yield* Ref.get(activeDownload);
        if (Option.isSome(active) && active.value.modelId === modelId) {
          yield* Deferred.fail(
            active.value.cancelled,
            new DesktopSpeechDownloadCancelled({ modelId }),
          );
          return result;
        }
        yield* applyEvent({ type: "download-canceled", modelId });
        return speechOperationFailed(DOWNLOAD_FAILURE_MESSAGE);
      }).pipe(Effect.uninterruptible),
    );

  const removeModel: DesktopSpeech["Service"]["removeModel"] = (modelId) =>
    Effect.gen(function* () {
      const entry = modelById(modelId);
      const result = yield* applyCommand({ type: "model-remove", modelId });
      if (result.type === "rejected" || !entry) return result;
      const paths = resolveDesktopSpeechArtifactPaths(path, environment.speechModelsDir, entry);
      if (!paths) {
        yield* applyEvent({
          type: "model-removal-failed",
          modelId,
          reason: "Voice model removal failed.",
        });
        return result;
      }
      const wasSelected =
        (yield* SynchronizedRef.get(machine)).snapshot.selectedModelId === modelId;
      yield* Effect.all(
        [
          fileSystem.remove(paths.final, { force: true }),
          fileSystem.remove(paths.verification, { force: true }),
        ],
        { discard: true },
      ).pipe(
        Effect.andThen(wasSelected ? settings.setSpeechModelId(null) : Effect.void),
        Effect.matchEffect({
          onFailure: () =>
            applyEvent({
              type: "model-removal-failed",
              modelId,
              reason: "Voice model removal failed.",
            }),
          onSuccess: () => applyEvent({ type: "model-removal-completed", modelId }),
        }),
      );
      verifiedModelIds.delete(modelId);
      return result;
    }).pipe(
      Effect.uninterruptible,
      Effect.withSpan("desktop.speech.removeModel", {
        attributes: { modelId },
      }),
    );

  const start: DesktopSpeech["Service"]["start"] = () =>
    sessionIngress
      .withPermit(
        Effect.gen(function* () {
          const sessionUuid = yield* crypto.randomUUIDv4.pipe(
            Effect.mapError(
              (cause) =>
                new DesktopSpeechInfrastructureError({ operation: "create-session", cause }),
            ),
          );
          const sessionId = sessionUuid as DesktopSpeechSessionId;
          const result = yield* applyCommand({ type: "session-start", sessionId });
          if (result.type === "rejected") return result;
          const state = yield* SynchronizedRef.get(machine);
          const modelId = state.snapshot.selectedModelId;
          const entry = modelId ? modelById(modelId) : undefined;
          if (!modelId || !entry) {
            yield* abandonStartingSession(sessionId);
            return speechOperationFailed(SESSION_FAILURE_MESSAGE);
          }
          const paths = resolveDesktopSpeechArtifactPaths(path, environment.speechModelsDir, entry);
          if (!paths) {
            yield* abandonStartingSession(sessionId);
            return speechOperationFailed(SESSION_FAILURE_MESSAGE);
          }
          const started = yield* Effect.gen(function* () {
            if (state.loadedModelId !== modelId) {
              const verified = yield* verifyInstalledModel(entry, paths.final, paths.verification);
              if (!verified) return false;
              yield* worker.load(paths.final);
            }
            yield* worker.start();
            return true;
          }).pipe(
            Effect.matchEffect({
              onFailure: () => Effect.succeed(false),
              onSuccess: (verified) => Effect.succeed(verified),
            }),
          );
          if (!started) {
            yield* invalidateLoadedModel;
            yield* abandonStartingSession(sessionId);
            yield* logSpeechWarning("voice session start failed", {
              modelId,
              backend: "transcribe-cpp",
              errorTag: "load-or-start",
            });
            return speechOperationFailed(SESSION_FAILURE_MESSAGE);
          }

          const commands = yield* Queue.bounded<SessionCommand>(audioQueueCapacity);
          const startedAt = yield* Clock.currentTimeMillis;
          const acceptedBytes = yield* Ref.make(0);
          const currentCommand = yield* Ref.make<Option.Option<SessionCommand>>(Option.none());
          const done = yield* Deferred.make<void>();
          const session: ActiveSession = {
            sessionId,
            modelId,
            commands,
            startedAt,
            acceptedBytes,
            currentCommand,
            done,
          };
          yield* Ref.set(activeSession, Option.some(session));
          yield* applyEvent({ type: "session-listening", sessionId });
          const listeningState = yield* SynchronizedRef.get(machine);
          const workerStillAlive = yield* worker.isAlive;
          if (
            !workerStillAlive ||
            listeningState.snapshot.session.type !== "listening" ||
            listeningState.snapshot.session.sessionId !== sessionId
          ) {
            yield* invalidateLoadedModel;
            yield* worker.cancel().pipe(Effect.ignore);
            yield* clearActiveSession(sessionId);
            yield* Queue.shutdown(commands);
            yield* Deferred.succeed(done, undefined);
            yield* abandonStartingSession(sessionId);
            return speechOperationFailed(SESSION_FAILURE_MESSAGE);
          }
          yield* Effect.forkIn(runSession(session), serviceScope);
          yield* logSpeechInfo("voice session started", {
            modelId,
            backend: "transcribe-cpp",
          });
          return { type: "accepted", sessionId } as const;
        }).pipe(Effect.uninterruptible),
      )
      .pipe(Effect.withSpan("desktop.speech.start"));

  const acceptAudio: DesktopSpeech["Service"]["acceptAudio"] = (input) =>
    Effect.gen(function* () {
      const enqueued = yield* sessionIngress.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const decision = yield* applyCommand({
              type: "audio-accept",
              sessionId: input.sessionId,
              sequence: input.sequence,
            });
            if (decision.type === "rejected") {
              return { type: "result", result: decision } as const;
            }

            const session = yield* Ref.get(activeSession);
            if (Option.isNone(session)) {
              return {
                type: "result",
                result: speechOperationFailed(SESSION_FAILURE_MESSAGE),
              } as const;
            }
            const completed = yield* Deferred.make<void, DesktopSpeechSessionOperationError>();
            const offered = yield* Queue.offer(session.value.commands, {
              type: "feed",
              samples: pcm16ToFloat32(input.pcm16),
              bytes: input.pcm16.byteLength,
              completed,
            });
            if (!offered) {
              yield* applyEvent({
                type: "session-failed",
                sessionId: input.sessionId,
                reason: SESSION_FAILURE_MESSAGE,
              });
              return {
                type: "result",
                result: speechOperationFailed(SESSION_FAILURE_MESSAGE),
              } as const;
            }
            return { type: "queued", completed } as const;
          }),
        ),
      );
      if (enqueued.type === "result") return enqueued.result;
      return yield* Deferred.await(enqueued.completed).pipe(
        Effect.map(() => ({ type: "accepted", sequence: input.sequence }) as const),
        Effect.orElseSucceed(() => speechOperationFailed(SESSION_FAILURE_MESSAGE)),
      );
    }).pipe(Effect.withSpan("desktop.speech.acceptAudio"));

  const stop: DesktopSpeech["Service"]["stop"] = (sessionId) =>
    sessionIngress
      .withPermit(
        Effect.gen(function* () {
          const session = yield* Ref.get(activeSession);
          if (Option.isNone(session) || session.value.sessionId !== sessionId) {
            const state = yield* SynchronizedRef.get(machine);
            const decision = decideSpeechMachine(state, { type: "session-finalize", sessionId });
            return decision.result.type === "accepted"
              ? speechOperationFailed(SESSION_FAILURE_MESSAGE)
              : decision.result;
          }

          const current = session.value;
          const decision = yield* applyCommand({ type: "session-finalize", sessionId });
          if (decision.type === "rejected") return decision;

          const completed = yield* Deferred.make<string, DesktopSpeechSessionOperationError>();
          const offered = yield* Queue.offer(current.commands, { type: "finalize", completed });
          if (!offered) {
            yield* applyEvent({
              type: "session-failed",
              sessionId,
              reason: SESSION_FAILURE_MESSAGE,
            });
            return speechOperationFailed(SESSION_FAILURE_MESSAGE);
          }
          return yield* Deferred.await(completed).pipe(
            Effect.map((text) => ({ type: "completed", text }) as const),
            Effect.orElseSucceed(() => speechOperationFailed(SESSION_FAILURE_MESSAGE)),
          );
        }).pipe(Effect.uninterruptible),
      )
      .pipe(Effect.withSpan("desktop.speech.stop"));

  const cancel: DesktopSpeech["Service"]["cancel"] = (sessionId) =>
    sessionIngress
      .withPermit(
        Effect.gen(function* () {
          const session = yield* Ref.get(activeSession);
          const state = yield* SynchronizedRef.get(machine);
          const decision = decideSpeechMachine(state, { type: "session-cancel", sessionId });
          if (decision.result.type === "rejected") return decision.result;
          if (Option.isNone(session)) {
            const workerStillAlive = yield* worker.isAlive;
            const reset = workerStillAlive
              ? yield* worker
                  .cancel()
                  .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }))
              : true;
            if (!reset) {
              yield* invalidateLoadedModel;
              yield* applyCommand({ type: "session-cancel", sessionId });
              return speechOperationFailed(SESSION_FAILURE_MESSAGE);
            }
            return yield* applyCommand({ type: "session-cancel", sessionId });
          }
          if (session.value.sessionId !== sessionId) {
            return speechOperationFailed(SESSION_FAILURE_MESSAGE);
          }
          const completed = yield* Deferred.make<void, DesktopSpeechSessionOperationError>();
          const offered = yield* Queue.offer(session.value.commands, { type: "cancel", completed });
          if (!offered) {
            yield* applyEvent({
              type: "session-failed",
              sessionId,
              reason: SESSION_FAILURE_MESSAGE,
            });
            return speechOperationFailed(SESSION_FAILURE_MESSAGE);
          }
          const reset = yield* Deferred.await(completed).pipe(
            Effect.match({ onFailure: () => false, onSuccess: () => true }),
          );
          if (!reset) {
            yield* applyCommand({ type: "session-cancel", sessionId });
            return speechOperationFailed(SESSION_FAILURE_MESSAGE);
          }
          return yield* applyCommand({ type: "session-cancel", sessionId });
        }).pipe(Effect.uninterruptible),
      )
      .pipe(Effect.withSpan("desktop.speech.cancel"));

  return DesktopSpeech.of({
    getState: SynchronizedRef.get(machine).pipe(Effect.map(getDesktopSpeechState)),
    restoreSelection,
    changes: StreamRuntime.fromPubSub(changes),
    previews: StreamRuntime.fromPubSub(previews),
    selectModel,
    downloadModel,
    cancelDownload,
    removeModel,
    start,
    acceptAudio,
    stop,
    cancel,
  });
});

export const layer = (options: DesktopSpeechOptions = {}) =>
  Layer.effect(DesktopSpeech, make(options));
