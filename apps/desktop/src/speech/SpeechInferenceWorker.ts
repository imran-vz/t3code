import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface SpeechInferencePreview {
  readonly committed: string;
  readonly tentative: string;
  readonly revision: number;
}

const SpeechInferenceOperation = Schema.Literals([
  "spawn",
  "load",
  "start",
  "feed",
  "finalize",
  "cancel",
  "protocol",
]);
export type SpeechInferenceOperation = typeof SpeechInferenceOperation.Type;

const SpeechInferenceFailureReason = Schema.Literals([
  "unavailable",
  "invalid-state",
  "invalid-input",
  "capacity",
  "native",
  "cancelled",
  "protocol",
  "closed",
]);
export type SpeechInferenceFailureReason = typeof SpeechInferenceFailureReason.Type;

export class SpeechInferenceWorkerError extends Schema.TaggedErrorClass<SpeechInferenceWorkerError>()(
  "SpeechInferenceWorkerError",
  {
    operation: SpeechInferenceOperation,
    reason: SpeechInferenceFailureReason,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class SpeechInferenceWorkerCrash extends Schema.TaggedErrorClass<SpeechInferenceWorkerCrash>()(
  "SpeechInferenceWorkerCrash",
  {
    exitCode: Schema.NullOr(Schema.Int),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export type SpeechInferenceFailure = SpeechInferenceWorkerError | SpeechInferenceWorkerCrash;

export class SpeechInferenceWorker extends Context.Service<
  SpeechInferenceWorker,
  {
    readonly load: (modelPath: string) => Effect.Effect<void, SpeechInferenceFailure>;
    readonly start: () => Effect.Effect<void, SpeechInferenceFailure>;
    readonly feed: (
      samples: Float32Array<ArrayBuffer>,
    ) => Effect.Effect<SpeechInferencePreview | null, SpeechInferenceFailure>;
    readonly finalize: () => Effect.Effect<string, SpeechInferenceFailure>;
    readonly cancel: () => Effect.Effect<void, SpeechInferenceFailure>;
    readonly isAlive: Effect.Effect<boolean>;
    readonly awaitCrash: Effect.Effect<SpeechInferenceWorkerCrash>;
  }
>()("@t3tools/desktop/speech/SpeechInferenceWorker") {}

export const layerTest = (service: SpeechInferenceWorker["Service"]) =>
  Layer.succeed(SpeechInferenceWorker, service);
