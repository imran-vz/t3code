import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { SpeechInferenceFailure, SpeechInferencePreview } from "./SpeechInferenceWorker.ts";
import {
  prepareInstalled,
  sequence,
  staleSessionId,
  testEntry,
  withSpeech,
  workerFailure,
} from "./DesktopSpeechTestHarness.ts";

const pcm16 = new Uint8Array([0, 0, 255, 127]);

describe("DesktopSpeech sessions", () => {
  it.effect("requires an installed model and permits one live session", () =>
    Effect.gen(function* () {
      const withoutModel = yield* withSpeech({}, ({ speech }) => speech.start());
      assert.equal(withoutModel.type, "rejected");
      assert.equal(
        withoutModel.type === "rejected" ? withoutModel.reason : null,
        "no-active-model",
      );

      yield* withSpeech(
        { initialSpeechModelId: testEntry.id, prepare: prepareInstalled },
        ({ speech, worker }) =>
          Effect.gen(function* () {
            const first = yield* speech.start();
            assert.equal(first.type, "accepted");
            if (first.type !== "accepted") return;
            const second = yield* speech.start();
            assert.equal(second.type, "rejected");
            assert.equal(second.type === "rejected" ? second.reason : null, "session-in-progress");
            assert.equal(worker.starts, 1);
            yield* speech.cancel(first.sessionId);
          }),
      );
    }),
  );

  it.effect("retries a failed load and reuses a successful warm model", () => {
    let loadAttempts = 0;
    return withSpeech(
      {
        initialSpeechModelId: testEntry.id,
        prepare: prepareInstalled,
        configureWorker: (worker) => {
          worker.loadImpl = () => {
            loadAttempts += 1;
            return loadAttempts === 1
              ? Effect.fail(workerFailure("load", "load failed"))
              : Effect.void;
          };
        },
      },
      ({ speech, worker }) =>
        Effect.gen(function* () {
          assert.equal((yield* speech.start()).type, "rejected");
          const first = yield* speech.start();
          assert.equal(first.type, "accepted");
          if (first.type !== "accepted") return;
          yield* speech.cancel(first.sessionId);
          const second = yield* speech.start();
          assert.equal(second.type, "accepted");
          if (second.type !== "accepted") return;
          assert.deepEqual(yield* speech.stop(second.sessionId), {
            type: "completed",
            text: "final transcript",
          });
          assert.equal(loadAttempts, 2);
          assert.equal(worker.starts, 2);
        }),
    );
  });

  it.effect("acknowledges a chunk only after native feed settles", () =>
    Effect.gen(function* () {
      const feedStarted = yield* Deferred.make<void>();
      const releaseFeed = yield* Deferred.make<void>();
      yield* withSpeech(
        {
          initialSpeechModelId: testEntry.id,
          prepare: prepareInstalled,
          configureWorker: (worker) => {
            worker.feedImpl = () =>
              Deferred.succeed(feedStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFeed)),
                Effect.as(null),
              );
          },
        },
        ({ speech }) =>
          Effect.gen(function* () {
            const started = yield* speech.start();
            assert.equal(started.type, "accepted");
            if (started.type !== "accepted") return;
            const push = yield* Effect.forkChild(
              speech.acceptAudio({
                sessionId: started.sessionId,
                sequence: sequence(0),
                sampleRate: 16_000,
                pcm16,
              }),
            );
            yield* Deferred.await(feedStarted);
            assert.isUndefined(push.pollUnsafe());
            yield* Deferred.succeed(releaseFeed, undefined);
            assert.deepEqual(yield* Fiber.join(push), {
              type: "accepted",
              sequence: sequence(0),
            });
            yield* speech.cancel(started.sessionId);
          }),
      );
    }),
  );

  it.effect("streams monotonic previews and returns one authoritative final", () =>
    withSpeech(
      {
        initialSpeechModelId: testEntry.id,
        prepare: prepareInstalled,
        configureWorker: (worker) => {
          let call = 0;
          worker.feedImpl = (): Effect.Effect<
            SpeechInferencePreview | null,
            SpeechInferenceFailure
          > => {
            call += 1;
            return Effect.succeed(
              call === 1
                ? { committed: "hello", tentative: " world", revision: 2 }
                : { committed: "stale", tentative: " preview", revision: 1 },
            );
          };
        },
      },
      ({ speech, worker }) =>
        Effect.gen(function* () {
          const started = yield* speech.start();
          assert.equal(started.type, "accepted");
          if (started.type !== "accepted") return;
          const previewFiber = yield* Effect.forkChild(
            speech.previews.pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
          );
          yield* Effect.yieldNow;
          for (const audioSequence of [sequence(0), sequence(1)]) {
            assert.equal(
              (yield* speech.acceptAudio({
                sessionId: started.sessionId,
                sequence: audioSequence,
                sampleRate: 16_000,
                pcm16,
              })).type,
              "accepted",
            );
          }
          const outOfOrder = yield* speech.acceptAudio({
            sessionId: started.sessionId,
            sequence: sequence(1),
            sampleRate: 16_000,
            pcm16,
          });
          assert.equal(outOfOrder.type, "rejected");
          assert.equal(
            outOfOrder.type === "rejected" ? outOfOrder.reason : null,
            "out-of-order-audio",
          );
          assert.deepEqual(yield* Fiber.join(previewFiber), {
            sessionId: started.sessionId,
            committed: "hello",
            tentative: " world",
            revision: 2,
          });
          assert.deepEqual((yield* speech.getState).preview, {
            committed: "hello",
            tentative: " world",
            revision: 2,
          });
          assert.deepEqual(yield* speech.stop(started.sessionId), {
            type: "completed",
            text: "final transcript",
          });
          assert.equal(worker.finalizes, 1);
          assert.equal((yield* speech.getState).session.type, "idle");
        }),
    ),
  );

  it.effect("rejects stale cancellation and resets the active stream", () =>
    withSpeech(
      { initialSpeechModelId: testEntry.id, prepare: prepareInstalled },
      ({ speech, worker }) =>
        Effect.gen(function* () {
          const started = yield* speech.start();
          assert.equal(started.type, "accepted");
          if (started.type !== "accepted") return;
          const stale = yield* speech.cancel(staleSessionId);
          assert.equal(stale.type, "rejected");
          assert.equal(stale.type === "rejected" ? stale.reason : null, "stale-session");
          assert.deepEqual(yield* speech.cancel(started.sessionId), { type: "accepted" });
          assert.equal(worker.cancels, 1);
          assert.equal((yield* speech.getState).session.type, "idle");
        }),
    ),
  );

  it.effect("fails terminally without batch recovery and permits retry after cancel", () =>
    withSpeech(
      {
        initialSpeechModelId: testEntry.id,
        prepare: prepareInstalled,
        configureWorker: (worker) => {
          worker.feedImpl = () => Effect.fail(workerFailure("feed", "feed failed"));
        },
      },
      ({ speech, worker }) =>
        Effect.gen(function* () {
          const started = yield* speech.start();
          assert.equal(started.type, "accepted");
          if (started.type !== "accepted") return;
          const failed = yield* speech.acceptAudio({
            sessionId: started.sessionId,
            sequence: sequence(0),
            sampleRate: 16_000,
            pcm16,
          });
          assert.equal(failed.type, "rejected");
          assert.equal((yield* speech.getState).session.type, "failed");
          yield* speech.cancel(started.sessionId);
          worker.feedImpl = () => Effect.succeed(null);
          const retry = yield* speech.start();
          assert.equal(retry.type, "accepted");
          if (retry.type === "accepted") yield* speech.cancel(retry.sessionId);
        }),
    ),
  );
});
