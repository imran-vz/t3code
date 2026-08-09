export interface ComposerSpeechTranscript {
  update(transcript: string): boolean;
  commit(finalTranscript: string): boolean;
  discard(): boolean;
}

export function createComposerSpeechTranscript({
  read,
  writeTransient,
  writeFinal,
  restoreInitial,
  isCurrent,
}: {
  readonly read: () => string;
  readonly writeTransient: (text: string) => void;
  readonly writeFinal: (text: string) => void;
  readonly restoreInitial: (text: string) => void;
  readonly isCurrent: () => boolean;
}): ComposerSpeechTranscript {
  const initialPrompt = read();
  const separator = initialPrompt.length > 0 && !/\s$/u.test(initialPrompt) ? " " : "";
  let ownedPrompt = initialPrompt;
  let closed = false;

  const canReplaceOwnedPrompt = () => {
    if (closed) return false;
    if (!isCurrent() || read() !== ownedPrompt) {
      closed = true;
      return false;
    }
    return true;
  };

  const promptWithTranscript = (transcript: string) =>
    transcript.length === 0 ? initialPrompt : `${initialPrompt}${separator}${transcript}`;

  return {
    update: (transcript) => {
      if (!canReplaceOwnedPrompt()) return false;
      const nextPrompt = promptWithTranscript(transcript);
      if (nextPrompt === ownedPrompt) return true;
      writeTransient(nextPrompt);
      ownedPrompt = nextPrompt;
      return true;
    },
    commit: (finalTranscript) => {
      if (!canReplaceOwnedPrompt()) return false;
      const nextPrompt = promptWithTranscript(finalTranscript);
      writeFinal(nextPrompt);
      ownedPrompt = nextPrompt;
      closed = true;
      return true;
    },
    discard: () => {
      if (!canReplaceOwnedPrompt()) return false;
      restoreInitial(initialPrompt);
      ownedPrompt = initialPrompt;
      closed = true;
      return true;
    },
  };
}
