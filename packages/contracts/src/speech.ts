import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DESKTOP_SPEECH_SAMPLE_RATE = 16_000 as const;
/** 200 ms of mono 16 kHz PCM16: 16,000 samples/s * 0.2 s * 2 bytes/sample. */
export const DESKTOP_SPEECH_MAX_PCM16_BATCH_BYTES = 6_400 as const;

const DisplaySafeText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^[^\p{Cc}/@\\]*$/u),
);

const PublicHttpsUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2_048),
  Schema.isPattern(/^https:\/\/[^@\s/]+(?:\/\S*)?$/),
);

export const DesktopSpeechModelId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
).pipe(Schema.brand("DesktopSpeechModelId"));
export type DesktopSpeechModelId = typeof DesktopSpeechModelId.Type;

export const DesktopSpeechSessionId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
).pipe(Schema.brand("DesktopSpeechSessionId"));
export type DesktopSpeechSessionId = typeof DesktopSpeechSessionId.Type;

export const DesktopSpeechLanguage = Schema.Struct({
  code: TrimmedNonEmptyString.check(
    Schema.isMaxLength(16),
    Schema.isPattern(/^[a-z]{2,3}(?:-[A-Z]{2})?$/),
  ),
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
});
export type DesktopSpeechLanguage = typeof DesktopSpeechLanguage.Type;

export const DesktopSpeechModelCapabilities = Schema.Struct({
  supportsStreaming: Schema.Boolean,
});
export type DesktopSpeechModelCapabilities = typeof DesktopSpeechModelCapabilities.Type;

export const DesktopSpeechArtifact = Schema.Struct({
  repository: TrimmedNonEmptyString.check(
    Schema.isMaxLength(193),
    Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,95})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,95})$/),
  ),
  revision: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  filename: TrimmedNonEmptyString.check(
    Schema.isMaxLength(255),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$/),
  ),
  format: Schema.Literal("gguf"),
  quantization: Schema.Literal("Q8_0"),
  bytes: PositiveInt,
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});
export type DesktopSpeechArtifact = typeof DesktopSpeechArtifact.Type;

export const DesktopSpeechLicense = Schema.Struct({
  name: Schema.Literal("MIT"),
  sourceUrl: PublicHttpsUrl,
});
export type DesktopSpeechLicense = typeof DesktopSpeechLicense.Type;

export const DesktopSpeechFivePointRating = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 5 }),
);
export type DesktopSpeechFivePointRating = typeof DesktopSpeechFivePointRating.Type;

export const DesktopSpeechCatalogEntry = Schema.Struct({
  id: DesktopSpeechModelId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  description: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  languages: Schema.Array(DesktopSpeechLanguage).check(Schema.isMinLength(1)),
  capabilities: DesktopSpeechModelCapabilities,
  artifact: DesktopSpeechArtifact,
  license: DesktopSpeechLicense,
  accuracyRating: DesktopSpeechFivePointRating,
  speedRating: DesktopSpeechFivePointRating,
  recommended: Schema.Boolean,
});
export type DesktopSpeechCatalogEntry = typeof DesktopSpeechCatalogEntry.Type;

export const DesktopSpeechCatalog = Schema.Array(DesktopSpeechCatalogEntry);
export type DesktopSpeechCatalog = typeof DesktopSpeechCatalog.Type;

export const DesktopSpeechModelInstallationState = Schema.Union([
  Schema.Struct({ type: Schema.Literal("not-installed") }),
  Schema.Struct({ type: Schema.Literal("installed") }),
  Schema.Struct({ type: Schema.Literal("removing") }),
  Schema.Struct({
    type: Schema.Literal("remove-failed"),
    reason: DisplaySafeText,
  }),
]);
export type DesktopSpeechModelInstallationState = typeof DesktopSpeechModelInstallationState.Type;

const DownloadProgress = Schema.Struct({
  type: Schema.Literal("downloading"),
  receivedBytes: NonNegativeInt,
  totalBytes: PositiveInt,
  percent: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
}).check(
  Schema.makeFilter((progress) => progress.receivedBytes <= progress.totalBytes, {
    expected: "download progress whose received bytes do not exceed total bytes",
  }),
);

export const DesktopSpeechModelDownloadState = Schema.Union([
  Schema.Struct({ type: Schema.Literal("idle") }),
  DownloadProgress,
  Schema.Struct({ type: Schema.Literal("canceling") }),
  Schema.Struct({
    type: Schema.Literal("failed"),
    reason: DisplaySafeText,
  }),
]);
export type DesktopSpeechModelDownloadState = typeof DesktopSpeechModelDownloadState.Type;

export const DesktopSpeechModelState = Schema.Struct({
  catalogEntry: DesktopSpeechCatalogEntry,
  installation: DesktopSpeechModelInstallationState,
  download: DesktopSpeechModelDownloadState,
});
export type DesktopSpeechModelState = typeof DesktopSpeechModelState.Type;

export const DesktopSpeechAvailability = Schema.Union([
  Schema.Struct({ type: Schema.Literal("supported") }),
  Schema.Struct({
    type: Schema.Literal("unsupported"),
    reason: DisplaySafeText,
  }),
]);
export type DesktopSpeechAvailability = typeof DesktopSpeechAvailability.Type;

export const DesktopSpeechPreviewRevision = NonNegativeInt.pipe(
  Schema.brand("DesktopSpeechPreviewRevision"),
);
export type DesktopSpeechPreviewRevision = typeof DesktopSpeechPreviewRevision.Type;

export const DesktopSpeechPreview = Schema.Struct({
  committed: Schema.String,
  tentative: Schema.String,
  revision: DesktopSpeechPreviewRevision,
});
export type DesktopSpeechPreview = typeof DesktopSpeechPreview.Type;

export const DesktopSpeechSessionState = Schema.Union([
  Schema.Struct({ type: Schema.Literal("idle") }),
  Schema.Struct({
    type: Schema.Literal("starting"),
    sessionId: DesktopSpeechSessionId,
  }),
  Schema.Struct({
    type: Schema.Literal("listening"),
    sessionId: DesktopSpeechSessionId,
  }),
  Schema.Struct({
    type: Schema.Literal("finalizing"),
    sessionId: DesktopSpeechSessionId,
  }),
  Schema.Struct({
    type: Schema.Literal("failed"),
    sessionId: Schema.NullOr(DesktopSpeechSessionId),
    reason: DisplaySafeText,
  }),
]);
export type DesktopSpeechSessionState = typeof DesktopSpeechSessionState.Type;

export const DesktopSpeechState = Schema.Struct({
  availability: DesktopSpeechAvailability,
  models: Schema.Array(DesktopSpeechModelState),
  selectedModelId: Schema.NullOr(DesktopSpeechModelId),
  session: DesktopSpeechSessionState,
  preview: DesktopSpeechPreview,
}).check(
  Schema.makeFilter(
    (state) => {
      const modelIds = state.models.map((model) => model.catalogEntry.id);
      return new Set(modelIds).size === modelIds.length;
    },
    { expected: "desktop speech state with unique model ids" },
  ),
  Schema.makeFilter(
    (state) =>
      state.models.filter(
        (model) => model.download.type === "downloading" || model.download.type === "canceling",
      ).length <= 1,
    { expected: "desktop speech state with at most one active download" },
  ),
);
export type DesktopSpeechState = typeof DesktopSpeechState.Type;

export const DesktopSpeechPreviewDelta = Schema.Struct({
  sessionId: DesktopSpeechSessionId,
  committed: Schema.String,
  tentative: Schema.String,
  revision: DesktopSpeechPreviewRevision,
});
export type DesktopSpeechPreviewDelta = typeof DesktopSpeechPreviewDelta.Type;

export const DesktopSpeechSelectModelInput = Schema.Struct({
  modelId: DesktopSpeechModelId,
});
export type DesktopSpeechSelectModelInput = typeof DesktopSpeechSelectModelInput.Type;

export const DesktopSpeechDownloadModelInput = Schema.Struct({
  modelId: DesktopSpeechModelId,
});
export type DesktopSpeechDownloadModelInput = typeof DesktopSpeechDownloadModelInput.Type;

export const DesktopSpeechCancelDownloadInput = Schema.Struct({
  modelId: DesktopSpeechModelId,
});
export type DesktopSpeechCancelDownloadInput = typeof DesktopSpeechCancelDownloadInput.Type;

export const DesktopSpeechRemoveModelInput = Schema.Struct({
  modelId: DesktopSpeechModelId,
});
export type DesktopSpeechRemoveModelInput = typeof DesktopSpeechRemoveModelInput.Type;

export const DesktopSpeechStartInput = Schema.Struct({});
export type DesktopSpeechStartInput = typeof DesktopSpeechStartInput.Type;

export const DesktopSpeechAudioSequence = NonNegativeInt.pipe(
  Schema.brand("DesktopSpeechAudioSequence"),
);
export type DesktopSpeechAudioSequence = typeof DesktopSpeechAudioSequence.Type;

export const DesktopSpeechPcm16 = Schema.Uint8Array.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(DESKTOP_SPEECH_MAX_PCM16_BATCH_BYTES),
  Schema.makeFilter((bytes) => bytes.byteLength % 2 === 0, {
    expected: "an even number of PCM16 bytes",
  }),
);
export type DesktopSpeechPcm16 = typeof DesktopSpeechPcm16.Type;

export const DesktopSpeechAudioInput = Schema.Struct({
  sessionId: DesktopSpeechSessionId,
  sequence: DesktopSpeechAudioSequence,
  sampleRate: Schema.Literal(DESKTOP_SPEECH_SAMPLE_RATE),
  pcm16: DesktopSpeechPcm16,
});
export type DesktopSpeechAudioInput = typeof DesktopSpeechAudioInput.Type;

export const DesktopSpeechStopInput = Schema.Struct({
  sessionId: DesktopSpeechSessionId,
});
export type DesktopSpeechStopInput = typeof DesktopSpeechStopInput.Type;

export const DesktopSpeechCancelInput = Schema.Struct({
  sessionId: DesktopSpeechSessionId,
});
export type DesktopSpeechCancelInput = typeof DesktopSpeechCancelInput.Type;

export const DesktopSpeechActionRejectionReason = Schema.Literals([
  "unsupported",
  "unknown-model",
  "already-installed",
  "not-installed",
  "download-in-progress",
  "no-download",
  "no-active-model",
  "session-in-progress",
  "no-session",
  "stale-session",
  "out-of-order-audio",
  "operation-failed",
]);
export type DesktopSpeechActionRejectionReason = typeof DesktopSpeechActionRejectionReason.Type;

export const DesktopSpeechActionRejected = Schema.Struct({
  type: Schema.Literal("rejected"),
  reason: DesktopSpeechActionRejectionReason,
  message: DisplaySafeText,
});
export type DesktopSpeechActionRejected = typeof DesktopSpeechActionRejected.Type;

const DesktopSpeechActionAccepted = Schema.Struct({
  type: Schema.Literal("accepted"),
});

export const DesktopSpeechActionResult = Schema.Union([
  DesktopSpeechActionAccepted,
  DesktopSpeechActionRejected,
]);
export type DesktopSpeechActionResult = typeof DesktopSpeechActionResult.Type;

export const DesktopSpeechSelectModelResult = DesktopSpeechActionResult;
export type DesktopSpeechSelectModelResult = typeof DesktopSpeechSelectModelResult.Type;

export const DesktopSpeechDownloadModelResult = DesktopSpeechActionResult;
export type DesktopSpeechDownloadModelResult = typeof DesktopSpeechDownloadModelResult.Type;

export const DesktopSpeechCancelDownloadResult = DesktopSpeechActionResult;
export type DesktopSpeechCancelDownloadResult = typeof DesktopSpeechCancelDownloadResult.Type;

export const DesktopSpeechRemoveModelResult = DesktopSpeechActionResult;
export type DesktopSpeechRemoveModelResult = typeof DesktopSpeechRemoveModelResult.Type;

export const DesktopSpeechStartResult = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("accepted"),
    sessionId: DesktopSpeechSessionId,
  }),
  DesktopSpeechActionRejected,
]);
export type DesktopSpeechStartResult = typeof DesktopSpeechStartResult.Type;

export const DesktopSpeechAudioResult = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("accepted"),
    sequence: DesktopSpeechAudioSequence,
  }),
  DesktopSpeechActionRejected,
]);
export type DesktopSpeechAudioResult = typeof DesktopSpeechAudioResult.Type;

export const DesktopSpeechStopResult = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("completed"),
    text: Schema.String,
  }),
  DesktopSpeechActionRejected,
]);
export type DesktopSpeechStopResult = typeof DesktopSpeechStopResult.Type;

export const DesktopSpeechCancelResult = DesktopSpeechActionResult;
export type DesktopSpeechCancelResult = typeof DesktopSpeechCancelResult.Type;
