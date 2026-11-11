Approve with changes. Top 3 concerns: "frame" means two things; failures (refused changes, late stems, a locked context) are silent; the API names drift between sections.

Read: ADR 0166 (fully), goal.md, the spike README, and the rhythm, beat-clock and streams-align READMEs (for the debugging and rhythm sections). Code checked: `src/plugins/audio/runtime/Audio.ts:33`, `audioSystem.ts:125-129`, `core/lookahead.ts:11-31`, `src/engine/audio/eventFormat.ts:103`, `events/eventRuntime.ts:1161-1173`.

## Issues

1. **major**: "frame" is overloaded. §2 and §5 use it for a rendering frame ("fires in the frame whose heard-time window covers it"). §3 and the glossary use it for an audio sample frame ("the exact audio frame it applies at"). `at` and `time` are seconds, stamps are frames. **Change:** add "display frame" and "audio frame" to the glossary, and state the unit of every field (`at`, `time`, `heardIn`, stamps).
2. **major**: failures are silent. The slip counter (§3) is only proposed, the spike says `lateCommands` and `starved` do not count a slip (streams-align README, Q1), and §6 refuses asap music changes with no stated signal. **Change:** each refusal, re-plan and slip should emit a named debug counter or warning, and the record should say where it shows.
3. **major**: rule precedence is unclear. §1 calls the table "ordered" and also says "the most specific rule wins". Ties and the always-present `*`→`*` default are not explained. **Change:** state the tie-break rule and whether list order matters at all.
4. **minor**: naming drift. §5 has `handle.music`, §6 has `handle.music.positionAt`, and the rhythm spike uses `Music.positionAt`. `heardIn` is defined as `time − Audio.time`, but a reader would expect "seconds until heard" to be the sign that schedules ahead. **Change:** pick one name, and state the sign.
5. **minor**: the glossary says `Audio.time` is "corrected for output latency". The beat-clock spike says it is a per-frame value (constant within a frame, moved only by `beginFrame()`) minus limiter latency, with device timing taken from `getOutputTimestamp`. **Change:** say what a script actually reads, and that a read in `update()` is one frame old.

## What was unclear (term, then the plain definition I want)

- **Quantum:** a block of 128 audio frames, about 2.7 ms at 48 kHz. "Splits the quantum" is used without it.
- **Stamped / asap:** a command the audio thread applies at a set audio frame / as soon as it arrives.
- **Lookahead, horizon:** how far ahead a stamped start must be so its message arrives in time (floor 1,024 frames, about 21 ms at 48 kHz).
- **ClockMap, STATUS:** the translator from audio frames to the browser clock / the message the audio thread sends back with its counters.
- **Ring, prime, slip:** the buffer per streamed file (300 KiB) / fill it before it is needed / a start that happens after its stamp.
- **Decoded clip vs stream:** a decoded clip is in memory and always exact; a stream is read as it plays and is exact only if primed. This is the key choice for every stem, and the glossary never defines it.
- **Voice, mixed-voice cap, preset (low/default/high):** one playing sound / the most sounds at once / the device class that sets the limits.
- **Seam, sameTime, equal-power, grid(n):** a join between two pieces / enter at the same musical position / a fade law that keeps loudness steady / every n-th bar line.
- **Latency:** five terms (output, base, lookahead, limiter, render lead). Rhythm mode lowers only one; "no absolute latency" means it cannot promise a number.

## Using it

Nothing exists to copy yet: `src/engine/audio` has no music, `timeAt` or `horizon`. The code below is the proposed API; names may change.

```ts
// Switch explore -> combat: the rules table (exit: bar) decides when it lands.
music.setParameter("state", "combat");

// Stinger when the player finds a secret: it lands on its own `at`.
music.trigger("secret-found");

// Flash on every beat. The callback already runs in the frame the beat is heard,
// so set the visual here. heardIn is only for scheduling ahead.
class BeatFlash extends GameBehavior {
  flash = 0;
  onMusicBeat(e: { beat: number }) {
    this.flash = e.beat === 1 ? 1 : 0.4;
  }
  update(dt: number) {
    this.flash = Math.max(0, this.flash - dt * 4); // a plain decay; not beat-synced
  }
}

// Judge a key press against the beat (rhythm mode).
onKeyDown(e: KeyboardEvent) {
  const { beatOffset } = music.positionAt(e.timeStamp); // assumed: signed seconds from the nearest beat
  const err = beatOffset - Audio.calibration;           // sign of calibration not stated
  const grade = Math.abs(err) < 0.05 ? "perfect" : "miss";
}
```

Open points in the code: `positionAt`'s return shape, and whether calibration is added or subtracted.

## Tasks I could take

**Good first tasks** (pure TypeScript, unit-testable, no audio thread):
- **Grid maths** (≈1 person-week): tempo map ⇄ seconds ⇄ frames. Edge cases are tempo changes and rounding. Ask for property tests.
- **`Calibration.fromTaps`** (part of the ≈2 week rhythm task): warm-up discard, median, MAD. Define the "confidence value" first.
- **Format validation** (≈1.5): follow the checks in `eventFormat.ts`, plus the same-length and same-layout rule for stems.
- **Rules table editor** (≈1.5): a grid with theme tokens (CLAUDE.md).
- **Import hints** (≈0.5): WAV `acid`/`cue` chunks with fixture files.

**Risky for me:**
- In-voice ramps: Rust on the audio thread, plus a wasm rebuild. Not my level, and out of scope for this round.
- Prime-then-stamp with re-plan: concurrency between main and the worker.
- Beat dispatch before `update` (changes frame order at `audioSystem.ts:125-129`): it changes timing for every script.
- Segment waveform view: zoom, playhead and drag on a canvas.
- Rhythm-mode latency tuning: needs a real device to test.

## Debugging

**"The music didn't change."** Check in this order:
1. Log `handle.music.segment`, `bar` and `beat` each beat. This shows whether the change is pending or never fired.
2. The parameter value must match a child's `value` label exactly (`eventFormat.ts:108`, "the label it plays for").
3. It may be waiting. The default `*`→`*` rule exits at `bar`, so at 120 BPM in 4/4 a change can take up to 2 s to land.
4. Which rule matched? Nothing in the record can answer that yet. Ask for a debug query.
5. The next segment may not be primed, so the planner moved the start to a later grid point. Until the slip counter exists, nothing shows it.
6. `Audio.status` is "locked" until a user gesture, and `at` is ignored while locked (`Audio.ts:33`, `Audio.ts:130`).
7. With rhythm mode on, an asap music change is refused. The record does not say whether that produces a warning.

**"The stems are out of sync."**
1. Add the slip counter first. Until then, a stem that started late and stayed late is invisible (streams-align Q1).
2. A constant offset that differs by device is output latency, which is calibration, not a sync bug.
3. Check stem lengths, sample rates and channel layouts. A 44.1 kHz stem in a 48 kHz context is resampled, and the spike did not test that path.
4. In a mixed segment, decoded stems are always exact, so a skew points at the streamed ones.
5. A re-plan under load sounds like a skipped bar, not drift.
6. On Babylon, streams have no sample alignment. That is expected, not a bug.

## Cheaper alternatives

From my lens: expose `handle.music.beat` as a plain property first, and read it in `update()`, before the callback messages. It costs one frame of delay and skips the dispatch-order change. Keep the callbacks for M4c.

## Questions for the author

1. What does `positionAt` return, and is calibration added or subtracted?
2. When the music ring pool is full, is the start refused, queued or stolen, and is that signalled?
3. Does list order matter in the transition table, or is specificity the only rule?
4. Can one segment mix decoded and streamed stems?
5. Which music counters appear in the debug panel in M4a?
6. Is it `handle.music.positionAt` or `Music.positionAt`?
