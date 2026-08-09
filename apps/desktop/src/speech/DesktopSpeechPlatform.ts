// @effect-diagnostics nodeBuiltinImport:off - Incremental hashing and disk-space inspection are Node platform capabilities not exposed by Effect FileSystem.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { resolveTranscribeCppNativeArtifact } from "@t3tools/shared/transcribeCppArtifacts";

export class DesktopSpeechPlatformError extends Schema.TaggedErrorClass<DesktopSpeechPlatformError>()(
  "DesktopSpeechPlatformError",
  {
    operation: Schema.Literals(["hash-file", "inspect-disk-space", "probe-native-artifact"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop speech platform operation failed: ${this.operation}.`;
  }
}

export class DesktopSpeechPlatform extends Context.Service<
  DesktopSpeechPlatform,
  {
    readonly hashFileSha256: (
      filePath: string,
    ) => Effect.Effect<string, DesktopSpeechPlatformError>;
    readonly availableBytes: (directory: string) => Effect.Effect<Option.Option<bigint>>;
    readonly nativeArtifactAvailable: (
      platform: NodeJS.Platform,
      arch: string,
    ) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/speech/DesktopSpeechPlatform") {}

const make = DesktopSpeechPlatform.of({
  hashFileSha256: (filePath) =>
    Effect.tryPromise({
      try: async () => {
        const hash = NodeCrypto.createHash("sha256");
        for await (const chunk of NodeFS.createReadStream(filePath)) {
          hash.update(chunk);
        }
        return hash.digest("hex");
      },
      catch: (cause) => new DesktopSpeechPlatformError({ operation: "hash-file", cause }),
    }),
  availableBytes: (directory) =>
    Effect.tryPromise({
      try: async () => {
        const stat = await NodeFSP.statfs(directory, { bigint: true });
        return Option.some(stat.bavail * stat.bsize);
      },
      catch: (cause) => new DesktopSpeechPlatformError({ operation: "inspect-disk-space", cause }),
    }).pipe(Effect.orElseSucceed(() => Option.none())),
  nativeArtifactAvailable: (platform, arch) =>
    Effect.try({
      try: () => {
        const artifact = resolveTranscribeCppNativeArtifact(platform, arch);
        if (!artifact) return false;

        const moduleUrl = import.meta.url;
        const bindingPackagePath = NodeModule.findPackageJSON("transcribe-cpp", moduleUrl);
        if (!bindingPackagePath) return false;
        const realBindingPackagePath = NodeFS.realpathSync(bindingPackagePath);
        const artifactPackagePath = NodeModule.findPackageJSON(
          artifact.packageName,
          NodeURL.pathToFileURL(realBindingPackagePath).href,
        );
        if (!artifactPackagePath) return false;
        const artifactDirectory = NodePath.dirname(artifactPackagePath);
        return (
          NodeFS.existsSync(NodePath.join(artifactDirectory, "contract.json")) &&
          NodeFS.existsSync(NodePath.join(artifactDirectory, artifact.libraryFileName))
        );
      },
      catch: (cause) =>
        new DesktopSpeechPlatformError({ operation: "probe-native-artifact", cause }),
    }).pipe(Effect.orElseSucceed(() => false)),
});

export const layer = Layer.succeed(DesktopSpeechPlatform, make);

export const layerTest = (service: DesktopSpeechPlatform["Service"]) =>
  Layer.succeed(DesktopSpeechPlatform, service);
