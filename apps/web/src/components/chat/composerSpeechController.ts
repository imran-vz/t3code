import type {
  DesktopSpeechBridge,
  DesktopSpeechModelId,
  DesktopSpeechPreviewDelta,
  DesktopSpeechSessionId,
  DesktopSpeechState,
} from "@t3tools/contracts";

import type {
  DesktopSpeechRecording,
  DesktopSpeechRecordingStartResult,
} from "../../speech/desktopSpeech";
import type { ComposerSpeechTranscript } from "./composerSpeechTranscript";

export type ComposerSpeechPhase =
  | "idle"
  | "starting"
  | "listening"
  | "stopping"
  | "canceling"
  | "error";

export interface ComposerSpeechViewState {
  readonly phase: ComposerSpeechPhase;
  readonly error: string | null;
  readonly unsupportedReason: string | null;
}

export interface ComposerSpeechController {
  readonly getViewState: () => ComposerSpeechViewState;
  readonly syncSpeechState: (state: DesktopSpeechState) => void;
  readonly toggle: () => Promise<void>;
  readonly cancel: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

interface ActiveComposerSpeechSession {
  readonly sessionId: DesktopSpeechSessionId;
  readonly modelId: DesktopSpeechModelId;
  readonly recording: DesktopSpeechRecording;
  readonly transcript: ComposerSpeechTranscript;
  previewRevision: number;
}

interface ComposerSpeechControllerOptions {
  readonly speech: DesktopSpeechBridge;
  readonly readSpeechState: () => DesktopSpeechState | null;
  readonly canStart: () => boolean;
  readonly startRecording: (options: {
    readonly speech: DesktopSpeechBridge;
    readonly onCaptureError: (error: unknown) => void;
  }) => Promise<DesktopSpeechRecordingStartResult>;
  readonly createTranscript: () => ComposerSpeechTranscript | null;
  readonly openVoiceInputSettings: () => void;
  readonly onViewState: (state: ComposerSpeechViewState) => void;
}

const INITIAL_VIEW_STATE: ComposerSpeechViewState = {
  phase: "idle",
  error: null,
  unsupportedReason: null,
};

function safeCaptureErrorMessage(error: unknown): string {
  return error instanceof Error && error.name === "DesktopSpeechCaptureError"
    ? error.message
    : "Voice input stopped because microphone audio could not be processed.";
}

function selectedInstalledModelId(state: DesktopSpeechState): DesktopSpeechModelId | null {
  const selectedModelId = state.selectedModelId;
  if (selectedModelId === null) return null;
  return state.models.some(
    (model) => model.catalogEntry.id === selectedModelId && model.installation.type === "installed",
  )
    ? selectedModelId
    : null;
}

function stateSessionId(state: DesktopSpeechState): DesktopSpeechSessionId | null {
  return state.session.type === "idle" ? null : state.session.sessionId;
}

export function createComposerSpeechController(
  options: ComposerSpeechControllerOptions,
): ComposerSpeechController {
  let viewState = INITIAL_VIEW_STATE;
  let active: ActiveComposerSpeechSession | null = null;
  let unsubscribe: (() => void) | null = null;
  let generation = 0;
  let disposed = false;

  const publish = (patch: Partial<ComposerSpeechViewState>) => {
    if (disposed) return;
    viewState = { ...viewState, ...patch };
    options.onViewState(viewState);
  };

  const clearSubscription = () => {
    const current = unsubscribe;
    unsubscribe = null;
    try {
      current?.();
    } catch {
      // The recording cleanup below must still run if the host listener was
      // already torn down during renderer shutdown.
    }
  };

  const detachActive = () => {
    const current = active;
    active = null;
    clearSubscription();
    return current;
  };

  const failActive = async (
    message: string,
    sessionId: DesktopSpeechSessionId | null,
    cancelRecording: boolean,
  ) => {
    const current = active;
    if (current === null || (sessionId !== null && current.sessionId !== sessionId)) return;
    generation += 1;
    detachActive();
    current.transcript.discard();
    publish({ phase: "error", error: message });
    if (cancelRecording) {
      await current.recording.cancel().catch(() => undefined);
    }
  };

  const handleSpeechPreview = (preview: DesktopSpeechPreviewDelta) => {
    const current = active;
    if (current === null) return;
    if (preview.sessionId !== current.sessionId || preview.revision <= current.previewRevision) {
      return;
    }

    current.previewRevision = preview.revision;
    if (!current.transcript.update(`${preview.committed}${preview.tentative}`)) {
      void failActive(
        "Voice input stopped because the prompt changed during transcription.",
        current.sessionId,
        true,
      );
    }
  };

  const handleSpeechState = (state: DesktopSpeechState) => {
    const current = active;
    if (current === null) return;

    if (viewState.phase !== "stopping" && state.selectedModelId !== current.modelId) {
      void failActive(
        "Voice input stopped because the active speech model changed.",
        current.sessionId,
        true,
      );
      return;
    }

    if (state.session.type === "failed") {
      if (state.session.sessionId === null || state.session.sessionId === current.sessionId) {
        void failActive(state.session.reason, current.sessionId, true);
      }
      return;
    }

    if (state.session.type === "idle") {
      // Idle snapshots carry no session identity, so they cannot safely end
      // the current recording. A delayed idle from the previous session may
      // arrive after a new session has already started.
      return;
    }

    const incomingSessionId = stateSessionId(state);
    if (incomingSessionId !== current.sessionId) return;
    handleSpeechPreview({ sessionId: current.sessionId, ...state.preview });
  };

  const cancel = async () => {
    generation += 1;
    const current = detachActive();
    if (current === null) {
      publish({ phase: "idle", error: null });
      return;
    }

    publish({ phase: "canceling", error: null });
    current.transcript.discard();
    await current.recording.cancel().catch(() => undefined);
    publish({ phase: "idle", error: null });
  };

  const start = async () => {
    if (!options.canStart()) return;
    const operationGeneration = ++generation;
    publish({
      phase: "starting",
      error: null,
      unsupportedReason: null,
    });

    const state = options.readSpeechState();
    if (state === null) {
      publish({
        phase: "error",
        error: "Voice input is temporarily unavailable.",
      });
      return;
    }

    if (disposed || generation !== operationGeneration) return;
    if (state.availability.type === "unsupported") {
      publish({
        phase: "error",
        error: state.availability.reason,
        unsupportedReason: state.availability.reason,
      });
      return;
    }

    const modelId = selectedInstalledModelId(state);
    if (modelId === null) {
      publish({ phase: "idle", error: null });
      options.openVoiceInputSettings();
      return;
    }

    let result: DesktopSpeechRecordingStartResult;
    try {
      result = await options.startRecording({
        speech: options.speech,
        onCaptureError: (error) => {
          const current = active;
          if (current === null) return;
          void failActive(safeCaptureErrorMessage(error), current.sessionId, false);
        },
      });
    } catch (error) {
      if (generation === operationGeneration) {
        publish({ phase: "error", error: safeCaptureErrorMessage(error) });
      }
      return;
    }

    if (disposed || generation !== operationGeneration) {
      if (result.type === "accepted") {
        await result.recording.cancel().catch(() => undefined);
      }
      return;
    }
    if (result.type === "rejected") {
      publish({ phase: "error", error: result.message });
      return;
    }

    const transcript = options.createTranscript();
    if (transcript === null) {
      await result.recording.cancel().catch(() => undefined);
      publish({
        phase: "error",
        error: "Voice input could not attach to the current composer prompt.",
      });
      return;
    }

    active = {
      sessionId: result.recording.sessionId,
      modelId,
      recording: result.recording,
      transcript,
      previewRevision: -1,
    };
    try {
      unsubscribe = options.speech.onPreviewChange(handleSpeechPreview);
    } catch {
      const current = detachActive();
      current?.transcript.discard();
      await current?.recording.cancel().catch(() => undefined);
      publish({
        phase: "error",
        error: "Voice input stopped because its preview listener could not be started.",
      });
      return;
    }
    publish({ phase: "listening", error: null });

    const latest = options.readSpeechState();
    if (latest === null) {
      await failActive(
        "Voice input stopped because its state could not be read.",
        result.recording.sessionId,
        true,
      );
    } else if (
      generation === operationGeneration &&
      active?.sessionId === result.recording.sessionId
    ) {
      handleSpeechState(latest);
    }
  };

  const stop = async () => {
    const current = active;
    if (current === null) return;
    const operationGeneration = ++generation;
    publish({ phase: "stopping", error: null });

    let result: Awaited<ReturnType<DesktopSpeechRecording["stop"]>>;
    try {
      result = await current.recording.stop();
    } catch {
      if (generation === operationGeneration && active?.sessionId === current.sessionId) {
        await failActive(
          "Voice input could not finish processing the recording.",
          current.sessionId,
          true,
        );
      }
      return;
    }

    if (disposed || generation !== operationGeneration || active?.sessionId !== current.sessionId) {
      return;
    }

    detachActive();
    if (result.type === "rejected") {
      current.transcript.discard();
      publish({ phase: "error", error: result.message });
      await options.speech.cancel(current.sessionId).catch(() => undefined);
      return;
    }

    if (!current.transcript.commit(result.text)) {
      publish({
        phase: "error",
        error: "The transcript finished, but the prompt changed before it could be finalized.",
      });
      return;
    }
    publish({ phase: "idle", error: null });
  };

  return {
    getViewState: () => viewState,
    syncSpeechState: handleSpeechState,
    toggle: async () => {
      if (disposed) return;
      if (viewState.phase === "listening") {
        await stop();
        return;
      }
      if (viewState.phase === "idle" || viewState.phase === "error") {
        await start();
      }
    },
    cancel,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      generation += 1;
      const current = detachActive();
      viewState = { ...INITIAL_VIEW_STATE };
      if (current !== null) {
        current.transcript.discard();
        await current.recording.cancel().catch(() => undefined);
      }
    },
  };
}
