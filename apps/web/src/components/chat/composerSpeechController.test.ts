import type {
  DesktopSpeechBridge,
  DesktopSpeechModelId,
  DesktopSpeechPreviewDelta,
  DesktopSpeechSessionId,
  DesktopSpeechState,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type {
  DesktopSpeechRecording,
  DesktopSpeechRecordingStartResult,
} from "../../speech/desktopSpeech";
import {
  createComposerSpeechController,
  type ComposerSpeechViewState,
} from "./composerSpeechController";

const modelId = "moonshine-streaming-medium" as DesktopSpeechModelId;
const sessionId = "speech-session-1" as DesktopSpeechSessionId;
const otherSessionId = "speech-session-stale" as DesktopSpeechSessionId;
const previewRevision = (value: number) => value as DesktopSpeechPreviewDelta["revision"];

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function speechState(options?: {
  readonly selectedModelId?: DesktopSpeechModelId | null;
  readonly installed?: boolean;
  readonly session?: DesktopSpeechState["session"];
  readonly revision?: number;
  readonly committed?: string;
  readonly tentative?: string;
  readonly unsupportedReason?: string;
}): DesktopSpeechState {
  return {
    availability:
      options?.unsupportedReason === undefined
        ? { type: "supported" }
        : { type: "unsupported", reason: options.unsupportedReason },
    models: [
      {
        catalogEntry: { id: modelId },
        installation: { type: options?.installed === false ? "not-installed" : "installed" },
        download: { type: "idle" },
      },
    ],
    selectedModelId: options?.selectedModelId === undefined ? modelId : options.selectedModelId,
    session: options?.session ?? { type: "idle" },
    preview: {
      revision: options?.revision ?? 0,
      committed: options?.committed ?? "",
      tentative: options?.tentative ?? "",
    },
  } as unknown as DesktopSpeechState;
}

function createHarness(initialState = speechState(), canStart = () => true) {
  let currentState = initialState;
  const previewListeners = new Set<(preview: DesktopSpeechPreviewDelta) => void>();
  const unsubscribe = vi.fn();
  const bridge = {
    getState: vi.fn(() => Promise.resolve(currentState)),
    selectModel: vi.fn(),
    downloadModel: vi.fn(),
    cancelDownload: vi.fn(),
    removeModel: vi.fn(),
    start: vi.fn(),
    pushAudio: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(() => Promise.resolve({ type: "accepted" } as const)),
    onStateChange: vi.fn(() => () => undefined),
    onPreviewChange: vi.fn((listener: (preview: DesktopSpeechPreviewDelta) => void) => {
      previewListeners.add(listener);
      return () => {
        previewListeners.delete(listener);
        unsubscribe();
      };
    }),
  } as DesktopSpeechBridge;
  const stop = vi.fn(
    (): ReturnType<DesktopSpeechRecording["stop"]> =>
      Promise.resolve({ type: "completed", text: "dictated text" }),
  );
  const cancel = vi.fn(() => Promise.resolve({ type: "accepted" } as const));
  const recording: DesktopSpeechRecording = { sessionId, stop, cancel };
  let onCaptureError: ((error: unknown) => void) | undefined;
  const startRecording = vi.fn(
    async (options: {
      readonly speech: DesktopSpeechBridge;
      readonly onCaptureError: (error: unknown) => void;
    }): Promise<DesktopSpeechRecordingStartResult> => {
      onCaptureError = options.onCaptureError;
      currentState = speechState({ session: { type: "listening", sessionId } });
      return { type: "accepted", recording };
    },
  );
  const updateTranscript = vi.fn(() => true);
  const commitTranscript = vi.fn(() => true);
  const discardTranscript = vi.fn(() => true);
  const transcript = {
    update: updateTranscript,
    commit: commitTranscript,
    discard: discardTranscript,
  };
  const createTranscript = vi.fn(() => transcript);
  const openVoiceInputSettings = vi.fn();
  const observed: ComposerSpeechViewState[] = [];
  const controller = createComposerSpeechController({
    speech: bridge,
    readSpeechState: () => currentState,
    canStart,
    startRecording,
    createTranscript,
    openVoiceInputSettings,
    onViewState: (state) => observed.push(state),
  });

  return {
    bridge,
    recording,
    stop,
    cancel,
    startRecording,
    createTranscript,
    updateTranscript,
    commitTranscript,
    discardTranscript,
    openVoiceInputSettings,
    observed,
    controller,
    setState: (state: DesktopSpeechState) => {
      currentState = state;
    },
    emit: (state: DesktopSpeechState) => {
      currentState = state;
      controller.syncSpeechState(state);
    },
    emitPreview: (preview: DesktopSpeechPreviewDelta) => {
      for (const listener of previewListeners) listener(preview);
    },
    listenerCount: () => previewListeners.size,
    unsubscribe,
    failCapture: (message: string) => {
      const error = new Error(message);
      error.name = "DesktopSpeechCaptureError";
      onCaptureError?.(error);
    },
  };
}

describe("createComposerSpeechController", () => {
  it("checks the insertion gate before acquiring the microphone", async () => {
    const harness = createHarness(speechState(), () => false);

    await harness.controller.toggle();

    expect(harness.startRecording).not.toHaveBeenCalled();
    expect(harness.controller.getViewState().phase).toBe("idle");
  });

  it.each([
    ["no model", speechState({ selectedModelId: null })],
    ["an uninstalled model", speechState({ installed: false })],
  ])("opens Voice Input settings for %s", async (_label, state) => {
    const harness = createHarness(state);

    await harness.controller.toggle();

    expect(harness.openVoiceInputSettings).toHaveBeenCalledOnce();
    expect(harness.startRecording).not.toHaveBeenCalled();
  });

  it("catches an early preview, streams newer revisions, and commits one final", async () => {
    const harness = createHarness();
    harness.startRecording.mockImplementationOnce(async () => {
      harness.setState(
        speechState({
          session: { type: "listening", sessionId },
          revision: 1,
          committed: "early ",
          tentative: "words",
        }),
      );
      return { type: "accepted", recording: harness.recording };
    });

    await harness.controller.toggle();
    expect(harness.updateTranscript).toHaveBeenLastCalledWith("early words");

    harness.emitPreview({
      sessionId,
      revision: previewRevision(2),
      committed: "hello ",
      tentative: "world",
    });
    harness.emitPreview({
      sessionId,
      revision: previewRevision(2),
      committed: "stale",
      tentative: "",
    });
    harness.emitPreview({
      sessionId: otherSessionId,
      revision: previewRevision(9),
      committed: "wrong session",
      tentative: "",
    });
    expect(harness.updateTranscript).toHaveBeenLastCalledWith("hello world");
    expect(harness.updateTranscript).toHaveBeenCalledTimes(2);

    await harness.controller.toggle();

    expect(harness.stop).toHaveBeenCalledOnce();
    expect(harness.commitTranscript).toHaveBeenCalledWith("dictated text");
    expect(harness.commitTranscript).toHaveBeenCalledOnce();
    expect(harness.discardTranscript).not.toHaveBeenCalled();
    expect(harness.listenerCount()).toBe(0);
  });

  it("discards and best-effort cancels when finalization is rejected", async () => {
    const harness = createHarness();
    harness.stop.mockResolvedValueOnce({
      type: "rejected",
      reason: "operation-failed",
      message: "Voice input failed to finalize.",
    });
    await harness.controller.toggle();

    await harness.controller.toggle();

    expect(harness.bridge.cancel).toHaveBeenCalledWith(sessionId);
    expect(harness.discardTranscript).toHaveBeenCalledOnce();
    expect(harness.commitTranscript).not.toHaveBeenCalled();
    expect(harness.controller.getViewState()).toMatchObject({
      phase: "error",
      error: "Voice input failed to finalize.",
    });
  });

  it("cancels and discards on Escape", async () => {
    const harness = createHarness();
    await harness.controller.toggle();

    await harness.controller.cancel();

    expect(harness.cancel).toHaveBeenCalledOnce();
    expect(harness.stop).not.toHaveBeenCalled();
    expect(harness.discardTranscript).toHaveBeenCalledOnce();
    expect(harness.commitTranscript).not.toHaveBeenCalled();
  });

  it("cancels a recording acquired after Escape during startup", async () => {
    const harness = createHarness();
    let resolveStart: ((result: DesktopSpeechRecordingStartResult) => void) | undefined;
    harness.startRecording.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );

    const starting = harness.controller.toggle();
    await Promise.resolve();
    await harness.controller.cancel();
    resolveStart?.({ type: "accepted", recording: harness.recording });
    await starting;

    expect(harness.cancel).toHaveBeenCalledOnce();
    expect(harness.stop).not.toHaveBeenCalled();
    expect(harness.createTranscript).not.toHaveBeenCalled();
    expect(harness.listenerCount()).toBe(0);
  });

  it("discards live text and cancels on a matching host failure", async () => {
    const harness = createHarness();
    await harness.controller.toggle();

    harness.emit(
      speechState({
        session: { type: "failed", sessionId, reason: "Worker exited." },
      }),
    );
    await Promise.resolve();

    expect(harness.cancel).toHaveBeenCalledOnce();
    expect(harness.discardTranscript).toHaveBeenCalledOnce();
    expect(harness.controller.getViewState()).toMatchObject({
      phase: "error",
      error: "Worker exited.",
    });
  });

  it("surfaces renderer capture failure without canceling twice", async () => {
    const harness = createHarness();
    await harness.controller.toggle();

    harness.failCapture("Microphone audio fell behind. Try again.");
    await Promise.resolve();

    expect(harness.controller.getViewState()).toMatchObject({
      phase: "error",
      error: "Microphone audio fell behind. Try again.",
    });
    expect(harness.discardTranscript).toHaveBeenCalledOnce();
    expect(harness.listenerCount()).toBe(0);
    expect(harness.cancel).not.toHaveBeenCalled();
  });

  it("cleans up when the preview listener cannot be installed", async () => {
    const harness = createHarness();
    vi.mocked(harness.bridge.onPreviewChange).mockImplementation(() => {
      throw new Error("listener unavailable");
    });

    await harness.controller.toggle();

    expect(harness.cancel).toHaveBeenCalledOnce();
    expect(harness.discardTranscript).toHaveBeenCalledOnce();
    expect(harness.controller.getViewState()).toMatchObject({
      phase: "error",
      error: "Voice input stopped because its preview listener could not be started.",
    });
  });

  it("ignores stale-session failures and identity-less idle snapshots", async () => {
    const harness = createHarness();
    await harness.controller.toggle();

    harness.emit(
      speechState({
        session: { type: "failed", sessionId: otherSessionId, reason: "Old failure." },
      }),
    );
    harness.emit(speechState({ session: { type: "idle" } }));
    await Promise.resolve();

    expect(harness.controller.getViewState().phase).toBe("listening");
    expect(harness.cancel).not.toHaveBeenCalled();
    expect(harness.discardTranscript).not.toHaveBeenCalled();
  });

  it("suppresses a final that resolves after the composer is disposed", async () => {
    const harness = createHarness();
    const final = deferred<Awaited<ReturnType<DesktopSpeechRecording["stop"]>>>();
    harness.stop.mockImplementation(() => final.promise);
    await harness.controller.toggle();

    const stopping = harness.controller.toggle();
    await Promise.resolve();
    await harness.controller.dispose();
    final.resolve({ type: "completed", text: "wrong draft" });
    await stopping;

    expect(harness.cancel).toHaveBeenCalledOnce();
    expect(harness.commitTranscript).not.toHaveBeenCalled();
    expect(harness.discardTranscript).toHaveBeenCalledOnce();
    expect(harness.listenerCount()).toBe(0);
  });

  it("cancels without overwriting after a prompt edit", async () => {
    const harness = createHarness();
    await harness.controller.toggle();
    harness.updateTranscript.mockReturnValueOnce(false);

    harness.emit(
      speechState({
        session: { type: "listening", sessionId },
        revision: 1,
        tentative: "new words",
      }),
    );
    await Promise.resolve();

    expect(harness.cancel).toHaveBeenCalledOnce();
    expect(harness.discardTranscript).toHaveBeenCalledOnce();
    expect(harness.controller.getViewState()).toMatchObject({
      phase: "error",
      error: "Voice input stopped because the prompt changed during transcription.",
    });
  });
});
