import {
  DesktopSpeechPreviewDelta,
  DesktopSpeechSessionId,
  DesktopSpeechState,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopSpeech from "../../speech/DesktopSpeech.ts";
import * as IpcChannels from "../channels.ts";
import {
  cancelSpeech,
  cancelSpeechDownload,
  downloadSpeechModel,
  getSpeechState,
  installSpeechStateForwarding,
  pushSpeechAudio,
  removeSpeechModel,
  selectSpeechModel,
  startSpeech,
  stopSpeech,
} from "./speech.ts";

const state = Schema.decodeUnknownSync(DesktopSpeechState)({
  availability: { type: "supported" },
  models: [],
  selectedModelId: null,
  session: { type: "idle" },
  preview: { committed: "", tentative: "", revision: 0 },
});
const sessionId = Schema.decodeUnknownSync(DesktopSpeechSessionId)("session-1");
const preview = Schema.decodeUnknownSync(DesktopSpeechPreviewDelta)({
  sessionId,
  committed: "hello",
  tentative: " world",
  revision: 1,
});

describe("speech IPC", () => {
  it.effect("schema-decodes invocations and delegates only to DesktopSpeech", () => {
    const calls: Array<string> = [];
    const speech = DesktopSpeech.DesktopSpeech.of({
      getState: Effect.sync(() => {
        calls.push("get-state");
        return state;
      }),
      restoreSelection: Effect.void,
      changes: Stream.never,
      previews: Stream.never,
      selectModel: (modelId) =>
        Effect.sync(() => {
          calls.push(`select:${modelId}`);
          return { type: "accepted" } as const;
        }),
      downloadModel: (modelId) =>
        Effect.sync(() => {
          calls.push(`download:${modelId}`);
          return { type: "accepted" } as const;
        }),
      cancelDownload: (modelId) =>
        Effect.sync(() => {
          calls.push(`cancel-download:${modelId}`);
          return { type: "accepted" } as const;
        }),
      removeModel: (modelId) =>
        Effect.sync(() => {
          calls.push(`remove:${modelId}`);
          return { type: "accepted" } as const;
        }),
      start: () =>
        Effect.sync(() => {
          calls.push("start");
          return { type: "accepted", sessionId } as const;
        }),
      acceptAudio: (input) =>
        Effect.sync(() => {
          calls.push(`audio:${input.sessionId}:${input.sequence}`);
          return { type: "accepted", sequence: input.sequence } as const;
        }),
      stop: (sessionId) =>
        Effect.sync(() => {
          calls.push(`stop:${sessionId}`);
          return { type: "completed", text: "final text" } as const;
        }),
      cancel: (sessionId) =>
        Effect.sync(() => {
          calls.push(`cancel:${sessionId}`);
          return { type: "accepted" } as const;
        }),
    });

    return Effect.gen(function* () {
      assert.deepEqual(yield* getSpeechState.handler(undefined), state);
      yield* selectSpeechModel.handler({ modelId: "moonshine-tiny" });
      yield* downloadSpeechModel.handler({ modelId: "moonshine-tiny" });
      yield* cancelSpeechDownload.handler({ modelId: "moonshine-tiny" });
      yield* removeSpeechModel.handler({ modelId: "moonshine-tiny" });
      assert.deepEqual(yield* startSpeech.handler({}), {
        type: "accepted",
        sessionId: "session-1",
      });
      assert.deepEqual(
        yield* pushSpeechAudio.handler({
          sessionId: "session-1",
          sequence: 0,
          sampleRate: 16_000,
          pcm16: new Uint8Array([0, 0]),
        }),
        { type: "accepted", sequence: 0 },
      );
      assert.deepEqual(yield* stopSpeech.handler({ sessionId: "session-1" }), {
        type: "completed",
        text: "final text",
      });
      yield* cancelSpeech.handler({ sessionId: "session-1" });

      assert.deepEqual(calls, [
        "get-state",
        "select:moonshine-tiny",
        "download:moonshine-tiny",
        "cancel-download:moonshine-tiny",
        "remove:moonshine-tiny",
        "start",
        "audio:session-1:0",
        "stop:session-1",
        "cancel:session-1",
      ]);
    }).pipe(Effect.provideService(DesktopSpeech.DesktopSpeech, speech));
  });

  it.effect("rejects invalid audio before resolving DesktopSpeech", () => {
    let called = false;
    const speechLayer = Layer.mock(DesktopSpeech.DesktopSpeech)({
      acceptAudio: (input) =>
        Effect.sync(() => {
          called = true;
          return { type: "accepted", sequence: input.sequence } as const;
        }),
    });

    return Effect.gen(function* () {
      const exit = yield* pushSpeechAudio
        .handler({
          sessionId: "session-1",
          sequence: 0,
          sampleRate: 16_000,
          pcm16: new Uint8Array([0]),
        })
        .pipe(Effect.exit);
      assert.isTrue(exit._tag === "Failure");
      assert.isFalse(called);
    }).pipe(Effect.provide(speechLayer));
  });

  it.effect("sanitizes unexpected infrastructure failures", () => {
    const speechLayer = Layer.mock(DesktopSpeech.DesktopSpeech)({
      selectModel: () =>
        Effect.fail(
          new DesktopSpeech.DesktopSpeechInfrastructureError({
            operation: "persist-selection",
            cause: new Error("/private/model/path"),
          }),
        ),
    });

    return Effect.gen(function* () {
      assert.deepEqual(yield* selectSpeechModel.handler({ modelId: "moonshine-tiny" }), {
        type: "rejected",
        reason: "operation-failed",
        message: "Voice input could not complete the requested operation.",
      });
    }).pipe(Effect.provide(speechLayer));
  });

  it.effect("forwards encoded full-state snapshots and unsubscribes with its scope", () =>
    Effect.gen(function* () {
      const delivered = yield* Deferred.make<void>();
      let finalized = false;
      const speechLayer = Layer.mock(DesktopSpeech.DesktopSpeech)({
        changes: Stream.concat(Stream.succeed(state), Stream.never).pipe(
          Stream.ensuring(
            Effect.sync(() => {
              finalized = true;
            }),
          ),
        ),
        previews: Stream.never,
      });
      const windowLayer = Layer.mock(ElectronWindow.ElectronWindow)({
        sendAll: (channel, snapshot) =>
          Effect.gen(function* () {
            assert.equal(channel, IpcChannels.SPEECH_STATE_CHANNEL);
            assert.deepEqual(snapshot, state);
            yield* Deferred.succeed(delivered, undefined);
          }),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* installSpeechStateForwarding();
          yield* Deferred.await(delivered);
        }),
      ).pipe(Effect.provide(Layer.mergeAll(speechLayer, windowLayer)));
      assert.isTrue(finalized);
    }),
  );

  it.effect("forwards compact preview deltas on the preview channel", () =>
    Effect.gen(function* () {
      const delivered = yield* Deferred.make<void>();
      const speechLayer = Layer.mock(DesktopSpeech.DesktopSpeech)({
        changes: Stream.never,
        previews: Stream.concat(Stream.succeed(preview), Stream.never),
      });
      const windowLayer = Layer.mock(ElectronWindow.ElectronWindow)({
        sendAll: (channel, payload) =>
          Effect.gen(function* () {
            assert.equal(channel, IpcChannels.SPEECH_PREVIEW_CHANNEL);
            assert.deepEqual(payload, preview);
            yield* Deferred.succeed(delivered, undefined);
          }),
      });

      yield* Effect.scoped(
        installSpeechStateForwarding().pipe(Effect.andThen(Deferred.await(delivered))),
      ).pipe(Effect.provide(Layer.mergeAll(speechLayer, windowLayer)));
    }),
  );
});
