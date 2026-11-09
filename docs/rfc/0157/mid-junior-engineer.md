# RFC 0157 review: mid-level engineer

**Verdict:** The direction is clear and the spike evidence is strong. But I can't tell from the RFC what I'd type in a game, what a "no sound" bug looks like, or what ships first. Accept the core design. Before implementing, ask for an API section and a smaller M1.

**Top 3 concerns**
1. **M1 is too big to ship as one step, and it removes the working fallback.** Clips, buses, snapshots, ducking, effects, streaming, virtual voices, a sample-accurate clock and the Howler removal all land together. Howler is deleted at the end of M1, so if the new core fails in one browser there is nothing to fall back to.
2. **The public API is undefined beyond "stays the same".** New knobs (priority, voice limits, spatial mode, quality preset, decoder opt-out, AAC opt-in) have no names, defaults or locations. Behaviour changes are unlisted too: `stream` clips stop using HTML5 audio, so routing and spatial behaviour change, and the RFC doesn't say which.
3. **No diagnostics until M5.** When a sound is silent, the RFC gives me no way to find out why.

## What was unclear

- **AudioWorklet:** "a script the browser runs on its own high-priority audio thread, 128 frames at a time."
- **Quantum and the 2.667 ms budget:** "one block of 128 frames. At 48 kHz that's 2.667 ms, so the whole mix must finish inside that time." Define it once, early.
- **Virtual voice:** "a sound that is tracked and advanced in time but not mixed. It costs almost nothing and starts being mixed when it becomes audible."
- **Logical vs mixed voices:** "4,096 sounds can exist; 256 are actually mixed per block."
- **Ducking, snapshot:** the guide defines these (`docs/guide/audio-mixer.md`). Link to it.
- **HRTF:** "makes a sound seem to come from a direction, through headphones."
- **Ambisonic bed:** "a cheap way to place many distant sounds around the listener."
- **Partitioned convolution reverb:** "reverb recorded from a real room. Partitioned means its work is split across blocks so it doesn't spike one frame."
- **LUFS:** "a loudness measure that tracks how loud people hear things. Used to match levels between tracks."
- **Sample-accurate, play-at-time:** "start a sound at an exact sample, not at the next frame."
- **SharedArrayBuffer, COOP/COEP:** "needs special server headers to enable. The design avoids needing them."
- **Stingers, stems, quantised transitions** (M4): one-line examples each.
- **Golden-output tests, transferable, MessagePort:** define in a glossary.
- **Spike table:** dense. Add a "what this means for you" line to each row.

## Using it as a game developer

What I'd expect to write, and whether it exists:

```ts
Audio.playOneShot("sfx/jump.wav", { volume: 0.8 });                    // works today
Audio.playOneShot("sfx/boom.wav", { position: pos, maxDistance: 80 });  // works today
Audio.bus("Music").volume = 0.5;                                        // works today
const h = Audio.playOneShot("sfx/loop.wav");  // returns void today; I need a handle to stop or fade
```

Missing or unclear:
- **A handle from `playOneShot`**, so I can stop or fade the sound.
- **Priority and limits:** `{ priority: "high" }` on a one-shot, and where per-bus limits are set.
- **Finished events:** there's no event system, so `AudioSource.isPlaying` polling is all I have. Say so, or propose a callback.
- **Two volumes:** `AudioSource.volume` multiplies the clip's import volume. Say which wins where.
- **`pitch` vs speed:** the guide calls it "playback rate". Name it once.
- **Gapless loops:** music loop points aren't mentioned.
- **Muting:** `Audio.muted` has a setter but no getter.
- **Quality preset:** how do I pick "low" for a phone? Project setting or automatic?
- **M2:** what is an event asset, how do I set a parameter, and what does `Audio.play(event, params)` return?

## Contributing and onboarding

- **TypeScript without Rust:** yes, as long as the committed wasm stays and the command-batch format is documented. Say this explicitly.
- **Rust side:** stable toolchain, the `wasm32-unknown-unknown` target, `npm run build:audio` and `cargo test`. Put this in one short contributor note. Not needing `wasm-bindgen` is a real help.
- **Missing:** a version number for the command-batch layout so TS and Rust can't drift apart silently. Also a note that `spikes/` is throwaway and not a starting point for the crate.
- **Test setup:** WebKit on Linux needs Docker in practice. Say which tests need it, and which run in plain `cargo test` or Node.
- **Examples:** no sample exercises buses, spatial sound or many voices. Ask for a sound-lab scene with one of each, plus a 4,096-voice stress scene.

## Tasks I could take

- Rust gain ramp, biquad filter, equal-power pan, with `cargo test` unit tests. Small, pure functions.
- TS command-batch encoder/decoder with round-trip tests, once the layout is written.
- Node golden-output harness: render N frames and compare against a reference WAV within a tolerance.
- Extend the pure TS settings parser (`settings.ts`) and its tests for new bus or ducking fields.
- API polish: a handle from `playOneShot`, an `Audio.muted` getter, clearer warnings.
- A "Playing sound" guide page. None exists; the basics are split across `atmosphere-and-sound.md` and `audio-mixer.md`.
- Bus peak meters in the editor, once the core reports levels.

## Tasks that look risky

- **Virtual voice priority and eviction:** subtle, and wrong choices silently drop sounds that should play.
- **Scheduling:** commands go one batch per frame, arriving 1–5 blocks late. "Sample-accurate" needs a stated meaning.
- **Streaming through MessagePort:** seeking, gapless loops, and recovery from a stalled decoder.
- **Howler removal:** parity across browsers, especially Safari, which is untested.
- **HRTF data, convolution reverb, LUFS:** SADIE II size and licence, non-uniform partitioning, and K-weighting with gating. All need DSP expertise.
- **Occlusion ray scheduling** (M3).
- **Event authoring UI** (M2, M5): the RFC itself says this is bigger than the DSP.

## Debugging and errors

Today there are `[myco]` warnings for unknown buses, unknown snapshots and spatial streams. Several silent cases have no message:
- `Audio.playOneShot` returns silently when the World has no view, and `AudioSource.play()` returns silently when `clip` is empty.

The RFC doesn't say:
- what happens when the wasm or the worklet fails to start;
- what happens to sounds requested before the first user gesture;
- what a missing codec does, for example `.m4a` without the AAC opt-in.

Ask for:
- one `[myco]` warning per distinct cause, naming the clip or bus;
- an `Audio.debug()` dump in M1 listing voices and their state (playing, virtual, evicted, bus muted, waiting for a gesture);
- a stated failure path: if the core can't start, warn once and stay silent, or keep Howler until the core is proven;
- bus peak meters in M1, not M5, since they're the first thing I'd check;
- a reason code on each handle explaining why a sound isn't audible.

## Suggestions

1. Split M1 into M1a (clips, buses, spatial parity, Howler still present) and M1b (virtual voices, streaming, effects, Howler removed).
2. Add an API section listing every new field and method with its default, and name the current `AudioVoice` interface as the stable surface.
3. Add a behaviour-change table: `stream`, `playOneShot` return value, codecs, `pitch`, first-gesture behaviour.
4. Write the command-batch layout as a short doc with a version number before any code.
5. Replace "identical output in every browser" with what was tested: Chromium on Windows, WebKitGTK and Firefox on Linux, in containers with no audio hardware. macOS is untested.
6. Add a "Why is there no sound?" guide page with a checklist.
7. Add a sound-lab sample scene for buses and spatial sound, plus a voice stress scene.
8. Give contributors one command list for the Rust and TS sides.
9. State the minimum stable Rust version in the RFC.

## Questions

1. Are sounds requested before the first user gesture dropped, queued or played later?
2. After M1, does a `stream` clip still stream, can it be spatial, and can it loop gaplessly?
3. What are the default voice limit and priority if I set nothing?
4. Who picks the quality preset?
5. Is a phone in scope for the "high" preset in M1?
6. If the wasm fails to load in one browser, is the game silent or does it fall back?
