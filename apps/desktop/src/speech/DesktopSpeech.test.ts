import * as NodeServices from "@effect/platform-node/NodeServices";
import type { DesktopSpeechCatalogEntry as DesktopSpeechCatalogEntryValue } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as DesktopSpeech from "./DesktopSpeech.ts";
import {
  artifactBytes,
  awaitModelSettled,
  installedPath,
  partialPath,
  prepareInstalled,
  response,
  testEntry,
  withSpeech,
} from "./DesktopSpeechTestHarness.ts";

describe("DesktopSpeech model", () => {
  it.effect("discovers and automatically selects the installed singleton model", () =>
    withSpeech({ prepare: prepareInstalled }, ({ speech, settings }) =>
      Effect.gen(function* () {
        const state = yield* speech.getState;
        assert.equal(state.models.length, 1);
        assert.equal(state.models[0]?.installation.type, "installed");
        assert.equal(state.selectedModelId, testEntry.id);
        assert.equal((yield* settings.get).speechModelId, testEntry.id);
      }),
    ),
  );

  it.effect("rejects a corrupt installed artifact before native loading", () =>
    withSpeech(
      {
        prepare: ({ environment, fileSystem }) =>
          fileSystem
            .makeDirectory(environment.speechModelsDir, { recursive: true })
            .pipe(
              Effect.andThen(
                fileSystem.writeFile(
                  installedPath(environment),
                  new TextEncoder().encode("ABCDEF"),
                ),
              ),
            ),
      },
      ({ speech, worker, settings, environment, fileSystem }) =>
        Effect.gen(function* () {
          assert.equal((yield* speech.start()).type, "rejected");
          const state = yield* speech.getState;
          assert.equal(state.models[0]?.installation.type, "not-installed");
          assert.isNull(state.selectedModelId);
          assert.isNull((yield* settings.get).speechModelId);
          assert.equal(worker.loads.length, 0);
          assert.isFalse(yield* fileSystem.exists(installedPath(environment)));
        }),
    ),
  );

  it.effect("reports unsupported platform and missing native artifact", () =>
    Effect.gen(function* () {
      const arm = yield* withSpeech(
        { environment: { platform: "win32", processArch: "arm64" } },
        ({ speech }) => speech.getState,
      );
      assert.equal(arm.availability.type, "unsupported");
      const missing = yield* withSpeech(
        { platform: { nativeArtifactAvailable: () => Effect.succeed(false) } },
        ({ speech }) => speech.getState,
      );
      assert.equal(missing.availability.type, "unsupported");
    }),
  );

  it.effect("builds a pinned URL and confines artifact paths", () =>
    Effect.gen(function* () {
      assert.equal(
        DesktopSpeech.desktopSpeechModelDownloadUrl(testEntry).href,
        "https://huggingface.co/test/speech-model/resolve/0000000000000000000000000000000000000000/test-speech-model-Q8_0.gguf?download=true",
      );
      const path = yield* Path.Path;
      assert.isNotNull(DesktopSpeech.resolveDesktopSpeechArtifactPaths(path, "/models", testEntry));
      const escaped = {
        ...testEntry,
        artifact: { ...testEntry.artifact, filename: "../outside.gguf" },
      } as DesktopSpeechCatalogEntryValue;
      assert.isNull(DesktopSpeech.resolveDesktopSpeechArtifactPaths(path, "/models", escaped));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("downloads, verifies, promotes, and activates the singleton model", () => {
    const urls: string[] = [];
    return withSpeech(
      {
        http: (request) =>
          Effect.sync(() => {
            urls.push(request.url);
            return response(request, artifactBytes);
          }),
      },
      ({ speech, settings, environment, fileSystem }) =>
        Effect.gen(function* () {
          assert.deepEqual(yield* speech.downloadModel(testEntry.id), { type: "accepted" });
          const state = yield* awaitModelSettled(speech);
          assert.equal(state.models[0]?.installation.type, "installed");
          assert.equal(state.selectedModelId, testEntry.id);
          assert.equal((yield* settings.get).speechModelId, testEntry.id);
          assert.deepEqual(yield* fileSystem.readFile(installedPath(environment)), artifactBytes);
          assert.isFalse(yield* fileSystem.exists(partialPath(environment)));
          assert.deepEqual(urls, [DesktopSpeech.desktopSpeechModelDownloadUrl(testEntry).href]);
        }),
    );
  });

  it.effect("fails closed on invalid size or insufficient disk", () =>
    Effect.gen(function* () {
      const oversized = yield* withSpeech(
        {
          http: (request) =>
            Effect.succeed(response(request, new Uint8Array([...artifactBytes, 7]))),
        },
        ({ speech }) =>
          Effect.gen(function* () {
            yield* speech.downloadModel(testEntry.id);
            return yield* awaitModelSettled(speech);
          }),
      );
      assert.equal(oversized.models[0]?.download.type, "failed");

      let requests = 0;
      const noSpace = yield* withSpeech(
        {
          platform: { availableBytes: () => Effect.succeed(Option.some(5n)) },
          http: (request) =>
            Effect.sync(() => {
              requests += 1;
              return response(request, artifactBytes);
            }),
        },
        ({ speech }) =>
          Effect.gen(function* () {
            yield* speech.downloadModel(testEntry.id);
            return yield* awaitModelSettled(speech);
          }),
      );
      assert.equal(noSpace.models[0]?.download.type, "failed");
      assert.equal(requests, 0);
    }),
  );

  it.effect("deletes a partial file on explicit cancellation", () =>
    Effect.gen(function* () {
      const requestStarted = yield* Deferred.make<void>();
      yield* withSpeech(
        {
          http: () =>
            Deferred.succeed(requestStarted, undefined).pipe(Effect.andThen(Effect.never)),
        },
        ({ speech, environment, fileSystem }) =>
          Effect.gen(function* () {
            yield* speech.downloadModel(testEntry.id);
            yield* Deferred.await(requestStarted);
            assert.deepEqual(yield* speech.cancelDownload(testEntry.id), { type: "accepted" });
            const state = yield* awaitModelSettled(speech);
            assert.equal(state.models[0]?.download.type, "idle");
            assert.isFalse(yield* fileSystem.exists(partialPath(environment)));
          }),
      );
    }),
  );

  it.effect("deletes the model when idle and protects it during a live session", () =>
    withSpeech({ prepare: prepareInstalled }, ({ speech, settings, environment, fileSystem }) =>
      Effect.gen(function* () {
        const started = yield* speech.start();
        assert.equal(started.type, "accepted");
        if (started.type !== "accepted") return;
        const busy = yield* speech.removeModel(testEntry.id);
        assert.equal(busy.type, "rejected");
        yield* speech.cancel(started.sessionId);
        assert.deepEqual(yield* speech.removeModel(testEntry.id), { type: "accepted" });
        assert.equal((yield* speech.getState).models[0]?.installation.type, "not-installed");
        assert.isNull((yield* settings.get).speechModelId);
        assert.isFalse(yield* fileSystem.exists(installedPath(environment)));
      }),
    ),
  );

  it.effect("publishes terminal download progress before readiness", () =>
    withSpeech(
      { http: (request) => Effect.succeed(response(request, artifactBytes)) },
      ({ speech }) =>
        Effect.gen(function* () {
          const settled = yield* Effect.forkChild(awaitModelSettled(speech));
          yield* speech.downloadModel(testEntry.id);
          assert.equal((yield* Fiber.join(settled)).models[0]?.installation.type, "installed");
        }),
    ),
  );
});
