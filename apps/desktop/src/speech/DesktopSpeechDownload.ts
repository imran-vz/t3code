import type { DesktopSpeechCatalogEntry, DesktopSpeechModelId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClientError, HttpClientRequest, type HttpClient } from "effect/unstable/http";

import type * as DesktopSpeechPlatform from "./DesktopSpeechPlatform.ts";
import type { SpeechMachineEvent } from "./speechMachine.ts";

const DOWNLOAD_PROGRESS_INTERVAL_MS = 200;
export const DOWNLOAD_FAILURE_MESSAGE = "Voice model download failed. Retry the download.";
export const DOWNLOAD_VALIDATION_MESSAGE = "Downloaded voice model failed verification.";
export const DOWNLOAD_DISK_MESSAGE = "Voice model could not be written to disk.";

const DesktopSpeechDownloadFailureReason = Schema.Literals([
  "network",
  "response",
  "disk-space",
  "disk-write",
  "size",
  "checksum",
  "promotion",
]);

export class DesktopSpeechDownloadError extends Schema.TaggedErrorClass<DesktopSpeechDownloadError>()(
  "DesktopSpeechDownloadError",
  {
    modelId: Schema.String,
    reason: DesktopSpeechDownloadFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

const isDownloadError = Schema.is(DesktopSpeechDownloadError);

export class DesktopSpeechDownloadCancelled extends Schema.TaggedErrorClass<DesktopSpeechDownloadCancelled>()(
  "DesktopSpeechDownloadCancelled",
  { modelId: Schema.String },
) {}

export interface ArtifactPaths {
  readonly final: string;
  readonly partial: string;
  readonly verification: string;
}

export interface ActiveDownload {
  readonly modelId: DesktopSpeechModelId;
  readonly partialPath: string;
  readonly cancelled: Deferred.Deferred<never, DesktopSpeechDownloadCancelled>;
  readonly done: Deferred.Deferred<void>;
}

export function desktopSpeechModelDownloadUrl(entry: DesktopSpeechCatalogEntry): URL {
  const { repository, revision, filename } = entry.artifact;
  return new URL(
    `https://huggingface.co/${repository}/resolve/${revision}/${encodeURIComponent(filename)}?download=true`,
  );
}

export function resolveDesktopSpeechArtifactPaths(
  path: Path.Path,
  modelsDirectory: string,
  entry: DesktopSpeechCatalogEntry,
): ArtifactPaths | null {
  const root = path.resolve(modelsDirectory);
  const final = path.resolve(root, entry.artifact.filename);
  const relative = path.relative(root, final);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return { final, partial: `${final}.partial`, verification: `${final}.verified.json` };
}

export interface DesktopSpeechDownloadProgressGate {
  readonly percent: number;
  readonly publishedAt: number;
}

export function updateDesktopSpeechDownloadProgressGate(
  previous: DesktopSpeechDownloadProgressGate,
  percent: number,
  now: number,
): { readonly publish: boolean; readonly next: DesktopSpeechDownloadProgressGate } {
  const publish =
    percent !== previous.percent &&
    (percent === 100 || now - previous.publishedAt >= DOWNLOAD_PROGRESS_INTERVAL_MS);
  return { publish, next: publish ? { percent, publishedAt: now } : previous };
}

export function desktopSpeechDownloadFailureMessage(error: DesktopSpeechDownloadError): string {
  if (error.reason === "checksum" || error.reason === "size") return DOWNLOAD_VALIDATION_MESSAGE;
  if (error.reason === "disk-space" || error.reason === "disk-write") return DOWNLOAD_DISK_MESSAGE;
  return DOWNLOAD_FAILURE_MESSAGE;
}

interface DownloadRuntimeOptions {
  readonly fileSystem: FileSystem.FileSystem;
  readonly platform: DesktopSpeechPlatform.DesktopSpeechPlatform["Service"];
  readonly httpClient: HttpClient.HttpClient;
  readonly modelsDirectory: string;
  readonly applyEvent: (event: SpeechMachineEvent) => Effect.Effect<unknown, never, never>;
}

export const makeSpeechDownloadRuntime = Effect.fn("DesktopSpeech.makeDownloadRuntime")(function* (
  options: DownloadRuntimeOptions,
) {
  const { fileSystem, platform, httpClient, modelsDirectory, applyEvent } = options;
  const lastProgress = yield* Ref.make({ percent: 0, publishedAt: 0 });
  const resetProgress = (publishedAt: number) => Ref.set(lastProgress, { percent: 0, publishedAt });

  const reportProgress = Effect.fn("DesktopSpeech.reportDownloadProgress")(function* (
    entry: DesktopSpeechCatalogEntry,
    receivedBytes: number,
  ) {
    const percent = Math.min(100, Math.floor((receivedBytes / entry.artifact.bytes) * 100));
    const now = yield* Clock.currentTimeMillis;
    const publish = yield* Ref.modify(lastProgress, (previous) => {
      const decision = updateDesktopSpeechDownloadProgressGate(previous, percent, now);
      return [decision.publish, decision.next] as const;
    });
    if (publish) {
      yield* applyEvent({ type: "download-progressed", modelId: entry.id, receivedBytes });
    }
  });

  const performDownload = Effect.fn("DesktopSpeech.performDownload")(function* (
    entry: DesktopSpeechCatalogEntry,
    paths: ArtifactPaths,
  ) {
    yield* fileSystem
      .remove(paths.partial, { force: true })
      .pipe(
        Effect.mapError(
          (cause) =>
            new DesktopSpeechDownloadError({ modelId: entry.id, reason: "disk-write", cause }),
        ),
      );
    const availableBytes = yield* platform.availableBytes(modelsDirectory);
    if (Option.isSome(availableBytes) && availableBytes.value < BigInt(entry.artifact.bytes)) {
      return yield* new DesktopSpeechDownloadError({ modelId: entry.id, reason: "disk-space" });
    }

    const response = yield* httpClient
      .execute(HttpClientRequest.get(desktopSpeechModelDownloadUrl(entry).href))
      .pipe(
        Effect.mapError(
          (cause) =>
            new DesktopSpeechDownloadError({ modelId: entry.id, reason: "network", cause }),
        ),
      );
    if (response.status !== 200) {
      return yield* new DesktopSpeechDownloadError({ modelId: entry.id, reason: "response" });
    }

    let receivedBytes = 0;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(paths.partial, { flag: "w" });
        yield* Stream.runForEach(response.stream, (chunk) =>
          Effect.gen(function* () {
            if (receivedBytes + chunk.byteLength > entry.artifact.bytes) {
              return yield* new DesktopSpeechDownloadError({ modelId: entry.id, reason: "size" });
            }
            yield* file.writeAll(chunk);
            receivedBytes += chunk.byteLength;
            yield* reportProgress(entry, receivedBytes);
          }),
        );
        yield* file.sync;
      }),
    ).pipe(
      Effect.mapError((cause) =>
        isDownloadError(cause)
          ? cause
          : new DesktopSpeechDownloadError({
              modelId: entry.id,
              reason: HttpClientError.isHttpClientError(cause) ? "network" : "disk-write",
              cause,
            }),
      ),
    );

    if (receivedBytes !== entry.artifact.bytes) {
      return yield* new DesktopSpeechDownloadError({ modelId: entry.id, reason: "size" });
    }
    const digest = yield* platform
      .hashFileSha256(paths.partial)
      .pipe(
        Effect.mapError(
          (cause) =>
            new DesktopSpeechDownloadError({ modelId: entry.id, reason: "checksum", cause }),
        ),
      );
    if (digest !== entry.artifact.sha256) {
      return yield* new DesktopSpeechDownloadError({ modelId: entry.id, reason: "checksum" });
    }
  });

  return { performDownload, resetProgress };
});
