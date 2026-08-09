import {
  type DesktopSpeechAudioInput,
  type DesktopSpeechAudioResult,
  type DesktopSpeechBridge,
  type DesktopSpeechSessionId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  DESKTOP_SPEECH_CAPTURE_STOP_TIMEOUT_MS,
  DESKTOP_SPEECH_MEDIA_CONSTRAINTS,
  DesktopSpeechCaptureError,
  startDesktopSpeechAudioCapture,
  type DesktopSpeechCaptureContext,
  type DesktopSpeechCaptureEnvironment,
  type DesktopSpeechCaptureMessagePort,
  type DesktopSpeechCaptureNode,
  type DesktopSpeechCaptureWorkletNode,
} from "./audioCapture";
import { startDesktopSpeechRecording } from "./desktopSpeech";
import {
  createPcm16WorkletBatcher,
  DESKTOP_SPEECH_AUDIO_WORKLET_NAME,
  DESKTOP_SPEECH_BATCH_SAMPLES,
  encodePcm16Mono,
} from "./audioWorklet";

const SESSION_ID = "session-1" as DesktopSpeechSessionId;
const pcm16 = (byteLength: number, fill = 1) => new Uint8Array(byteLength).fill(fill).buffer;

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

class FakeMessagePort implements DesktopSpeechCaptureMessagePort {
  readonly close = vi.fn();
  readonly start = vi.fn();
  readonly messageListeners = new Set<(event: MessageEvent<unknown>) => void>();
  readonly errorListeners = new Set<() => void>();
  readonly postMessage = vi.fn((message: unknown) => {
    if (
      this.autoDrain &&
      typeof message === "object" &&
      message !== null &&
      (message as { readonly type?: unknown }).type === "stop"
    ) {
      this.emit({ type: "drained" });
    }
  });

  constructor(private readonly autoDrain: boolean) {}

  addEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject | null) => {
    if (typeof listener !== "function") return;
    if (type === "message") this.messageListeners.add(listener as never);
    if (type === "messageerror") this.errorListeners.add(listener as never);
  }) as MessagePort["addEventListener"];
  removeEventListener = vi.fn(
    (type: string, listener: EventListenerOrEventListenerObject | null) => {
      if (typeof listener !== "function") return;
      if (type === "message") this.messageListeners.delete(listener as never);
      if (type === "messageerror") this.errorListeners.delete(listener as never);
    },
  ) as MessagePort["removeEventListener"];

  emit(data: unknown) {
    const event = new MessageEvent("message", { data });
    for (const listener of this.messageListeners) listener(event);
  }
}

function createHarness(options?: {
  readonly sampleRate?: number;
  readonly getUserMediaError?: unknown;
  readonly manualDrain?: boolean;
}) {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] };
  const source = { connect: vi.fn(), disconnect: vi.fn() } satisfies DesktopSpeechCaptureNode;
  const port = new FakeMessagePort(options?.manualDrain !== true);
  const worklet: DesktopSpeechCaptureWorkletNode = {
    port,
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const context: DesktopSpeechCaptureContext = {
    sampleRate: options?.sampleRate ?? 16_000,
    destination: {},
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  let unload: (() => void) | undefined;
  const environment: DesktopSpeechCaptureEnvironment = {
    getUserMedia: vi.fn(async () => {
      if (options?.getUserMediaError) throw options.getUserMediaError;
      return stream;
    }),
    createAudioContext: vi.fn(() => context),
    createSourceNode: vi.fn(() => source),
    createWorkletNode: vi.fn(() => worklet),
    workletModuleUrl: "t3code://app/assets/speech.js",
    addUnloadListener: vi.fn((listener) => {
      unload = listener;
    }),
    removeUnloadListener: vi.fn((listener) => {
      if (unload === listener) unload = undefined;
    }),
  };
  return { context, environment, port, source, track, worklet, triggerUnload: () => unload?.() };
}

const emitPcm16 = (port: FakeMessagePort, buffer: ArrayBuffer) =>
  port.emit({ type: "pcm16", pcm16: buffer });

describe("desktop speech AudioWorklet", () => {
  it("encodes clamped mono PCM16 and flushes the final short batch", () => {
    const bytes = encodePcm16Mono([new Float32Array([1, -1, 2]), new Float32Array([1, 1, 2])]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect([view.getInt16(0, true), view.getInt16(2, true), view.getInt16(4, true)]).toEqual([
      32_767, 0, 32_767,
    ]);
    expect(DESKTOP_SPEECH_AUDIO_WORKLET_NAME).toBe("t3-desktop-speech-pcm16");

    const batches: Uint8Array[] = [];
    const batcher = createPcm16WorkletBatcher((buffer) => batches.push(new Uint8Array(buffer)));
    batcher.append([new Float32Array(DESKTOP_SPEECH_BATCH_SAMPLES).fill(0.5)]);
    batcher.append([new Float32Array([1, -1])]);
    batcher.flush();
    expect(batches.map((batch) => batch.byteLength)).toEqual([DESKTOP_SPEECH_BATCH_SAMPLES * 2, 4]);
  });
});

describe("desktop speech audio capture", () => {
  it("uses audio-only constraints, a 16 kHz worklet, and complete cleanup", async () => {
    const harness = createHarness();
    const capture = await startDesktopSpeechAudioCapture({
      sessionId: SESSION_ID,
      pushAudio: vi.fn(),
      environment: harness.environment,
    });
    expect(harness.environment.getUserMedia).toHaveBeenCalledWith(DESKTOP_SPEECH_MEDIA_CONSTRAINTS);
    expect(harness.environment.createAudioContext).toHaveBeenCalledWith({ sampleRate: 16_000 });
    await capture.cancel();
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.source.disconnect).toHaveBeenCalledOnce();
    expect(harness.worklet.disconnect).toHaveBeenCalledOnce();
    expect(harness.context.close).toHaveBeenCalledOnce();
  });

  it("preserves sequence order with exactly one push in flight", async () => {
    const harness = createHarness();
    const pending: Array<ReturnType<typeof deferred<DesktopSpeechAudioResult>>> = [];
    const inputs: DesktopSpeechAudioInput[] = [];
    const capture = await startDesktopSpeechAudioCapture({
      sessionId: SESSION_ID,
      pushAudio: vi.fn((input: DesktopSpeechAudioInput) => {
        inputs.push(input);
        const next = deferred<DesktopSpeechAudioResult>();
        pending.push(next);
        return next.promise;
      }),
      environment: harness.environment,
    });
    emitPcm16(harness.port, pcm16(5_120, 1));
    emitPcm16(harness.port, pcm16(5_120, 2));
    expect(inputs).toHaveLength(1);
    pending[0]!.resolve({ type: "accepted", sequence: inputs[0]!.sequence });
    await flushPromises();
    expect(inputs.map((input) => input.sequence)).toEqual([0, 1]);
    const stopping = capture.stop();
    pending[1]!.resolve({ type: "accepted", sequence: inputs[1]!.sequence });
    await stopping;
  });

  it("fails instead of dropping middle audio when buffering is bounded", async () => {
    const harness = createHarness();
    const first = deferred<DesktopSpeechAudioResult>();
    const onError = vi.fn();
    const capture = await startDesktopSpeechAudioCapture({
      sessionId: SESSION_ID,
      pushAudio: vi.fn(() => first.promise),
      onError,
      environment: harness.environment,
    });
    for (let index = 0; index < 6; index += 1) emitPcm16(harness.port, pcm16(5_120));
    await flushPromises();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "backpressure" }));
    first.resolve({ type: "accepted", sequence: 0 as never });
    await expect(capture.stop()).rejects.toMatchObject({ code: "backpressure" });
  });

  it("drains final worklet audio before resolving stop", async () => {
    const harness = createHarness({ manualDrain: true });
    const inputs: DesktopSpeechAudioInput[] = [];
    const capture = await startDesktopSpeechAudioCapture({
      sessionId: SESSION_ID,
      pushAudio: vi.fn(async (input: DesktopSpeechAudioInput) => {
        inputs.push(input);
        return { type: "accepted" as const, sequence: input.sequence };
      }),
      environment: harness.environment,
    });
    const stopping = capture.stop();
    emitPcm16(harness.port, pcm16(800, 9));
    harness.port.emit({ type: "drained" });
    await stopping;
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.pcm16).toEqual(new Uint8Array(800).fill(9));
  });

  it("bounds a missing worklet drain and releases the microphone", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ manualDrain: true });
      const capture = await startDesktopSpeechAudioCapture({
        sessionId: SESSION_ID,
        pushAudio: vi.fn(),
        environment: harness.environment,
      });
      const stopping = capture.stop();
      const rejected = expect(stopping).rejects.toMatchObject({ code: "stop-timeout" });
      await vi.advanceTimersByTimeAsync(DESKTOP_SPEECH_CAPTURE_STOP_TIMEOUT_MS);
      await rejected;
      expect(harness.track.stop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects permission, sample-rate, and malformed-message failures safely", async () => {
    const denied = createHarness({ getUserMediaError: new Error("denied") });
    await expect(
      startDesktopSpeechAudioCapture({
        sessionId: SESSION_ID,
        pushAudio: vi.fn(),
        environment: denied.environment,
      }),
    ).rejects.toMatchObject({ code: "permission-denied" });
    expect(denied.environment.createAudioContext).not.toHaveBeenCalled();

    const wrongRate = createHarness({ sampleRate: 48_000 });
    await expect(
      startDesktopSpeechAudioCapture({
        sessionId: SESSION_ID,
        pushAudio: vi.fn(),
        environment: wrongRate.environment,
      }),
    ).rejects.toMatchObject({ code: "unsupported-sample-rate" });

    const malformed = createHarness();
    const onError = vi.fn();
    const capture = await startDesktopSpeechAudioCapture({
      sessionId: SESSION_ID,
      pushAudio: vi.fn(),
      onError,
      environment: malformed.environment,
    });
    malformed.port.emit({ type: "pcm16", pcm16: "invalid" });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "invalid-worklet-message" }),
    );
    await expect(capture.stop()).rejects.toMatchObject({ code: "invalid-worklet-message" });
  });

  it("reports unload as unexpected cleanup", async () => {
    const harness = createHarness();
    const onUnexpectedClose = vi.fn();
    const capture = await startDesktopSpeechAudioCapture({
      sessionId: SESSION_ID,
      pushAudio: vi.fn(),
      onUnexpectedClose,
      environment: harness.environment,
    });
    harness.triggerUnload();
    await flushPromises();
    expect(onUnexpectedClose).toHaveBeenCalledOnce();
    expect(harness.track.stop).toHaveBeenCalledOnce();
    await capture.cancel();
  });
});

function speechBridge(overrides: Partial<DesktopSpeechBridge> = {}): DesktopSpeechBridge {
  return {
    getState: vi.fn(),
    selectModel: vi.fn(),
    downloadModel: vi.fn(),
    cancelDownload: vi.fn(),
    removeModel: vi.fn(),
    start: vi.fn(async () => ({ type: "accepted", sessionId: SESSION_ID })),
    pushAudio: vi.fn(),
    stop: vi.fn(async () => ({ type: "completed", text: "hello" })),
    cancel: vi.fn(async () => ({ type: "accepted" })),
    onStateChange: vi.fn(() => vi.fn()),
    onPreviewChange: vi.fn(() => vi.fn()),
    ...overrides,
  } as DesktopSpeechBridge;
}

describe("desktop speech recording facade", () => {
  it("drains capture before finalizing and returns text without submitting", async () => {
    const calls: string[] = [];
    const result = await startDesktopSpeechRecording({
      speech: speechBridge({
        stop: vi.fn(async () => {
          calls.push("desktop-stop");
          return { type: "completed" as const, text: "hello world" };
        }),
      }),
      captureFactory: vi.fn(async () => ({
        stop: async () => {
          calls.push("capture-stop");
        },
        cancel: vi.fn(),
      })),
    });
    expect(result.type).toBe("accepted");
    if (result.type !== "accepted") return;
    await expect(result.recording.stop()).resolves.toEqual({
      type: "completed",
      text: "hello world",
    });
    expect(calls).toEqual(["capture-stop", "desktop-stop"]);
  });

  it("cancels the desktop session when microphone setup fails", async () => {
    const cancel = vi.fn(async () => ({ type: "accepted" as const }));
    const error = new DesktopSpeechCaptureError("permission-denied", "Permission denied.");
    await expect(
      startDesktopSpeechRecording({
        speech: speechBridge({ cancel }),
        captureFactory: vi.fn(async () => {
          throw error;
        }),
      }),
    ).rejects.toBe(error);
    expect(cancel).toHaveBeenCalledWith(SESSION_ID);
  });

  it("discards capture before canceling the desktop stream", async () => {
    const calls: string[] = [];
    const result = await startDesktopSpeechRecording({
      speech: speechBridge({
        cancel: vi.fn(async () => {
          calls.push("desktop-cancel");
          return { type: "accepted" as const };
        }),
      }),
      captureFactory: vi.fn(async () => ({
        stop: vi.fn(),
        cancel: async () => {
          calls.push("capture-cancel");
        },
      })),
    });
    expect(result.type).toBe("accepted");
    if (result.type !== "accepted") return;
    await result.recording.cancel();
    expect(calls).toEqual(["capture-cancel", "desktop-cancel"]);
  });
});
