# The recorded conversation

**This directory is deliberately empty.**

Plan §5.1 and R-56 call for a short recorded conversation — audio or muted video
with captions — so that a visitor on a muted laptop, a locked-down work machine,
or a browser with no microphone can still see what the demo does. The fallback
panel (`src/ui/components/fallback-panel.ts`) and the README both expect it here
as `conversation.webm`, with `conversation.vtt` alongside for captions.

It has not been produced, because recording a real conversation needs a real
microphone and a person to speak into it. Neither was available when this was
built, and a synthesised stand-in would be a worse artefact than an honest gap —
the whole point of the recording is to show what the thing actually sounds like.

The fallback panel is written to degrade cleanly when the file is absent: it
feature-detects, listens for a media `error`, and removes the player entirely,
leaving the explanation and the repository link. So nothing is broken by this
being empty; there is simply one fewer way in.

## To produce it

1. Open the live site, allow the microphone, and book a table out loud.
2. Screen-record with audio, or record the audio alone. Keep it under 45 seconds.
3. Use synthetic details only — no real name, no real phone number.
4. Save as `public/demo/conversation.webm` and write `public/demo/conversation.vtt`.
5. Embed the same file in the README.
