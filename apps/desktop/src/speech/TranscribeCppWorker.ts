import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as Electron from "electron";

import {
  SpeechInferenceWorker,
  SpeechInferenceWorkerCrash,
  SpeechInferenceWorkerError,
  type SpeechInferenceFailure,
  type SpeechInferenceOperation,
} from "./SpeechInferenceWorker.ts";
import {
  SpeechWorkerResponse,
  type SpeechWorkerRequest,
  type SpeechWorkerResult,
  type SpeechWorkerResultType,
} from "./speechWorkerProtocol.ts";

const DEFAULT_MAX_PENDING_REQUESTS = 32;
const DEFAULT_REQUEST_TIMEOUT = "30 seconds";
const decodeSpeechWorkerResponse = Schema.decodeUnknownEffect(SpeechWorkerResponse);

type MessageListener = (message: unknown) => void;
type ExitListener = (code: number) => void;

export interface SpeechUtilityProcess {
  readonly postMessage: (
    message: SpeechWorkerRequest,
    transfer?: Electron.MessagePortMain[],
  ) => void;
  readonly kill: () => void;
  readonly onMessage: (listener: MessageListener) => void;
  readonly offMessage: (listener: MessageListener) => void;
  readonly onExit: (listener: ExitListener) => void;
  readonly offExit: (listener: ExitListener) => void;
}

interface PendingRequest {
  readonly operation: SpeechInferenceOperation;
  readonly expectedType: SpeechWorkerResultType;
  readonly deferred: Deferred.Deferred<SpeechWorkerResult, SpeechInferenceFailure>;
}

interface RequestTracker {
  posted: boolean;
}

type ComputeState = "empty" | "idle" | "streaming";
type WorkerCommand = SpeechWorkerRequest extends infer Request
  ? Request extends SpeechWorkerRequest
    ? Omit<Request, "requestId">
    : never
  : never;

export interface TranscribeCppWorkerOptions {
  readonly maxPendingRequests?: number;
  readonly requestTimeout?: Duration.Input;
}

interface ManagedSpeechWorker {
  readonly service: SpeechInferenceWorker["Service"];
  readonly scope: Scope.Closeable;
}

type LazySpeechWorkerState =
  | { readonly type: "idle" }
  | { readonly type: "crashed"; readonly worker: ManagedSpeechWorker }
  | { readonly type: "running"; readonly worker: ManagedSpeechWorker };

function workerError(
  operation: SpeechInferenceOperation,
  reason: SpeechInferenceWorkerError["reason"],
  detail: string,
): SpeechInferenceWorkerError {
  return new SpeechInferenceWorkerError({ operation, reason, detail });
}

function operationForRequest(request: SpeechWorkerRequest): SpeechInferenceOperation {
  return request.type;
}

function removePending(pending: Ref.Ref<ReadonlyMap<string, PendingRequest>>, requestId: string) {
  return Ref.modify(pending, (entries) => {
    const entry = entries.get(requestId);
    if (!entry) return [Option.none(), entries] as const;
    const next = new Map(entries);
    next.delete(requestId);
    return [Option.some(entry), next] as const;
  });
}

function failPending(
  pending: Ref.Ref<ReadonlyMap<string, PendingRequest>>,
  failure: SpeechInferenceFailure,
) {
  return Effect.gen(function* () {
    const entries = yield* Ref.getAndSet(pending, new Map());
    yield* Effect.forEach(entries.values(), (entry) => Deferred.fail(entry.deferred, failure), {
      discard: true,
    });
  });
}

export const make = Effect.fn("TranscribeCppWorker.make")(function* (
  child: SpeechUtilityProcess,
  options: TranscribeCppWorkerOptions = {},
) {
  const maxPendingRequests = options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
  const requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
  const pending = yield* Ref.make<ReadonlyMap<string, PendingRequest>>(new Map());
  const nextRequestId = yield* Ref.make(0);
  const alive = yield* Ref.make(true);
  const crashSignal = yield* Deferred.make<SpeechInferenceWorkerCrash>();
  const computeState = yield* Ref.make<ComputeState>("empty");
  const computeLock = yield* Semaphore.make(1);
  const adapterScope = yield* Scope.Scope;
  const context = yield* Effect.context();
  const runFork = Effect.runForkWith(context);

  const terminate = Effect.fn("TranscribeCppWorker.terminate")(function* (
    exitCode: number | null,
    detail: string,
    kill: boolean,
  ) {
    const wasAlive = yield* Ref.getAndSet(alive, false);
    if (!wasAlive) return;
    if (kill) {
      yield* Effect.try(() => child.kill()).pipe(Effect.ignore);
    }
    const failure = new SpeechInferenceWorkerCrash({
      exitCode,
      detail,
    });
    yield* failPending(pending, failure);
    yield* Deferred.succeed(crashSignal, failure);
  });

  const crash = (exitCode: number | null) =>
    terminate(exitCode, "Speech inference worker exited unexpectedly.", false);
  const protocolFailure = terminate(null, "Speech inference worker protocol failed.", true);

  const onMessage: MessageListener = (raw) => {
    runFork(
      decodeSpeechWorkerResponse(raw).pipe(
        Effect.mapError(() =>
          workerError("protocol", "protocol", "Speech inference worker sent an invalid response."),
        ),
        Effect.matchEffect({
          onFailure: () => protocolFailure,
          onSuccess: (response) =>
            Effect.gen(function* () {
              const pendingRequest = yield* removePending(pending, response.requestId);
              if (Option.isNone(pendingRequest)) {
                yield* protocolFailure;
                return;
              }

              const entry = pendingRequest.value;
              if (response.type === "failure") {
                const reason =
                  response.code === "cancelled"
                    ? "cancelled"
                    : response.code === "invalid-state"
                      ? "invalid-state"
                      : response.code === "invalid-message"
                        ? "protocol"
                        : response.code === "capacity"
                          ? "capacity"
                          : "native";
                yield* Deferred.fail(
                  entry.deferred,
                  workerError(entry.operation, reason, response.message),
                );
                return;
              }

              if (response.result.type !== entry.expectedType) {
                yield* Deferred.fail(
                  entry.deferred,
                  new SpeechInferenceWorkerCrash({
                    exitCode: null,
                    detail: "Speech inference worker protocol failed.",
                  }),
                );
                yield* protocolFailure;
                return;
              }
              yield* Deferred.succeed(entry.deferred, response.result);
            }),
        }),
      ),
    );
  };
  const onExit: ExitListener = (code) => {
    runFork(crash(code));
  };

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      child.onMessage(onMessage);
      child.onExit(onExit);
    }),
    () =>
      Effect.sync(() => {
        child.offMessage(onMessage);
        child.offExit(onExit);
      }),
  );

  yield* Effect.addFinalizer(() =>
    failPending(pending, workerError("protocol", "closed", "Speech inference worker was closed.")),
  );

  const request = Effect.fn("TranscribeCppWorker.request")(function* (
    command: WorkerCommand,
    expectedType: SpeechWorkerResultType,
    tracker: RequestTracker = { posted: false },
  ) {
    if (!(yield* Ref.get(alive))) {
      return yield* workerError(
        operationForRequest(command as SpeechWorkerRequest),
        "closed",
        "Speech inference worker is not running.",
      );
    }

    const requestNumber = yield* Ref.getAndUpdate(nextRequestId, (value) => value + 1);
    const requestId = `speech-${requestNumber}`;
    const message = { ...command, requestId } as SpeechWorkerRequest;
    const deferred = yield* Deferred.make<SpeechWorkerResult, SpeechInferenceFailure>();
    const operation = operationForRequest(message);
    const inserted = yield* Ref.modify(pending, (entries) => {
      if (entries.size >= maxPendingRequests) return [false, entries] as const;
      return [
        true,
        new Map(entries).set(requestId, { operation, expectedType, deferred }),
      ] as const;
    });
    if (!inserted) {
      return yield* workerError(
        operation,
        "capacity",
        "Speech inference worker has too many pending requests.",
      );
    }

    yield* Effect.try({
      try: () => {
        child.postMessage(message, []);
        tracker.posted = true;
      },
      catch: () =>
        workerError(operation, "unavailable", "Failed to send a speech inference request."),
    }).pipe(
      Effect.tapError((failure) =>
        removePending(pending, requestId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (entry) => Deferred.fail(entry.deferred, failure).pipe(Effect.asVoid),
            }),
          ),
        ),
      ),
    );

    const response = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(requestTimeout));
    if (Option.isSome(response)) return response.value;

    const failure = new SpeechInferenceWorkerCrash({
      exitCode: null,
      detail: `Speech inference ${operation} timed out.`,
    });
    yield* terminate(null, failure.detail, true);
    return yield* failure;
  });

  const detached = <A, E>(
    operation: (tracker: RequestTracker) => Effect.Effect<A, E>,
    options: {
      readonly serialized: boolean;
      readonly onPostedInterrupt?: () => Effect.Effect<void>;
    },
  ): Effect.Effect<A, E> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (options.serialized) yield* restore(computeLock.take(1));
        const tracker: RequestTracker = { posted: false };
        const release = options.serialized
          ? computeLock.release(1).pipe(Effect.asVoid)
          : Effect.void;
        const fiber = yield* Effect.forkIn(
          operation(tracker).pipe(Effect.ensuring(release)),
          adapterScope,
          { startImmediately: true, uninterruptible: false },
        );
        return yield* restore(Fiber.join(fiber)).pipe(
          Effect.onInterrupt(() =>
            Effect.suspend(() =>
              tracker.posted
                ? (options.onPostedInterrupt?.() ?? Effect.void)
                : Fiber.interrupt(fiber).pipe(Effect.asVoid),
            ),
          ),
        );
      }),
    );

  const requireState = (
    operation: SpeechInferenceOperation,
    expected: ComputeState,
    actual: ComputeState,
  ) =>
    actual === expected
      ? Effect.void
      : workerError(
          operation,
          "invalid-state",
          `Speech inference ${operation} is not valid while the worker is ${actual}.`,
        );

  const load: SpeechInferenceWorker["Service"]["load"] = (modelPath) =>
    detached(
      (tracker) =>
        Effect.gen(function* () {
          const state = yield* Ref.get(computeState);
          if (state === "streaming") {
            return yield* workerError(
              "load",
              "invalid-state",
              "A model cannot be loaded while speech inference is active.",
            );
          }
          yield* request({ type: "load", modelPath }, "loaded", tracker).pipe(
            Effect.tap(() => Ref.set(computeState, "idle")),
            Effect.tapError(() => Ref.set(computeState, "empty")),
          );
        }),
      { serialized: true },
    );

  const start: SpeechInferenceWorker["Service"]["start"] = () =>
    detached(
      (tracker) =>
        Effect.gen(function* () {
          const state = yield* Ref.get(computeState);
          yield* requireState("start", "idle", state);
          yield* request({ type: "start" }, "started", tracker);
          yield* Ref.set(computeState, "streaming");
        }),
      { serialized: true },
    );

  const feed: SpeechInferenceWorker["Service"]["feed"] = (samples) =>
    detached(
      (tracker) =>
        Effect.gen(function* () {
          const state = yield* Ref.get(computeState);
          yield* requireState("feed", "streaming", state);
          const result = yield* request({ type: "feed", samples }, "feed", tracker);
          if (result.type !== "feed") {
            return yield* workerError("protocol", "protocol", "Invalid speech feed response.");
          }
          return result.preview;
        }),
      { serialized: true },
    );

  const finalize: SpeechInferenceWorker["Service"]["finalize"] = () =>
    detached(
      (tracker) =>
        Effect.gen(function* () {
          const state = yield* Ref.get(computeState);
          yield* requireState("finalize", "streaming", state);
          const result = yield* request({ type: "finalize" }, "finalized", tracker).pipe(
            Effect.ensuring(
              Effect.suspend(() => (tracker.posted ? Ref.set(computeState, "idle") : Effect.void)),
            ),
          );
          if (result.type !== "finalized") {
            return yield* workerError(
              "protocol",
              "protocol",
              "Invalid speech finalization response.",
            );
          }
          return result.text;
        }),
      { serialized: true },
    );

  const sendCancel = (tracker: RequestTracker) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(computeState);
      if (current === "empty") {
        return yield* workerError(
          "cancel",
          "invalid-state",
          "Speech inference has no loaded model.",
        );
      }
      yield* request({ type: "cancel" }, "cancelled", tracker).pipe(
        Effect.tap(() => Ref.set(computeState, "idle")),
        Effect.tapError(() => Ref.set(computeState, "empty")),
      );
    });

  const cancel: SpeechInferenceWorker["Service"]["cancel"] = () =>
    Effect.gen(function* () {
      yield* detached(sendCancel, { serialized: true });
    });

  return SpeechInferenceWorker.of({
    load,
    start,
    feed,
    finalize,
    cancel,
    isAlive: Ref.get(alive),
    awaitCrash: Deferred.await(crashSignal),
  });
});

export const layerWithProcess = (
  acquire: Effect.Effect<SpeechUtilityProcess, SpeechInferenceWorkerError>,
  options: TranscribeCppWorkerOptions = {},
) =>
  Layer.effect(
    SpeechInferenceWorker,
    Effect.gen(function* () {
      const layerScope = yield* Scope.Scope;
      const active = yield* SynchronizedRef.make<LazySpeechWorkerState>({ type: "idle" });
      const crashes = yield* Queue.unbounded<SpeechInferenceWorkerCrash>();

      const createWorker = Effect.gen(function* () {
        const workerScope = yield* Scope.make();
        return yield* Effect.gen(function* () {
          let killed = false;
          const acquired = yield* Effect.acquireRelease(acquire, (process) =>
            Effect.try(() => {
              if (killed) return;
              killed = true;
              process.kill();
            }).pipe(Effect.ignore),
          ).pipe(Scope.provide(workerScope));
          const child: SpeechUtilityProcess = {
            postMessage: acquired.postMessage,
            kill: () => {
              if (killed) return;
              killed = true;
              try {
                acquired.kill();
              } catch {
                // The process already exited between liveness and cleanup.
              }
            },
            onMessage: acquired.onMessage,
            offMessage: acquired.offMessage,
            onExit: acquired.onExit,
            offExit: acquired.offExit,
          };
          const worker = yield* make(child, options).pipe(Scope.provide(workerScope));
          const managed: ManagedSpeechWorker = { service: worker, scope: workerScope };
          yield* Effect.forkIn(
            worker.awaitCrash.pipe(
              Effect.flatMap((failure) =>
                SynchronizedRef.update(active, (current) =>
                  current.type === "running" && current.worker === managed
                    ? { type: "crashed" as const, worker: managed }
                    : current,
                ).pipe(Effect.andThen(Queue.offer(crashes, failure))),
              ),
              Effect.asVoid,
            ),
            layerScope,
          );
          return [worker, { type: "running", worker: managed } as const] as const;
        }).pipe(Effect.onError(() => Scope.close(workerScope, Exit.void)));
      });

      const getOrCreate = SynchronizedRef.modifyEffect(active, (current) => {
        if (current.type === "idle") return createWorker;
        if (current.type === "crashed") {
          return Scope.close(current.worker.scope, Exit.void).pipe(Effect.andThen(createWorker));
        }
        const managed = current.worker;
        return managed.service.isAlive.pipe(
          Effect.flatMap((alive) =>
            alive
              ? Effect.succeed([managed.service, current] as const)
              : Scope.close(managed.scope, Exit.void).pipe(Effect.andThen(createWorker)),
          ),
        );
      });

      const missing = (operation: SpeechInferenceOperation) =>
        workerError(operation, "invalid-state", "Speech inference has no loaded worker process.");
      const getActive = (operation: SpeechInferenceOperation) =>
        SynchronizedRef.get(active).pipe(
          Effect.flatMap((current) =>
            current.type === "running"
              ? Effect.succeed(current.worker.service)
              : missing(operation),
          ),
        );

      yield* Effect.addFinalizer(() =>
        SynchronizedRef.get(active).pipe(
          Effect.flatMap((current) =>
            current.type === "idle" ? Effect.void : Scope.close(current.worker.scope, Exit.void),
          ),
        ),
      );

      return SpeechInferenceWorker.of({
        load: (modelPath) => getOrCreate.pipe(Effect.flatMap((worker) => worker.load(modelPath))),
        start: () => getActive("start").pipe(Effect.flatMap((worker) => worker.start())),
        feed: (samples) => getActive("feed").pipe(Effect.flatMap((worker) => worker.feed(samples))),
        finalize: () => getActive("finalize").pipe(Effect.flatMap((worker) => worker.finalize())),
        cancel: () => getActive("cancel").pipe(Effect.flatMap((worker) => worker.cancel())),
        isAlive: SynchronizedRef.get(active).pipe(
          Effect.flatMap((current) => {
            switch (current.type) {
              case "idle":
                return Effect.succeed(true);
              case "crashed":
                return Effect.succeed(false);
              case "running":
                return current.worker.service.isAlive;
            }
          }),
        ),
        awaitCrash: Queue.take(crashes),
      });
    }),
  );

function wrapUtilityProcess(child: Electron.UtilityProcess): SpeechUtilityProcess {
  return {
    postMessage: (message, transfer) => child.postMessage(message, transfer),
    kill: () => {
      child.kill();
    },
    onMessage: (listener) => child.on("message", listener),
    offMessage: (listener) => child.off("message", listener),
    onExit: (listener) => child.on("exit", listener),
    offExit: (listener) => child.off("exit", listener),
  };
}

export const layer = layerWithProcess(
  Effect.try({
    try: () =>
      wrapUtilityProcess(
        Electron.utilityProcess.fork(`${__dirname}/speech-worker.cjs`, [], {
          serviceName: "T3 Code Speech Inference",
          stdio: "ignore",
        }),
      ),
    catch: () =>
      workerError("spawn", "unavailable", "Failed to start the speech inference worker."),
  }),
);
