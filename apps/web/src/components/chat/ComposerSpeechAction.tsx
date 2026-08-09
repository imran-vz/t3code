import type { DesktopSpeechBridge } from "@t3tools/contracts";
import { CircleAlertIcon, MicIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { startDesktopSpeechRecording } from "../../speech/desktopSpeech";
import { useDesktopSpeechState } from "../../state/desktopSpeechState";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import {
  createComposerSpeechController,
  type ComposerSpeechViewState,
} from "./composerSpeechController";
import type { ComposerSpeechTranscript } from "./composerSpeechTranscript";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const INITIAL_VIEW_STATE: ComposerSpeechViewState = {
  phase: "idle",
  error: null,
  unsupportedReason: null,
};

function statusText(state: ComposerSpeechViewState): string {
  switch (state.phase) {
    case "starting":
      return "Starting voice input";
    case "listening":
      return "Listening";
    case "stopping":
      return "Finishing voice input";
    case "canceling":
      return "Canceling voice input";
    case "error":
      return state.error ?? "Voice input stopped";
    case "idle":
      return "Voice input ready";
  }
}

function isActivePhase(state: ComposerSpeechViewState): boolean {
  return (
    state.phase === "starting" ||
    state.phase === "listening" ||
    state.phase === "stopping" ||
    state.phase === "canceling"
  );
}

export function ComposerSpeechActionView(props: {
  readonly state: ComposerSpeechViewState;
  readonly onToggle: () => void;
}) {
  const isListening = props.state.phase === "listening";
  const isTransitioning =
    props.state.phase === "starting" ||
    props.state.phase === "stopping" ||
    props.state.phase === "canceling";
  const label = isListening ? "Stop voice input" : "Start voice input";
  const visibleStatus =
    props.state.phase === "starting"
      ? "Starting…"
      : props.state.phase === "listening"
        ? "Listening"
        : props.state.phase === "stopping"
          ? "Finishing…"
          : props.state.phase === "canceling"
            ? "Canceling…"
            : null;

  return (
    <div className="flex min-w-0 items-center gap-2" data-composer-speech-action>
      {visibleStatus !== null ? (
        <span
          className={
            isListening ? "text-xs font-medium text-destructive" : "text-muted-foreground text-xs"
          }
          data-composer-speech-status
        >
          {visibleStatus}
        </span>
      ) : props.state.error !== null ? (
        <span className="max-w-64 truncate text-xs text-destructive" title={props.state.error}>
          <CircleAlertIcon aria-hidden="true" className="me-1 inline size-3.5" />
          {props.state.error}
        </span>
      ) : null}

      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              type="button"
              aria-label={label}
              aria-pressed={isListening}
              disabled={isTransitioning || props.state.unsupportedReason !== null}
              className={isListening ? "text-destructive hover:text-destructive" : undefined}
              onClick={props.onToggle}
            />
          }
        >
          <ComposerControlIcon icon={isListening ? SquareIcon : MicIcon} />
        </TooltipTrigger>
        <TooltipPopup side="top">
          {props.state.unsupportedReason ??
            (isListening ? "Stop and add transcript" : "Start voice input")}
        </TooltipPopup>
      </Tooltip>

      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {statusText(props.state)}
      </span>
    </div>
  );
}

interface ComposerSpeechActionProps {
  readonly speech: DesktopSpeechBridge | undefined;
  readonly canStart?: boolean;
  readonly visible?: boolean;
  readonly targetKey: string;
  readonly createTranscript: () => ComposerSpeechTranscript | null;
  readonly openVoiceInputSettings: () => void;
  readonly onActiveChange: (active: boolean) => void;
}

export function handleComposerSpeechEscape(
  event: Pick<KeyboardEvent, "key" | "isComposing" | "preventDefault" | "stopPropagation">,
  composerOwnsEscape: boolean,
  cancel: () => void,
): boolean {
  if (event.key !== "Escape" || event.isComposing || !composerOwnsEscape) return false;
  event.preventDefault();
  event.stopPropagation();
  cancel();
  return true;
}

export function ComposerSpeechAction(props: ComposerSpeechActionProps) {
  if (props.speech === undefined) return null;
  return <AvailableComposerSpeechAction key={props.targetKey} {...props} speech={props.speech} />;
}

function AvailableComposerSpeechAction(
  props: ComposerSpeechActionProps & { readonly speech: DesktopSpeechBridge },
) {
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  const speechState = useDesktopSpeechState();
  const speechStateRef = useRef(speechState);
  speechStateRef.current = speechState;
  const controllerRef = useRef<ReturnType<typeof createComposerSpeechController> | null>(null);
  const createTranscriptRef = useRef(props.createTranscript);
  const openVoiceInputSettingsRef = useRef(props.openVoiceInputSettings);
  const onActiveChangeRef = useRef(props.onActiveChange);
  const canStartRef = useRef(props.canStart !== false);

  useEffect(() => {
    createTranscriptRef.current = props.createTranscript;
    openVoiceInputSettingsRef.current = props.openVoiceInputSettings;
    onActiveChangeRef.current = props.onActiveChange;
    canStartRef.current = props.canStart !== false;
  }, [props.canStart, props.createTranscript, props.onActiveChange, props.openVoiceInputSettings]);

  useEffect(() => {
    const controller = createComposerSpeechController({
      speech: props.speech,
      readSpeechState: () => speechStateRef.current,
      canStart: () => canStartRef.current,
      startRecording: startDesktopSpeechRecording,
      createTranscript: () => createTranscriptRef.current(),
      openVoiceInputSettings: () => openVoiceInputSettingsRef.current(),
      onViewState: (nextState) => {
        onActiveChangeRef.current(isActivePhase(nextState));
        setViewState(nextState);
      },
    });
    controllerRef.current = controller;

    const dispose = () => {
      onActiveChangeRef.current(false);
      void controller.dispose();
    };
    window.addEventListener("pagehide", dispose);

    return () => {
      window.removeEventListener("pagehide", dispose);
      controllerRef.current = null;
      dispose();
    };
  }, [props.speech]);

  useEffect(() => {
    if (speechState !== null) controllerRef.current?.syncSpeechState(speechState);
  }, [speechState]);

  const canCancelWithEscape = viewState.phase === "starting" || viewState.phase === "listening";
  useEffect(() => {
    if (!canCancelWithEscape) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      handleComposerSpeechEscape(
        event,
        target instanceof Element && target.closest('[data-chat-composer-form="true"]') !== null,
        () => void controllerRef.current?.cancel(),
      );
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [canCancelWithEscape]);

  if (props.visible === false) return null;

  return (
    <ComposerSpeechActionView
      state={viewState}
      onToggle={() => void controllerRef.current?.toggle()}
    />
  );
}
