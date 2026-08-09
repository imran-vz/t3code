# Desktop speech architecture

Desktop voice input is a local Electron capability. It does not cross the T3
server WebSocket, relay, tunnel, or provider adapters, and ordinary web and mobile
clients do not expose it.

## Data flow

```text
composer mic -> AudioWorklet -> bounded PCM16 IPC -> utility process
-> transcribe-cpp stream -> revisioned preview -> final composer text
```

The AudioWorklet keeps conversion and batching off the renderer main thread. The
renderer never sends a second chunk until the previous IPC push settles. Its queue
is bounded; overload ends the recording instead of dropping middle audio.

## Model lifecycle

The desktop supports one pinned Moonshine Streaming Tiny Q8 artifact. The user
must explicitly download it in Settings → Voice Input. A fresh download writes a
partial file, reports throttled progress, validates its exact size and SHA-256,
and atomically renames it. Cancel deletes the partial. Delete removes the installed
model. There is no model picker, automatic download, or resumable transfer.

## Session lifecycle

Only one session may be active. `start` verifies the installed artifact and opens
a native stream. `pushAudio` accepts only the matching session and next sequence,
and acknowledges after native feed completes. Each newer preview carries its
session ID and monotonically increasing revision.

The renderer drains the worklet and all push acknowledgements before `stop`.
Finalization returns one authoritative string. Cancel rejects late work. Stream,
protocol, timeout, and utility-process failures are terminal and retryable.

Raw PCM journaling and batch fallback are intentionally deferred to a focused
follow-up. The live path never writes recording audio to disk.

## Composer ownership

The composer captures a prompt lease. Live revisions replace only its owned suffix
and remain outside persisted drafts. User edits or target changes invalidate the
lease, so late speech cannot overwrite current text. Cancel restores the original
prompt only while the lease remains current. Speech never submits automatically.

## Isolation and permissions

Native inference runs in a lazily spawned Electron utility process. Messages are
schema-decoded, correlated, and timed out. A crash is isolated from Electron and
the next model load spawns a fresh process.

Microphone permission is granted only to the trusted main-window, same-origin,
main-frame renderer and only for audio. Preview tabs, subframes, foreign origins,
and video remain denied.

The worker and native artifact are unpacked from ASAR and validated during
packaging. Windows ARM64 reports a typed unsupported state. Release verification
requires a real desktop microphone/native-inference smoke test on supported targets.
