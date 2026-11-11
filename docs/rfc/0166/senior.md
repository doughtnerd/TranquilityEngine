**Verdict: approve with changes.** Top concerns: (1) the estimate of 38–46 person-weeks repeats the mistake 0162 made at 22 and is likely 50–60 once priced as a task table; (2) the format additions break the existing parser's tree invariants (`switch` overloaded, positions in seconds, no child-id scheme for `from`/`to`); (3) "in-voice ramps" are filed as a 1.5 pw item but change the render path of every voice and every M2/M3 golden.

Read: 0166, goal.md, `spikes/audio-music/README.md`, the streams-align, cost and beat-clock results as summarised there; 0157 (clock, roadmap), 0158 and 0162 (shape, revision 4) in part; `eventFormat.ts`, `voices.rs`, `stream.rs`, `lookahead.ts`, `audioSystem.ts`, `Audio.ts`, `coreBackend.ts`, the 0162 build log.

## Issues

1. **Estimate is not honest yet (major).** 0162 was priced at ≈ 22 pw as a feature list (0162 "Estimate") and became 36.7 pw (169.5 table days + 14 reserve) in revision 4 (item 10). 0166 applies a ×1.55–1.85 multiplier to 24.5 and calls it calibrated, but 0162's multiplier (×1.67) already included a reserve and still grew from scope the record hadn't priced (ray query, 16-channel streams, private decoders). M4 has the same hidden items (below). Change: state that 38–46 is a floor, and name the unpriced items in Milestones.
2. **`switch` cannot carry both behaviours (major).** `SwitchNode` has `onChange: keep|restart|crossfade` and requires a labelled parameter (`eventFormat.ts:151-160`, check at `:544-547`). "Gains music behaviour when its children are music" makes validation type-dependent and gives the same node two semantics. Make it a distinct `musicSwitch` node (or `switch` with a required `transitions` that replaces `onChange`), and let `NODE_TYPES` (`:197`) grow honestly. Wwise also separates Switch and Playlist containers from the SFX ones.
3. **Rule endpoints have no addressing scheme (major).** `from`/`to` are "a child id", but nodes have no id field (`NodeBase`, `:95-113`); switch children are addressed by `value`. Rules must reference switch labels, playlist indices or segment names. Add a required unique `id` on music nodes, validated like parameter names (`parseParameters`), with a problem on a dangling `from`/`to`.
4. **Limits are not set (major).** The parser caps everything: depth 16, 1,024 nodes (`:252-254`), 32 curve keys (`:65`), 16 local parameters. The record adds tempo markers, cues, regions, rules and stingers with no cap. Needed: tempo markers ≤ 64, cues ≤ 128, regions ≤ 32, tracks ≤ 16 (equals the music pool's high size), rules ≤ 256, stingers ≤ 32 per container. Rules need a cost bound because main evaluates them on a parameter change.
5. **Seconds as the stored position (major).** A tempo edit then moves every bar line away from its cue, and floating-point seconds make "bar 17 beat 1" round-trip badly. Wwise stores ms, FMOD stores time against tempo markers. Store **cue and region positions as sample frames of the stem** (integers, exact), with tempo markers in frames too, and convert in the editor. `eventFormat` stores seconds elsewhere only because nothing before needed sample accuracy. If seconds stay, validation must snap to the grid and the record must say what resolution is promised.
6. **`transitions`/`stingers` placement and the wildcard order (minor).** Precedence "exact pair, then from, then to, then `*`" is Wwise's, but unspecified ties inside a tier (two rules for the same pair) need "first listed wins" plus a validator warning. `exit: cue(name?)` with an absent name is ambiguous; give it `nextCue`.
7. **Stamped PLAY and STOP also split the quantum (major).** `render()` splits at every record with `offset > cursor` (`voices.rs:310-325`), whatever the record. Only gain records are called out (§4). A transition is a PLAY B and STOP A at one frame, which is one split; a stinger landing mid-quantum is another. Fine, but the record must say that in-voice ramps remove *gain* splits only, and the stamped-start split stays, or give starts an in-voice start offset too. Otherwise the "no splits" claim is false for the common case (a stinger on a beat).
8. **In-voice ramps touch every voice and every golden (blocking for the estimate, not the design).** Voices already hold gain, fade and mix ramps (`voices.rs:33-40, 956-975`); 0162 required M2 goldens bit-identical (build log D1/K3 lines). A start-frame field in the ramp changes the state in `VOICE_SLOT_BYTES` (`:142`), the generated wire layout (`audio-wire/src/generated.rs`, `FADE = 0x04`), the mirror in `voiceTable.ts` and the replay path (`replay.ts`: REPLAY must restore a pending ramp). State whether goldens stay bit-identical for non-stamped fades (they should) and price the replay and recovery cases.
9. **The slip counter and music pool change the ABI (major).** `stream_count(p)` is `max_mixed / 16` clamped 4..16 (`stream.rs:118-120`), and `region_bytes` derives from it; a music pool means a new `InitParams` field, a layout change and a generated STATUS field (0162 added 4 regions and went to ABI 2.0). Say whether this is ABI 2.1, and that `streamStartsLate` is a wire-generator change plus `statusReader.ts` and the debug panel. Also decide who counts a slip: the core knows only when the voice started, not what stamp it missed; compare at PLAY apply (stamp vs first-render frame) and say so.
10. **Pool semantics unclear (minor).** "Released once its fade reaches silence" needs a core-visible event (the voice's end) and a main-side release path; how does a ring in the music pool differ from a normal one for `STREAM_OPEN`? A pool flag on the ring id, or a separate id range, must be chosen.

## API

Review of the §5 surface against the existing one.

- **`handle.music` (approve with changes).** A pure read of main-side state; fine. `time` duplicates `Audio.time` semantics; define it as the heard time of the *playhead position* now. `segment` should be the node id (issue 3). Document that it is `undefined` for non-music handles, not an empty object.
- **Component messages (approve).** ADR 0093 messages are fixed-step physics; beat messages arrive in the early audio step, so state the phase: after systems, before `update`. The existing `onTriggerEnter` receives a component (`Component.ts:150-152`); the beat event is a plain object. Two risks. (a) An `AudioSource` plays many instances; the event carries `handle`, good. (b) Messages need a **registration cost rule**: dispatch only if some component on the entity defines `onMusicBeat`, otherwise main still computes the predictions for nothing. Predict lazily per subscribed instance.
- **`Audio.timeAt(performanceTime)` / `Audio.horizon` (approve).** Both are cheap (`coreBackend.ts:1002` has `horizon()`). One concern: the existing `Audio.time` getter (`Audio.ts:234`) is "updated once per frame", so `timeAt` is the only per-event-accurate clock; document that `horizon` is not a promise that a stamp at `time + horizon` is exact for a *streamed* voice (priming), or scripts will misuse it with `playOneShot(clip,{at})` on a streamed clip. Cap `at` in the past: it already runs late and counts.
- **`handle.nextGrid('beat'|'bar'|n)` (major).** Returns a heard time, but the grid changes after a transition or tempo marker; return `{ time, bar, beat }` so the caller can display it, and say what it returns for a pending transition (the new segment's grid, or null). `n` as a bare number is unclear (bars? beats?): use `{ every: 'bar', n: 2 }` or `grid(n)` as in the rule table.
- **`handle.trigger(name)` (minor).** Stingers live on a container, so the name needs the container path or a global stinger namespace per event. Return a boolean (accepted, dropped by `dontRepeat`, or no such stinger).
- **`handle.setParameter` (already exists).** Do not re-announce it as new. For a music switch it must define "latest wins" if called twice before the quantised exit.
- **Rhythm API (`Calibration.fromTaps`, `Audio.calibration`).** A statistics helper in the engine is fine, but a persisted per-device offset needs a storage key; there is no project-wide save API in the audio runtime. Check the engine's existing persistence service before inventing a path.

Industry notes: FMOD's callbacks carry tempo and signature (matched), Wwise's `AK_MusicSyncBeat` is a callback per instance (matched by component messages). Unity has no equivalent, so no conflict there.

## Conflicts

- **With 0157:** the amendment is real, and larger than stated. 0157 fixes the stream counts at 4 / 8 / 16 (§5.3) and the 1.3 ms p99.9 high total. The record puts music inside the voice cap (owner decision 2), which is consistent, but "−1% net" is an estimate from p50 deltas; keep the ≈ 1.34 ms fallback visible as a risk rather than burying it in §7. Also the "stamped records only use lookahead" rule (0157 line 107) means a transition at the next beat can be refused when the beat is under `horizon + prime`; say the minimum quantisation latency (~100 ms) in the docs.
- **With 0158:** the format claim of "no version bump" is defensible only because the engine is unpublished, but unknown node types are today a parse problem, not a skip: an older reader would drop a `segment` node with a problem. Fine here. Conflict: 0158 §"no timeline" (cited by 0166 itself) is kept, but `regions` with `while` conditions are a mini-language over parameters; reuse the existing curve/parameter condition vocabulary instead of a new one.
- **With 0162:** the shape follows it. The mixer size gate was raised to 320 KB because M3 reached ≈ 266 KB (build log D25). M4 adds ramp state and music counters; list the budget (target ≤ +8 KB) so it is not a surprise.
- **Disagreement with accepted records (separate point):** 0157's rule that the audio thread keeps no musical state is respected, but I disagree with its decision to keep `STATUS` the only core-to-main report channel for *grid* events: with design A the core cannot tell main about a `while` loop exit until after the fact. The record already handles this by correcting predictions; just note that a `while` region makes the prediction wrong for up to one STATUS interval, so `while` regions should be quantised to loop ends decided at least one lookahead ahead.
- **`layer` deprecation text:** "The `layer` node itself stays" while "sound-lab becomes a segment" is consistent; list the exact files in samples to update.

## Milestones and estimate

Milestone order is sound: each is shippable, and the core work (ramps, pool, counter) sits in M4a. Two changes.

1. **Split M4a.** In-voice ramps plus the music pool plus the slip counter are an ABI change and touch goldens; ship them as **M4a0** before the main-side player, with their own metered gate and golden run, because everything after depends on them.
2. **Move Babylon fallback to the end of each milestone, not one lump.** Priced at 1 pw, it is really 0.25 per milestone, and the e2e on Babylon is mostly missing.

Unpriced items (pw), from the 0162 build log's patterns:

| Item | pw |
|---|---|
| Golden updates and `REPLAY`/recovery for pending ramps and primed rings | 1.5 |
| Generated wire (STATUS field, InitParams, layout) and `statusReader`, debug panel, mirror | 1 |
| Decoder-worker prime protocol: ack ordering, cancel on re-plan, memory release; wasm worker tests | 1.5 |
| Metered scenes and benches (cost scenes S4 become a gated bench, wasm and native) | 1.5 |
| e2e (Chromium; WebKit owed at milestone ends) and loopback tests | 2 |
| Guide, API docs, `implementation-status.md`, ADR amendments 0157/0158/0097 | 1 |
| Listening pass fixes and owner-review rework | 1.5 |
| Editor: waveform computation, tempo-aware snapping, undo for music nodes, preview through the backend | 2 |
| **Sum** | **≈ 12** |

24.5 + 12 = 36.5 pw of tasks, plus a 14-day reserve (≈ 3 pw) as 0162 kept, gives **≈ 40 pw as the centre**, and **45–55 as the honest range**: M3's table day count grew ×1.67 once, and revision 4 still had the reserve used in the build log. The editor is the least certain line: 0162 priced its editor at 4 and 0166's is 7.5, and a segment view with waveforms, grids, drag and zoom is not a form. I would keep the table-day approach (as 0162 did) and not accept any figure before the technical design.

Calibration notes. Agent wall time in 0162 was ≈ 6.4 agent-minutes per table day (build log pilot), so wall-clock is not the constraint; **review and the listening pass are**, and they are the owner's time. Price the owner's listening pass as elapsed time, not effort.

Testing and tooling the record should require: (a) a golden for each seam type (cut, crossfade, bridge) comparing against an offline-rendered reference at sample level (streams-align already has the method); (b) a metered scene per cost row, gated like M3's; (c) a deterministic beat-clock test with a fake `ClockMap` and a recorded jitter trace instead of a live-timing test; (d) Playwright e2e with the sample, using the debug panel's late-start counter as the pass criterion.

## Cheaper alternatives

- **Drop `while` regions in M4.** Counted loops cover most scores; a conditional loop is the one place the core must decide, which breaks "main predicts".
- **Defer the equal-power table and the S-curve:** ship linear and one polynomial curve; save ≈ 0.5 pw and a wasm-size cost.
- **Fallback as "segments play, no beat callbacks"** (≈ 0.3 pw instead of 1), since Babylon has no sample clock to predict from.
- **Rhythm mode as docs plus `Audio.timeAt` plus `Calibration.fromTaps`,** with no new sample scene beyond the calibration screen (saves ≈ 0.5 pw).

## Questions for the author

1. Are cue and tempo positions seconds or sample frames, and what resolution does validation promise (issue 5)?
2. Do stamped PLAY and STOP get an in-voice start offset, or does the record accept one split per transition (issue 7)?
3. Is the music pool an ABI 2.1 bump, and who counts a slipped start (issue 9)?
4. What is the minimum latency of a quantised change in the worst case (horizon + prime), and is it documented for designers?
5. How does a `while` region interact with prediction (one STATUS interval of error)?
6. What are the node ids rules refer to (issue 3), and is a duplicate `from`/`to` pair an error or a warning?
7. Where does the per-device calibration persist?
