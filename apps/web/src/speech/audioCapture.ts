import {
  DESKTOP_SPEECH_SAMPLE_RATE,
  type DesktopSpeechAudioInput,
  type DesktopSpeechAudioResult,
  type DesktopSpeechAudioSequence,
  type DesktopSpeechPcm16,
  type DesktopSpeechSessionId,
} from "@t3tools/contracts";

import {
  DESKTOP_SPEECH_AUDIO_WORKLET_NAME,
  type DesktopSpeechAudioWorkletMessage,
  type DesktopSpeechAudioWorkletStopMessage,
} from "./audioWorklet";
import desktopSpeechAudioWorkletUrl from "./audioWorkletProcessor.ts?worker&url";

export const DESKTOP_SPEECH_MAX_BUFFERED_AUDIO_MS = 640;
export const DESKTOP_SPEECH_CAPTURE_STOP_TIMEOUT_MS = 5_000;

export const DESKTOP_SPEECH_MEDIA_CONSTRAINTS = {
  audio: {
    autoGainControl: false,
    echoCancellation: false,
    noiseSuppression: false,
  },
  video: false,
} as const satisfies MediaStreamConstraints;

export type DesktopSpeechCaptureErrorCode =
  | "permission-denied"
  | "unsupported-sample-rate"
  | "worklet-load-failed"
  | "invalid-worklet-message"
  | "backpressure"
  | "push-failed"
  | "stop-timeout";

export class DesktopSpeechCaptureError extends Error {
  readonly code: DesktopSpeechCaptureErrorCode;
  override readonly cause: unknown;

  constructor(code: DesktopSpeechCaptureErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "DesktopSpeechCaptureError";
    this.code = code;
    this.cause = cause;
  }
}

export interface DesktopSpeechMediaTrack {
  stop(): void;
}

export interface DesktopSpeechMediaStream {
  getTracks(): readonly DesktopSpeechMediaTrack[];
}

export interface DesktopSpeechCaptureNode {
  connect(destination: unknown): void;
  disconnect(): void;
}

export type DesktopSpeechCaptureMessagePort = Pick<
  MessagePort,
  "addEventListener" | "removeEventListener" | "postMessage" | "start" | "close"
>;

export interface DesktopSpeechCaptureWorkletNode extends DesktopSpeechCaptureNode {
  readonly port: DesktopSpeechCaptureMessagePort;
}

export interface DesktopSpeechCaptureContext {
  readonly sampleRate: number;
  readonly destination: unknown;
  readonly audioWorklet: {
    addModule(moduleUrl: string): Promise<void>;
  };
  resume(): Promise<void>;
  close(): Promise<void>;
}

export interface DesktopSpeechCaptureEnvironment {
  getUserMedia(constraints: MediaStreamConstraints): Promise<DesktopSpeechMediaStream>;
  createAudioContext(options: AudioContextOptions): DesktopSpeechCaptureContext;
  createSourceNode(
    context: DesktopSpeechCaptureContext,
    stream: DesktopSpeechMediaStream,
  ): DesktopSpeechCaptureNode;
  createWorkletNode(
    context: DesktopSpeechCaptureContext,
    processorName: string,
  ): DesktopSpeechCaptureWorkletNode;
  readonly workletModuleUrl: string;
  addUnloadListener(listener: () => void): void;
  removeUnloadListener(listener: () => void): void;
}

function assertEvenPcm16(pcm16: Uint8Array): void {
  if (pcm16.byteLength % 2 !== 0) {
    throw new DesktopSpeechCaptureError(
      "invalid-worklet-message",
      "Voice input received malformed microphone audio.",
    );
  }
}

export interface DesktopSpeechAudioCapture {
  /** Flushes the final short batch and waits for every accepted push. */
  stop(): Promise<void>;
  /** Discards unsent audio and releases browser resources. */
  cancel(): Promise<void>;
}

export interface StartDesktopSpeechAudioCaptureOptions {
  readonly sessionId: DesktopSpeechSessionId;
  readonly pushAudio: (input: DesktopSpeechAudioInput) => Promise<DesktopSpeechAudioResult>;
  readonly onError?: (error: DesktopSpeechCaptureError) => void;
  readonly onUnexpectedClose?: () => void;
  readonly environment?: DesktopSpeechCaptureEnvironment;
}

export type DesktopSpeechAudioCaptureFactory = (
  options: StartDesktopSpeechAudioCaptureOptions,
) => Promise<DesktopSpeechAudioCapture>;

function createBrowserCaptureEnvironment(): DesktopSpeechCaptureEnvironment {
  return {
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createAudioContext: (options) => new AudioContext(options),
    createSourceNode: (context, stream) =>
      (context as AudioContext).createMediaStreamSource(stream as MediaStream),
    createWorkletNode: (context, processorName) =>
      new AudioWorkletNode(context as AudioContext, processorName, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      }),
    workletModuleUrl: desktopSpeechAudioWorkletUrl,
    addUnloadListener: (listener) => window.addEventListener("beforeunload", listener),
    removeUnloadListener: (listener) => window.removeEventListener("beforeunload", listener),
  };
}

function isPcm16Message(
  value: unknown,
): value is Extract<DesktopSpeechAudioWorkletMessage, { readonly type: "pcm16" }> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readonly type?: unknown; readonly pcm16?: unknown };
  return candidate.type === "pcm16" && candidate.pcm16 instanceof ArrayBuffer;
}

function isDrainedMessage(value: unknown): value is DesktopSpeechAudioWorkletMessage {
  if (typeof value !== "object" || value === null) return false;
  return (value as { readonly type?: unknown }).type === "drained";
}

function toCaptureError(error: unknown): DesktopSpeechCaptureError {
  if (error instanceof DesktopSpeechCaptureError) return error;
  return new DesktopSpeechCaptureError(
    "push-failed",
    "Voice input could not keep up with microphone audio. You can try again.",
    error,
  );
}

function withStopTimeout<T>(promise: Promise<T>, stage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      reject(
        new DesktopSpeechCaptureError(
          "stop-timeout",
          `Voice input timed out while ${stage}. The recording was canceled.`,
        ),
      );
    }, DESKTOP_SPEECH_CAPTURE_STOP_TIMEOUT_MS);
    promise.then(
      (value) => {
        globalThis.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export async function startDesktopSpeechAudioCapture(
  options: StartDesktopSpeechAudioCaptureOptions,
): Promise<DesktopSpeechAudioCapture> {
  const environment = options.environment ?? createBrowserCaptureEnvironment();
  const maxBufferedBytes =
    (DESKTOP_SPEECH_SAMPLE_RATE * DESKTOP_SPEECH_MAX_BUFFERED_AUDIO_MS * 2) / 1_000;

  type CaptureState = "active" | "stopping" | "stopped" | "canceled" | "failed";
  let state: CaptureState = "active";
  let nextSequence = 0;
  let failure: DesktopSpeechCaptureError | undefined;
  let activePush: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const queued: Uint8Array[] = [];
  const drainWaiters = new Set<() => void>();
  const releaseDrainWaiters = () => {
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  };
  const readState = (): CaptureState => state;

  let stream: DesktopSpeechMediaStream;
  try {
    stream = await environment.getUserMedia(DESKTOP_SPEECH_MEDIA_CONSTRAINTS);
  } catch (error) {
    throw new DesktopSpeechCaptureError(
      "permission-denied",
      "Microphone access was not granted. Check system permissions and try again.",
      error,
    );
  }

  let context: DesktopSpeechCaptureContext | undefined;
  let sourceNode: DesktopSpeechCaptureNode | undefined;
  let workletNode: DesktopSpeechCaptureWorkletNode | undefined;
  let unloadListenerInstalled = false;
  let closePromise: Promise<void> | undefined;
  let inputStopped = false;
  let resolveWorkletDrain: (() => void) | undefined;
  let rejectWorkletDrain: ((error: DesktopSpeechCaptureError) => void) | undefined;
  let handleWorkletMessage: ((event: MessageEvent<unknown>) => void) | undefined;
  let handleWorkletMessageError: (() => void) | undefined;

  const cleanupSafely = (cleanup: () => void) => {
    try {
      cleanup();
    } catch {
      // Resource cleanup is best-effort so one broken browser handle cannot
      // prevent the remaining microphone resources from being released.
    }
  };

  const stopInput = () => {
    if (inputStopped) return;
    inputStopped = true;
    cleanupSafely(() => sourceNode?.disconnect());
    for (const track of stream.getTracks()) {
      cleanupSafely(() => track.stop());
    }
  };

  const closeResources = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;

    rejectWorkletDrain?.(
      new DesktopSpeechCaptureError(
        "push-failed",
        "Voice input recording ended before microphone audio could be drained.",
      ),
    );
    resolveWorkletDrain = undefined;
    rejectWorkletDrain = undefined;

    if (unloadListenerInstalled) {
      cleanupSafely(() => environment.removeUnloadListener(handleUnload));
      unloadListenerInstalled = false;
    }
    if (workletNode !== undefined) {
      if (handleWorkletMessage !== undefined) {
        workletNode.port.removeEventListener("message", handleWorkletMessage);
      }
      if (handleWorkletMessageError !== undefined) {
        workletNode.port.removeEventListener("messageerror", handleWorkletMessageError);
      }
      cleanupSafely(() => workletNode?.port.close());
      cleanupSafely(() => workletNode?.disconnect());
    }
    stopInput();
    queued.length = 0;
    releaseDrainWaiters();

    closePromise =
      context === undefined
        ? Promise.resolve()
        : Promise.resolve()
            .then(() => context?.close())
            .catch(() => undefined);
    return closePromise;
  };

  try {
    context = environment.createAudioContext({ sampleRate: DESKTOP_SPEECH_SAMPLE_RATE });
    if (context.sampleRate !== DESKTOP_SPEECH_SAMPLE_RATE) {
      throw new DesktopSpeechCaptureError(
        "unsupported-sample-rate",
        `Voice input requires a ${DESKTOP_SPEECH_SAMPLE_RATE.toLocaleString()} Hz audio context.`,
      );
    }

    try {
      await context.audioWorklet.addModule(environment.workletModuleUrl);
    } catch (error) {
      throw new DesktopSpeechCaptureError(
        "worklet-load-failed",
        "Voice input could not initialize microphone processing.",
        error,
      );
    }

    sourceNode = environment.createSourceNode(context, stream);
    workletNode = environment.createWorkletNode(context, DESKTOP_SPEECH_AUDIO_WORKLET_NAME);
  } catch (error) {
    await closeResources();
    throw error;
  }

  const waitingBytes = () => queued.reduce((total, batch) => total + batch.byteLength, 0);

  const settleDrainWaiters = () => {
    if (activePush !== undefined || queued.length > 0) return;
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  };

  const fail = (error: unknown) => {
    if (state === "failed" || state === "stopped" || state === "canceled") return;
    failure = toCaptureError(error);
    state = "failed";
    rejectWorkletDrain?.(failure);
    resolveWorkletDrain = undefined;
    rejectWorkletDrain = undefined;
    void closeResources();
    options.onError?.(failure);
    settleDrainWaiters();
  };

  const pump = () => {
    if (activePush !== undefined || queued.length === 0) {
      settleDrainWaiters();
      return;
    }
    if (state !== "active" && state !== "stopping") return;

    const pcm16 = queued.shift();
    if (pcm16 === undefined) return;
    const sequence = nextSequence as DesktopSpeechAudioSequence;
    nextSequence += 1;
    activePush = options
      .pushAudio({
        sessionId: options.sessionId,
        sequence,
        sampleRate: DESKTOP_SPEECH_SAMPLE_RATE,
        pcm16: pcm16 as DesktopSpeechPcm16,
      })
      .then((result) => {
        if (state === "canceled") return;
        if (result.type !== "accepted" || result.sequence !== sequence) {
          throw new DesktopSpeechCaptureError(
            "push-failed",
            "Voice input stopped because the desktop audio stream was rejected. You can try again.",
          );
        }
      })
      .catch(fail)
      .finally(() => {
        activePush = undefined;
        pump();
        settleDrainWaiters();
      });
  };

  const waitForDrain = (): Promise<void> => {
    if (activePush === undefined && queued.length === 0) return Promise.resolve();
    return new Promise((resolve) => drainWaiters.add(resolve));
  };

  const acceptPcm16 = (pcm16: Uint8Array) => {
    if (state !== "active" && state !== "stopping") return;
    try {
      assertEvenPcm16(pcm16);
    } catch (error) {
      fail(error);
      return;
    }
    if (pcm16.byteLength === 0) return;
    queued.push(pcm16);
    pump();

    if (waitingBytes() > maxBufferedBytes) {
      fail(
        new DesktopSpeechCaptureError(
          "backpressure",
          "Voice input could not keep up with microphone audio. You can try again.",
        ),
      );
    }
  };

  function handleUnload() {
    if (state !== "active" && state !== "stopping") return;
    state = "canceled";
    void closeResources();
    settleDrainWaiters();
    options.onUnexpectedClose?.();
  }

  handleWorkletMessage = (event) => {
    if (isDrainedMessage(event.data)) {
      resolveWorkletDrain?.();
      resolveWorkletDrain = undefined;
      rejectWorkletDrain = undefined;
      return;
    }
    if (!isPcm16Message(event.data)) {
      fail(
        new DesktopSpeechCaptureError(
          "invalid-worklet-message",
          "Voice input received malformed microphone audio.",
        ),
      );
      return;
    }
    acceptPcm16(new Uint8Array(event.data.pcm16));
  };
  handleWorkletMessageError = () => {
    fail(
      new DesktopSpeechCaptureError(
        "invalid-worklet-message",
        "Voice input could not read microphone audio.",
      ),
    );
  };
  workletNode.port.addEventListener("message", handleWorkletMessage);
  workletNode.port.addEventListener("messageerror", handleWorkletMessageError);
  workletNode.port.start();

  try {
    environment.addUnloadListener(handleUnload);
    unloadListenerInstalled = true;
    sourceNode.connect(workletNode);
    workletNode.connect(context.destination);
    await context.resume();
  } catch (error) {
    fail(error);
    await closeResources();
    throw failure;
  }

  return {
    stop: () => {
      if (stopPromise !== undefined) return stopPromise;
      stopPromise = (async () => {
        if (state === "stopped") return;
        if (readState() === "canceled") {
          throw new DesktopSpeechCaptureError(
            "push-failed",
            "Voice input recording was already canceled.",
          );
        }
        if (failure !== undefined) {
          await closeResources();
          throw failure;
        }

        state = "stopping";
        try {
          await withStopTimeout(
            new Promise<void>((resolve, reject) => {
              resolveWorkletDrain = resolve;
              rejectWorkletDrain = reject;
              try {
                workletNode.port.postMessage(
                  {
                    type: "stop",
                  } satisfies DesktopSpeechAudioWorkletStopMessage,
                  [],
                );
              } catch (error) {
                fail(error);
              }
            }),
            "draining microphone processing",
          );
          workletNode.port.removeEventListener("message", handleWorkletMessage);
          stopInput();
          pump();
          await withStopTimeout(waitForDrain(), "sending the final microphone audio");
        } catch (error) {
          failure = toCaptureError(error);
          state = "failed";
          resolveWorkletDrain = undefined;
          rejectWorkletDrain = undefined;
          await closeResources();
          throw failure;
        }
        if (readState() === "canceled") {
          throw new DesktopSpeechCaptureError(
            "push-failed",
            "Voice input recording ended before it could be finalized.",
          );
        }
        if (failure !== undefined) {
          await closeResources();
          throw failure;
        }
        state = "stopped";
        await closeResources();
      })();
      return stopPromise;
    },
    cancel: async () => {
      if (state === "canceled" || state === "stopped") {
        await closeResources();
        return;
      }
      state = "canceled";
      await closeResources();
      settleDrainWaiters();
    },
  };
}
