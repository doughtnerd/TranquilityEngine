**Verdict: approve with changes.** Top 3 concerns: (1) the estimate is under-priced, and my bottom-up is about 68 pw (60–75), not 50–65; (2) the STATUS buffer has 192 B spare and M5 adds more than that; (3) "edits apply live" has no path from the editor's saved draft into the play Engine, and "index-stable" has no identity for a renamed or removed bus.

Read: BRIEF, the record, goal.md, `spikes/audio-mix/README.md`, 0166's README and `api-and-models.md` §10 (M4's task table), and the code named below. I did not read the sub-spike READMEs; I took their numbers from the main README.

## Issues

1. **Blocking: STATUS has no room.** `STATUS_BUFFER_BYTES` is 16,384 and `STATUS_WORST_CASE_BYTES` is 16,192 (`audio-wire/src/schema.rs:73-74`), so 192 B are spare (0166 `architecture.md:659`). The record adds 28 B × 8 metered buses (224 B) plus section work units (§10), which already overflows. Change: §10 states the new worst case and either raises `STATUS_BUFFER_BYTES` (a worklet/SAB sizing change, so cost it) or shrinks `peaks`/`beds` capacity (`counters.rs:23`, `PEAKS_CAP` = 32). Add a wire task that regenerates the hash and vectors.
2. **Major: a bus has no identity, so "index-stable" can't be built from a diff.** The mixer keys buses by name (`mixer.ts:87`) and the core backend maps names to indices (`coreBackend.ts:766-771`). A rename in the Project Settings is therefore remove plus add: the voices on it are lost, and `Audio.bus("x")` handles held by scripts go inert. Change: the Mixer panel and settings edit through the pure model functions (`AudioSettingsSection.tsx:2`), so the record should say edits are applied as **operations** (rename, move, add, remove, set) from those functions, not as a diff of two settings objects. Alternatively add a stable `id` to `BusSettings`.
3. **Major: removed buses become tombstones, and `MAX_BUSES = 32` (`settings.ts:209`) counts them.** A long mixing session of add, remove and undo exhausts the slots, and the 32 peaks cap is the same number. Change: say when a tombstone is recycled (after its tail has faded and no voice references it) and what happens at 32. The hard-rebuild replay (`busConfigWire`, `coreBackend.ts:794-801`, which numbers buses by settings order) and the context-rebuild path must replay the tombstoned layout. Neither is mentioned.
4. **Major: no path carries a saved edit into the running game.** `startPlay` hands the Engine a copy of the settings (`playMode.ts:88,122`), and the mixer is configured once at create (`Engine.ts:184-187`). `ProjectSectionSpec.saved` and `.stepped` exist (`projectSection.ts:34-37`), so undo and redo during Play work and fire a hook. But a plugin's section contribution (`sdk/contributions.ts:174-190`) exposes no such hook, and 0147 forbids the audio editor half from reaching the shell. Change: add a small SDK surface (an `onSaved` for a settings section, or `editor.project.changed()` carrying the section key) and a `mixer.apply(settings | ops)` that does not clear script state, unlike `configure` (`mixer.ts:79-90`). This is its own task and an amendment to 0147's SDK list.
5. **Major: the capture can't be opened if it lacks the project's mix.** Live edits change the bus tree during a recording, yet the header holds only a name table. Change: the file records the `audio` section at start plus every mix-edit event with its operation, so the profiler can name tombstoned buses and judge loudness against the target as it stood.
6. **Minor: the capture is bound to one wire hash.** STATUS is stored raw, so the editor must carry the decoder of the wire that wrote it. A refusal is safe but means a capture from an export one ABI older is unreadable. Say that this is accepted, or key the decoder by ABI.
7. **Minor: the estimate.** See below.

## API

Concrete shapes the record leaves open.

- **Three meanings of "loudness"** (bus flag, `Bus.loudness`, `audio.loudness`) will collide in docs and in `parseAudioSettings`. Change: bus field `meter: "loudness"` (absent = off, never written when default, as `bed` is, `settings.ts:42-43`), project target `audio.loudnessTarget`, and `Bus.loudness` stays the reader.
- **`Bus.loudness` must be a stable object**, allocated once per bus, like `peak` (`mixer.ts:59`, fed by `_setPeak`). It carries `momentary`, `shortTerm`, `integrated`, `lra`, `maxTruePeak`, `maxMomentary`, plus `reset(what)` and `paused`. It reports `-Infinity` while gated or empty, and `NaN` never. For an unmetered bus it holds `metered = false` with `-Infinity` readings, since a test build that reads it should not throw. The Babylon backend reports the same shape with `metered = false`.
- **Where it lives:** the type and fields belong with `Bus` in `engine/audio/mixer.ts` (as `peak` does), the statistics in the plugin runtime. The record should say so; ADR 0010 holds because no backend type leaks.
- **`Bus.volume` split:** the getter at `mixer.ts:49` documents "1 = as authored" but `configure` initialises it to the authored value (`mixer.ts:87`), so the comment is already wrong. M5 should define `volume` as the **runtime multiplier, default 1**, range 0..2, and name the authored value `authoredVolume` (read-only to scripts, written by the editor). `fadeTo`, snapshots and automation all act on the multiplier. State that authored 2 × runtime 2 = 4 is legal and the master limiter catches it. Whether the editor fader shows `effectiveGain` is open question 8.
- **Ducking `mode`:** the format today is `target, trigger, amount, attack, release` (`settings.ts:66-75`, parsed at `:364-368`). Change: `mode: "level" | "presence"`, and for `level` add `threshold` (dBFS) and `detector: "peak" | "rms"`. For an absent `mode`, the engine is unpublished, so default to `level` and rewrite the samples' rules; the default rule at `settings.ts:14` should be explicit. Add validation for a trigger that is the target's ancestor; the current check refuses only `target === trigger` (`:367`).
- **`Audio.capture`:** `start(options?)` must be `Promise<void>` or buffer, because the recorder module loads lazily and events before it loads would be lost. `save(name?)` returns `Promise<string>` (the path or filename). Say what happens when the editor's panel ring and a game capture both run (one ring, shared).
- **Ducking, loudness and ramps on Babylon:** the record says "not available" in prose. Put it in `Audio.debug()` as capability flags, as `MusicBackendCaps` does for music.

## Milestones and estimate

**Ordering is right.** M5-0 first, bit-identical for unstamped work as M4-0 was. M5a and M5b share only the STATUS wire, so land the wire task (issue 1) at the head of M5-0. M5c depends on the SDK hook (issue 4).

**The record's calibration doesn't hold.** It prices 31 pw of features plus 40% for tests plus a quarter to a third reserve. Check against 0166:
- M4's record priced 24.5 pw of features; its table came to 58.1 pw of tasks (×2.37) and 69.7 with the 20% reserve (`0166 README:44`, `api-and-models.md` §10.2). The record itself then sorted 12 pw of "not in the record" work (goldens, benches, e2e, docs) at 59.5 d.
- M5's 31 × 2.37 = 73 pw of tasks; × 1.67 (M3's factor) = 52. The record picked the lower and still gives 50 as its floor. Arithmetic: 31 + 40% = 43.4, and a quarter to a third on top is 58–65, so "50" implies a 13% reserve.

**Unpriced work (my days, M4's rows as units):**

| Item | Basis | d |
|---|---|---|
| Wire plumbing: STATUS growth and buffer, stamped bus ramp and sidechain records, hash, vectors, fuzz, status reader, replay of a stable-index config | M4 Z1 3 d + W1 3.5 d | 8 |
| Goldens: stamped bus ramps re-recorded, M1–M4 digests unchanged, sidechain null tests, loudness against the EBU Tech 3341/3342 files (never run: spike README, "Still unverified") and BS.1770 Annex 2's table (+0.10 dB true-peak error) | M4 Z3 5 d + C3 5.5 d | 12 |
| Metered scenes and budget gate for loudness and sidechain | M4 Z5 2 d | 4 |
| e2e: profiler record and scrub, live-edit click check, capture round trip in an export, Babylon | M4 E1–E3 9 d | 12 |
| Docs: guide, status rows, amendments to 0097, 0157, 0158, 0147 | M4 D2–D5 | 5 |
| Listening pass (ducking feel, crossfade lengths, live-edit clicks) | M4 L1–L3 | 4 |
| **Subtotal** | | **45 d = 9 pw** |

**Under-priced features:**
- M5-0 at 4 pw: M4-0 was 5 pw for in-voice records alone. M5-0 also rewrites `configureBuses`, which today rebuilds everything (`coreBackend.ts:765-792`: beds replanned, automation rebound, table limits, every voice re-routed). Price 7 pw.
- Profiler panel at 7 pw: M4's editor was 8 pw for a music editor and its own RFC cited waveform, snap and undo as 2 pw the record had missed. A scrubbable timeline with seven track kinds, a 1,024-voice table, a decode worker and loudness-target marks is 10–12 pw.
- The Mixer panel sits inside "live mixing 6 pw" with the authored/runtime split, the SDK hook, `mixer.apply`, three edit classes and crossfades. Split it: live apply 7 pw, Mixer panel 4 pw.

**Bottom-up:** M5-0 7, stream 5 (the encoder's 370 B per block must be rewritten, `capture` spike), CPU 1.5, profiler 11, loudness 5, live apply 7, Mixer panel 4, sidechain 2.5, captures 2.5, Babylon/samples/guides 2.5 = 48; plus the 9 pw above = **57 pw of tasks**. With M4's chosen 20% reserve that is **≈ 68 pw, range 60–75**. State the record's range as 60–75 and name the reserve.

**Test tooling the table must include:**
- Loudness against the EBU files as a golden (tolerance ±0.1 LU), once the files are fetched outside the proxy; keep the 189 checks as the unit gate.
- A live-edit click test: render N quanta through the core, apply each edit class, assert a sample-difference bound (the S4 method), for every class including rename and remove.
- Capture round trip: record, `save`, open, compare at five cursor positions against the live STATUS.
- A CPU-figure test with a fake `Date.now` (steps of 1 ms) checking the 256 ms window and the section refit.

## Conflicts

- **0097:** its ducking is presence-only (`mixer.ts:203-208`); M5 changes it, which the record notes. It also changes what `Bus.volume` means (`mixer.ts:48-50`): amend 0097's bus section, not just 0171.
- **0158:** automation bus gain is applied by the core (`BUS_AUTOMATE`, `mixer.ts` `_setAutomationView`); the record's "parameter-driven bus automation becomes stamped ramps" overlaps it. Say which owns the curve evaluation (it is already in the core, so presumably nothing changes), and that automation joins the multiplier.
- **0162:** the shedding ladder drops work in order; the record never says where loudness and sidechain sit on it. A metered bus that sheds loses its LUFS history. Say they are never shed, or that a shed pauses the meter and marks it in the stream.
- **0166/0167:** M5-0 must keep M4-0's stamped classes G and S and `splitQuanta` = 0 (`0166 README`, Notes for the build); bus ramps are a third stamped class. Say it joins the due list (`due.rs`) rather than adding a second mechanism.
- **0147:** the SDK change in issue 4. Also the Profiler and Mixer panels import `../../../editor/sdk` only; the play session's internal tier is a closed list (0147's internal tier), so don't import `session`.
- **0157 §4.7:** `loadPermille` is "reserved 0" (`counters.rs:424-425`); the record fills it. Fine; list it in the amendment.
- **0010:** nothing in the API leaks Babylon, Rapier or Howler.

## Cheaper alternatives

- **Drop `Audio.capture` as a separate recorder module;** keep the lazy module but ship only the `--audio-capture` trigger plus `save`. Saves about 0.5 pw and removes the start-race.
- **Mixer panel without effects editing** (open question 5): faders, mute, solo, snapshots, meters. Edits to effects stay in Project Settings, where the live apply still works. Saves ≈ 1.5 pw.
- **Structural live edits (re-parent, reorder, remove effect) apply at Stop,** while volume, mute, solo, filter, send and append edits are live. Saves the crossfade path (≈ 2 pw) but contradicts the owner's "edits are kept" only in timing, not in outcome; a cost to point out, not a reopening.
- **Loudness on master only on low** (open question 7): decide now, it is free.

## Questions for the author

1. Is STATUS growth planned as a larger buffer or fewer peaks, and does the worklet's SAB size follow?
2. Do edits reach the mixer as operations or as a diff, and what is a bus's identity across a rename?
3. When a tombstone is recycled, and what is the limit at 32?
4. Which SDK hook carries a saved audio section into the play Engine, and is 0147 amended for it?
5. Does a shed (0162) pause the meters, and is that visible in the stream?
6. Is the 60–75 pw range acceptable, and which of the cheaper cuts, if any, does the owner want?
