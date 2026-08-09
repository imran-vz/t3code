import {
  DesktopSpeechActionResult,
  DesktopSpeechAudioInput,
  DesktopSpeechAudioResult,
  DesktopSpeechCancelDownloadInput,
  DesktopSpeechCancelInput,
  DesktopSpeechDownloadModelInput,
  DesktopSpeechRemoveModelInput,
  DesktopSpeechSelectModelInput,
  DesktopSpeechPreviewDelta,
  DesktopSpeechStartInput,
  DesktopSpeechStartResult,
  DesktopSpeechState,
  DesktopSpeechStopInput,
  DesktopSpeechStopResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopSpeech from "../../speech/DesktopSpeech.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const SAFE_OPERATION_FAILURE = "Voice input could not complete the requested operation.";
const operationFailed = {
  type: "rejected",
  reason: "operation-failed",
  message: SAFE_OPERATION_FAILURE,
} as const;

export const installSpeechStateForwarding = Effect.fn("desktop.ipc.speech.installStateForwarding")(
  function* () {
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const speech = yield* DesktopSpeech.DesktopSpeech;
    const encodeState = Schema.encodeUnknownEffect(DesktopSpeechState);
    const encodePreview = Schema.encodeUnknownEffect(DesktopSpeechPreviewDelta);

    yield* speech.changes.pipe(
      Stream.mapEffect((state) => encodeState(state)),
      Stream.runForEach((state) => electronWindow.sendAll(IpcChannels.SPEECH_STATE_CHANNEL, state)),
      Effect.forkScoped,
    );
    yield* speech.previews.pipe(
      Stream.mapEffect((preview) => encodePreview(preview)),
      Stream.runForEach((preview) =>
        electronWindow.sendAll(IpcChannels.SPEECH_PREVIEW_CHANNEL, preview),
      ),
      Effect.forkScoped,
    );
  },
);

export const getSpeechState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopSpeechState,
  handler: Effect.fn("desktop.ipc.speech.getState")(function* () {
    const speech = yield* DesktopSpeech.DesktopSpeech;
    return yield* speech.getState;
  }),
});

export const selectSpeechModel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_SELECT_MODEL_CHANNEL,
  payload: DesktopSpeechSelectModelInput,
  result: DesktopSpeechActionResult,
  handler: Effect.fn("desktop.ipc.speech.selectModel")(function* ({ modelId }) {
    const speech = yield* DesktopSpeech.DesktopSpeech;
    return yield* speech.selectModel(modelId).pipe(Effect.orElseSucceed(() => operationFailed));
  }),
});

export const downloadSpeechModel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_DOWNLOAD_MODEL_CHANNEL,
  payload: DesktopSpeechDownloadModelInput,
  result: DesktopSpeechActionResult,
  handler: Effect.fn("desktop.ipc.speech.downloadModel")(function* ({ modelId }) {
    const speech = yield* DesktopSpeech.DesktopSpeech;
    return yield* speech.downloadModel(modelId);
  }),
});

export const cancelSpeechDownload = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_CANCEL_DOWNLOAD_CHANNEL,
  payload: DesktopSpeechCancelDownloadInput,
  result: DesktopSpeechActionResult,
  handler: Effect.fn("desktop.ipc.speech.cancelDownload")(function* ({ modelId }) {
    const speech = yield* DesktopSpeech.DesktopSpeech;
    return yield* speech.cancelDownload(modelId);
  }),
});

export const removeSpeechModel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_REMOVE_MODEL_CHANNEL,
  payload: DesktopSpeechRemoveModelInput,
  result: DesktopSpeechActionResult,
  handler: Effect.fn("desktop.ipc.speech.removeModel")(function* ({ modelId }) {
    const speech = yield* DesktopSpeech.DesktopSpeech;
    return yield* speech.removeModel(modelId);
  }),
});

export const startSpeech = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_START_CHANNEL,
  payload: DesktopSpeechStartInput,
  result: DesktopSpeechStartResult,
  handler: Effect.fn("desktop.ipc.speech.start")(function* () {
    const speech = yield* DesktopSpeech.DesktopSpeech;
    return yield* speech.start().pipe(Effect.orElseSucceed(() => operationFailed));
  }),
});

export const pushSpeechAudio = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_PUSH_AUDIO_CHANNEL,
  payload: DesktopSpeechAudioInput,
  result: DesktopSpeechAudioResult,
  handler: Effect.fn("desktop.ipc.speech.pushAudio")(function* (input) {
    const speech = yield* DesktopSpeech.DesktopSpeech;
    return yield* speech.acceptAudio(input);
  }),
});

export const stopSpeech = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_STOP_CHANNEL,
  payload: DesktopSpeechStopInput,
  result: DesktopSpeechStopResult,
  handler: Effect.fn("desktop.ipc.speech.stop")(function* ({ sessionId }) {
    const speech = yield* DesktopSpeech.DesktopSpeech;
    return yield* speech.stop(sessionId);
  }),
});

export const cancelSpeech = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_CANCEL_CHANNEL,
  payload: DesktopSpeechCancelInput,
  result: DesktopSpeechActionResult,
  handler: Effect.fn("desktop.ipc.speech.cancel")(function* ({ sessionId }) {
    const speech = yield* DesktopSpeech.DesktopSpeech;
    return yield* speech.cancel(sessionId);
  }),
});

export const methods = [
  getSpeechState,
  selectSpeechModel,
  downloadSpeechModel,
  cancelSpeechDownload,
  removeSpeechModel,
  startSpeech,
  pushSpeechAudio,
  stopSpeech,
  cancelSpeech,
] as const;
