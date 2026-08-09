import { useAtomValue } from "@effect/atom-react";
import type { DesktopSpeechBridge, DesktopSpeechState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { Atom } from "effect/unstable/reactivity";

type SpeechStateBridge = Pick<DesktopSpeechBridge, "getState" | "onStateChange">;

function getBridge(): SpeechStateBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.speech;
}

export function createDesktopSpeechStateAtom(readBridge: () => SpeechStateBridge | undefined) {
  const updates = Stream.callback<DesktopSpeechState | null>((queue) =>
    Effect.gen(function* () {
      const bridge = readBridge();
      if (!bridge) {
        Queue.offerUnsafe(queue, null);
        return yield* Effect.never;
      }
      let receivedUpdate = false;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          bridge.onStateChange((state) => {
            receivedUpdate = true;
            Queue.offerUnsafe(queue, state);
          }),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      const initial = yield* Effect.tryPromise({ try: bridge.getState, catch: () => null }).pipe(
        Effect.retry({ times: 2 }),
        Effect.orElseSucceed(() => null),
      );
      if (!receivedUpdate && initial !== null) Queue.offerUnsafe(queue, initial);
      return yield* Effect.never;
    }),
  );
  return Atom.make(updates, { initialValue: null }).pipe(
    Atom.keepAlive,
    Atom.withLabel("desktop:speech-state"),
  );
}

const desktopSpeechStateAtom = createDesktopSpeechStateAtom(getBridge);

export function useDesktopSpeechState(): DesktopSpeechState | null {
  return AsyncResult.getOrElse(useAtomValue(desktopSpeechStateAtom), () => null);
}
