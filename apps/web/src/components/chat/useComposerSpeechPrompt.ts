import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import { composerTargetKey, type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { createComposerSpeechTranscript } from "./composerSpeechTranscript";

type ComposerSpeechTarget = ScopedThreadRef | DraftId;

export interface ComposerSpeechPromptOverride {
  readonly targetKey: string;
  readonly persistedPrompt: string;
  readonly value: string;
  readonly status: "active" | "settled";
  readonly historyMode: "push" | "merge";
}

interface UseComposerSpeechPromptOptions {
  readonly target: ComposerSpeechTarget;
  readonly persistedPrompt: string;
  readonly promptRef: React.RefObject<string>;
  readonly canStart: boolean;
}

export interface ComposerSpeechPromptBinding {
  readonly targetKey: string;
  readonly active: boolean;
  readonly subscribeToOverride: (listener: () => void) => () => void;
  readonly readOverride: () => ComposerSpeechPromptOverride | null;
  readonly createTranscript: () => ReturnType<typeof createComposerSpeechTranscript> | null;
  readonly readPersistedPrompt: () => string;
  readonly onActiveChange: (active: boolean) => void;
}

export function resolveComposerSpeechPromptOverride(
  override: ComposerSpeechPromptOverride | null,
  targetKey: string,
  persistedPrompt: string,
): ComposerSpeechPromptOverride | null {
  if (override?.targetKey !== targetKey) return null;
  if (override.status === "active") {
    return persistedPrompt === override.persistedPrompt ? override : null;
  }
  return persistedPrompt === override.persistedPrompt || persistedPrompt === override.value
    ? override
    : null;
}

export function shouldReleaseComposerSpeechPromptOverride(
  override: ComposerSpeechPromptOverride,
  targetKey: string,
  persistedPrompt: string,
): boolean {
  if (override.targetKey !== targetKey) return true;
  if (override.status === "active") return persistedPrompt !== override.persistedPrompt;
  if (persistedPrompt !== override.persistedPrompt) return true;
  return persistedPrompt === override.value;
}

/**
 * Owns the temporary prompt overlay used while speech recognition revises a
 * transcript. The draft store remains authoritative: interim text is never
 * persisted, while the final transcript is committed exactly once.
 */
export function useComposerSpeechPrompt({
  target,
  persistedPrompt,
  promptRef,
  canStart,
}: UseComposerSpeechPromptOptions): ComposerSpeechPromptBinding {
  const targetKey = composerTargetKey(target);
  const targetKeyRef = useRef(targetKey);
  targetKeyRef.current = targetKey;

  const activeRef = useRef(false);
  const activeListenersRef = useRef(new Set<() => void>());
  const subscribeToActive = useCallback((listener: () => void) => {
    activeListenersRef.current.add(listener);
    return () => activeListenersRef.current.delete(listener);
  }, []);
  const readActive = useCallback(() => activeRef.current, []);
  const active = useSyncExternalStore(subscribeToActive, readActive, readActive);
  const onActiveChange = useCallback((nextActive: boolean) => {
    if (activeRef.current === nextActive) return;
    activeRef.current = nextActive;
    for (const listener of activeListenersRef.current) listener();
  }, []);

  const overrideRef = useRef<ComposerSpeechPromptOverride | null>(null);
  const overrideListenersRef = useRef(new Set<() => void>());
  const setOverride = useCallback((nextOverride: ComposerSpeechPromptOverride | null) => {
    overrideRef.current = nextOverride;
    for (const listener of overrideListenersRef.current) listener();
  }, []);
  const subscribeToOverride = useCallback((listener: () => void) => {
    overrideListenersRef.current.add(listener);
    return () => overrideListenersRef.current.delete(listener);
  }, []);
  const readOverride = useCallback(() => overrideRef.current, []);

  const setPersistedPrompt = useComposerDraftStore((store) => store.setPrompt);
  const readPersistedPrompt = useCallback(
    () => useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "",
    [target],
  );
  useEffect(() => {
    const current = overrideRef.current;
    if (current === null) return;
    if (shouldReleaseComposerSpeechPromptOverride(current, targetKey, persistedPrompt)) {
      setOverride(null);
    }
  }, [persistedPrompt, setOverride, targetKey]);

  const createTranscript = useCallback(() => {
    if (!canStart) return null;

    const capturedTarget = target;
    const capturedTargetKey = targetKey;
    const capturedPersistedPrompt = readPersistedPrompt();
    if (promptRef.current !== capturedPersistedPrompt) return null;

    const present = (nextPrompt: string) => {
      if (targetKeyRef.current !== capturedTargetKey) return;
      promptRef.current = nextPrompt;
    };
    const nextHistoryMode = () => {
      const current = overrideRef.current;
      return current?.targetKey === capturedTargetKey && current.status === "active"
        ? ("merge" as const)
        : ("push" as const);
    };

    return createComposerSpeechTranscript({
      read: () => promptRef.current,
      isCurrent: () =>
        targetKeyRef.current === capturedTargetKey &&
        (useComposerDraftStore.getState().getComposerDraft(capturedTarget)?.prompt ?? "") ===
          capturedPersistedPrompt,
      writeTransient: (nextPrompt) => {
        setOverride({
          targetKey: capturedTargetKey,
          persistedPrompt: capturedPersistedPrompt,
          value: nextPrompt,
          status: "active",
          historyMode: nextHistoryMode(),
        });
        present(nextPrompt);
      },
      writeFinal: (nextPrompt) => {
        setOverride({
          targetKey: capturedTargetKey,
          persistedPrompt: capturedPersistedPrompt,
          value: nextPrompt,
          status: "settled",
          historyMode: nextHistoryMode(),
        });
        if (capturedPersistedPrompt !== nextPrompt) {
          setPersistedPrompt(capturedTarget, nextPrompt);
        }
        present(nextPrompt);
      },
      restoreInitial: (initialPrompt) => {
        const current = overrideRef.current;
        if (current?.targetKey === capturedTargetKey && current.status === "active") {
          setOverride({
            targetKey: capturedTargetKey,
            persistedPrompt: capturedPersistedPrompt,
            value: initialPrompt,
            status: "settled",
            historyMode: "merge",
          });
        }
        present(initialPrompt);
      },
    });
  }, [
    canStart,
    promptRef,
    readPersistedPrompt,
    setOverride,
    setPersistedPrompt,
    target,
    targetKey,
  ]);

  return {
    targetKey,
    active,
    subscribeToOverride,
    readOverride,
    createTranscript,
    readPersistedPrompt,
    onActiveChange,
  };
}
