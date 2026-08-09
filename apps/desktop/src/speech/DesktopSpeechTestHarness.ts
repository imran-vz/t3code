import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DesktopSpeechCatalogEntry,
  DesktopSpeechSessionId,
  type DesktopSpeechAudioSequence,
  type DesktopSpeechCatalogEntry as DesktopSpeechCatalogEntryValue,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopSpeech from "./DesktopSpeech.ts";
import * as DesktopSpeechPlatform from "./DesktopSpeechPlatform.ts";
import {
  SpeechInferenceWorker,
  SpeechInferenceWorkerCrash,
  SpeechInferenceWorkerError,
  layerTest as speechInferenceWorkerLayerTest,
} from "./SpeechInferenceWorker.ts";

export const artifactBytes = new TextEncoder().encode("abcdef");

export const testEntry = Schema.decodeUnknownSync(DesktopSpeechCatalogEntry)({
  id: "test-speech-model",
  title: "Test Speech Model",
  description: "A deterministic speech model fixture.",
  languages: [{ code: "en", label: "English" }],
  capabilities: { supportsStreaming: true },
  artifact: {
    repository: "test/speech-model",
    revision: "0000000000000000000000000000000000000000",
    filename: "test-speech-model-Q8_0.gguf",
    format: "gguf",
    quantization: "Q8_0",
    bytes: artifactBytes.byteLength,
    sha256: "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721",
  },
  license: { name: "MIT", sourceUrl: "https://example.com/license" },
  accuracyRating: 3,
  speedRating: 5,
  recommended: true,
});

export const sequence = (value: number) => value as DesktopSpeechAudioSequence;

export class FakeSpeechWorker {
  readonly loads: string[] = [];
  readonly feeds: Float32Array[] = [];
  starts = 0;
  finalizes = 0;
  cancels = 0;
  alive = true;
  loadImpl: SpeechInferenceWorker["Service"]["load"] = () => Effect.void;
  startImpl: SpeechInferenceWorker["Service"]["start"] = () => Effect.void;
  feedImpl: SpeechInferenceWorker["Service"]["feed"] = () => Effect.succeed(null);
  finalizeImpl: SpeechInferenceWorker["Service"]["finalize"] = () =>
    Effect.succeed("final transcript");
  cancelImpl: SpeechInferenceWorker["Service"]["cancel"] = () => Effect.void;
  readonly crashes: Queue.Queue<SpeechInferenceWorkerCrash>;
  readonly service: SpeechInferenceWorker["Service"];

  constructor(crashes: Queue.Queue<SpeechInferenceWorkerCrash>) {
    this.crashes = crashes;
    this.service = SpeechInferenceWorker.of({
      load: (modelPath) => {
        this.loads.push(modelPath);
        return this.loadImpl(modelPath);
      },
      start: () => {
        this.starts += 1;
        return this.startImpl();
      },
      feed: (samples) => {
        this.feeds.push(new Float32Array(samples));
        return this.feedImpl(samples);
      },
      finalize: () => {
        this.finalizes += 1;
        return this.finalizeImpl();
      },
      cancel: () => {
        this.cancels += 1;
        return this.cancelImpl();
      },
      isAlive: Effect.sync(() => this.alive),
      awaitCrash: Queue.take(this.crashes),
    });
  }

  emitCrash(exitCode = 9) {
    this.alive = false;
    return Queue.offer(
      this.crashes,
      new SpeechInferenceWorkerCrash({
        exitCode,
        detail: "Speech inference worker exited unexpectedly.",
      }),
    );
  }
}

type HttpHandler = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, never>;

export interface HarnessOptions {
  readonly catalog?: ReadonlyArray<DesktopSpeechCatalogEntryValue>;
  readonly prepare?: (input: {
    readonly environment: DesktopEnvironment.DesktopEnvironment["Service"];
    readonly fileSystem: FileSystem.FileSystem;
  }) => Effect.Effect<void, PlatformError.PlatformError>;
  readonly http?: HttpHandler;
  readonly configureWorker?: (worker: FakeSpeechWorker) => void;
  readonly initialSpeechModelId?: string | null;
  readonly environment?: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput>;
  readonly platformLayer?: Layer.Layer<DesktopSpeechPlatform.DesktopSpeechPlatform>;
  readonly platform?: Partial<DesktopSpeechPlatform.DesktopSpeechPlatform["Service"]>;
  readonly audioQueueCapacity?: number;
}

export function withSpeech<A, E, R>(
  options: HarnessOptions,
  use: (input: {
    readonly speech: DesktopSpeech.DesktopSpeech["Service"];
    readonly worker: FakeSpeechWorker;
    readonly environment: DesktopEnvironment.DesktopEnvironment["Service"];
    readonly settings: DesktopAppSettings.DesktopAppSettings["Service"];
    readonly fileSystem: FileSystem.FileSystem;
  }) => Effect.Effect<A, E, R>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-speech-test-" });
      const crashes = yield* Queue.unbounded<SpeechInferenceWorkerCrash>();
      const worker = new FakeSpeechWorker(crashes);
      options.configureWorker?.(worker);
      const productionPlatform = yield* DesktopSpeechPlatform.DesktopSpeechPlatform.pipe(
        Effect.provide(DesktopSpeechPlatform.layer),
      );
      const environmentLayer = DesktopEnvironment.layer({
        dirname: `${root}/app/dist-electron`,
        homeDirectory: root,
        platform: "linux",
        processArch: "x64",
        appVersion: "0.0.22",
        appPath: `${root}/app`,
        isPackaged: false,
        resourcesPath: `${root}/resources`,
        runningUnderArm64Translation: false,
        ...options.environment,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: root })),
        ),
      );
      const initialSettings = {
        ...DesktopAppSettings.resolveDefaultDesktopSettings("0.0.22"),
        speechModelId: options.initialSpeechModelId ?? null,
      };
      const dependencies = Layer.mergeAll(
        environmentLayer,
        DesktopAppSettings.layerTest(initialSettings),
        speechInferenceWorkerLayerTest(worker.service),
        options.platformLayer ??
          DesktopSpeechPlatform.layerTest({
            ...productionPlatform,
            nativeArtifactAvailable: () => Effect.succeed(true),
            ...options.platform,
          }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(
            options.http ?? (() => Effect.die("unexpected speech model HTTP request")),
          ),
        ),
      );
      return yield* Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const innerFileSystem = yield* FileSystem.FileSystem;
        yield* options.prepare?.({ environment, fileSystem: innerFileSystem }) ?? Effect.void;
        const speech = yield* DesktopSpeech.make({
          catalog: options.catalog ?? [testEntry],
          ...(options.audioQueueCapacity === undefined
            ? {}
            : { audioQueueCapacity: options.audioQueueCapacity }),
        });
        yield* speech.restoreSelection;
        return yield* use({
          speech,
          worker,
          environment,
          settings,
          fileSystem: innerFileSystem,
        });
      }).pipe(Effect.provide(dependencies));
    }),
  ).pipe(Effect.provide(NodeServices.layer));
}

export function response(
  request: HttpClientRequest.HttpClientRequest,
  body: Uint8Array,
  status = 200,
  headers?: HeadersInit,
) {
  const bodyBuffer = body.buffer.slice(
    body.byteOffset,
    body.byteOffset + body.byteLength,
  ) as ArrayBuffer;
  return HttpClientResponse.fromWeb(
    request,
    new Response(bodyBuffer, { status, ...(headers === undefined ? {} : { headers }) }),
  );
}

export const installedPath = (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  entry = testEntry,
) => `${environment.speechModelsDir}/${entry.artifact.filename}`;

export const partialPath = (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  entry = testEntry,
) => `${installedPath(environment, entry)}.partial`;

export const prepareInstalled = ({
  environment,
  fileSystem,
}: {
  readonly environment: DesktopEnvironment.DesktopEnvironment["Service"];
  readonly fileSystem: FileSystem.FileSystem;
}) =>
  fileSystem
    .makeDirectory(environment.speechModelsDir, { recursive: true })
    .pipe(Effect.andThen(fileSystem.writeFile(installedPath(environment), artifactBytes)));

export const staleSessionId = Schema.decodeUnknownSync(DesktopSpeechSessionId)("session:stale");

export const workerFailure = (operation: "load" | "feed" | "finalize" | "cancel", detail: string) =>
  new SpeechInferenceWorkerError({ operation, reason: "native", detail });

export function awaitModelSettled(speech: DesktopSpeech.DesktopSpeech["Service"]) {
  return speech.changes.pipe(
    Stream.filter((state) => {
      const model = state.models[0];
      return (
        model !== undefined &&
        model.download.type !== "downloading" &&
        model.download.type !== "canceling"
      );
    }),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
}
