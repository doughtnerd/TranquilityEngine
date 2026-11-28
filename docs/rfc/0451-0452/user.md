What I read: ADR 0452 and 0451 (fully), `docs/design/plugin-lanes-localisation/goal.md`, ADR 0411 and 0412 (fully), `capture/trigger.ts` (header and F9/F10 constants, lines 2-33), `src/player/main.ts:147-150`, `src/player/buildLaunch.ts:47-49`, `src/studio/screens/take/` and `profiler/` (file lists; `take/index.tsx` replay transport), `src/editor/playStats.ts` (counters and tables), `engine/localisation/t.ts` (tracker), `audio/runtime/localisation/languageState.ts` (head). Not read: the spikes, ADRs 0133-0144, 0348, 0376, 0403, 0408, 0416, 0417, 0356, animation debug code, `runtimeContext.ts`.

Persona: **Audio designer (AD)** and **gameplay developer (GD)**.

## Verdict

**Approve with changes.** The direction is right for us; two daily behaviours are left undefined.

Top 3 concerns:
1. **The look-back window is the feature we'll live in, and it has no length, storage, or "save the last N seconds" story.** It is an open question, but it decides whether live-then-Record is usable.
2. **The Take screen "goes live from connect" without saying what Replay does on a live window** (today it is inactive while recording, 0411 item 4).
3. **Disabling `myco.localisation` degrades silently to keys** in a game that ships.

## Issues

1. **major: look-back is undefined (0452 Open questions).** Today the Profiler follows a live capture from connect (0411 item 1). After: a bounded window, nothing saved until Record. If the window is 30 s, "that glitch two minutes ago" is gone. Add a stated default window, a visible "window covers 00:00 to now" indicator, and **Save last N seconds** as a Record variant. Without it we press Record earlier, which is what we do today.
2. **major: live Take view semantics.** 0411 deliberately kept the Take timeline growing only while recording (Alternatives: "stream the take live even when nothing records" was rejected). 0452 reverses it. Specify whether I can Replay a live window through my current project (the AD's main loop: tweak a playlist, replay the same moment). Today Replay is disabled while a recording runs (`take/index.tsx:176`, "Inactive while a recording runs"). If it stays disabled live, I still Record, Stop, then open it. Say so.
3. **major: record key regression in a build.** F10 is freed and there is one `capture` Export option. Today a build can hold a profile-only F9 capture (cheap) or an F10 take with requests and pictures (heavy). After: one key, one file, everything on. On a long session the file is always the heavy kind. Confirm which cap applies (64 MiB capture vs 256 MiB take, goal.md) and that the `take.frames` picture width (0411 item 5) still applies to captures.
4. **major: record key versus live ownership.** 0412 item 3: a Studio-started take is stopped by the next F10. State what F9 does when a tool is connected and already recording (stop it, ignore, toast "Studio owns this"), since take ownership (0417) moves into the engine.
5. **minor: Play Stats loses plugin counters during the move.** `registerPlayStatsCounter/Table` (`playStats.ts:91-118`) are removed outright. GD uses `myco.audio.underruns` daily. Require it to appear in the overlay unchanged at phase 1 exit, with a test.
6. **minor: Take and Profiler share one recording (0411 item 4, 0412 item 1).** 0452 doesn't restate the shared-view and shared-playhead guarantees. Add them to Consequences so the module split doesn't lose them (`recordingView.ts` and `reviewLink.ts` sit in the screens today, and the module boundary may cut them).
7. **minor: deep link "click a sound, open its playlist".** Today the Inspector's Open playlist and Open in Mixer work, including read-only against the mounted build audio (0411 item 7). Say that a read-only build-audio target still opens, and what happens in a takes folder with no project.
8. **minor (0451): localisation disabled.** `t(key)` shows the key and warns once, in a log we don't watch. Add an editor warning when a project has `*.strings.json` but the plugin is disabled, and the same in Export.

## Workflow today vs after

| Step | Today | After |
|---|---|---|
| Connect a build | Profiler follows live capture from connect; Take shows only while a take records, else "Record session" (0411) | Both screens stream from connect (0452). **Gain:** Take is no longer blank. |
| Watch live | Profiler live, Rejoin if the feed ends | Same, via the profiler module, over a bounded window. |
| Scroll back | Whole capture since connect (until the ring budget drops the oldest behind GAP records) | **Only the look-back window.** Loss if short. |
| Record a section | Record session pill, press again to save; build keys F9 (capture) and F10 (take) | Record controls the build's capture; one build key, F9 (touch: 3-finger hold). **Gain:** one concept. **Loss:** no light F9 versus heavy F10 choice. |
| Review | Open in either screen, both follow (0411 item 4) | Same file type, one kind of capture. "Take" wording disappears from the UI. |
| Replay through current project | Take screen Replay, against the open project's audio | Re-execution hook on audio's source. Same, if audio's requests are in every capture. |
| Click a sound, open its playlist | Inspector: Open playlist / Open in Mixer | Deep link on records that name a path. Same intent. |
| Play Stats | Overlay with counters and an Animation table | Overlay reading diagnostics; same numbers if the adapter holds. |

**AD:** my loop is *play, press Record at the moment, stop, tweak the playlist, Replay.* If live Replay works over the window, I skip Record entirely, a real speed-up. If it doesn't, nothing changes for me and I lose the "Take" name I know.

**GD:** the biggest win is one capture holding animation and core frames beside audio, with no separate F10 and no Export checkbox hunt (`audioCapture`, `audioTake`, `audioTakeFrames` become `capture`). Phase 1 adds no new data, so on day one I see core frames in the Profiler only as much as Play Stats shows them today. Set that expectation.

## What I'd miss

- **F10's heavy take as a deliberate choice.** I'd use F9 for a quick profile on a slow device and F10 when I need replay. One key means always paying for requests and pictures, which hurts on the phone later (goal.md answer 3, deferred) and on long soaks. Cheapest fix: keep one key, but let Record options (not Export) choose sources, as "later" already implies. Pull that forward if budgets bite.
- **Take pictures at a chosen width** (320 to 1280, 0411 item 5, 0412 item 2). 0452 doesn't mention them. If captures drop them we lose the visual cue that makes recordings reviewable.
- **A saved recording can't be opened while connected** (0411 negative). Not new, but the live view now also looks like a take, so the confusion grows. Offer a **Back to live** chip.
- **The word "take".** Retired on purpose and I'm fine with it, but the Take screen's name, the takes folder and notes (0408) all say it. Rename consistently or we get two vocabularies.
- **Localisation panel with the plugin off.** The panel and the `strings` asset kind vanish (0451). Consistent, but string tables in the project become invisible files. The Studio's Dialogue screens import the plugin directly, so the Studio keeps working while the editor does not. Surprising.
- **Subtitles gain a hard dependency** on `myco.localisation`: disabling localisation disables subtitles. The editor should say "required by subtitles" when I try.

## What I'd want next

1. **Save last N seconds** (retroactive capture) from the look-back window, one click or the record key held.
2. **Live Replay** of the window through the current project, so tweak and listen needs no Record.
3. **Per-record options** (sources, picture width) in the Record popover, with an estimated MB per minute shown before pressing.
4. **Notes and markers** (M key, `take/index.tsx:206`) surviving into every capture and shown in the profiler, so a bug report is "capture plus note".
5. **Animation views in the profiler** (listed as later). GD needs animation and audio on one timeline for lip-sync and footstep checks.
6. **A toast after Record naming sources and size** (the third open question: yes, please).
7. **Localisation:** a "strings missing because plugin disabled" diagnostic, and a pseudo-locale toggle that works without the panel.

## Cheaper alternatives

- Keep F10 and its Export option in phase 1 as an alias for "capture with requests" and fold them into one key later. Costs a flag, removes the regression in Issue 3.
- Skip "Take screen goes live" in phase 1; keep it recording-only. Cheaper, but loses the day-one gain.
- Look-back as an in-memory ring only (no temporary file) with a fixed default, since there are no outside users and phase 1 targets desktop.

## Questions for the author

1. What is the default look-back window, and is there a "save the window" action?
2. Does Replay work against the live window, or only a stopped capture?
3. Is audio's requests source always on in a capture (so Replay always works), and which cap applies?
4. What does F9 do while a connected tool is recording, and is the touch hold unchanged?
5. Do take pictures and their width setting survive onto captures?
6. With `myco.localisation` disabled, does Export warn, and are the Studio's Dialogue screens affected?
