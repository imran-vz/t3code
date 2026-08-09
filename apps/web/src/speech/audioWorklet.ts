import { DESKTOP_SPEECH_SAMPLE_RATE } from "@t3tools/contracts";

export const DESKTOP_SPEECH_AUDIO_WORKLET_NAME = "t3-desktop-speech-pcm16";
export const DESKTOP_SPEECH_BATCH_DURATION_MS = 160;
export const DESKTOP_SPEECH_BATCH_SAMPLES =
  (DESKTOP_SPEECH_SAMPLE_RATE * DESKTOP_SPEECH_BATCH_DURATION_MS) / 1_000;
const DESKTOP_SPEECH_BATCH_BYTES = DESKTOP_SPEECH_BATCH_SAMPLES * 2;

export type DesktopSpeechAudioWorkletMessage =
  | { readonly type: "pcm16"; readonly pcm16: ArrayBuffer }
  | { readonly type: "drained" };

export interface DesktopSpeechAudioWorkletStopMessage {
  readonly type: "stop";
}

function pcm16MonoFrameCount(inputChannels: readonly Float32Array[]): number {
  let frameCount = 0;
  for (const channel of inputChannels) frameCount = Math.max(frameCount, channel.length);
  return frameCount;
}

function writePcm16Mono(
  inputChannels: readonly Float32Array[],
  output: Uint8Array,
  inputFrameOffset: number,
  outputByteOffset: number,
  frameCount: number,
): void {
  for (let relativeFrame = 0; relativeFrame < frameCount; relativeFrame += 1) {
    const frame = inputFrameOffset + relativeFrame;
    let mixed = 0;
    for (const channel of inputChannels) mixed += channel[frame] ?? 0;

    const mono = mixed / inputChannels.length;
    const finiteMono = Number.isFinite(mono) ? mono : 0;
    const clamped = Math.max(-1, Math.min(1, finiteMono));
    const sample = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
    const offset = outputByteOffset + relativeFrame * 2;
    output[offset] = sample & 0xff;
    output[offset + 1] = (sample >> 8) & 0xff;
  }
}

export function createPcm16WorkletBatcher(onBatch: (pcm16: ArrayBuffer) => void) {
  let batch = new Uint8Array(DESKTOP_SPEECH_BATCH_BYTES);
  let bufferedSamples = 0;

  const emit = () => {
    if (bufferedSamples === 0) return;
    const byteLength = bufferedSamples * 2;
    const pcm16 =
      byteLength === batch.byteLength
        ? (batch.buffer as ArrayBuffer)
        : (batch.buffer.slice(0, byteLength) as ArrayBuffer);
    batch = new Uint8Array(DESKTOP_SPEECH_BATCH_BYTES);
    bufferedSamples = 0;
    onBatch(pcm16);
  };

  return {
    append(inputChannels: readonly Float32Array[]) {
      const inputSamples = pcm16MonoFrameCount(inputChannels);
      let inputOffset = 0;
      while (inputOffset < inputSamples) {
        const writableSamples = Math.min(
          inputSamples - inputOffset,
          DESKTOP_SPEECH_BATCH_SAMPLES - bufferedSamples,
        );
        writePcm16Mono(inputChannels, batch, inputOffset, bufferedSamples * 2, writableSamples);
        inputOffset += writableSamples;
        bufferedSamples += writableSamples;
        if (bufferedSamples === DESKTOP_SPEECH_BATCH_SAMPLES) emit();
      }
    },
    flush: emit,
  };
}

/**
 * Averages every input channel, clamps the result, and writes signed PCM16 in
 * little-endian byte order. Kept self-contained so the same function body can
 * run inside the generated AudioWorklet module.
 */
export function encodePcm16Mono(inputChannels: readonly Float32Array[]): Uint8Array {
  const frameCount = pcm16MonoFrameCount(inputChannels);

  if (frameCount === 0 || inputChannels.length === 0) {
    return new Uint8Array();
  }

  const pcm16 = new Uint8Array(frameCount * 2);
  writePcm16Mono(inputChannels, pcm16, 0, 0, frameCount);

  return pcm16;
}
