import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { composerTargetKey, DraftId } from "../../composerDraftStore";
import {
  type ComposerSpeechPromptOverride,
  resolveComposerSpeechPromptOverride,
  shouldReleaseComposerSpeechPromptOverride,
} from "./useComposerSpeechPrompt";

const activeOverride: ComposerSpeechPromptOverride = {
  targetKey: "draft:one",
  persistedPrompt: "saved",
  value: "saved spoken words",
  status: "active",
  historyMode: "push",
};

describe("composer speech prompt overlay", () => {
  it("uses environment-qualified identities for server threads", () => {
    expect(composerTargetKey(DraftId.make("one"))).toBe("one");
    expect(
      composerTargetKey({
        environmentId: EnvironmentId.make("env-one"),
        threadId: ThreadId.make("thread-one"),
      }),
    ).toBe("env-one:thread-one");
  });

  it("shows an active transcript only while its target and persisted base still match", () => {
    expect(resolveComposerSpeechPromptOverride(activeOverride, "draft:one", "saved")).toBe(
      activeOverride,
    );
    expect(resolveComposerSpeechPromptOverride(activeOverride, "draft:two", "saved")).toBeNull();
    expect(
      resolveComposerSpeechPromptOverride(activeOverride, "draft:one", "user edit"),
    ).toBeNull();
  });

  it("releases an active overlay after target navigation or an external draft edit", () => {
    expect(shouldReleaseComposerSpeechPromptOverride(activeOverride, "draft:one", "saved")).toBe(
      false,
    );
    expect(shouldReleaseComposerSpeechPromptOverride(activeOverride, "draft:two", "saved")).toBe(
      true,
    );
    expect(
      shouldReleaseComposerSpeechPromptOverride(activeOverride, "draft:one", "user edit"),
    ).toBe(true);
  });

  it("keeps a settled overlay for the render that commits its Lexical history entry", () => {
    const settledOverride: ComposerSpeechPromptOverride = {
      ...activeOverride,
      status: "settled",
      historyMode: "merge",
    };

    expect(resolveComposerSpeechPromptOverride(settledOverride, "draft:one", "saved")).toBe(
      settledOverride,
    );
    expect(shouldReleaseComposerSpeechPromptOverride(settledOverride, "draft:one", "saved")).toBe(
      false,
    );
    expect(
      shouldReleaseComposerSpeechPromptOverride(settledOverride, "draft:one", "saved spoken words"),
    ).toBe(true);
  });

  it("releases settled speech when another writer wins the draft", () => {
    const settledOverride: ComposerSpeechPromptOverride = {
      ...activeOverride,
      status: "settled",
      historyMode: "merge",
    };

    expect(
      shouldReleaseComposerSpeechPromptOverride(settledOverride, "draft:one", "external value"),
    ).toBe(true);
    expect(
      resolveComposerSpeechPromptOverride(settledOverride, "draft:one", "external value"),
    ).toBeNull();
  });
});
