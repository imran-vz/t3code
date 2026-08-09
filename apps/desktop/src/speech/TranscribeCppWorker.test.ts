import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import { SpeechInferenceWorker, SpeechInferenceWorkerCrash } from "./SpeechInferenceWorker.ts";
import {
  layerWithProcess,
  type SpeechUtilityProcess,
  type TranscribeCppWorkerOptions,
} from "./TranscribeCppWorker.ts";
import type { SpeechWorkerRequest, SpeechWorkerResult } from "./speechWorkerProtocol.ts";

class FakeSpeechUtilityProcess implements SpeechUtilityProcess {
  readonly posted: Queue.Queue<SpeechWorkerRequest>;
  readonly messageListeners = new Set<(message: unknown) => void>();
  readonly exitListeners = new Set<(code: number) => void>();
  killCount = 0;

  constructor(posted: Queue.Queue<SpeechWorkerRequest>) {
    this.posted = posted;
  }

  postMessage = (message: SpeechWorkerRequest) => {
    Queue.offerUnsafe(this.posted, message);
  };
  kill = () => {
    this.killCount += 1;
  };
  onMessage = (listener: (message: unknown) => void) => {
    this.messageListeners.add(listener);
  };
  offMessage = (listener: (message: unknown) => void) => {
    this.messageListeners.delete(listener);
  };
  onExit = (listener: (code: number) => void) => {
    this.exitListeners.add(listener);
  };
  offExit = (listener: (code: number) => void) => {
    this.exitListeners.delete(listener);
  };

  emitMessage(response: unknown): void {
    for (const listener of this.messageListeners) listener(response);
  }

  emitExit(code: number): void {
    for (const listener of this.exitListeners) listener(code);
  }
}

const makeProcess = Effect.gen(function* () {
  return new FakeSpeechUtilityProcess(yield* Queue.bounded<SpeechWorkerRequest>(32));
});

function respond(
  process: FakeSpeechUtilityProcess,
  request: SpeechWorkerRequest,
  result: SpeechWorkerResult,
): void {
  process.emitMessage({ requestId: request.requestId, type: "success", result });
}

function withWorker<A, E>(
  process: FakeSpeechUtilityProcess,
  use: (worker: SpeechInferenceWorker["Service"]) => Effect.Effect<A, E>,
  options: TranscribeCppWorkerOptions = {},
) {
  return Effect.gen(function* () {
    return yield* use(yield* SpeechInferenceWorker);
  }).pipe(Effect.provide(layerWithProcess(Effect.succeed(process), options)));
}

const load = Effect.fn("test.loadSpeechModel")(function* (
  worker: SpeechInferenceWorker["Service"],
  process: FakeSpeechUtilityProcess,
) {
  const fiber = yield* Effect.forkChild(worker.load("/models/moonshine.gguf"));
  const request = yield* Queue.take(process.posted);
  assert.equal(request.type, "load");
  respond(process, request, { type: "loaded" });
  yield* Fiber.join(fiber);
});

const start = Effect.fn("test.startSpeechStream")(function* (
  worker: SpeechInferenceWorker["Service"],
  process: FakeSpeechUtilityProcess,
) {
  const fiber = yield* Effect.forkChild(worker.start());
  const request = yield* Queue.take(process.posted);
  assert.equal(request.type, "start");
  respond(process, request, { type: "started" });
  yield* Fiber.join(fiber);
});

describe("TranscribeCppWorker", () => {
  it.effect("spawns lazily and releases the utility process with its layer", () =>
    Effect.gen(function* () {
      const process = yield* makeProcess;
      let acquisitions = 0;
      yield* Effect.gen(function* () {
        const worker = yield* SpeechInferenceWorker;
        assert.equal(acquisitions, 0);
        assert.isTrue(yield* worker.isAlive);
        yield* load(worker, process);
        assert.equal(acquisitions, 1);
      }).pipe(
        Effect.provide(
          layerWithProcess(
            Effect.sync(() => {
              acquisitions += 1;
              return process;
            }),
          ),
        ),
      );
      assert.equal(process.killCount, 1);
      assert.equal(process.messageListeners.size, 0);
      assert.equal(process.exitListeners.size, 0);
    }),
  );

  it.effect("respawns lazily after a typed utility-process crash", () =>
    Effect.gen(function* () {
      const first = yield* makeProcess;
      const second = yield* makeProcess;
      const processes = [first, second];
      let acquisitions = 0;

      yield* Effect.gen(function* () {
        const worker = yield* SpeechInferenceWorker;
        yield* load(worker, first);
        const crashFiber = yield* Effect.forkChild(worker.awaitCrash);
        first.emitExit(9);
        assert.equal((yield* Fiber.join(crashFiber)).exitCode, 9);
        assert.isFalse(yield* worker.isAlive);
        yield* load(worker, second);
        assert.equal(acquisitions, 2);
        assert.isTrue(yield* worker.isAlive);
      }).pipe(
        Effect.provide(
          layerWithProcess(
            Effect.sync(() => {
              const process = processes[acquisitions++];
              if (!process) throw new Error("Unexpected speech worker acquisition.");
              return process;
            }),
          ),
        ),
      );
    }),
  );

  it.effect("turns a request timeout into a crash and permits a fresh load", () =>
    Effect.gen(function* () {
      const first = yield* makeProcess;
      const second = yield* makeProcess;
      const processes = [first, second];
      let acquisitions = 0;

      yield* Effect.gen(function* () {
        const worker = yield* SpeechInferenceWorker;
        const loadFiber = yield* Effect.forkChild(worker.load("/models/moonshine.gguf"));
        assert.equal((yield* Queue.take(first.posted)).type, "load");
        yield* TestClock.adjust("1 second");
        assert.instanceOf(
          yield* Fiber.join(loadFiber).pipe(Effect.flip),
          SpeechInferenceWorkerCrash,
        );
        yield* load(worker, second);
      }).pipe(
        Effect.provide(
          layerWithProcess(
            Effect.sync(() => {
              const process = processes[acquisitions++];
              if (!process) throw new Error("Unexpected speech worker acquisition.");
              return process;
            }),
            { requestTimeout: "1 second" },
          ),
        ),
      );
    }),
  );

  it.effect("keeps live feeds and finalization FIFO", () =>
    Effect.gen(function* () {
      const process = yield* makeProcess;
      yield* withWorker(process, (worker) =>
        Effect.gen(function* () {
          yield* load(worker, process);
          yield* start(worker, process);

          const firstFeed = yield* Effect.forkChild(worker.feed(new Float32Array([0.1])));
          const firstRequest = yield* Queue.take(process.posted);
          const secondFeed = yield* Effect.forkChild(worker.feed(new Float32Array([0.2])));
          const finalize = yield* Effect.forkChild(worker.finalize());
          assert.isTrue(Option.isNone(yield* Queue.poll(process.posted)));

          respond(process, firstRequest, {
            type: "feed",
            preview: { committed: "hello", tentative: " wor", revision: 1 },
          });
          const secondRequest = yield* Queue.take(process.posted);
          assert.equal(secondRequest.type, "feed");
          respond(process, secondRequest, { type: "feed", preview: null });
          const finalizeRequest = yield* Queue.take(process.posted);
          assert.equal(finalizeRequest.type, "finalize");
          respond(process, finalizeRequest, { type: "finalized", text: "hello world" });

          assert.deepEqual(yield* Fiber.join(firstFeed), {
            committed: "hello",
            tentative: " wor",
            revision: 1,
          });
          assert.isNull(yield* Fiber.join(secondFeed));
          assert.equal(yield* Fiber.join(finalize), "hello world");
        }),
      );
    }),
  );

  it.effect("serializes cancellation behind an active feed", () =>
    Effect.gen(function* () {
      const process = yield* makeProcess;
      yield* withWorker(process, (worker) =>
        Effect.gen(function* () {
          yield* load(worker, process);
          yield* start(worker, process);
          const feed = yield* Effect.forkChild(worker.feed(new Float32Array([0.1])));
          const feedRequest = yield* Queue.take(process.posted);
          const cancel = yield* Effect.forkChild(worker.cancel());
          yield* Effect.yieldNow;
          assert.isTrue(Option.isNone(yield* Queue.poll(process.posted)));
          respond(process, feedRequest, { type: "feed", preview: null });
          const cancelRequest = yield* Queue.take(process.posted);
          assert.equal(cancelRequest.type, "cancel");
          respond(process, cancelRequest, { type: "cancelled" });
          assert.isNull(yield* Fiber.join(feed));
          yield* Fiber.join(cancel);
        }),
      );
    }),
  );

  it.effect("treats malformed responses as terminal protocol failures", () =>
    Effect.gen(function* () {
      const process = yield* makeProcess;
      yield* withWorker(process, (worker) =>
        Effect.gen(function* () {
          const crashFiber = yield* Effect.forkChild(worker.awaitCrash);
          const loadFiber = yield* Effect.forkChild(worker.load("/models/moonshine.gguf"));
          const request = yield* Queue.take(process.posted);
          process.emitMessage({ requestId: request.requestId, type: "success" });
          assert.instanceOf(
            yield* Fiber.join(loadFiber).pipe(Effect.flip),
            SpeechInferenceWorkerCrash,
          );
          assert.equal((yield* Fiber.join(crashFiber)).exitCode, null);
          assert.isFalse(yield* worker.isAlive);
        }),
      );
      assert.equal(process.killCount, 1);
    }),
  );
});
