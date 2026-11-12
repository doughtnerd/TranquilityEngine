**Verdict: approve with changes.** Top 3 concerns: (1) the "one stream, built for a link we are not building" premise buys ≈ 4 pw of codec and format before any user sees a profile; (2) the authored/runtime volume split and index-stable core are the costliest and riskiest part of live mixing, and a cheaper route reaches the owner's settled goal; (3) per-bus loudness and level-mode ducking are specified as one shape, but the data show a staged path (master first, ducking by bus-order fix) that defers most audio-thread and ABI risk.

Read: the record (all), goal.md, spikes/audio-mix/README.md, and the code at mixer.ts, Engine.ts, lookahead.ts, AudioDebugPanel.tsx, BusMeters.tsx, counters.rs, settings.ts. I did not open the sub-spike READMEs; I cite only their rows in the top README. Settled items (all four pieces in M5, keep edits after Stop, no live link, master plus picked buses with warn-only targets, own budget, size gates as tripwires) are not reopened. I note their cost where relevant.

## Cheaper alternatives

Savings are person-weeks (pw) against the record's table (31 pw of features, 50-65 pw with tests and reserve; the 1.4x test uplift and the reserve scale with features, so a feature pw saved is worth about 1.6-2 pw of total). They are my estimates, not measurements.

**A. Extend the debug panel with a history buffer instead of a new stream and Profiler panel.**
- Today the panel polls `Audio.debug()` every 250 ms and keeps no history (`AudioDebugPanel.tsx:15-21`). A ring of the last N debug snapshots (JSON-ish objects, 4 Hz) plus a scrub slider covers "pause, scrub, inspect a moment" for voices, buses and counters.
- Saves: the binary codec, keyframes and file format (≈ 4 pw), most of the 7 pw timeline UI (say 3-4 pw kept for a slimmer one). About 5-6 pw features, ≈ 9-11 pw total.
- Loses: 62.5 Hz fidelity (underruns and late commands between samples vanish), main-side event reason codes with timestamps on the audio clock, 6-7 minutes of history, and the capture file that exports record (settled scope item 2 needs *some* file). A snapshot dump to JSON at 4 Hz is far smaller than the spike's JSON figures, which assumed every STATUS block (8.4-49 MB per minute). At 4 Hz that is roughly 1/15 of the data, so about 0.5-3 MB per minute, and it compresses.
- **My take:** this is the strongest cheap option, but it fails the owner's "underruns and late commands" and "why" tracks unless the event log is kept. The middle path is below.

**A'. Middle path: record STATUS raw (the spike's 0.6-3.2 µs copy), skip the delta encoder and keyframe-index machinery.** The raw copy is 0.51-5.04 MB per minute in memory and compresses to 0.08-0.25 MB (README, capture row). Keyframes exist only to make jumping O(1); a 10-minute capture decodes in 0.24-0.83 s anyway, so scrub can decode fully on open. Saves ≈ 1.5-2 pw and the "encoder still allocates 370 B per block" problem disappears (a raw copy into a preallocated ring is trivial). Loses: instant seek on huge captures and the compact file. Both are within the owner's own open-time target (< 2 s).

**B. Meter loudness on master only.**
- Master costs 2.2 / 3.1 µs; 8 buses cost 10-21 / 25-45 µs (README, loudness rows). The audio-thread saving is tiny: M5's whole allowance is 0.015 ms typical.
- Saves: per-bus config and validation (the 8-bus cap, `loudness: true`), a tenth of the loudness pw (≈ 0.5-1 pw), the 28 B per bus STATUS growth, the gated-true-peak rule, 24 kB histograms per bus, and the metered-buses-on-low question (open question 7).
- Loses: the owner's settled "picked buses" (FMOD/Wwise parity). This is a cost note only. Deferred as a stage, not dropped: the wire carries a count, so a second bus later adds no wire change.

**C. Chromium DevTools' WebAudio panel or browser profilers instead of our own CPU figure.**
- Does not fit: the panel doesn't see our worklet's per-quantum cost, `playbackStats` counts underruns only, there is no `renderCapacity` in Chromium (README, CPU-clock row), and WebView on Android and Tauri's desktop WebViews don't offer it uniformly. Saves 1 pw and loses the figure in exports and on devices, which is where the owner wants it. **Not recommended.** The `Date.now` sum at 0.19 µs per quantum is already about as cheap as an alternative gets.

**D. Keep ducking voice-count based; fix bus ordering only.**
- The spike shows the real fault in presence mode is the one-quantum-late read, fixed by trigger-first edges "at no audio cost" (README, bus-order row). That alone is ≈ 0.5 pw inside M5-0.
- Saves: the core detector, rule format, level-mode UI and tests (≈ 2 pw features, ≈ 3-4 total) and the new commands and ABI surface.
- Loses: settled scope item 5 (signal-driven ducking), the user-visible reason for sidechain. Cost note only.
- **Real point:** the record bundles `mode: presence` and `level` into one rule and defaults to `level`. Presence needs no core work; level does. Ship presence with fixed order in M5-0 and level in M5c, so the ABI and the editor can be verified one at a time. This is staging, not removal.

**E. Keep main-thread ramps, but stamp them.**
- Today's one-frame ramps trail the curve by 18 ms at 60 fps and 35 ms at 30 fps with error at -38 to -49 dB rms and "no audible step" (README, fades row; `lookahead.ts:33-37`). Main can compute the target and a start frame and send one stamped ramp, as M4-0 did for voices, with the core only interpolating.
- That *is* the record's §6 for fades and snapshots; the cheaper part is **not moving ducking and automation into the core in the same milestone.** The saving is at most 1 pw. Note the owner asked for sample-accurate fades in the core, so I treat this as confirming the record, with one suggestion: the benefit is "exactness", not an audible fix, so say so, and let M5-0's golden re-record be the only gate.

**F. Skip the authored/runtime split: play-mode edits write project.json and reload the mixer.**
- `Engine.ts:184-187` already calls `mixer.configure` and `notifyAudioConfigured`, which has an `onAudioConfigured` subscriber in `src/engine/core/audioConfigure.ts`. A reconfigure on each edit exists as a hook.
- But `configure` clears the bus map and fades and resets every volume to the project's (`mixer.ts:80-84`), so script changes, snapshot state and fades die on each editor edit. Also a rebuilt core graph clicks (README, live-edit rows: slot shifts, re-parenting, mid-tree inserts and removed sends all click).
- Saves: authored/runtime multipliers (the part of the 6 pw that changes `Bus` semantics and samples, ≈ 1.5-2 pw) and possibly the index-stable BUS_CONFIG diff plus crossfades (≈ 2 pw).
- Loses: edits made mid-snapshot or mid-duck would pop and snap back. For faders and mutes (the common live move), it already works if configure keeps runtime state.
- **Cheapest credible version:** diff on main, apply *direct* class edits in place (the README says all apply in place), and for structural edits just reload with a short master duck (fade to silence 30 ms, apply, fade up). That is Unity's practical behaviour for structural changes. Saves ≈ 3 pw (≈ 5 total) and drops the crossfade class and the index-stable invariant. Loses: seamless structural edits, which the spike found click without crossfade. I judge "structural live edit with a 60 ms dip" acceptable for a design tool; the owner may not.
- Still needed regardless: Bus.volume's two meanings. One line: a script's `volume` multiplies; the editor writes the authored base. That is a rename, not a subsystem.

**G. Skip captures in exports; rely on `Audio.debug()` logging.**
- Saves ≈ 1.5 pw (record's row) plus the lazy recorder module, the export checkbox and per-platform saving. Settled scope item 2 puts it in. Cost note: the Android pull is itself an open question (open question 3) and may need a plugin and its own record.
- Cheapest valid form: a debug-build only recorder, no export option, no release availability. The record already asks (open questions 1, 2); recommend "API only, behind the debug flag" to drop the touch gesture and release-build policy.

**H. AnalyserNode for meters on the Babylon path.**
- It gives peak and RMS and a time-domain buffer; it cannot give BS.1770 K-weighted LUFS or true peak without our own filters. The record already marks Babylon loudness unavailable (§9). Zero saving and no gain. Skip.

**I. Drop the Mixer panel; live-edit through Project Settings > Audio.**
- `AudioSettingsSection.tsx` (798 lines) already edits buses, effects, snapshots and ducking as undoable edits, and `BusMeters.tsx` already draws per-bus bars in it during Play (`BusMeters.tsx:20-25`). What is missing is only the push to the running mixer (F) and a loudness readout.
- Saves most of the "Mixer panel (faders, mute, solo, meters, loudness, snapshot buttons)" share of the 6 pw: ≈ 2-3 pw (≈ 4-5 total).
- Loses: a mixing-desk view (all faders in one strip, solo/mute at a glance, snapshot buttons). Wwise and FMOD have one, so industry practice is against dropping it, and open question 5 already asks the owner for scope. **Recommend the small version:** a strip with fader, mute, solo, meter and snapshot buttons only, built by reusing `BusMeters`, not a new panel with effect editing.

**Summed.** A' plus F's cheap form plus I's small panel plus D's staging come to ≈ 8-10 pw features (≈ 13-17 total) with every settled scope item still present. A, B, G go further but cut into settled items.

## When the premise is wrong

The record's premise is: a new binary stream, the Profiler panel and the core-resident mix are all needed; the stream format is chosen "so the link is a transport, not a redesign"; and the authored/runtime split plus index-stable routing are the right foundation for live mixing. Each is wrong under testable conditions:

1. **The stream is over-built if a 4 Hz snapshot ring answers the questions designers ask.** Test: give three sound designers five real "why does this sound wrong" tasks (a stolen voice, a duck that stays on, an underrun, a late command, a clipping bus) with only a 4 Hz ring of `Audio.debug()` plus the existing event log. If at least four of the five are answerable, the codec, keyframes and 62.5 Hz recording are unjustified. If underruns and late commands between 250 ms samples are needed (they are counters in STATUS, `counters.rs:424-425` region), keep raw STATUS only.
2. **The "link is a transport" argument is unverified and costs now.** The record has no spike for a socket, no framing and no back-pressure design (the README doesn't test a live reader at all). If the first real link needs a different framing (chunked, lossy, partial), the format will change anyway. Test: before accepting §1, write the framing for a `ws://` reader against the format on paper. If it needs fields the file doesn't have (sequence numbers, drop markers, a resync point), the premise is wrong and the format should be file-first.
3. **Presence-vs-level ducking is a real change only where order or loudness differ.** If every rule in the samples works after the trigger-first sort (the README says it does for every rule in sound-lab and stress), then level mode serves a *future* need. Test: ask the owner for one shipped-game case that presence plus fixed order cannot do (music ducks for quiet dialogue). If none exists, level mode can follow the first user.
4. **The 18-38 ms lag is not heard.** The README says "no audible step" and error at -38 to -49 dB rms. Test: an ABX of today's ramp against a stamped one on a snapshot fade at 30 fps. If listeners can't tell, §6's value is architectural (a shared core clock), not audible, and the 4 pw M5-0 should be justified on the live-edit and ducking work it unblocks, not on lag.
5. **The authored/runtime split is wrong if scripts rarely write `Bus.volume`.** Grep the samples: if none do (I did not run the search; the brief forbids builds, not greps, so the author should), a rename and a clamp suffice, and the split's real cost (two values, UI to show them, open question 8's "do faders show runtime changes?") is unpaid for.
6. **Index-stable routing is wrong if designers mostly move faders.** If over 90% of play-mode edits in a pilot are volume, mute, solo, filter and send levels (all "direct", all clean in the README), the structural classes, crossfades and diff-based BUS_CONFIG are a long tail that can be a 60 ms dip until asked for.
7. **The loudness cost allowance is wrong in the other direction.** It is sized from a 4-vCPU container and a null sink. The README itself says high is already over 1.3 ms p99.9 on the lab VM, and loudness adds 20 KB. If on the Pixel 8 profile loudness exceeds ~3% of a quantum, "meter on low" (open question 7) stops being optional and the per-bus choice needs a visible cost in the UI.
8. **The CPU figure is a 256 ms average.** If a profiler user chases a 20 ms stall, a smoothed figure hides it. The record then needs the underruns track and `minSlackFrames` (already counted) to be the headline, with `loadPermille` secondary. Test: replay the F-37 start-up click through the profiler. If the `loadPermille` line is flat while the click happens, the figure is decoration there.
9. **The effort estimate's premise (×1.67 and +40% tests, then a quarter to a third reserve) double-counts the UI.** Seven pw for the Profiler panel plus 6 for live mixing is front-loaded on UI, which the record itself says is "the largest part". If editor UI is built on existing components (`BusMeters`, the debug rows module `audioDebugRows`), the uplift for tests is closer to 25%. Track the first two waves' actuals against the table; if the Profiler panel's first usable version exceeds 4 pw, cut to option A'.

## Questions for the author

1. Which of the five designer tasks in condition 1 can the raw-STATUS-only recorder (A') not answer? If none, why is the delta encoder in scope?
2. Is there any sample script that sets `Bus.volume` or `fadeTo`? If not, why the two-value split now?
3. Can M5-0 ship presence-mode with the sorted bus order as a self-contained gate, with level mode landing in M5c?
4. What is the pilot evidence for the share of structural versus direct play-mode edits?
5. Which Android release-build capture route does the owner prefer if the share-sheet plugin is out? Saving to app data with no way to read it is a silent feature.
