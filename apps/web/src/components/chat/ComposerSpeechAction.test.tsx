import type { DesktopSpeechBridge } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  ComposerSpeechAction,
  ComposerSpeechActionView,
  handleComposerSpeechEscape,
} from "./ComposerSpeechAction";

describe("ComposerSpeechAction", () => {
  it("claims Escape even when an earlier global listener prevented its default", () => {
    const cancel = vi.fn();
    const event = {
      key: "Escape",
      isComposing: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    expect(handleComposerSpeechEscape(event, true, cancel)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("ignores unrelated keys", () => {
    const cancel = vi.fn();
    const event = {
      key: "Enter",
      isComposing: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    expect(handleComposerSpeechEscape(event, true, cancel)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each([
    ["IME composition", true, true],
    ["focus outside the composer", false, false],
  ])("leaves Escape to %s", (_label, isComposing, composerOwnsEscape) => {
    const cancel = vi.fn();
    const event = {
      key: "Escape",
      isComposing,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    expect(handleComposerSpeechEscape(event, composerOwnsEscape, cancel)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("does not render outside a host that exposes local speech", () => {
    const markup = renderToStaticMarkup(
      <ComposerSpeechAction
        speech={undefined}
        targetKey="draft:one"
        createTranscript={() => null}
        openVoiceInputSettings={() => {}}
        onActiveChange={() => {}}
      />,
    );

    expect(markup).toBe("");
  });

  it("renders the microphone only when the local speech capability exists", () => {
    const markup = renderToStaticMarkup(
      <ComposerSpeechAction
        speech={{} as DesktopSpeechBridge}
        targetKey="draft:one"
        createTranscript={() => null}
        openVoiceInputSettings={() => {}}
        onActiveChange={() => {}}
      />,
    );

    expect(markup).toContain('data-composer-speech-action="true"');
    expect(markup).toContain('aria-label="Start voice input"');
  });

  it("hides the action without removing the speech capability host", () => {
    const markup = renderToStaticMarkup(
      <ComposerSpeechAction
        speech={{} as DesktopSpeechBridge}
        visible={false}
        targetKey="draft:one"
        createTranscript={() => null}
        openVoiceInputSettings={() => {}}
        onActiveChange={() => {}}
      />,
    );

    expect(markup).toBe("");
  });
});

describe("ComposerSpeechActionView", () => {
  it("shows listening status without rendering a separate transcript preview", () => {
    const markup = renderToStaticMarkup(
      <ComposerSpeechActionView
        state={{
          phase: "listening",
          error: null,
          unsupportedReason: null,
        }}
        onToggle={vi.fn()}
      />,
    );

    expect(markup).toContain("Listening");
    expect(markup).toContain("data-composer-speech-status");
    expect(markup).not.toContain("data-composer-speech-preview");
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-label="Stop voice input"');
    expect(markup).toContain('aria-pressed="true"');
  });

  it("surfaces a recoverable error next to a retryable microphone action", () => {
    const markup = renderToStaticMarkup(
      <ComposerSpeechActionView
        state={{
          phase: "error",
          error: "Microphone access was not granted.",
          unsupportedReason: null,
        }}
        onToggle={vi.fn()}
      />,
    );

    expect(markup).toContain("Microphone access was not granted.");
    expect(markup).toContain('aria-label="Start voice input"');
    expect(markup).not.toMatch(/<button[^>]*\sdisabled(?:=|>)/);
  });
});
