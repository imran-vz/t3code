import {
  DESKTOP_SPEECH_AUDIO_WORKLET_NAME,
  createPcm16WorkletBatcher,
  type DesktopSpeechAudioWorkletMessage,
  type DesktopSpeechAudioWorkletStopMessage,
} from "./audioWorklet";

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

class DesktopSpeechPcm16Processor extends AudioWorkletProcessor {
  private stopped = false;
  private readonly batcher = createPcm16WorkletBatcher((pcm16) => {
    this.port.postMessage({ type: "pcm16", pcm16 } satisfies DesktopSpeechAudioWorkletMessage, [
      pcm16,
    ]);
  });

  constructor() {
    super();
    this.port.addEventListener(
      "message",
      (event: MessageEvent<DesktopSpeechAudioWorkletStopMessage>) => {
        if (event.data.type !== "stop" || this.stopped) return;
        this.stopped = true;
        this.batcher.flush();
        this.port.postMessage({ type: "drained" } satisfies DesktopSpeechAudioWorkletMessage, []);
      },
    );
    this.port.start();
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    this.batcher.append(inputs[0] ?? []);
    return true;
  }
}

registerProcessor(DESKTOP_SPEECH_AUDIO_WORKLET_NAME, DesktopSpeechPcm16Processor);
