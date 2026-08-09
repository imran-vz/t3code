import * as NodeModule from "node:module";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  resolveTranscribeCppNativeArtifact,
  type TranscribeCppNativeArtifact,
} from "@t3tools/shared/transcribeCppArtifacts";

import type { BuildArch, BuildPlatform } from "./build-target-arch.ts";

const BuildPlatformSchema = Schema.Literals(["mac", "linux", "win"]);
const BuildArchSchema = Schema.Literals(["arm64", "x64", "universal"]);

export const DESKTOP_SPEECH_WORKER_ASAR_UNPACK = [
  "apps/desktop/dist-electron/speech-worker.cjs",
] as const;
export const TRANSCRIBE_CPP_ASAR_UNPACK = ["**/node_modules/@transcribe-cpp/**"] as const;

export class TranscribeCppNativeArtifactMissingError extends Schema.TaggedErrorClass<TranscribeCppNativeArtifactMissingError>()(
  "TranscribeCppNativeArtifactMissingError",
  {
    packageName: Schema.String,
    artifactFileName: Schema.String,
    packageEntryPath: Schema.String,
    platform: BuildPlatformSchema,
    arch: BuildArchSchema,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `transcribe.cpp native artifact is missing: ${this.packageName}/${this.artifactFileName}`;
  }
}

export class PackagedDesktopSpeechRuntimeMissingError extends Schema.TaggedErrorClass<PackagedDesktopSpeechRuntimeMissingError>()(
  "PackagedDesktopSpeechRuntimeMissingError",
  {
    filePath: Schema.String,
    platform: BuildPlatformSchema,
    arch: BuildArchSchema,
  },
) {
  override get message(): string {
    return `Packaged desktop speech runtime file is missing: ${this.filePath}`;
  }
}

export function resolveTranscribeCppNativeArtifacts(
  platform: BuildPlatform,
  arch: BuildArch,
): readonly TranscribeCppNativeArtifact[] {
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];
  const runtimePlatform = platform === "mac" ? "darwin" : platform === "win" ? "win32" : platform;
  return architectures.flatMap((architecture) => {
    const artifact = resolveTranscribeCppNativeArtifact(runtimePlatform, architecture);
    return artifact ? [artifact] : [];
  });
}

export const assertTranscribeCppNativeArtifacts = Effect.fn("assertTranscribeCppNativeArtifacts")(
  function* (stageAppDir: string, platform: BuildPlatform, arch: BuildArch) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageEntryPath = yield* fs.realPath(
      path.join(stageAppDir, "node_modules", "transcribe-cpp", "dist", "index.js"),
    );
    const packageRequire = NodeModule.createRequire(packageEntryPath);

    for (const artifact of resolveTranscribeCppNativeArtifacts(platform, arch)) {
      const packageJsonPath = yield* Effect.try({
        try: () => packageRequire.resolve(`${artifact.packageName}/package.json`),
        catch: (cause) =>
          new TranscribeCppNativeArtifactMissingError({
            packageName: artifact.packageName,
            artifactFileName: "package.json",
            packageEntryPath,
            platform,
            arch,
            cause,
          }),
      });
      const artifactDir = path.dirname(packageJsonPath);
      for (const artifactFileName of ["contract.json", artifact.libraryFileName]) {
        if (!(yield* fs.exists(path.join(artifactDir, artifactFileName)))) {
          return yield* new TranscribeCppNativeArtifactMissingError({
            packageName: artifact.packageName,
            artifactFileName,
            packageEntryPath,
            platform,
            arch,
          });
        }
      }
    }
  },
);

function findPackagedResourcesDirectories(stageDistDir: string, platform: BuildPlatform) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stageEntries = yield* fs.readDirectory(stageDistDir);
    const resourcesDirectories: string[] = [];

    for (const entry of stageEntries) {
      const outputDirectory = path.join(stageDistDir, entry);
      const outputStat = yield* fs.stat(outputDirectory).pipe(Effect.orElseSucceed(() => null));
      if (!outputStat || outputStat.type !== "Directory") continue;

      if (platform === "mac" && entry.startsWith("mac")) {
        for (const appEntry of yield* fs.readDirectory(outputDirectory)) {
          if (appEntry.endsWith(".app")) {
            resourcesDirectories.push(
              path.join(outputDirectory, appEntry, "Contents", "Resources"),
            );
          }
        }
      } else if (platform !== "mac" && entry.endsWith("-unpacked")) {
        resourcesDirectories.push(path.join(outputDirectory, "resources"));
      }
    }

    return resourcesDirectories;
  });
}

export const assertPackagedDesktopSpeechRuntime = Effect.fn("assertPackagedDesktopSpeechRuntime")(
  function* (stageDistDir: string, platform: BuildPlatform, arch: BuildArch) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resourcesDirectories = yield* findPackagedResourcesDirectories(stageDistDir, platform);
    let missingPath = path.join(stageDistDir, "<platform-unpacked>", "resources");

    for (const resourcesDirectory of resourcesDirectories) {
      const unpackedRoot = path.join(resourcesDirectory, "app.asar.unpacked");
      const requiredPaths = [
        path.join(unpackedRoot, "apps", "desktop", "dist-electron", "speech-worker.cjs"),
        ...resolveTranscribeCppNativeArtifacts(platform, arch).flatMap((artifact) => [
          path.join(unpackedRoot, "node_modules", artifact.packageName, "contract.json"),
          path.join(unpackedRoot, "node_modules", artifact.packageName, artifact.libraryFileName),
        ]),
      ];
      let complete = true;
      for (const requiredPath of requiredPaths) {
        if (!(yield* fs.exists(requiredPath))) {
          complete = false;
          missingPath = requiredPath;
          break;
        }
      }
      if (complete) return;
    }

    return yield* new PackagedDesktopSpeechRuntimeMissingError({
      filePath: missingPath,
      platform,
      arch,
    });
  },
);
