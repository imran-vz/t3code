import type {
  DesktopSpeechActionRejectionReason,
  DesktopSpeechActionResult,
  DesktopSpeechAudioSequence,
  DesktopSpeechAvailability,
  DesktopSpeechCatalogEntry,
  DesktopSpeechModelId,
  DesktopSpeechModelState,
  DesktopSpeechPreview,
  DesktopSpeechPreviewRevision,
  DesktopSpeechSessionId,
  DesktopSpeechState,
} from "@t3tools/contracts";

const EMPTY_PREVIEW: DesktopSpeechPreview = {
  committed: "",
  tentative: "",
  revision: 0 as DesktopSpeechPreviewRevision,
};

const REJECTION_MESSAGES = {
  unsupported: "Voice input is not supported on this platform.",
  "unknown-model": "Voice model is not in the catalog.",
  "already-installed": "Voice model is already installed.",
  "not-installed": "Voice model is not installed.",
  "download-in-progress": "Another voice model download is in progress.",
  "no-download": "Voice model is not downloading.",
  "no-active-model": "Select an installed voice model first.",
  "session-in-progress": "A voice input session is in progress.",
  "no-session": "There is no active voice input session.",
  "stale-session": "Voice input session is no longer active.",
  "out-of-order-audio": "Voice audio arrived out of order.",
  "operation-failed": "Voice input action is not valid in the current state.",
} satisfies Record<DesktopSpeechActionRejectionReason, string>;

export interface SpeechMachineState {
  readonly snapshot: DesktopSpeechState;
  readonly loadedModelId: DesktopSpeechModelId | null;
  readonly nextAudioSequence: number;
  readonly lastPreviewRevision: number;
}

export interface CreateSpeechMachineOptions {
  readonly availability: DesktopSpeechAvailability;
  readonly catalog: ReadonlyArray<DesktopSpeechCatalogEntry>;
  readonly installedModelIds: ReadonlySet<DesktopSpeechModelId>;
  readonly selectedModelId: DesktopSpeechModelId | null;
}

export type SpeechMachineCommand =
  | { readonly type: "download-start"; readonly modelId: DesktopSpeechModelId }
  | { readonly type: "download-cancel"; readonly modelId: DesktopSpeechModelId }
  | { readonly type: "model-select"; readonly modelId: DesktopSpeechModelId }
  | { readonly type: "model-selection-clear" }
  | { readonly type: "model-remove"; readonly modelId: DesktopSpeechModelId }
  | { readonly type: "session-start"; readonly sessionId: DesktopSpeechSessionId }
  | {
      readonly type: "audio-accept";
      readonly sessionId: DesktopSpeechSessionId;
      readonly sequence: DesktopSpeechAudioSequence;
    }
  | { readonly type: "session-finalize"; readonly sessionId: DesktopSpeechSessionId }
  | { readonly type: "session-cancel"; readonly sessionId: DesktopSpeechSessionId };

export type SpeechMachineEvent =
  | {
      readonly type: "model-selection-restored";
      readonly modelId: DesktopSpeechModelId | null;
    }
  | { readonly type: "loaded-model-invalidated" }
  | { readonly type: "model-invalidated"; readonly modelId: DesktopSpeechModelId }
  | {
      readonly type: "download-progressed";
      readonly modelId: DesktopSpeechModelId;
      readonly receivedBytes: number;
    }
  | { readonly type: "download-completed"; readonly modelId: DesktopSpeechModelId }
  | { readonly type: "download-canceled"; readonly modelId: DesktopSpeechModelId }
  | {
      readonly type: "download-failed";
      readonly modelId: DesktopSpeechModelId;
      readonly reason: string;
    }
  | { readonly type: "model-removal-completed"; readonly modelId: DesktopSpeechModelId }
  | {
      readonly type: "model-removal-failed";
      readonly modelId: DesktopSpeechModelId;
      readonly reason: string;
    }
  | { readonly type: "session-listening"; readonly sessionId: DesktopSpeechSessionId }
  | {
      readonly type: "session-previewed";
      readonly sessionId: DesktopSpeechSessionId;
      readonly preview: DesktopSpeechPreview;
    }
  | { readonly type: "session-finalized"; readonly sessionId: DesktopSpeechSessionId }
  | {
      readonly type: "session-failed";
      readonly sessionId: DesktopSpeechSessionId;
      readonly reason: string;
    }
  | { readonly type: "worker-crashed"; readonly reason: string };

export interface SpeechMachineDecision {
  readonly state: SpeechMachineState;
  readonly result: DesktopSpeechActionResult;
}

function accepted(state: SpeechMachineState): SpeechMachineDecision {
  return { state, result: { type: "accepted" } };
}

function rejected(
  state: SpeechMachineState,
  reason: DesktopSpeechActionRejectionReason,
): SpeechMachineDecision {
  return {
    state,
    result: {
      type: "rejected",
      reason,
      message:
        reason === "unsupported" && state.snapshot.availability.type === "unsupported"
          ? state.snapshot.availability.reason
          : REJECTION_MESSAGES[reason],
    },
  };
}

function findModel(
  state: SpeechMachineState,
  modelId: DesktopSpeechModelId,
): DesktopSpeechModelState | undefined {
  return state.snapshot.models.find((model) => model.catalogEntry.id === modelId);
}

function updateModel(
  state: SpeechMachineState,
  modelId: DesktopSpeechModelId,
  update: (model: DesktopSpeechModelState) => DesktopSpeechModelState,
): SpeechMachineState {
  const index = state.snapshot.models.findIndex((model) => model.catalogEntry.id === modelId);
  if (index === -1) return state;

  const current = state.snapshot.models[index];
  if (!current) return state;
  const next = update(current);
  if (next === current) return state;

  const models = [...state.snapshot.models];
  models[index] = next;
  return {
    ...state,
    snapshot: {
      ...state.snapshot,
      models,
    },
  };
}

function activeDownloadModelId(state: SpeechMachineState): DesktopSpeechModelId | null {
  return (
    state.snapshot.models.find(
      (model) => model.download.type === "downloading" || model.download.type === "canceling",
    )?.catalogEntry.id ?? null
  );
}

function currentSessionId(state: SpeechMachineState): DesktopSpeechSessionId | null {
  return state.snapshot.session.type === "idle" ? null : state.snapshot.session.sessionId;
}

function resetSession(state: SpeechMachineState): SpeechMachineState {
  return {
    ...state,
    snapshot: {
      ...state.snapshot,
      session: { type: "idle" },
      preview: EMPTY_PREVIEW,
    },
    nextAudioSequence: 0,
    lastPreviewRevision: -1,
  };
}

function rejectUnsupported(state: SpeechMachineState): SpeechMachineDecision | undefined {
  return state.snapshot.availability.type === "unsupported"
    ? rejected(state, "unsupported")
    : undefined;
}

export function createSpeechMachine(options: CreateSpeechMachineOptions): SpeechMachineState {
  const models = options.catalog.map(
    (catalogEntry): DesktopSpeechModelState => ({
      catalogEntry,
      installation: options.installedModelIds.has(catalogEntry.id)
        ? { type: "installed" }
        : { type: "not-installed" },
      download: { type: "idle" },
    }),
  );
  const persistedModelId = models.some(
    (model) =>
      model.catalogEntry.id === options.selectedModelId && model.installation.type === "installed",
  )
    ? options.selectedModelId
    : null;
  const selectedModelId =
    persistedModelId ??
    models.find((model) => model.installation.type === "installed")?.catalogEntry.id ??
    null;

  return {
    snapshot: {
      availability: options.availability,
      models,
      selectedModelId,
      session: { type: "idle" },
      preview: EMPTY_PREVIEW,
    },
    loadedModelId: null,
    nextAudioSequence: 0,
    lastPreviewRevision: -1,
  };
}

export function getDesktopSpeechState(state: SpeechMachineState): DesktopSpeechState {
  return state.snapshot;
}

export function decideSpeechMachine(
  state: SpeechMachineState,
  command: SpeechMachineCommand,
): SpeechMachineDecision {
  switch (command.type) {
    case "download-start": {
      const unsupported = rejectUnsupported(state);
      if (unsupported) return unsupported;
      const model = findModel(state, command.modelId);
      if (!model) return rejected(state, "unknown-model");
      if (model.installation.type !== "not-installed") {
        return rejected(state, "already-installed");
      }
      if (activeDownloadModelId(state)) return rejected(state, "download-in-progress");

      return accepted(
        updateModel(state, command.modelId, (current) => ({
          ...current,
          download: {
            type: "downloading",
            receivedBytes: 0,
            totalBytes: current.catalogEntry.artifact.bytes,
            percent: 0,
          },
        })),
      );
    }
    case "download-cancel": {
      const model = findModel(state, command.modelId);
      if (!model) return rejected(state, "unknown-model");
      if (model.download.type === "canceling") return accepted(state);
      if (model.download.type !== "downloading") return rejected(state, "no-download");

      return accepted(
        updateModel(state, command.modelId, (current) => ({
          ...current,
          download: { type: "canceling" },
        })),
      );
    }
    case "model-select": {
      const unsupported = rejectUnsupported(state);
      if (unsupported) return unsupported;
      if (state.snapshot.session.type !== "idle") return rejected(state, "session-in-progress");
      const model = findModel(state, command.modelId);
      if (!model) return rejected(state, "unknown-model");
      if (model.installation.type !== "installed") return rejected(state, "not-installed");

      return accepted({
        ...state,
        snapshot: { ...state.snapshot, selectedModelId: command.modelId },
      });
    }
    case "model-selection-clear": {
      if (state.snapshot.session.type !== "idle") return rejected(state, "session-in-progress");
      return accepted({
        ...state,
        snapshot: { ...state.snapshot, selectedModelId: null },
      });
    }
    case "model-remove": {
      const model = findModel(state, command.modelId);
      if (!model) return rejected(state, "unknown-model");
      if (model.installation.type === "removing") return rejected(state, "operation-failed");
      if (model.installation.type !== "installed" && model.installation.type !== "remove-failed") {
        return rejected(state, "not-installed");
      }
      if (
        state.snapshot.session.type !== "idle" &&
        (state.snapshot.selectedModelId === command.modelId ||
          state.loadedModelId === command.modelId)
      ) {
        return rejected(state, "session-in-progress");
      }

      return accepted(
        updateModel(state, command.modelId, (current) => ({
          ...current,
          installation: { type: "removing" },
        })),
      );
    }
    case "session-start": {
      const unsupported = rejectUnsupported(state);
      if (unsupported) return unsupported;
      if (state.snapshot.session.type !== "idle") return rejected(state, "session-in-progress");
      const selectedModelId = state.snapshot.selectedModelId;
      if (!selectedModelId) return rejected(state, "no-active-model");
      const selectedModel = findModel(state, selectedModelId);
      if (!selectedModel || selectedModel.installation.type !== "installed") {
        return rejected(state, "no-active-model");
      }

      return accepted({
        ...state,
        snapshot: {
          ...state.snapshot,
          session: { type: "starting", sessionId: command.sessionId },
          preview: EMPTY_PREVIEW,
        },
        nextAudioSequence: 0,
        lastPreviewRevision: -1,
      });
    }
    case "audio-accept": {
      const sessionId = currentSessionId(state);
      if (!sessionId) return rejected(state, "no-session");
      if (sessionId !== command.sessionId) return rejected(state, "stale-session");
      if (state.snapshot.session.type !== "listening") return rejected(state, "operation-failed");
      if (command.sequence !== state.nextAudioSequence) {
        return rejected(state, "out-of-order-audio");
      }

      return accepted({ ...state, nextAudioSequence: state.nextAudioSequence + 1 });
    }
    case "session-finalize": {
      const sessionId = currentSessionId(state);
      if (!sessionId) return rejected(state, "no-session");
      if (sessionId !== command.sessionId) return rejected(state, "stale-session");
      if (state.snapshot.session.type !== "listening" && state.snapshot.session.type !== "failed") {
        return rejected(state, "operation-failed");
      }

      return accepted({
        ...state,
        snapshot: {
          ...state.snapshot,
          session: { type: "finalizing", sessionId: command.sessionId },
        },
      });
    }
    case "session-cancel": {
      const sessionId = currentSessionId(state);
      if (!sessionId) return rejected(state, "no-session");
      if (sessionId !== command.sessionId) return rejected(state, "stale-session");
      return accepted(resetSession(state));
    }
  }
}

export function reduceSpeechMachine(
  state: SpeechMachineState,
  event: SpeechMachineEvent,
): SpeechMachineState {
  switch (event.type) {
    case "model-selection-restored": {
      if (state.snapshot.session.type !== "idle") return state;
      const modelId = event.modelId;
      if (modelId !== null && findModel(state, modelId)?.installation.type !== "installed") {
        return state;
      }
      return state.snapshot.selectedModelId === modelId
        ? state
        : { ...state, snapshot: { ...state.snapshot, selectedModelId: modelId } };
    }
    case "loaded-model-invalidated":
      return state.loadedModelId === null ? state : { ...state, loadedModelId: null };
    case "model-invalidated": {
      const next = updateModel(state, event.modelId, (model) => ({
        ...model,
        installation: { type: "not-installed" },
        download: { type: "idle" },
      }));
      return {
        ...next,
        snapshot: {
          ...next.snapshot,
          selectedModelId:
            next.snapshot.selectedModelId === event.modelId ? null : next.snapshot.selectedModelId,
        },
        loadedModelId: next.loadedModelId === event.modelId ? null : next.loadedModelId,
      };
    }
    case "download-progressed":
      return updateModel(state, event.modelId, (model) => {
        if (model.download.type !== "downloading") return model;
        if (!Number.isFinite(event.receivedBytes)) return model;
        const receivedBytes = Math.min(
          model.download.totalBytes,
          Math.max(0, Math.trunc(event.receivedBytes)),
        );
        return {
          ...model,
          download: {
            ...model.download,
            receivedBytes,
            percent: Math.floor((receivedBytes / model.download.totalBytes) * 100),
          },
        };
      });
    case "download-completed": {
      const next = updateModel(state, event.modelId, (model) =>
        model.download.type === "downloading"
          ? {
              ...model,
              installation: { type: "installed" },
              download: { type: "idle" },
            }
          : model,
      );
      return next === state
        ? state
        : { ...next, snapshot: { ...next.snapshot, selectedModelId: event.modelId } };
    }
    case "download-canceled":
      return updateModel(state, event.modelId, (model) =>
        model.download.type === "canceling" ? { ...model, download: { type: "idle" } } : model,
      );
    case "download-failed":
      return updateModel(state, event.modelId, (model) =>
        model.download.type === "downloading" || model.download.type === "canceling"
          ? { ...model, download: { type: "failed", reason: event.reason } }
          : model,
      );
    case "model-removal-completed": {
      const model = findModel(state, event.modelId);
      if (model?.installation.type !== "removing") return state;
      const next = updateModel(state, event.modelId, (current) => ({
        ...current,
        installation: { type: "not-installed" },
        download: { type: "idle" },
      }));
      return {
        ...next,
        snapshot: {
          ...next.snapshot,
          selectedModelId:
            next.snapshot.selectedModelId === event.modelId ? null : next.snapshot.selectedModelId,
        },
        loadedModelId: next.loadedModelId === event.modelId ? null : next.loadedModelId,
      };
    }
    case "model-removal-failed":
      return updateModel(state, event.modelId, (model) =>
        model.installation.type === "removing"
          ? { ...model, installation: { type: "remove-failed", reason: event.reason } }
          : model,
      );
    case "session-listening":
      if (
        state.snapshot.session.type !== "starting" ||
        state.snapshot.session.sessionId !== event.sessionId ||
        !state.snapshot.selectedModelId
      ) {
        return state;
      }
      return {
        ...state,
        snapshot: {
          ...state.snapshot,
          session: { type: "listening", sessionId: event.sessionId },
        },
        loadedModelId: state.snapshot.selectedModelId,
      };
    case "session-previewed": {
      const session = state.snapshot.session;
      if (
        (session.type !== "listening" && session.type !== "finalizing") ||
        session.sessionId !== event.sessionId ||
        event.preview.revision <= state.lastPreviewRevision
      ) {
        return state;
      }
      return {
        ...state,
        snapshot: { ...state.snapshot, preview: event.preview },
        lastPreviewRevision: event.preview.revision,
      };
    }
    case "session-finalized":
      return state.snapshot.session.type === "finalizing" &&
        state.snapshot.session.sessionId === event.sessionId
        ? resetSession(state)
        : state;
    case "session-failed": {
      const session = state.snapshot.session;
      if (
        session.type === "idle" ||
        session.type === "failed" ||
        session.sessionId !== event.sessionId
      ) {
        return state;
      }
      return {
        ...state,
        snapshot: {
          ...state.snapshot,
          session: { type: "failed", sessionId: event.sessionId, reason: event.reason },
          preview: EMPTY_PREVIEW,
        },
        nextAudioSequence: 0,
        lastPreviewRevision: -1,
      };
    }
    case "worker-crashed": {
      const sessionId = currentSessionId(state);
      if (!sessionId) return { ...state, loadedModelId: null };
      return {
        ...state,
        snapshot: {
          ...state.snapshot,
          session: { type: "failed", sessionId, reason: event.reason },
          preview: EMPTY_PREVIEW,
        },
        loadedModelId: null,
        nextAudioSequence: 0,
        lastPreviewRevision: -1,
      };
    }
  }
}
