import * as Schema from "effect/Schema";

const RequestId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const ModelPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));
const Samples = Schema.instanceOf(Float32Array);

export const SPEECH_FEED_MAX_SAMPLES = 3_200;

export function hasValidSpeechSamples(samples: Float32Array, maxSamples?: number): boolean {
  if (samples.length === 0 || (maxSamples !== undefined && samples.length > maxSamples)) {
    return false;
  }
  for (const sample of samples) {
    if (!Number.isFinite(sample) || sample < -1 || sample > 1) return false;
  }
  return true;
}

export function pcm16ToFloat32(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const samples = new Float32Array(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32_768;
  }
  return samples;
}

const LoadRequest = Schema.Struct({
  requestId: RequestId,
  type: Schema.Literal("load"),
  modelPath: ModelPath,
});
const StartRequest = Schema.Struct({
  requestId: RequestId,
  type: Schema.Literal("start"),
});
const FeedRequest = Schema.Struct({
  requestId: RequestId,
  type: Schema.Literal("feed"),
  samples: Samples,
});
const FinalizeRequest = Schema.Struct({
  requestId: RequestId,
  type: Schema.Literal("finalize"),
});
const CancelRequest = Schema.Struct({
  requestId: RequestId,
  type: Schema.Literal("cancel"),
});

export const SpeechWorkerRequest = Schema.Union([
  LoadRequest,
  StartRequest,
  FeedRequest,
  FinalizeRequest,
  CancelRequest,
]);
export type SpeechWorkerRequest = typeof SpeechWorkerRequest.Type;

export const SpeechWorkerPreview = Schema.Struct({
  committed: Schema.String,
  tentative: Schema.String,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type SpeechWorkerPreview = typeof SpeechWorkerPreview.Type;

const LoadedResult = Schema.Struct({ type: Schema.Literal("loaded") });
const StartedResult = Schema.Struct({ type: Schema.Literal("started") });
const FeedResult = Schema.Struct({
  type: Schema.Literal("feed"),
  preview: Schema.NullOr(SpeechWorkerPreview),
});
const FinalizedResult = Schema.Struct({
  type: Schema.Literal("finalized"),
  text: Schema.String,
});
const CancelledResult = Schema.Struct({ type: Schema.Literal("cancelled") });

export const SpeechWorkerResult = Schema.Union([
  LoadedResult,
  StartedResult,
  FeedResult,
  FinalizedResult,
  CancelledResult,
]);
export type SpeechWorkerResult = typeof SpeechWorkerResult.Type;
export type SpeechWorkerResultType = SpeechWorkerResult["type"];

export const SpeechWorkerFailureCode = Schema.Literals([
  "invalid-state",
  "invalid-message",
  "capacity",
  "native",
  "cancelled",
]);
export type SpeechWorkerFailureCode = typeof SpeechWorkerFailureCode.Type;

const SuccessResponse = Schema.Struct({
  requestId: RequestId,
  type: Schema.Literal("success"),
  result: SpeechWorkerResult,
});
const FailureResponse = Schema.Struct({
  requestId: RequestId,
  type: Schema.Literal("failure"),
  code: SpeechWorkerFailureCode,
  message: Schema.String,
});

export const SpeechWorkerResponse = Schema.Union([SuccessResponse, FailureResponse]);
export type SpeechWorkerResponse = typeof SpeechWorkerResponse.Type;
