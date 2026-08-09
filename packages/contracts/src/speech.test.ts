import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DESKTOP_SPEECH_MAX_PCM16_BATCH_BYTES,
  DESKTOP_SPEECH_SAMPLE_RATE,
  DesktopSpeechActionResult,
  DesktopSpeechArtifact,
  DesktopSpeechAudioInput,
  DesktopSpeechAudioResult,
  DesktopSpeechAvailability,
  DesktopSpeechCancelInput,
  DesktopSpeechCatalogEntry,
  DesktopSpeechDownloadModelInput,
  DesktopSpeechModelDownloadState,
  DesktopSpeechModelId,
  DesktopSpeechPreview,
  DesktopSpeechSessionId,
  DesktopSpeechStartResult,
  DesktopSpeechState,
  DesktopSpeechStopResult,
} from "./speech.ts";

const decode = <S extends Schema.Top>(schema: S, input: unknown): Schema.Schema.Type<S> =>
  Schema.decodeUnknownSync(schema as never)(input) as Schema.Schema.Type<S>;
const rejects = <S extends Schema.Top>(schema: S, input: unknown) =>
  expect(() => decode(schema, input)).toThrow();

const entry = {
  id: "moonshine-streaming-tiny-q8",
  title: "Moonshine Streaming Tiny",
  description: "Fast, lightweight English live transcription.",
  languages: [{ code: "en", label: "English" }],
  capabilities: { supportsStreaming: true },
  artifact: {
    repository: "handy-computer/moonshine-streaming-tiny-gguf",
    revision: "85ddff612fa3a2cf40b2f745abcfa90ef82f293b",
    filename: "moonshine-streaming-tiny-Q8_0.gguf",
    format: "gguf",
    quantization: "Q8_0",
    bytes: 50_462_816,
    sha256: "930e4622ad3a24158b91406c30c977fa6a26b34cb32d6ac3e57cfb23383a869e",
  },
  license: { name: "MIT", sourceUrl: "https://huggingface.co/model/README.md#license" },
  accuracyRating: 3,
  speedRating: 5,
  recommended: true,
} as const;

const model = {
  catalogEntry: entry,
  installation: { type: "not-installed" },
  download: { type: "idle" },
} as const;

const state = {
  availability: { type: "supported" },
  models: [model],
  selectedModelId: null,
  session: { type: "idle" },
  preview: { committed: "", tentative: "", revision: 0 },
} as const;

describe("desktop speech contracts", () => {
  it("validates branded identifiers and the pinned artifact", () => {
    expect(decode(DesktopSpeechModelId, " moonshine-streaming-tiny-q8 ")).toBe(
      "moonshine-streaming-tiny-q8",
    );
    expect(decode(DesktopSpeechSessionId, " session:123 ")).toBe("session:123");
    rejects(DesktopSpeechModelId, "Moonshine Tiny");
    rejects(DesktopSpeechSessionId, "session id");
    expect(decode(DesktopSpeechCatalogEntry, entry)).toEqual(entry);
    rejects(DesktopSpeechArtifact, { ...entry.artifact, bytes: 0 });
    rejects(DesktopSpeechArtifact, { ...entry.artifact, revision: "main" });
    rejects(DesktopSpeechCatalogEntry, {
      ...entry,
      license: { name: "MIT", sourceUrl: "https://token:secret@example.com/license" },
    });
  });

  it("accepts valid state and rejects impossible public state", () => {
    expect(decode(DesktopSpeechState, state)).toEqual(state);
    rejects(DesktopSpeechState, { ...state, models: [model, model] });
    rejects(DesktopSpeechModelDownloadState, {
      type: "downloading",
      receivedBytes: 101,
      totalBytes: 100,
      percent: 100,
    });
    expect(
      decode(DesktopSpeechPreview, { committed: "hello", tentative: " world", revision: 2 }),
    ).toEqual({ committed: "hello", tentative: " world", revision: 2 });
    rejects(DesktopSpeechPreview, { committed: "", tentative: "", revision: -1 });
  });

  it("keeps unsupported reasons display-safe", () => {
    expect(
      decode(DesktopSpeechAvailability, {
        type: "unsupported",
        reason: "Voice input is unavailable on Windows ARM64.",
      }),
    ).toMatchObject({ type: "unsupported" });
    rejects(DesktopSpeechAvailability, { type: "unsupported", reason: "Unsafe\nreason" });
    rejects(DesktopSpeechAvailability, {
      type: "unsupported",
      reason: "Native model missing at /Users/person/model.gguf",
    });
  });

  it("round-trips ordered bounded 16 kHz PCM16", () => {
    const input = {
      sessionId: "session:123",
      sequence: 0,
      sampleRate: DESKTOP_SPEECH_SAMPLE_RATE,
      pcm16: Uint8Array.of(0, 0),
    };
    expect(decode(DesktopSpeechAudioInput, input).pcm16).toEqual(Uint8Array.of(0, 0));
    rejects(DesktopSpeechAudioInput, { ...input, sequence: -1 });
    rejects(DesktopSpeechAudioInput, { ...input, sampleRate: 48_000 });
    rejects(DesktopSpeechAudioInput, { ...input, pcm16: new Uint8Array(3) });
    rejects(DesktopSpeechAudioInput, {
      ...input,
      pcm16: new Uint8Array(DESKTOP_SPEECH_MAX_PCM16_BATCH_BYTES + 2),
    });
  });

  it("decodes action inputs and results", () => {
    expect(decode(DesktopSpeechDownloadModelInput, { modelId: entry.id }).modelId).toBe(entry.id);
    expect(decode(DesktopSpeechCancelInput, { sessionId: "session:123" }).sessionId).toBe(
      "session:123",
    );
    expect(decode(DesktopSpeechActionResult, { type: "accepted" })).toEqual({ type: "accepted" });
    expect(
      decode(DesktopSpeechStartResult, { type: "accepted", sessionId: "session:123" }),
    ).toMatchObject({ type: "accepted", sessionId: "session:123" });
    expect(decode(DesktopSpeechAudioResult, { type: "accepted", sequence: 4 })).toEqual({
      type: "accepted",
      sequence: 4,
    });
    expect(decode(DesktopSpeechStopResult, { type: "completed", text: "final text" })).toEqual({
      type: "completed",
      text: "final text",
    });
    rejects(DesktopSpeechActionResult, {
      type: "rejected",
      reason: "unsupported",
      message: "unsafe/path",
    });
  });
});
