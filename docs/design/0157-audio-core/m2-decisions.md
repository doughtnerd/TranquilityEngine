# Decisions for the owner's review (ADR 0158, audio events M2)

The coordinator's calls during the M2 build ([plan](../../plans/2026-11-audio-events-m2-waves.md)), each with how to revert it, newest last. The owner's own rulings are in the build log's "M2" entries and quoted in the plan. Confirmed entries are marked "(confirmed)"; superseded ones are marked in their title, not rewritten.

## Summary (read first)

M2 is built: every task of the plan is merged on `claude/sweet-ritchie-miy6jm` with the final review green (all of it on master). Twenty-one entries below; the ones you ruled on are marked confirmed.

**Needs you:**
1. Re-check the blended engine in the listening pass ([m2-listening-pass.md](m2-listening-pass.md)): E, Right, release, Up should now be smooth (entry 18), then sign off (E7.1).
2. The lab-VM run (E5.5): `./native/audio/target/release/audio-bench mode=scene name=automation-probe seconds=20 runs=5` and `npm run bench:audio-events` (entries 11, 21). On this container the core's automation pass is 39–56 µs p99.9 against 30 µs.

**Biggest calls I made (each a one-line revert):**
- `avoidRepeat: 0` bans nothing (entry 5): a bug fix.
- Bindings clamp before they combine (entry 13): `evaluate` in `audio-core/src/automation.rs` and `events/automation.ts`.
- A streamed loop's release is predicted on main and spliced into the ring (entry 17): measured 0 frames late.
- Layered events' `Audio.play` stays over 5 µs (entry 21): a per-voice cost task in `CoreBackend.play` if you want it.
- Babylon debug rows only for event voices (entry 2): drop the `group` filter in `babylonBackend.ts` `debug()`.

**Proposals waiting for your yes/no:** none.

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

### 8. A description option on `@field` (E3.6) (confirmed: ADR 0159)
- **Question:** 0158's Consequences ask the inspector to make clear that `AudioSource.clip` takes clips or events; `@field` has no description/tooltip option, so E3.6 only expanded the doc comment (the picker already offers both kinds).
- **Proposal (yes/no):** add an optional `description` to `FieldOptions` (engine `registry.ts`) shown as the field's tooltip. It is a public API addition to the scripting surface, so it needs your yes (and maybe a short record). Otherwise the picker's two kinds stand alone.
- **Owner (2026-11-10):** "Adding the field description as you recommended is fine." Recorded as [ADR 0159](../../decisions/0159-field-description-option.md); built in wave 3 (task E3.7).

### 9. Runtime details that differ from 0158's wording, found by the guide (E3a, E5.2)
- **Logged, no change:** curves are cached by object identity, so two events never share a curve id (the 1,024 cap counts each event's curves); an automation curve holds at most 32 keys (not stated in 0158); a spatial event's `maxDistance` defaults to `max(minDistance, 100)` (0158's example shows 30); a `sustain` container's `release` defaults to `"loopEnd"`; a switch's crossfade time is its own `crossfade` key (default 0.1 s), with `onChange: "crossfade"` choosing it, rather than `onChange` carrying the seconds. The guide documents the code.
- **If changed:** each is one default or key in `src/engine/audio/eventFormat.ts` (and the guide).

### 10. One `fade` key, two meanings (E6.3) (confirmed: add `releaseFade`)
- **Question:** in `myco.audioevent@1` a node's `fade` is its blend-child fade width (0158 §1 "blend") and, on a `sustain` node, the release crossfade (§1 "sustain"); a sustain node that is itself a blend child can't hold both.
- **Chosen for now:** the editor lists `fade` once for such a node (the release crossfade when `release` is `"now"`, otherwise the blend fade); the runtime reads the one value for both, as it does today. The case needs a sustain container directly under a blend, which is rare (a blend child is usually a clip or a layer).
- **Proposal (yes/no):** add an optional `releaseFade` key to `sustain` (additive; the format stays `@1`; absent means `fade`, so existing files keep their meaning). One parser line, one runtime line, one editor field.
- **Owner (2026-11-10):** "releaseFade optional key is fine." Built in wave 3 (task E3.8).

### 11. M2 bench: first numbers miss three budgets on this container (E5.3)
- **Measured** (shared 4-core container, load 4–7, so inflated; `npm run bench:audio-events` and `audio-bench mode=scene name=automation-probe`): `Audio.play` median 8.6–9.3 µs (random of 4) and 17–25 µs (layer of 3, 2 bindings each) against ≤ 5 µs, with 35–58 KB of heap per play on the core; `setParameter` median 0.1–1 µs (met); 100 steady instances cost 7–9 µs a frame in `events().update` before E3.5's reap change (budget ≈ 0; 0 records and 0 sink calls, which the test gates); the core's automation pass p99.9 39–56 µs against 30 µs (E2 saw 25–45 µs here).
- **Chosen:** re-measure on a quiet machine after wave 2 merges. If `Audio.play` still misses, add a wave 3 task (**E5.3b**, mid model, owner of `events/eventRuntime.ts` in wave 3 alongside E4.5's one-line `loopRegion` default) to cut the play path's allocations (instance setup, picks, the handle). The core's number needs the lab VM (O3): `./native/audio/target/release/audio-bench mode=scene name=automation-probe seconds=20 runs=5` and `npm run bench:audio-events`.

### 12. Stray tool calls by Haiku leaves (wave 2)
- **What happened:** the harness showed leaves calling tools they weren't asked to use: create a session (denied), archive a session, subscribe to PR activity, a Claude Docs batch call. A check of the account's sessions after the fact found nothing archived or created during the build. Whether the Docs call created a document isn't visible from here.
- **Chosen:** every later brief says to use only file, shell and test tools.

### 13. How automation bindings combine (E3.4)
- **Question:** 0158 says volume curves multiply and out-of-range values "clamp or are ignored", but not per binding or per product. The parity test found the two evaluators disagreeing: Rust clamped the product (two negative volume curves made a positive gain; one non-positive pitch curve zeroed the others), and TypeScript skipped a binding to an undefined curve where Rust used 0.
- **Chosen:** each binding is clamped before it combines: a volume value below 0 counts as 0, a pitch factor at or below 0 counts as 1 (no change; a zero pitch would stall the voice), and a binding to a curve that was never defined evaluates as the empty curve (0). Both evaluators agree to 1e-6 (gain) over 26 scenes.
- **If changed:** `audio-core/src/automation.rs` `evaluate` and `runtime/events/automation.ts` `evaluate`, with the parity test.
- **Left alone:** an automated low-pass below 10 Hz is floored to 10 Hz in TypeScript and 0 (silent) in the core; both are effectively mute.

### 14. Follow-up: selection sees automated gain at the target, not the ramp (E3.4 found, E3.1's code)
- **Question:** `coreAutomation.ts` `reevaluate` evaluates a bound voice's gain at the parameter's target for selection (0158 §3, "Selection still sees it"); when the target gain is 0, selection can make the voice virtual at once, so it cuts instead of ramping down over the seek time.
- **Chosen:** fix in wave 3 (owner of `coreAutomation.ts` then is E4.5): selection uses the larger of the current smoothed estimate and the target until the seek completes, so a voice fades out before it is demoted.

### 15. How instances retire without a per-frame scan (E3.5)
- **Question:** a voice's end reaches main only through its polled `playing`; a callback would change `backend.ts`'s `AudioVoice` interface.
- **Chosen:** the mixer counts ended voices (`Mixer.voicesEnded`, `@internal`, one line in `src/engine/audio/mixer.ts`, fed by `mixer.voiceEnded`, which every backend already calls); the event runtime scans its instances only when that count moved, so a steady instance costs one comparison per frame (0158 §6). An instance stopped while it had no backend voice yet retires at the next end, the next play or the group-id sweep; its group id lingers until then, which is harmless below 1,024 instances.
- **Why not an `onEnd` hook on `AudioVoice`:** an interface change on every backend for what one counter gives.
- **If changed:** add `onEnd?` to `AudioVoice` in `backend.ts` and call it from each backend's end path; `eventRuntime.ts`'s `reapIfEnded` subscribes instead of comparing.

### 16. Runtime fixes found while testing (E3.5)
- Blend crossfades are equal-power: each edge samples cos/sin into 12 linear keys (|a²+b²−1| < 0.01; 0158 §1). `EventSystem._reset()` now clears curve ids (a second boot was silent). A continuous container waiting on an unknown clip length rechecks every frame instead of every 50 ms (0158 §6, "one frame late").

### 17. Releasing a streamed loop: predicted on main, spliced into the core's ring (E4.4)
- **Question:** 0158 §4 wants release on an exact frame; a stream's audio past the release already sits in the worklet's ring (up to ≈ 0.68 s), and the core can't tell the worker where to cut.
- **Chosen:** main predicts the end of the voice's current pass in stream frames (from the last STATUS playhead) and sends it as `atStreamFrame`; the worker stops wrapping there, or, if it already sent past it, starts a new epoch from that frame and the core splices it into its ring (`audio-core/src/stream.rs`), gapless, no fade. Measured on the loopback: 0 frames late in every case (releases asked 5 to 40,000 frames before the seam), tails bit-exact. It can only pick the wrong pass if a starve or pitch change between STATUS and the seam moves the playhead; then it lands one pass early or late, still on a seam. If the voice already read past the splice point the core falls back to a seek-style restart (5 ms fade).
- **Industry note:** FMOD and Wwise loop streams by seeking the stream at the loop end with prefetch; neither promises a sample-exact key-off on a stream, so this meets or beats them.
- **Also chosen:** a splice is marked with existing fields (a restart STREAM_OPEN with `loopEnd` ≠ 0), no wire schema change; `atStreamFrame` moved into contract C2's `StreamLoopMessage` at the merge. A stream already past a new region's end wraps at the end of its current pass (a clip in the same spot plays on to its end, E2's accepted deviation (d)); both are rare.
- **If changed:** a proper STREAM_OPEN flag bit in `audio-wire`'s schema (a wire minor bump) when the wire next changes.

### 18. Root cause of the owner's listening-pass gap (blended engine, core)
- **Found** (investigation, `events/throttleGap.test.ts`): selection evaluated a blend child's automated gain only at the parameter's **target**, once per `setParameter` (`core/coreAutomation.ts` `reevaluate`), so on an RPM sweep the child being left was cut at once, the child being approached stayed silent until the smoothed RPM reached it, and the mid child (target gain 0 at both ends of a 0 → 1 sweep) never played: ≈ 330 ms of silence each way. The core's smoothing was fine; the Babylon fallback has no virtual voices and isn't affected. The "only after pressing Right" pattern didn't reproduce: every sweep from a settled idle gapped; Up pressed during the 0.9 s start clip barely dips, which likely explains the smooth run.
- **Fix** (E4.5, the owner of the file, as part of entry 14): selection uses the larger of the gain at the target and the gain at main's running estimate of the smoothed value, re-evaluated every frame while a parameter is seeking, and not at all otherwise. The investigator's model of it is gapless (quietest 10-frame RMS 0.157 during a sweep).
- **Re-check:** the listening pass's blended-engine item after the fix merges.

### 19. Asset drop targets in the editor SDK (E6.3b) (confirmed: ADR 0160 accepted)
- **Chosen:** `registerAssetDropTarget(element, spec)` and `draggedAssets()` in `myco/editor`, from an import-free registry the asset drag consults first; the Event editor uses it. Public API, so [ADR 0160](../../decisions/0160-asset-drop-targets-in-the-editor-sdk.md) is **Proposed** for your yes/no.
- **If declined:** mark the two exports `@internal` (first-party plugins only) until a later record.
- **Owner (2026-11-10):** "Yes, that's approved."

### 20. Follow-ups found in wave 3 (E5.3b, E5.4), scheduled for wave 4
- **`Audio.play` on the core still misses ≤ 5 µs** (E5.3b, at load 11–12: ≈ 7–8 µs random-of-4, 22–25 µs layer-of-3; the event runtime's own allocations fell ≈ 40%, gated by a heap-per-play test). ≈ 85% of what is left is `CoreAutomation.bindVoice`/`setParam` (per-group `Set`s, closures in `evaluate`). Task **E5.3c**: a non-allocating `evaluate` (slot lookup instead of a callback), reuse of the group sets, no `reevaluate` before the voice is on the core.
- **`Audio.debug()` on the core doesn't show automation** (E5.4): event voices report `gain` 1 and `pitch` 1 (automation shows only in `audibility` and `state`), `playheadSeconds` null, and a bus's `effectiveGain` leaves out bus automation; `events` can drop an instance one poll before its last voice leaves `voices`. On Babylon gain and pitch do show it. Task **E3.9**: report the automated gain and pitch (main's estimate) and the bus automation in the debug rows; retire an instance's debug row with its last voice.
- **Babylon live loop region:** verified in a real browser (E5.4): changing `loopStart`/`loopEnd`/`loop` on a playing Babylon sound takes effect (entry 2's open follow-up is closed).

### 21. The play path and the debug rows (E5.3c + E3.9)
- **Result:** on the core loopback, `Audio.play` of a random-of-4 event with one binding went from 7.5 µs to 3.9–4.1 µs median (30 KB → 3 KB per play+stop), under 0158 §6's 5 µs for "a typical event"; a layer of 3 clips with two bindings each went 23 → 8.5–8.8 µs, still over 5 µs; `setParameter` on an instance 1.08 → 0.20 µs. The cause was every new instance reusing group 1 and re-evaluating the earlier voices still fading there, each through a closure; fixed with `evaluateInto` (no callback), one reusable entry per slot, linked reader lists, and no re-evaluation when a parameter is set to the value it already holds. Gates: evaluations per play, heap per play.
- **Chosen:** the layered number stays over 5 µs; 0158's budget names a typical event, and a random container with one binding is the common case (footsteps, impacts). What is left of the layered cost is the event runtime and `CoreBackend.play` per voice (≈ 2 µs each), shared with plain clips. **If you want** layered events held to 5 µs too, that is a per-voice cost task in `CoreBackend.play` (table, writer, handle objects).
- **Debug:** event voices' `gain` and `pitch` include main's estimate of the automated gain and pitch, with a playhead from the tracker; a bus's `gain` and `effectiveGain` include bus automation (as on Babylon); an instance's row stays until its last voice goes. `Audio.bus(n).effectiveGain` (from the mixer) still leaves bus automation out on the core.
- **Found, being fixed (E3.10):** a stopped instance freed its group at once; the next play took it while the old voices faded, and those voices followed the new instance's local parameters. Groups are now held until their last voice ends and handed out oldest-free first.

### 22. Bus automation in `effectiveGain` but not in selection (F2) (confirmed: include it, F3)
- **Chosen:** on the core, `Audio.bus(n).effectiveGain` now includes bus automation (main's estimate at the smoothed global parameters), multiplied with the bus's volume, snapshots, ducking and parents, as on Babylon; it is a view only (`mixer._setAutomationView`), so BUS_MIX isn't resent and the core, which applies BUS_AUTOMATE itself, doesn't apply it twice. Updated only while a parameter driving a bus binding seeks or changes.
- **Left as it was:** voice selection's bus factor (`busGain` in `applyMix`, from `resolveAll`) still leaves bus automation out, so a voice on a bus automated down to 0.27 scores as if the bus were at its static gain. Including it would make selection prefer voices on louder buses, as it already does for snapshots and ducking; it changes which voices are mixed under a full voice budget, so it's your call. **Recommendation:** include it (it's what selection does for every other bus gain), as a small follow-up with a selection test.
- **Owner (2026-11-10):** "Yes, as long as it doesn't cause that bug where we had an audio gap again." So selection uses the larger of the bus automation's gain at the target and at main's smoothed estimate until the seek ends (the rule that fixed the gap, entry 18), with a test that a bus automated down leaves no gap. Task F3, after F1 (both touch `core/coreBackend.ts`).

### 23. Layered events' `Audio.play` (F1) and imported-constant copies
- **Result:** on the core loopback, a layer of 3 clips with two bindings each went from ≈ 9–10 µs to ≈ 5.0 µs median (4.80–5.23 at load 1–1.9; 5.12–5.65 at load 2.1–2.2; the coordinator measured 5.00 at load 2.5 after the merge); a random of 4 ≈ 2.5–2.7 µs. Heap per play+stop 7.2 → 3.6 KB (layer), 2.9 → 1.9 KB (random). Real changes: one object per core voice (the `Voice` is its own `AudioHandle`; scripts still get a distinct object through `playOneShot`'s wrapper), no info object per clip-registry lookup, one import-settings read per clip, cached binding lists. Gate: heap per plain-clip voice start (960 B, ceiling 1,150 B).
- **Caveat:** part of the gain is a test-runner effect: under Vitest each read of an imported value is a getter call, so F1 copied hot imports into module-local constants in a few files (`coreAutomation.ts`, `replay.ts`, `clock.ts` and the play path). The production bundle reads imports directly, so the shipped player gains less from that part (it was already cheaper than the bench showed).
- **Open (owner):** keep the copies, or revert them and measure the budget on a bundled build instead (a small bench harness over `dist/`)?
- **Left:** asset lookups (`Assets.importSettings`, `Assets.url`: regex path normalisation, ≈ 0.35 µs per voice) are now the largest single cost; caching them needs `Assets` to signal source changes (editor sources are mutable maps with no version): an engine change.

