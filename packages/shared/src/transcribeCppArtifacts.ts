export interface TranscribeCppNativeArtifact {
  readonly packageName: string;
  readonly libraryFileName: string;
}

export type TranscribeCppPlatform = "darwin" | "linux" | "win32";
export type TranscribeCppArchitecture = "arm64" | "x64";

const TRANSCRIBE_CPP_NATIVE_ARTIFACTS = [
  {
    platform: "darwin",
    arch: "arm64",
    packageName: "@transcribe-cpp/darwin-arm64-metal",
    libraryFileName: "libtranscribe.dylib",
  },
  {
    platform: "darwin",
    arch: "x64",
    packageName: "@transcribe-cpp/darwin-x64-cpu",
    libraryFileName: "libtranscribe.dylib",
  },
  {
    platform: "linux",
    arch: "arm64",
    packageName: "@transcribe-cpp/linux-arm64-cpu-vulkan",
    libraryFileName: "libtranscribe.so",
  },
  {
    platform: "linux",
    arch: "x64",
    packageName: "@transcribe-cpp/linux-x64-cpu-vulkan",
    libraryFileName: "libtranscribe.so",
  },
  {
    platform: "win32",
    arch: "x64",
    packageName: "@transcribe-cpp/win32-x64-cpu-vulkan",
    libraryFileName: "transcribe.dll",
  },
] as const;

export function resolveTranscribeCppNativeArtifact(
  platform: string,
  arch: string,
): TranscribeCppNativeArtifact | null {
  const artifact = TRANSCRIBE_CPP_NATIVE_ARTIFACTS.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
  );
  return artifact
    ? { packageName: artifact.packageName, libraryFileName: artifact.libraryFileName }
    : null;
}

export function resolveTranscribeCppNativeSupport(platform: string, arch: string) {
  const artifact = resolveTranscribeCppNativeArtifact(platform, arch);
  return artifact
    ? ({ supported: true, artifact } as const)
    : ({
        supported: false,
        reason:
          platform === "win32" && arch === "arm64"
            ? "Voice input is not supported on Windows ARM64."
            : "Voice input is not supported on this platform.",
      } as const);
}
