import { describe, expect, it, vi } from "vite-plus/test";

import { createComposerSpeechTranscript } from "./composerSpeechTranscript";

function createHarness(initialPrompt: string) {
  let prompt = initialPrompt;
  let current = true;
  const writeTransient = vi.fn((nextPrompt: string) => {
    prompt = nextPrompt;
  });
  const writeFinal = vi.fn((nextPrompt: string) => {
    prompt = nextPrompt;
  });
  const restoreInitial = vi.fn((nextPrompt: string) => {
    prompt = nextPrompt;
  });
  const lease = createComposerSpeechTranscript({
    read: () => prompt,
    writeTransient,
    writeFinal,
    restoreInitial,
    isCurrent: () => current,
  });

  return {
    lease,
    readPrompt: () => prompt,
    mutatePrompt: (nextPrompt: string) => {
      prompt = nextPrompt;
    },
    invalidate: () => {
      current = false;
    },
    writeTransient,
    writeFinal,
    restoreInitial,
  };
}

describe("createComposerSpeechTranscript", () => {
  it("captures the initial prompt without writing to it", () => {
    const harness = createHarness("existing draft");

    expect(harness.readPrompt()).toBe("existing draft");
    expect(harness.writeTransient).not.toHaveBeenCalled();
    expect(harness.writeFinal).not.toHaveBeenCalled();
    expect(harness.restoreInitial).not.toHaveBeenCalled();
  });

  it.each([
    ["", "first words", "first words"],
    ["existing draft", "first words", "existing draft first words"],
    ["existing draft ", "first words", "existing draft first words"],
    ["existing draft\n", "first words", "existing draft\nfirst words"],
  ])("uses exactly the required separator for %j", (initialPrompt, transcript, expected) => {
    const { lease, readPrompt } = createHarness(initialPrompt);

    expect(lease.update(transcript)).toBe(true);
    expect(readPrompt()).toBe(expected);
  });

  it("replaces the prior speech-owned suffix with each complete transcript", () => {
    const { lease, readPrompt } = createHarness("keep this");

    expect(lease.update("partial phrase")).toBe(true);
    expect(lease.update("revised complete phrase")).toBe(true);
    expect(readPrompt()).toBe("keep this revised complete phrase");
  });

  it("does not add a separator before the first non-empty revision", () => {
    const { lease, readPrompt } = createHarness("keep this");

    expect(lease.update("")).toBe(true);
    expect(readPrompt()).toBe("keep this");
    expect(lease.update("first word")).toBe(true);
    expect(readPrompt()).toBe("keep this first word");
  });

  it("commits the authoritative final transcript and closes the lease", () => {
    const { lease, readPrompt, writeTransient, writeFinal, restoreInitial } =
      createHarness("draft");

    expect(lease.update("rough partial")).toBe(true);
    expect(lease.commit("correct final")).toBe(true);
    expect(readPrompt()).toBe("draft correct final");

    writeTransient.mockClear();
    writeFinal.mockClear();
    restoreInitial.mockClear();
    expect(lease.update("too late")).toBe(false);
    expect(lease.commit("also too late")).toBe(false);
    expect(lease.discard()).toBe(false);
    expect(writeTransient).not.toHaveBeenCalled();
    expect(writeFinal).not.toHaveBeenCalled();
    expect(restoreInitial).not.toHaveBeenCalled();
    expect(readPrompt()).toBe("draft correct final");
  });

  it("discards all speech text and restores the exact initial prompt", () => {
    const { lease, readPrompt, writeTransient } = createHarness("draft\t");

    expect(lease.update("temporary speech")).toBe(true);
    expect(lease.discard()).toBe(true);
    expect(readPrompt()).toBe("draft\t");

    writeTransient.mockClear();
    expect(lease.update("too late")).toBe(false);
    expect(writeTransient).not.toHaveBeenCalled();
  });

  it.each([
    ["update", (lease: ReturnType<typeof createComposerSpeechTranscript>) => lease.update("new")],
    ["commit", (lease: ReturnType<typeof createComposerSpeechTranscript>) => lease.commit("final")],
    ["discard", (lease: ReturnType<typeof createComposerSpeechTranscript>) => lease.discard()],
  ])("refuses %s after an external prompt mutation without overwriting it", (_name, act) => {
    const { lease, readPrompt, mutatePrompt, writeTransient, writeFinal, restoreInitial } =
      createHarness("draft");
    expect(lease.update("owned speech")).toBe(true);
    writeTransient.mockClear();
    writeFinal.mockClear();
    restoreInitial.mockClear();

    mutatePrompt("user-edited text");

    expect(act(lease)).toBe(false);
    expect(readPrompt()).toBe("user-edited text");
    expect(writeTransient).not.toHaveBeenCalled();
    expect(writeFinal).not.toHaveBeenCalled();
    expect(restoreInitial).not.toHaveBeenCalled();
  });

  it("closes a lease after detecting an external mutation", () => {
    const { lease, mutatePrompt, writeFinal } = createHarness("draft");
    expect(lease.update("owned speech")).toBe(true);

    mutatePrompt("external text");
    expect(lease.update("rejected")).toBe(false);

    mutatePrompt("draft owned speech");
    writeFinal.mockClear();
    expect(lease.commit("must remain rejected")).toBe(false);
    expect(writeFinal).not.toHaveBeenCalled();
  });

  it("keeps live revisions transient and performs one authoritative final write", () => {
    const { lease, writeTransient, writeFinal, restoreInitial } = createHarness("draft");

    expect(lease.update("one")).toBe(true);
    expect(lease.update("one two")).toBe(true);
    expect(writeTransient).toHaveBeenCalledTimes(2);
    expect(writeFinal).not.toHaveBeenCalled();
    expect(restoreInitial).not.toHaveBeenCalled();

    expect(lease.commit("one two three")).toBe(true);
    expect(writeFinal).toHaveBeenCalledOnce();
    expect(writeFinal).toHaveBeenCalledWith("draft one two three");
  });

  it("restores a transient revision without performing a final write", () => {
    const { lease, readPrompt, writeFinal, restoreInitial } = createHarness("saved draft");

    expect(lease.update("temporary words")).toBe(true);
    expect(lease.discard()).toBe(true);

    expect(readPrompt()).toBe("saved draft");
    expect(writeFinal).not.toHaveBeenCalled();
    expect(restoreInitial).toHaveBeenCalledOnce();
  });

  it("refuses to write after its composer target changes", () => {
    const { lease, invalidate, writeTransient, writeFinal, restoreInitial } =
      createHarness("draft");

    invalidate();

    expect(lease.update("wrong target")).toBe(false);
    expect(writeTransient).not.toHaveBeenCalled();
    expect(writeFinal).not.toHaveBeenCalled();
    expect(restoreInitial).not.toHaveBeenCalled();
  });
});
