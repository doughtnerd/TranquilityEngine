What I read: ADR 0452, 0451, 0411, 0412 (fully); the Decision sections of 0348, 0408, 0416, 0417 and 0356; `docs/design/plugin-lanes-localisation/goal.md`; `spikes/player-chunks/README.md` (tables on the take chunk, capture and localisation share); `capture/trigger.ts` lines 2-33; `src/player/main.ts:147-150`; `buildLaunch.ts:47-49`; `take/index.tsx` (replay transport); `playStats.ts:91-118`; `engine/localisation/t.ts`; `languageState.ts` (head). Not read: `spikes/studio-editor-halves/`, ADR 0133-0144, 0376, 0403, `runtimeContext.ts`, animation debug code.

Persona: **Audio designer (AD)** and **gameplay developer (GD)**.

## Verdict

**Approve with changes.** One capture concept helps us. Two daily behaviours stay undefined.

Top 3 concerns:
1. The look-back window has no length, storage, or "save the last N seconds".
2. The live Take screen doesn't say whether Replay works on a live window.
3. Merging F9 and F10 changes what every build records and loads (cost, caps, pictures).

## Issues

1. **major: look-back undefined (0452 Open questions).** Today the Profiler follows a live capture from connect (0411 item 1) over the capture's bounded ring (0348: oldest dropped behind GAP). After, a window with nothing saved until Record. Add a default length, a visible "covers 00:00 to now" indicator, and **Save last N seconds**.
2. **major: live Take view and Replay.** 0411 rejected streaming a take when nothing records. 0452 reverses it (amends item 1). Replay is disabled while a recording runs (`take/index.tsx:176`). State whether live Replay is in scope, or only after Stop.
3. **major: F9/F10 merge changes the record.** 0348: a take is a capture plus requests; requests are never dropped, the take cap is 256 MiB (capture 64 MiB, goal.md), pictures are optional (`audioTakeFrames`, once a second, 0411 item 5 width). 0452 says "today's caps" and one `capture` option without saying which cap, whether requests are always on, or whether pictures survive. Also cost: the spike shows the take chunk is 227.7 kB / 76.4 kB gzip (shared with audio runtime) and F9 capture alone avoids it (`player-chunks/README.md`, "take" rows). Name the cap, say requests are always recorded or optional, and say whether the single trigger loads the take chunk.
4. **minor: F9 while a tool owns the recording.** Answered by precedent: 0408 item 6 and 0417 (take ownership): while a tool holds the subscription, the build's key stops the take and does not save it for the player, and the Studio decides where it is saved. 0452 says only that Record "controls the build's capture". Cite 0408 item 6 and 0417 and say the same rule holds for F9 and the touch hold. (My earlier "unspecified" was too strong.)
5. **minor: Play Stats counters.** `registerPlayStatsCounter/Table` (`playStats.ts:91-118`) are removed. Require `myco.audio.underruns` and the Animation table to show unchanged at phase 1 exit, with a test.
6. **minor: Take and Profiler share one recording and view.** 0411 item 4 and 0412 item 1 (`recordingView.ts`, `reviewLink.ts`). 0452 doesn't restate it; add it to Consequences so the module boundary keeps it.
7. **minor: deep link target.** Inspector Open playlist and Open in Mixer work read-only against the mounted build audio (0411 item 7). Say the profiler's "open an asset" keeps that, including in a takes folder with no project (0408 item 2).
8. **minor (0451): plugin disabled.** 0356 line 187 and 0451 agree: a missing key returns the key and warns once. 0356 also provides `Locale.debug()` (last 64 missing keys, "for the profiler and tests", line 306). Ask that this survives the move so the profiler can show missing keys, instead of a warning only in a log. Add an Export and editor warning when a project has `*.strings.json` but the plugin is disabled.

Dropped after reading: "where recordings go" (0408 item 3 already says takes folder, project `takes/`, browser asks per take; 0452 keeps "where the tool keeps recordings (0408)"); "editor records nothing" (0416, 0452 already notes it unchanged).

## Workflow today vs after

| Step | Today | After |
|---|---|---|
| Connect | Profiler live from connect; Take blank until Record session (0411) | Both live from connect. **Gain:** Take not blank. |
| Watch live | Profiler live, Rejoin | Same, over a look-back window |
| Scroll back | Whole capture since connect, ring-bounded | **Only the window.** Loss if short |
| Record a section | Record session pill; build F9 (capture) or F10 (take) | Record controls the build capture; one key F9 (touch: 3-finger hold). **Gain:** one concept. **Loss:** light-versus-heavy choice |
| Review | Open in either screen, both follow | Same file, one kind. "Take" wording gone |
| Replay through current project | Take screen Replay (0348) | Re-execution hook on audio's source |
| Click sound, open playlist | Inspector buttons | Deep link on path records |
| Play Stats | Overlay with plugin counters | Overlay reading diagnostics |

**AD:** my loop is *play, Record at the moment, Stop, tweak the playlist, Replay.* If live Replay works over the window I skip Record. If not, nothing changes but the name.

**GD:** the win is one capture holding animation and core frames beside audio, and one Export option instead of `audioCapture`, `audioTake`, `audioTakeFrames`. Phase 1 adds no new data, so on day one the Profiler shows core frames no more than Play Stats does.

## What I'd miss

- **F10's choice of weight.** F9 for a quick profile on a slow device, F10 when I need replay. One key means always paying for whatever is on. Let Record options (not Export) choose sources; pull that forward if budgets bite.
- **Take pictures at a chosen width** (0411 item 5, 0412 item 2). 0452 is silent. Without them a recording loses its visual cue.
- **Opening a saved recording while connected** isn't possible (0411 negative). The live view now also looks like a take; add a **Back to live** chip.
- **The word "take".** Retired on purpose. The Take screen, takes folder and notes (0408) must be renamed together or we get two vocabularies.
- **Localisation panel and `strings` asset kind with the plugin off.** Tables become invisible files in the editor, while the Studio's Dialogue screens still import the plugin and work. Say this in 0451.
- **Subtitles depend hard on `myco.localisation`** (0451). The editor should say "required by subtitles" when I disable it.

## What I'd want next

1. **Save last N seconds** from the look-back window.
2. **Live Replay** of the window through the current project.
3. **Per-record options** (sources, picture width) with an estimated MB per minute shown before pressing.
4. **Markers and notes** (M key, `take/index.tsx:206`) in every capture.
5. **Animation views in the profiler** (later in 0452); GD needs animation and audio on one timeline.
6. **A toast after Record** naming sources and size (open question 3: yes).
7. **Missing-key view** in the profiler from `Locale.debug()`, working with the plugin disabled.

## Cheaper alternatives

- Keep F10 and its Export option in phase 1 as an alias for "capture with requests"; fold into one key later. Costs a flag and removes Issue 3.
- Keep the Take screen recording-only in phase 1; cheaper, loses the day-one gain.
- Look-back as an in-memory ring only with a fixed default (no outside users, desktop first).

## Questions for the author

1. What is the default look-back window, and is there a "save the window" action?
2. Does Replay work on a live window, or only after Stop?
3. Which cap applies to a capture, are requests always recorded, and do pictures survive?
4. Does the single trigger load the 227 kB take chunk in every debug build?
5. Is `Locale.debug()` kept for the profiler with the plugin disabled?
