**Verdict: approve with changes.** Top 3 concerns: (1) the record has no way to compare or repeat a mix session (no per-session loudness reset in the editor, no A/B of snapshots or captures, no replay), (2) meters and loudness exist only on the first 32 buses and 8 metered ones, with no reading of what a script is doing to the mix, (3) a CPU figure averaged over 256 ms can't answer "what caused that click".

Read: BRIEF.md, ADR 0171, goal.md, spikes/audio-mix/README.md, and the editor files `BusMeters.tsx`, `AudioSettingsSection.tsx` and `AudioDebugPanel.tsx` (plus `mixer.ts` for solo and snapshots).

## Issues

1. **Major: solo is runtime-only and the record doesn't say what happens to it.** `BusSettings` has `mute` but no `solo` (`src/engine/audio/settings.ts:36-44`); solo is a field on the runtime bus (`mixer.ts:55`, `:87`). §5 lists "mute, solo (ramped)" among live edits that are "kept". Kept solo in `project.json` would ship a game with one bus soloed. Change: say solo is a session monitor state, never written to `project.json`, never counted in loudness targets' pass/fail, and shown in the Mixer panel as a banner ("Solo active: loudness readings are not the full mix"). Wwise's Mixing Desk does the same.
2. **Major: loudness is read from a solo/mute-altered mix with no warning.** Mute and solo change the integrated figure. Change: a meter that has seen a mute or solo since its last reset is flagged "tainted" in the panel and in `Bus.loudness`.
3. **Major: no reset or session control in the editor.** §4 gives scripts `reset`, and FMOD-style states, but the Mixer panel list (§5) has no reset, pause or "analyse from here" button, and no way to start a measurement at a marker. A 20-minute pass needs: reset on Play (default), a Pause button for menus and loading, a manual reset, and an elapsed-time readout. Change: add to the panel and make "reset on Play start" a project option, default on.
4. **Major: snapshots are one-at-a-time, with no priority or blending.** `mixer.ts:72` keeps a single `snapshotName`. Wwise states and FMOD snapshots stack by priority and blend (FMOD snapshot instances with intensity). Pause + Dialogue-focus + Low-health is the normal case on console. §6 only moves existing snapshots into the core; it doesn't say what two active snapshots do. Change: either state that stacking is out of M5 and what the Mixer panel shows when a script overlaps two, or add last-wins plus intensity (0..1) as the minimal form. I'd take the second; the stamped ramp already does the work.
5. **Major: profiler and meters show the mix the game made, but not why.** During a session I need "who is turning Music down right now": snapshot, ducking rule, parameter automation or a script. §5 separates authored from runtime values, but §3's tracks don't include per-bus gain contributions. Change: record per-bus authored, snapshot, duck, automation and script factors (five numbers) in the keyframe and at the cursor, and show them in the Mixer panel on hover. Without it the authored-vs-runtime split is invisible.
6. **Major: 32-bus meter cap vs 8-bus loudness cap.** Meters stop at the first 32 buses (`meters.rs`, goal.md table) and loudness at 8. Console projects with per-character dialogue buses and per-zone ambience pass 32. Change: state the 32 cap in the Mixer panel (a visible "not metered" state, not silence) and let the 8 loudness meters be chosen by name, not by tree order.
7. **Minor: the existing bus meters poll 50 ms and are peak only** (`BusMeters.tsx:10`, `:37-45`). Mixing needs peak hold, a clip latch that stays until clicked, RMS and the loudness readout in the same strip. §4 gives LUFS but the record doesn't say the strip shows it. Change: the Mixer panel's strip shows peak with hold, a clip latch, momentary and short-term LUFS (integrated on metered buses), with a reset on click.
8. **Minor: edits stay after Stop but undo granularity during a ride is unspecified.** Dragging a fader makes hundreds of edits. `AudioSettingsSection` commits on `onCommit` with a label (`:236`, `:292`), so a drag would be one edit only if the panel does the same. Change: a fader drag is one undo step, committed on release, and the heard value follows the drag.
9. **Minor: no way to compare "before my session" and "after".** Kept edits are good; losing the original mix is risky. Change: "Compare with Play start" (a button that swaps in the authored mix at Play start and back) in the Mixer panel. That's a snapshot of `audio` at Play start, not a new feature class.

## A mixing session

I start the game at a level, open the Mixer panel, and play for 20 minutes. What I need:

- **Faders for every bus with the meters beside them,** mute and solo, and the snapshot buttons. Open question 5's "faders, meters and snapshots only" is the minimum; effect editing inside the panel (Wwise's Mixing Desk does it) is a nice-to-have, since Project Settings > Audio still works live.
- **Loudness that I can trust.** Momentary and short-term shown large, integrated per metered bus, a target line (§4's `audio.loudness`) and a clear off-target mark. Over a 20-minute run integrated drifts; I must see it and reset it at the start of the real section. (Issues 2 and 3.)
- **A/B.** Compare the mix now with the mix at Play start, and with a snapshot (Issue 9; FMOD has no real A/B either, but Wwise Soundcaster state toggles give the same). Loudness-matched A/B is the usual trap, so show the integrated difference between A and B in LU.
- **Ride faders and keep the result.** The record's keep-after-Stop is what I want. Cost: I will mess up the project. Undo works per edit; the Compare button above is the safety net.
- **Mobile target.** Mobile is -18 LUFS and a different true-peak ceiling, while the same project ships to console. §4 has one `audio.loudness`. Change: allow targets per preset or per platform (a small table: console, mobile, with the editor's Play choosing one). Otherwise I edit the target by hand before each pass. This is the most likely thing I'd hit weekly.
- **Speaker sim.** Mixing for phones means listening through a phone-like curve. Not M5; roadmap.
- **Latency of my own move.** The spike left "main-to-worklet latency for a live edit" unmeasured. If a fader drag lags more than about 50 ms I won't trust my ears. Put a measured gate on it in M5c.

Settled items that hurt: "loudness warns, never adjusts" is right. "Live link is roadmap" hurts: mixing on a phone's speaker is half of mobile work. I accept it, but capture files then have to carry loudness (Issue below, profiling).

## A profiling session

Cases: "why isn't this sound playing", "why did the music drop out", "what is eating CPU".

- **Not playing.** The record's per-voice reasons (refused, queued, stolen by whom, virtual and why) answer this. Must-have: search a voice or event by name across the timeline and jump to its start or refusal, as Wwise's Advanced Profiler lets me filter by game object. Change: a name filter in the Profiler panel, in M5a, not later.
- **Music dropped out.** §1 records transitions, but the answer is usually one of: ducked by a rule, a snapshot, the bus's `maxVoices`, a steal, or the shedding ladder. The panel needs the per-bus gain factors (Issue 5) next to the voice table at the cursor.
- **CPU.** `loadPermille` is a 256 ms average (§2). A click at one quantum won't show; the underrun and late-command counters do. Say so in the panel. Per-section shares are modelled work units, not timings: label them "estimated share". I'd accept it; Wwise's own breakdown is also modelled for some categories. What I'd add: a **marker on underruns** that jumps the cursor to them (previous/next underrun), since those are what I hunt.
- **QA captures.** QA hands me a capture from a phone build. I need: open by drop, the device's preset and sample rate in the header (§1 has them), the **loudness readings in the capture** (state that STATUS carries them, §4 28 B per bus, so yes) and the project version, so I can tell if the capture's mix matches mine. Mismatch of project vs capture should warn, not refuse (only the wire hash refuses).
- **Capture recording from a script button.** Test builds with the key combination (§7) are right. Add a free-text note or marker (`Audio.capture.mark("boss start")`) that shows on the timeline; QA otherwise sends me 6 minutes with no landmark. Cheap, large payoff.
- **Replay.** FMOD's profiler can replay an API capture against the engine; Unreal Insights can't. Not asking for it in M5, but say it is a non-goal so QA doesn't expect it.

## What I'd miss from Wwise/FMOD

**Must-have for M5 (not in the record):**
1. Solo and mute handled as monitor state with a "tainted" loudness flag (Issues 1, 2).
2. Loudness reset, pause and elapsed time in the editor (Issue 3).
3. Per-platform loudness targets (mixing section).
4. Per-bus gain contribution at the cursor (Issue 5).
5. Capture markers and a previous/next underrun jump.

**Should have:**
- Snapshot intensity and stacking (Issue 4).
- Clip latch, peak hold, RMS (Issue 7).
- Loudness histogram and percentiles shown (FMOD offers 10th/95th and a histogram; the spike keeps the 24 kB histogram anyway, so showing it is nearly free).

**Nice-to-have, fine to leave:**
- **Voices Graph** (Wwise): the bus routing with live levels as a graph. The Mixer panel's tree covers 80% of it.
- **HDR audio.** Not M5; a ducking-like "loudest wins" system, large design. Say it's on no roadmap or on a roadmap.
- **Soundcaster:** auditioning events and parameters without the game. Large payoff for iteration speed. The audio plugin's event editor may already preview; if not, it is the next ask after M5. Mixing against real gameplay is what M5 provides, but a fast sound-to-hear loop for a single event matters for loudness matching of assets.
- **Compressor sidechain as an effect** (FMOD): M5's ducking rules cover music-under-dialogue. A sidechained compressor on any bus with any source is more general; leave it, but make sure `mode: level` has threshold, ratio-like amount, attack, release, and a detector choice (peak or RMS), and shows gain reduction on a meter. I'd like to see how much it is ducking; the gain-reduction meter is the cheapest way to tune it.
- **Loudness on any bus, not 8.** Fine.
- **Mixer snapshot priority/blend:** see above (should have).
- **Live link to a device:** settled.

## Cheaper alternatives

- The Compare-with-Play-start button (Issue 9) costs a copy of `audio` taken at Play, not a diff system.
- Per-platform targets are a small array in `audio.loudness`, no new engine code.
- Capture markers are one event record type in a stream that already has events.
- Skip effect editing in the Mixer panel (open question 5): Project Settings stays live.

## Questions for the author

1. Does a mute or solo reset or flag the integrated reading? What does `Bus.loudness.integrated` return while soloed?
2. Is solo ever written to `project.json`?
3. Can two snapshots be active, and what does the panel show when a script triggers a second one mid-fade?
4. How long from a fader move on main to the audible change, measured?
5. Is the loudness target one per project or one per preset or platform, given the mobile -18 against console -24 split in the record's own glossary?
6. Does a capture contain the loudness readings and the authored mix version, or only voices and levels?
