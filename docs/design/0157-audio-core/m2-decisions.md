# Decisions for the owner's review (ADR 0158, audio events M2)

The coordinator's calls during the M2 build ([plan](../../plans/2026-11-audio-events-m2-waves.md)), each with how to revert it, newest last. The owner's own rulings are in the build log's "M2" entries and quoted in the plan. Confirmed entries are marked "(confirmed)"; superseded ones are marked in their title, not rewritten.

## Summary (read first)

Wave 1 is merged with every gate green; wave 2 is running (E5.2 guide and E5.3 bench merged). Master has E1, E2, E3a and the plan.

**Needs you:**
1. The lab-VM run (E5.5): `./native/audio/target/release/audio-bench mode=scene name=automation-probe seconds=20 runs=5` and `npm run bench:audio-events` (entry 11).

**Biggest calls so far:**
- `avoidRepeat: 0` now bans nothing (entry 5): a bug fix; random events with the default pick more randomly.
- Babylon debug rows only for event voices (entry 2): drop the `group` filter in `babylonBackend.ts` `debug()`.

**Proposals waiting for your yes/no:** a `description` option on `@field` (entry 8); a `releaseFade` key on `sustain` (entry 10).

## Entries

### 1. E2's deviations from ADR 0158, logged rather than changed (wave 0) (confirmed: accepted)
- **Question:** E2 (merged before planning) departs from 0158 in six places; accepted records aren't rewritten.
- **Chosen:** logged in the build log and here; no task changes them. (a) Only voices with a low-pass binding are filtered (M1 never applied per-voice `lpHz`; unbound voices stay bit-identical). (b) AUTOMATE, PARAM and CURVES apply on arrival, not stamped; the writer orders AUTOMATE after its PLAY. (c) Pitch automation ramps per frame; virtual voices advance at the block's mean pitch. (d) A voice past `loopEnd` when SET_LOOP arrives plays on to the end. (e) Curve uploads over the 256 KB staging area are dropped past ≈ 660 full curves (upload per asset; E3.1 spreads its replay over batches). (f) STATUS carries no `group` (0158 §6's line); main knows each voice's group.
- **Why:** each keeps M1's goldens bit-identical or avoids a wire record that can't hold eight bindings.
- **If changed:** (a) is `audio-core/src/automation.rs` and `voices.rs`'s filter gate; (f) would need a STATUS voice section, which STATUS doesn't have.
- **Owner (2026-11-10):** "assuming all 6 recommendations keep the audio system in-line with industry standards, I accept them." They do: (a) FMOD and Wwise bypass a voice's filter at its default; (b) FMOD Studio applies parameter changes on its update, not sample-accurately; (c) per-sample smoothing is standard, and approximate positions for virtual voices is how Wwise's virtual voices work; (d) samplers play on to the end when the playhead is already past the loop; (e) and (f) are internal.

### 2. Babylon debug rows only for event voices (E3.2)
- **Question:** contract C3 adds `voices[].event`; on the Babylon fallback `debug().voices` has been empty for plain voices, and existing tests assert that.
- **Chosen:** the fallback lists only voices belonging to an event instance (nonzero `group`), with `state` "playing", `priority` 0, `audibility` 1, `playheadSeconds`/`world`/`owner` null, `gain` = volume × fade.
- **Why:** keeps M1's fallback behaviour and tests; the panel's grouping needs event voices only.
- **If changed:** drop the `group` filter in `babylonBackend.ts`'s `debug()` and relax the `[]` assertions in `babylonBackend.test.ts` and `audioApi.test.ts`.
- **Open follow-up:** whether changing `loopStart`/`loopEnd` on an already-playing Babylon sound takes effect isn't covered by the mocks; check in a real browser in the E5.4 `@slow` spec (Babylon backend).

### 3. Loop points from files: clamping, ABI bump, Vorbis only (E4.1)
- **Question:** how the decoder reports a file's loop and what to do with odd values.
- **Chosen:** the clip-info record grows from 32 to 40 bytes (flags bit 1 = the file states a loop; `loopStart` u32 at 32, `loopEnd` exclusive u32 at 36); decoder `ABI_VERSION` 0x100 → 0x101 (minor, so main's major check is unaffected). A loop is clamped to the file's stated length and dropped if empty. A malformed `smpl` loop record is skipped; a truncated `smpl` gives no loop. Ogg **Vorbis** comments are read; **Opus** comments aren't, because this decoder build doesn't decode Opus (0158 §4 names Ogg/Opus). Streams need no ranged read: the worker already gets the whole file at stream open, so E4.4 only maps the stream's info into its reply.
- **Why:** additive ABI change; a bad loop in a file should never break playback.
- **If changed:** `audio-decode/src/decoder.rs` (clamp) and `loop_points.rs` (record rules); Opus comments come with Opus decoding.

### 4. The AAC decoder's size gate (E4.1 merge) (confirmed: raised)
- **Question:** `myco_audio_decode_aac.wasm` is 1,073,338 B against the 1,100 KB (1,126,400 B) gate, 95%; it was already 94.8% before M2 (loop points added 5.6 KB).
- **Proposal (waiting for your yes/no):** under ADR 0158 the gates are tripwires, so raise `DECODER_AAC_LIMIT` in `native/audio/build.mjs` to 1,280 KB with a build-log line, or leave it until something actually trips it. Later briefs touching `audio-decode` are told the remaining headroom (≈ 52 KB).
- **Owner (2026-11-10):** "the size gate is just a signal to investigate and make sure the systems aren't bloating unnecessarily, so the AAC decoder is fine to increase in size." Raised to 1,280 KB in `native/audio/build.mjs`.

### 5. `avoidRepeat: 0` banned every earlier pick; fixed (E3.6)
- **Question:** E3a's random container did `history.slice(-avoidRepeat)`; with the default 0 that is the whole history, so up to 32 earlier picks were banned, weights were skewed, and it could fall back to a uniform pick.
- **Chosen:** 0 bans nothing, as 0158 §1 means. Random events with the default sound more random than in E3a, and picks for a given seed change (E3a was never released).
- **If changed:** not recommended; the old behaviour was a bug.

### 6. Per-World state on the Babylon fallback is shared (E3.6)
- **Chosen:** generators and sequence positions are per World key, seeded `(audio.seed ^ imul(key, 0x9e3779b1)) >>> 0` (key 0 keeps `mulberry32(seed)`); state is forgotten when the host stops listing a World. On the Babylon fallback every World has key 0, so they share one generator; only the World with the view plays there.
- **If changed:** give the fallback its own World keys (`audioSystem.ts`).

### 7. Follow-up: the per-frame reap scan (E3.6 → E3.5 in wave 2)
- **Question:** making `EventInstance.playing` side-effect free moved retirement into `EventSystem.update()`, which now scans the live instances every frame; 0158 says steady instances cost main nothing per frame.
- **Chosen:** accepted for wave 1; the wave 2 owner of `eventRuntime.ts` (the E3.3+E3.5 lead) retires instances from voice-end events instead (the core's STATUS already reports ends) and keeps the idle path at one heap comparison. E5.3's bench measures it.

### 8. Proposal: a description option on `@field` (E3.6)
- **Question:** 0158's Consequences ask the inspector to make clear that `AudioSource.clip` takes clips or events; `@field` has no description/tooltip option, so E3.6 only expanded the doc comment (the picker already offers both kinds).
- **Proposal (yes/no):** add an optional `description` to `FieldOptions` (engine `registry.ts`) shown as the field's tooltip. It is a public API addition to the scripting surface, so it needs your yes (and maybe a short record). Otherwise the picker's two kinds stand alone.

### 9. Runtime details that differ from 0158's wording, found by the guide (E3a, E5.2)
- **Logged, no change:** curves are cached by object identity, so two events never share a curve id (the 1,024 cap counts each event's curves); an automation curve holds at most 32 keys (not stated in 0158); a spatial event's `maxDistance` defaults to `max(minDistance, 100)` (0158's example shows 30); a `sustain` container's `release` defaults to `"loopEnd"`; a switch's crossfade time is its own `crossfade` key (default 0.1 s), with `onChange: "crossfade"` choosing it, rather than `onChange` carrying the seconds. The guide documents the code.
- **If changed:** each is one default or key in `src/engine/audio/eventFormat.ts` (and the guide).

### 10. One `fade` key, two meanings (E6.3)
- **Question:** in `myco.audioevent@1` a node's `fade` is its blend-child fade width (0158 §1 "blend") and, on a `sustain` node, the release crossfade (§1 "sustain"); a sustain node that is itself a blend child can't hold both.
- **Chosen for now:** the editor lists `fade` once for such a node (the release crossfade when `release` is `"now"`, otherwise the blend fade); the runtime reads the one value for both, as it does today. The case needs a sustain container directly under a blend, which is rare (a blend child is usually a clip or a layer).
- **Proposal (yes/no):** add an optional `releaseFade` key to `sustain` (additive; the format stays `@1`; absent means `fade`, so existing files keep their meaning). One parser line, one runtime line, one editor field.

### 11. M2 bench: first numbers miss three budgets on this container (E5.3)
- **Measured** (shared 4-core container, load 4–7, so inflated; `npm run bench:audio-events` and `audio-bench mode=scene name=automation-probe`): `Audio.play` median 8.6–9.3 µs (random of 4) and 17–25 µs (layer of 3, 2 bindings each) against ≤ 5 µs, with 35–58 KB of heap per play on the core; `setParameter` median 0.1–1 µs (met); 100 steady instances cost 7–9 µs a frame in `events().update` before E3.5's reap change (budget ≈ 0; 0 records and 0 sink calls, which the test gates); the core's automation pass p99.9 39–56 µs against 30 µs (E2 saw 25–45 µs here).
- **Chosen:** re-measure on a quiet machine after wave 2 merges. If `Audio.play` still misses, add a wave 3 task (**E5.3b**, mid model, owner of `events/eventRuntime.ts` in wave 3 alongside E4.5's one-line `loopRegion` default) to cut the play path's allocations (instance setup, picks, the handle). The core's number needs the lab VM (O3): `./native/audio/target/release/audio-bench mode=scene name=automation-probe seconds=20 runs=5` and `npm run bench:audio-events`.

