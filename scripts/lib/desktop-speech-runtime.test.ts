import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  assertPackagedDesktopSpeechRuntime,
  assertTranscribeCppNativeArtifacts,
  PackagedDesktopSpeechRuntimeMissingError,
  resolveTranscribeCppNativeArtifacts,
} from "./desktop-speech-runtime.ts";

it.layer(NodeServices.layer)("desktop-speech-runtime", (it) => {
  it("resolves the native artifact matrix", () => {
    assert.deepStrictEqual(resolveTranscribeCppNativeArtifacts("mac", "universal"), [
      {
        packageName: "@transcribe-cpp/darwin-arm64-metal",
        libraryFileName: "libtranscribe.dylib",
      },
      {
        packageName: "@transcribe-cpp/darwin-x64-cpu",
        libraryFileName: "libtranscribe.dylib",
      },
    ]);
    assert.deepStrictEqual(resolveTranscribeCppNativeArtifacts("linux", "arm64"), [
      {
        packageName: "@transcribe-cpp/linux-arm64-cpu-vulkan",
        libraryFileName: "libtranscribe.so",
      },
    ]);
    assert.deepStrictEqual(resolveTranscribeCppNativeArtifacts("linux", "x64"), [
      {
        packageName: "@transcribe-cpp/linux-x64-cpu-vulkan",
        libraryFileName: "libtranscribe.so",
      },
    ]);
    assert.deepStrictEqual(resolveTranscribeCppNativeArtifacts("win", "x64"), [
      {
        packageName: "@transcribe-cpp/win32-x64-cpu-vulkan",
        libraryFileName: "transcribe.dll",
      },
    ]);
    assert.deepStrictEqual(resolveTranscribeCppNativeArtifacts("win", "arm64"), []);
  });

  it.effect("verifies unpacked runtime files for every packaged target", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-speech-packaged-" });
      const targets = [
        {
          platform: "mac",
          arch: "arm64",
          resources: ["mac-arm64", "T3 Code.app", "Contents", "Resources"],
        },
        {
          platform: "mac",
          arch: "x64",
          resources: ["mac", "T3 Code.app", "Contents", "Resources"],
        },
        {
          platform: "linux",
          arch: "arm64",
          resources: ["linux-arm64-unpacked", "resources"],
        },
        {
          platform: "linux",
          arch: "x64",
          resources: ["linux-unpacked", "resources"],
        },
        {
          platform: "win",
          arch: "x64",
          resources: ["win-unpacked", "resources"],
        },
        {
          platform: "win",
          arch: "arm64",
          resources: ["win-arm64-unpacked", "resources"],
        },
      ] as const;

      for (const [index, target] of targets.entries()) {
        const stageDistDir = path.join(root, String(index));
        const unpackedRoot = path.join(stageDistDir, ...target.resources, "app.asar.unpacked");
        const workerPath = path.join(
          unpackedRoot,
          "apps",
          "desktop",
          "dist-electron",
          "speech-worker.cjs",
        );
        yield* fs.makeDirectory(path.dirname(workerPath), { recursive: true });
        yield* fs.writeFileString(workerPath, "// packaged speech worker\n");

        for (const artifact of resolveTranscribeCppNativeArtifacts(target.platform, target.arch)) {
          const artifactDirectory = path.join(unpackedRoot, "node_modules", artifact.packageName);
          yield* fs.makeDirectory(artifactDirectory, { recursive: true });
          yield* fs.writeFileString(path.join(artifactDirectory, "contract.json"), "{}\n");
          yield* fs.writeFileString(
            path.join(artifactDirectory, artifact.libraryFileName),
            "native artifact\n",
          );
        }

        yield* assertPackagedDesktopSpeechRuntime(stageDistDir, target.platform, target.arch);
      }
    }),
  );

  it.effect("fails when the unpacked speech worker is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stageDistDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-speech-packaged-missing-",
      });
      yield* fs.makeDirectory(path.join(stageDistDir, "linux-unpacked", "resources"), {
        recursive: true,
      });

      const error = yield* assertPackagedDesktopSpeechRuntime(stageDistDir, "linux", "x64").pipe(
        Effect.flip,
      );

      assert.instanceOf(error, PackagedDesktopSpeechRuntimeMissingError);
      assert.include(error.filePath, "speech-worker.cjs");
    }),
  );

  it.effect("resolves installed artifacts from the dependency layout", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const hostPlatform = yield* HostProcessPlatform;
      const hostArchitecture = yield* HostProcessArchitecture;
      const repoRoot = yield* path.fromFileUrl(new URL("../..", import.meta.url));
      const desktopDir = path.join(repoRoot, "apps", "desktop");
      const platform =
        hostPlatform === "darwin" ? "mac" : hostPlatform === "win32" ? "win" : "linux";
      const arch = hostArchitecture === "arm64" ? "arm64" : "x64";

      yield* assertTranscribeCppNativeArtifacts(desktopDir, platform, arch);
    }),
  );

  it.effect("resolves transcribe.cpp from a staged production dependency layout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hostPlatform = yield* HostProcessPlatform;
      const hostArchitecture = yield* HostProcessArchitecture;
      const repoRoot = yield* path.fromFileUrl(new URL("../..", import.meta.url));
      const sourceEntryPath = yield* fs.realPath(
        path.join(
          repoRoot,
          "apps",
          "desktop",
          "node_modules",
          "transcribe-cpp",
          "dist",
          "index.js",
        ),
      );
      const sourceRequire = NodeModule.createRequire(sourceEntryPath);
      const sourcePackageDir = path.resolve(path.dirname(sourceEntryPath), "..");
      const platform =
        hostPlatform === "darwin" ? "mac" : hostPlatform === "win32" ? "win" : "linux";
      const arch = hostArchitecture === "arm64" ? "arm64" : "x64";
      const artifact = resolveTranscribeCppNativeArtifacts(platform, arch)[0];
      if (!artifact) return;
      const sourceArtifactPackageJson = sourceRequire.resolve(
        `${artifact.packageName}/package.json`,
      );
      const sourceArtifactDir = path.dirname(sourceArtifactPackageJson);
      const stageDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-speech-stage-" });
      const stagePackageDir = path.join(stageDir, "node_modules", "transcribe-cpp");
      const stageArtifactDir = path.join(
        stageDir,
        "node_modules",
        "@transcribe-cpp",
        artifact.packageName.slice("@transcribe-cpp/".length),
      );

      yield* fs.copy(sourcePackageDir, stagePackageDir);
      yield* fs.copy(sourceArtifactDir, stageArtifactDir);

      const loaderUrl = NodeURL.pathToFileURL(path.join(stagePackageDir, "dist", "loader.js")).href;
      const loader = (yield* Effect.promise(() => import(/* @vite-ignore */ loaderUrl))) as {
        readonly resolveLibrary: () => { readonly artifactDir: string };
      };

      assert.equal(loader.resolveLibrary().artifactDir, yield* fs.realPath(stageArtifactDir));
      assert.isTrue(yield* fs.exists(path.join(stageArtifactDir, artifact.libraryFileName)));
    }),
  );
});
