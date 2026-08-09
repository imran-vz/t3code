import type {
  DesktopSpeechBridge,
  DesktopSpeechCancelResult,
  DesktopSpeechSessionId,
  DesktopSpeechStartResult,
  DesktopSpeechStopResult,
} from "@t3tools/contracts";

import {
  startDesktopSpeechAudioCapture,
  DesktopSpeechCaptureError,
  type DesktopSpeechAudioCapture,
  type DesktopSpeechAudioCaptureFactory,
} from "./audioCapture";

export const DESKTOP_SPEECH_FINALIZE_TIMEOUT_MS = 35_000;

function finalizeWithTimeout(
  finalize: Promise<DesktopSpeechStopResult>,
): Promise<DesktopSpeechStopResult> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      reject(
        new DesktopSpeechCaptureError(
          "stop-timeout",
          "Voice input timed out while finalizing the transcript. The recording was canceled.",
        ),
      );
    }, DESKTOP_SPEECH_FINALIZE_TIMEOUT_MS);
    finalize.then(
      (result) => {
        globalThis.clearTimeout(timeout);
        resolve(result);
      },
      (error) => {
        globalThis.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export interface DesktopSpeechRecording {
  readonly sessionId: DesktopSpeechSessionId;
  stop(): Promise<DesktopSpeechStopResult>;
  cancel(): Promise<DesktopSpeechCancelResult>;
}

export type DesktopSpeechRecordingStartResult =
  | {
      readonly type: "accepted";
      readonly recording: DesktopSpeechRecording;
    }
  | Exclude<DesktopSpeechStartResult, { readonly type: "accepted" }>;

export interface StartDesktopSpeechRecordingOptions {
  readonly speech: DesktopSpeechBridge;
  readonly captureFactory?: DesktopSpeechAudioCaptureFactory;
  readonly onCaptureError?: (error: DesktopSpeechCaptureError) => void;
}

/** Starts the desktop session and owns its matching browser microphone lease. */
export async function startDesktopSpeechRecording(
  options: StartDesktopSpeechRecordingOptions,
): Promise<DesktopSpeechRecordingStartResult> {
  const started = await options.speech.start();
  if (started.type !== "accepted") return started;

  const captureFactory = options.captureFactory ?? startDesktopSpeechAudioCapture;
  const sessionId = started.sessionId;
  let capture: DesktopSpeechAudioCapture;
  let state: "active" | "stopping" | "canceling" | "closed" | "failed" = "active";
  let terminalPromise: Promise<unknown> | undefined;
  let captureFailure: DesktopSpeechCaptureError | undefined;
  const readState = (): typeof state => state;

  const cancelAfterCaptureFailure = (error: DesktopSpeechCaptureError) => {
    if (state !== "active") return;
    state = "failed";
    captureFailure = error;
    terminalPromise = options.speech.cancel(sessionId).catch(() => undefined);
    options.onCaptureError?.(error);
  };

  const cancelAfterUnload = () => {
    if (state !== "active" && state !== "stopping") return;
    state = "closed";
    terminalPromise = options.speech.cancel(sessionId).catch(() => undefined);
  };

  try {
    capture = await captureFactory({
      sessionId,
      pushAudio: options.speech.pushAudio,
      onError: cancelAfterCaptureFailure,
      onUnexpectedClose: cancelAfterUnload,
    });
  } catch (error) {
    if (readState() === "failed" || readState() === "closed") {
      await terminalPromise;
    } else {
      await options.speech.cancel(sessionId).catch(() => undefined);
    }
    throw error;
  }

  if (readState() !== "active") {
    await capture.cancel();
    await terminalPromise;
    if (captureFailure !== undefined) throw captureFailure;
    throw new Error("Voice input recording ended during microphone setup.");
  }

  return {
    type: "accepted",
    recording: {
      sessionId,
      stop: async () => {
        if (state === "failed") {
          await terminalPromise;
          throw captureFailure;
        }
        if (state !== "active") {
          throw new Error("Voice input recording is no longer active.");
        }

        state = "stopping";
        try {
          await capture.stop();
        } catch (error) {
          if (readState() === "canceling" || readState() === "closed") {
            await terminalPromise;
            throw error;
          }
          state = "failed";
          await options.speech.cancel(sessionId).catch(() => undefined);
          throw error;
        }

        if (readState() !== "stopping") {
          await terminalPromise;
          throw new Error("Voice input recording was canceled before finalization.");
        }

        terminalPromise = finalizeWithTimeout(options.speech.stop(sessionId));
        let result: DesktopSpeechStopResult;
        try {
          result = (await terminalPromise) as DesktopSpeechStopResult;
        } catch (error) {
          state = "failed";
          await options.speech.cancel(sessionId).catch(() => undefined);
          throw error;
        }
        state = "closed";
        return result;
      },
      cancel: async () => {
        if (state === "closed") {
          throw new Error("Voice input recording is no longer active.");
        }
        if (state === "failed") {
          await terminalPromise;
          return { type: "accepted" };
        }
        if (state === "canceling") {
          return (await terminalPromise) as DesktopSpeechCancelResult;
        }

        state = "canceling";
        terminalPromise = (async () => {
          await capture.cancel();
          return options.speech.cancel(sessionId);
        })();
        const result = (await terminalPromise) as DesktopSpeechCancelResult;
        state = "closed";
        return result;
      },
    },
  };
}
