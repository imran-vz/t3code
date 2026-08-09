# Voice input

Voice input lets the desktop app turn microphone audio into prompt text locally.
It shows a live transcript in the composer and never sends the prompt
automatically.

## Set up

1. Open **Settings → Voice Input**.
2. Download the Moonshine Streaming Tiny model.
3. Wait until its status is **Ready**.

The model is downloaded only when you request it. You can cancel, retry, or delete
it from the same page.

## Dictate a prompt

Select the microphone in the composer and begin speaking. New words appear live.
Select stop to keep the final transcript, or press Escape to cancel and restore
the prompt from before recording. You can edit the resulting text before sending.

If you edit the prompt or switch to another composer while recording, voice input
stops rather than overwriting the newer text.

## Privacy and availability

Audio and transcription stay on the desktop device. Voice input is not available
in ordinary web browsers or the mobile app. Platform support depends on an
available native inference package; Windows ARM64 is currently unsupported.

If transcription fails, the recording stops and the composer is restored when it
is still safe to do so. Start a new recording to retry.
