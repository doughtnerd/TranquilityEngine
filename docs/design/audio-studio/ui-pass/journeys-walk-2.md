# Workflow Trials, second walk: the real Studio after UI-pass waves 1–4

Studio: http://localhost:3100/studio.html (HEAD dda6effd, plus whatever Vite served during the walk; no reloads happened mid-step).
Chromium 1440×1000, DPR 1. Real screenshots: `scratchpad/audit2/shots/a…png`. Prototype screenshots: `scratchpad/audit/shell/NNN-…png`
(numbering from `audit/shell-prototype.md` Part 2). The previous real walk is `audit/shell-gaps.md` Part 2.

**How I walked it.** I used one persistent Chromium profile (`audit2/profile`) with `showDirectoryPicker` serving an OPFS folder,
so the project carried over from one script run to the next. Start screen → **New Project…** → "Hover Racer" (Empty 2D) → a genuinely
empty project. Import samples… → Choose a folder… brought in 15 real WAVs from `samples/sound-lab` and `samples/pirates` as a GameSFX
tree (Footsteps/Wood ×3, Footsteps/Metal ×3, HoverBike/Engine low/high loops, HoverBike/Brakes/brake_skid, Music/Canyon ×2,
Ambience ×2, Impacts, UI). Then J1 to J11 in order on that one project.

**Take and capture files.** `audit/tpfiles/canyon_run_03.mycotake` no longer opens. It was recorded with audio ABI 6.0 and this build
is ABI 6.1 (`wireMismatch`). So I recorded a fresh take and capture in the editor: a Sound Lab copy, Record take + Record capture on
the Play toolbar, keys 1–6 and the E page. Script `audit2/s/rec.cjs`, files `audit2/rec/`. I opened them in the Studio with
Open take file… / Open capture file….

**Console.** No console errors and no page errors in any run (every script logs them).

Scripts: `audit2/s/r00…r79.cjs` (library `audit2/lib.cjs`).

## Results: 42 works · 5 partly · 1 fails (48 steps)

The previous walk had 34 works, 12 partly and 2 fails. These are now fixed: J6.3 (the hold), J9.3 (occlusion), J9.1 (picking with the
mouse), J4.1, J5.1 and J6.5 (global parameters offered everywhere, plus "+ New parameter…"), J9.2 ("Make it 3D" inline), J2.7
(Ctrl+S saves) and J8.5 (the live board, and "while the game runs" through take replay). J10.4's deep link now selects the bus.

| Step | Result | Real (audit2/shots) | Prototype (audit/shell) | What happened / what's wrong |
|---|---|---|---|---|
| J1.1 Samples empty state | **works** | a003 | 110 | Centred dashed card "No samples yet" + **Import samples…**, docks hidden, focus on the button (no visible focus ring, unlike the prototype). The player bar still shows Selection ▾, a grey ▶, Source and A/B with nothing to play. |
| J1.2 Playlists empty state | **works** | a004 | 112 | Matches the prototype: panel line, Library "Go to Samples", centre "No playlists yet" + paragraph + warning line + New playlist / New sequence / New folder. |
| J1.3 Mixer: only Master, offer a bus | **partly** | a005 | 220 | A new project still ships **Music, SFX, UI and Voice** buses besides Master (spec §9: Master only). It also shows "Live board 2/8 pinned" and "Beds 1/2" on an empty project. New bus (+) is there. |
| J1.4 Spatial: listener + offer emitter | **works** | a006, a120 | 230 | "No test scenes yet" + New test scene; the new scene has Player 1 and the tool rail. |
| J1.5 Take: no runs, how to record | **partly** | a007 | – | The centre says "Open a take from the Takes panel" with no button. *How to record* sits only in the ⓘ tooltip of "No takes yet". The Studio can't record a take (owner decision, see J10.1). |
| J1.6 Profiler: no captures, how to start | **works** | a008 | – | The centre explains "record one here while a playlist or a take plays, or … F9". The player bar's Record is an unlabelled grey dot (see V12). |
| J2.1 Import a folder keeping structure | **works** | a010 → a011 → a012 | 111, 113–116 | Review dialog "Import audio · 15 files" (styled now) → tree kept (GameSFX/Ambience, Footsteps/Metal…) → status "Imported 15 samples into the project." Still differs: the first step is a two-button dialog (Choose files… / Choose a folder…), not the prototype's checkbox file tree. It opens engine_low_loop.wav, not the first file. No toast. |
| J2.2 Review what each WAV brought in | **works** | a013, a014, a015 | 117–119 | "cues" chips with the tooltip "Read from the WAV: 1 loop · root…", Outline "file" chips, Root note popover (From file, Detect, Revert to file), the v1 source menu. |
| J2.3 Trim the engine loop, loop + crossfade | **works** | a016, a017 | 120–122 | Trim start/end and Loop start/end timecodes plus Crossfade 30 ms. "From file · smpl loop 1 · 2 changed" with per-row revert. Undo "Edit loop 1". See V3 and V4. |
| J2.4 Markers (event + note) on brake skid | **works** | a019, a020 | 123, 124 | Add marker → Type **Cue** (the name field becomes "Cue name") "tyre_smoke" at 0.250; second marker Note "Squeal peak" at 0.600 with a note. The Type segmented control wraps onto two rows (V1). |
| J2.5 Tempo/meter on music, check Exits | **works** | a021, a022 | 125–127 | Tempo popover (BPM, Tap, meter, "Set by you", Detect, Clear); an Exit marker added at 2.0 s; Tail hatching after the Exit. The ruler stays in seconds after a tempo is set, where the prototype switches to bars. |
| J2.6 Normalize a quiet sample | **works** | a023, a024 | 128, 129 | NORMALIZE · −23.0 LUFS → Loudness, Target −16, Gain +7.0 dB; "Norm −16 LUFS" chip; Edits row "Normalize -16 LUFS → +7.0 dB · Toolbar", Cached. The sign is a hyphen-minus "-16" where everything else uses "−". |
| J2.7 Save, then search | **works** | a025, a025b, a026, a026b, a027 | 130–133 | **Ctrl+S now saves** ("Saved quiet_wind.wav."). Save ▾ → Save / Write to file… / Fork as new sample… → the chunk review → "Wrote … 1 cues …" ("1 cues" grammar, still). Search "step" gives flat results with folder paths. Bugs: **Write to file wipes the undo history** (undo/redo greyed afterwards, a027). The status bar "Saved" never changes to an unsaved state after an edit. |
| J3.1 One Clip playlist per take from Library | **works** | a041, a042 | 151–157 | Library right-click → "Create playlist from "step-wood-1"" → CLP playlist in GameSFX/Footsteps/Wood. Three toasts stack over the centre (a042). |
| J3.2 Queue (Random) with the takes | **works** | a043, a044, a045, a046 | 160–163 | New playlist enters rename mode **with the text selected** (fixed). Add… picker with filters. **Clicking a row replaces the pick even though every row shows a checkbox** ("1 picked" after three row clicks, a045); ticking the checkboxes does add up. Result: 3 linked entries, "Undo Add 3 entries". |
| J3.3 Avoid last + weights | **works** | a047 | 164 | Avoid last 2; weights 3 / 0.5 / 1 → 60 % / 20 % / 20 % (fractions allowed now). |
| J3.4 Trigger repeatedly | **works** | a048, a049 | 165, 166 | Picks 1, 2, 3, 1, 2, 3 (forced by avoid-last 2 of 3). Plays now and the NOW bars animate; Voices shows "0 playing · 6 triggers". |
| J4.1 Blend 1D by rpm | **works** | a051, a052, a053 | 170 | X select offers **"+ New parameter…"** → "A global parameter…" dialog (Name, Min, Max, Default) → rpm 0–8000 is selected and shows in Parameters. |
| J4.2 Low/high loops, shape crossfade | **works** | a054 | 171–173 | Entries are placed in pick order (low at 0, high at 8000 when low is ticked first); Crossfade/Layer, Linear/**Equal power**, glide 120 ms. The "▲ 8000" handle label is clipped at the right edge, and the table's column header reads "AT WEIGHT 0" (V7). |
| J4.3 Move rpm, hear the blend | **works** | a055, a056 | 174, 175 | rpm 800: low −0.5 dB / high −10 dB; 7500: low −12 / high −0.3; slider 4000: both −3 dB. |
| J5.1 Switch on Surface | **works** | a060, a061, a062 | 180 | By → "+ New parameter…" → Labels dialog → global Surface (Wood, Metal, Water). |
| J5.2 Assign an entry per label | **works** | a063, a064, a065 | 181–184 | Add… three entries, then each "<label> plays nothing" menu (an entry used by another label is marked "also Wood"). |
| J5.3 Change rule + test switching | **works** | a066, a067, a068, a069 | 185–187 | + Rule (To defaults to the first label, Wood: same as the prototype) → Water→Metal Cut; Water plays rain_loop, switching to Metal cuts to step-metal-1. **Rule edits are not undoable**: header Undo stays disabled after changing a rule select (verified in r79). The rule selects show no dropdown chevron (V8). |
| J6.1 Folder → playlist → Sequence | **works** | a070, a071, a072 | 190, 191 | ▾ → New folder creates "New Folder" **without rename mode** (focus drops to body; still the case). Rename comes from the context menu. Sequence mode starts empty ("No tracks. Drop a sample here, or add a track with +."), where the prototype starts with Audio 1 + Playlist 1 tracks. |
| J6.2 Drag brake skid onto the track | **works** | a073 | 192 | Drop creates a track named after the sequence ("Brake") + a clip at 1.5 s. The dropped clip **isn't selected** (the Inspector stays on the sequence). The header and Inspector still say "Sequence · 0 entries". The Library's search result row shows the path "GameSFX/HoverBike/Brak…" instead of the name. |
| J6.3 Loop While held; play, release | **works** (was fails) | a074, a075, a076, a077, a078 | 193–196 | brake_skid had no loop, so a round trip to Samples (Add loop, Ctrl+S) was needed. Then Active **While held**, Sync. Play from the start → "At 00:02.281: Brake loop pass 1", Inspector Parameters "held · Held", **Release** in the bar → plays out to 4.00 s ✔. The **Voices panel stays "Trigger to start capturing"** while the sequence plays (status bar Voices 1/128). |
| J6.4 Clip volume envelope | **works** | a079, a080 | 197, 198 | Double-click on the clip → "Volume" tag + points, "Undo Add volume envelope". **Right-clicking a clip opens the lane menu** (Paste here / Add marker here / Add hold point here), not a clip menu (Copy/Duplicate/Split/Delete/Open sample, as in the prototype). |
| J6.5 Low-pass, cutoff by a game parameter | **works** | a081–a086 | 199–203 | Add effect → Low-pass → Automate → the floating Curves window. **Driven by now offers the global rpm** (Clip time / rpm / + New parameter…). Defects: it opens on "Low-pass · On" rather than Cutoff; the title repeats the name ("Automation · brake_skid · brake_skid Brake"); dope-sheet labels "Low-pass · Cutoff" wrap into the next row; the selects' accessible names include every option ("Driven byClip timerpm+ New parameter…", from a label wrapping the select). |
| J6.6 Playlist clip on a Playlist track | **works** | a087, a088, a090, a091 | 204, 204a | Toolbar ▾ → Playlist track; pointer-drag "Footsteps wood" from the tree → QUE clip on "Playlist 1". The track name truncates to "P…" next to its "Playlist" badge, and the bus to "Sequ…". |
| J7.1 Music samples with tempo, loops, Exits | **works** | a092 | (125–127) | Both canyon samples: tempo 120, Exit at 2.0 s, Add loop; saved. |
| J7.2 Music Switch, one entry per state | **works** | a093 | 210 | New global Labels parameter "Game state" (Explore, Combat) from the By select. The "GAME STATE" column header wraps onto two lines. |
| J7.3 Rule that leaves at the next Exit | **works** | a094 | 210-j7-3 | When "Next Exit marker" → the fade shows **0.5 beats** (the old "300 beats" unit bug is fixed). |
| J7.4 Change state while playing, hear it wait | **works** | a095, a096, a097 | 211, 212 | Plays now shows a pending banner "Level music: Explore → Combat · at the next Exit marker · crossfade 0.5 beats" while explore keeps playing; combat starts at ~1.9 s and explore ends at 2.5 s ✔ (better than the prototype). |
| J8.1 Buses SFX › Vehicles, Ambience | **works** | a100, a101 | 220 | + New bus → child "New bus". No inline rename (rename goes through the Name field). Rows aren't alphabetical (Ambience after Voice). Live board grew to 3/8 by itself. |
| J8.2 Output bus of playlists/sequences | **works** | a102, a102b | 215–217 | Inspector ▸ PLAYBACK (collapsed by default) → Output select (flat: Inherit · Master, Master, Music, SFX, Vehicles…; no "SFX › Vehicles" path). The tree badge is a bare "→" with no bus name. "When full" and "Priority" labels are indented 8 px more than the other rows (V9). |
| J8.3 Levels, voice limit, bed priority | **works** | a103 | 221 | Vehicles −4 dB, Limit 32, Ambience Own · p128. Two inputs share the name "Vehicles level in dB" (Inspector and row); the Bed priority input has no accessible name. |
| J8.4 Snapshot Pause + ducking | **works** | a104, a105, a106 | 222–225 | New snapshot enters rename ✔ ("Pause"); Esc during that rename keeps a "New snapshot" instead of cancelling. Music → Ducking + → menu "Duck when this plays" → Voice → On, Ducked by, When, Duck by, Attack, Release. The bus context menu carries a stray item **"Undo New snapshot · New snapshot"** (a107). |
| J8.5 Pin buses, mix while the game runs | **works** (was partly) | a107, a108, a109, a110 | 226–228 | Right-click → Pin to live board → Live board 4/8 with strips. Open take → Game session pill → on the Mixer the bar reads "Take replay · plays through this mix · LIVE", header "Live", and Music −6 applies live. The live-board strips' dB fields are overlapped by the fader caps ("0.(", "-6.0" clipped; V10). |
| J9.1 Test scene + emitter playing the sequence | **works** (was partly) | a120, a121, a122, a123 | 230–234 | Emitter tool → click → Emitter 1; Sound picker → **mouse pick works** (SEQ Brake). **The picker popover stays open after the pick** (a123). |
| J9.2 Edit attenuation | **works** | a124, a125, a126 | 235 | "Brake plays flat (2D). **Make it 3D**" right in the emitter Inspector → Edit attenuation… → "Give it attenuation" (Create preset / Inline) → Distance curves window (Volume 8 keys, Low-pass, Reverb send, Spread; Min/Max, Listener now 20.2 m). That is three clicks where the prototype takes one. There is no "And by" row in the attenuation editor. |
| J9.3 Move listener; panning, elevation, occlusion | **works** (was partly) | a127, a128, a129, a130, a131, a132 | 236–238 | Distance 20.2 → 12.3 m on drag; raising the player 3 m shows "↓3 m"; Side view ✔. **Occlusion works**: a concrete box between listener and emitter gives "−30.0 dB · low-pass 800 Hz · concrete" (a131). Labels and floating toolbars overlap (V11). One listener drag panned the view instead of moving the listener (a130). |
| J10.1 Start a game session, record a take | **fails** (owner decision) | a140 | 240, 241 | No Record take in the Studio. Takes come only from the editor/game build (D71 owner answer 1: the pill drives take replay; no live link this pass). |
| J10.2 Scrub the take, inspect an instance | **partly** | a141, a141b, a142 | 242 | First, the old take can't be read (ABI 6.0, wireMismatch). Then **after that failed take, clicking take_01 in the Takes tree keeps the stale red error and no timeline** (the URL stays on canyon_run_03, a141). Opening take_01 by URL works: instance lanes, game lanes; scrub to 7.3 s; footstep instance 5 → Inspector "Sound footstep · Instance 00:08.644 – end · Emitter None (flat) · Options volume 0.8 · pitch 1.03". One-shot instances draw as bars running to the end of the take. |
| J10.3 Capture, find a voice-limit/loudness warning | **works** | a143, a144, a145, a147, a148 | 245–247 | Open capture file… → Problems only → Messages "Master over the target (integrated)", "UI over the target…" with "Open in Mixer ›". **Recording in the Studio works** while a playlist auditions ("● Recording a new capture · 2.2 s" → capture_02 2.9 s). It doesn't work during a take replay of a foreign take: Record says "Nothing is playing" because 0 voices. The **Captures tree also lists the takes folder** (canyon_run_03, take_01). |
| J10.4 Fix in the Mixer, confirm in a new take | **partly** | a146 | 248 | "Open in Mixer ›" → `#/mixer?select=UI`, UI bus selected ✔ (fixed). A new take can't be recorded to confirm (J10.1). |
| J11.1 Re-import a changed WAV, review | **works** | a150, a151, a152 | 140, 141, 143 | v1 menu → Re-import… → Choose a file… → "brake_skid_v2.wav · 0.300 s (now 1.000 s)", Keep seconds / Scale → Re-import → toast "Re-imported as v2 · 2 items past the end · Undo", warning bar "2 items past the end of the source · Fit to source", ⚠ on Squeal peak. |
| J11.2 Undo the re-import from History | **partly** | a153, a154 | 142, 144, 145 | Right after opening the sample, the Sample toolbar's History shows **"No edits yet · Click into a document to see its history"** with an empty 300 px box, though the sample is open. After any click into the sample it lists every step (Re-import · v3 / Add Marker 3 / Re-import · v2 / …), and clicking "Add Marker 3" goes back to v2 (300 ms) ✔. A flat list, not a branching tree as in the prototype. |
| J11.3 Fork an edited sample | **works** | a155, a156, a157 | 146, 147 | Save ▾ → Fork as new sample… → Name, Folder (styled folder combo), "References brake_skid.wav and its 4 edits; no audio is copied", Follow / Pin → Fork → toast. In the tree it shows as **"brake_skid_fork.sample.json"** (extension exposed, sorted above the original). In the Library it shows as a path. |

## Defects to fix (ordered by impact), with likely source and a concrete fix

1. **Take: a stale error survives choosing another take** (J10.2, a141). After a take fails to open, clicking another take in the
   Takes tree leaves `tk-error` "Can't open takes/canyon_run_03…" and no timeline; the URL keeps the failed asset.
   *Source:* `src/studio/screens/take/index.tsx:262` (`s.kind === "failed"`) and the Takes tree selection handler.
   *Fix:* a tree click must navigate (`?asset=<path>`) and reset the load state to `loading` for the new path; key the load state on
   the path so a new path can never render an old failure.
2. **Switch change-rule edits aren't undoable** (J5.3, a067; r79). Header Undo stays disabled after any From/To/When/How change.
   *Source:* `src/studio/screens/playlists/SwitchView.tsx:156–161` (`onEdit("Change setting", …)` from the `SelectBox`es),
   `PlaylistHistoryScope.tsx`. *Fix:* route the rule edits through the same history-recording edit as entry edits (which do record,
   e.g. "Add 3 entries"), with labels such as "Change rule 1 To".
3. **Write to file wipes the undo history** (J2.7, a027). After Write to file both undo buttons grey out.
   *Source:* `src/studio/screens/samples/sampleWrites.ts` / `SaveSplitButton.tsx` (reloading the sidecar after the write).
   *Fix:* keep the document's history across the write; record "Write to file" as a history entry instead of resetting it.
4. **Sample History is empty right after opening a sample** (J11.2, a153 first run). *Source:* `TimelinePanel.tsx:392`
   (`<HistoryPopover none="No edits yet" />` uses the focused-document scope). *Fix:* bind the Sample toolbar's History to the open
   sample's sidecar (`<asset>.meta.json`), not to whichever document has focus. Size the popover to its content.
5. **Sound picker stays open after a pick** (J9.1, a123). *Source:* `src/studio/components/SoundPicker.tsx`. *Fix:* close the
   popover and return focus to the trigger after `onPick` (mouse and Enter).
6. **Clip context menu missing** (J6.4, a079). Right-clicking a clip shows the lane's menu. *Source:*
   `src/studio/screens/playlists/sequence/*` (lane `onContextMenu` fires before the clip's). *Fix:* the clip handles `contextmenu`
   (stopPropagation) with Copy / Paste / Duplicate / Split here / Disable / Delete / Open sample in Samples, as in prototype 197.
7. **Add picker: a row click replaces the pick while checkboxes are shown** (J3.2, a045). *Source:*
   `src/studio/screens/playlists/AddDialog.tsx` / `addDialogModel.ts`. *Fix:* a row click toggles that row (the checkbox is the
   affordance); keep Shift for ranges. Or drop the checkboxes if single-pick is meant.
8. **New items without inline rename**: playlist folders (J6.1, a070) and buses (J8.1, a100); focus drops to `<body>`.
   *Source:* `PlaylistTreeView.tsx` (New folder) and `src/studio/screens/mixer/BusesPanel.tsx` (New bus). *Fix:* start rename
   mode with the default text selected, as New playlist and New snapshot already do.
9. **Mixer bus context menu has a stray "Undo New snapshot · New snapshot" item** (J8.4, a107). *Source:*
   `src/studio/screens/mixer/mixerViewParts.tsx:74` (the undo entry is appended to the bus menu, and its label repeats the name).
   *Fix:* remove the undo entry from the row menu, or label it "Undo New snapshot" once.
10. **New project ships 4 buses + 2 pins + a bed** (J1.3, a005). *Source:* the new-project template's `audio.json` (Studio project
    creation). *Fix:* Master only, no pins, Beds 1/1 (spec §9), or record the deviation.
11. **Captures tree lists takes** (J10.3, a143). *Source:* `src/studio/screens/profiler/runFiles.ts` (the file filter). *Fix:* show
    only `captures/` (`.mycap`) and folders that hold them.
12. **Sequence counts "0 entries"** with clips on the timeline (J6.2/J6.6, a072, a091), in the header (`PlaylistEditor.tsx:174`)
    and the Inspector card. *Fix:* for a Sequence say "N clips · M tracks".
13. **The dropped clip isn't selected** (J6.2, a073). *Fix:* select the new clip so its Inspector (Loops, Markers) shows,
    as in prototype 193.
14. **The Voices panel ignores sequence playback** (J6.3, a077). *Fix:* the sequence player feeds `voiceLog.ts` like Trigger does.
15. **Automate Low-pass opens on "On"** (J6.5, a083). *Fix:* select the effect's first continuous parameter (Cutoff). Also
    de-duplicate the title "Automation · brake_skid · brake_skid".
16. **Library search rows and the fork show paths or file names** (J6.2 a073, J11.3 a157 / a156). *Source:* `LibraryList.tsx`,
    `SamplesPanel.tsx`. *Fix:* label = display name (no `.sample.json`); path as the meta line.
17. **Profiler Record during a take replay** (J10.3): blocked with "Nothing is playing" because the replay produced 0 voices.
    *Source:* `src/studio/screens/profiler/RecordButton.tsx:29`. *Fix:* allow Record while the game session (replay) runs, even at
    0 voices, or word it "The replay plays no sounds of this project".
18. **Take: one-shot instances drawn to the end of the take** (J10.2, a142: "Instance 00:08.644 – end"). *Fix:* end a one-shot
    instance at its last voice's end (or the clip length).
19. **The empty Take screen doesn't say how to record** (J1.5, a007). *Fix:* show the ⓘ text as the centre's one line ("Record a
    take with Record take on the editor's Play toolbar, or F10 in a game build"), plus Open take file….
20. **Mixer: the Esc of a new snapshot keeps it**, buses aren't alphabetical, the Output list is flat (J8.1/J8.2/J8.4). *Fix:* Esc
    cancels creation; sort children alphabetically; show the Output as "SFX › Vehicles" paths.
21. **Status bar "Saved" never changes** (J2.7). *Fix:* show "Unsaved changes" / "Saving…" from the project's dirty state.
22. **Grammar and copy**: "1 cues" (write toast, J2.7); "-16 LUFS" with a hyphen-minus (J2.6, toolbar tooltip and Edits row); the
    Write review row "Removes the smpl loops" on a file with none (a026); "At 00:00.000:" with a trailing colon and nothing after it
    (sequence footer, a072); "1 beat" snap shown with "No tempo" (a072).

## Visual defects seen along the way

| # | Where | Screenshot | Defect | Likely source → fix |
|---|---|---|---|---|
| V1 | Samples Inspector | a012, a019, a020 | Segmented controls wrap at 1440: Kind (One-shot/Loop/Sustain + **Music on a 2nd row**) and marker Type (Note/Exit/Entry + **Hit point/Cue on a 2nd row**). | `screens/samples/InspectorPanel.tsx`, `samples.css` → let the control go full width under its label, or shorten to icons with tooltips. |
| V2 | Samples Inspector, Encoding | a012, a024, a152 | Truncated controls: "From rules and the defau", "Decode o", table column "Ratio M…" cut at the panel edge. | `EncodingSection.tsx` → wrap the profile select onto its own row; let the table scroll horizontally or drop the Memory column at narrow widths. |
| V3 | Samples timeline | a017, a020 | The "MARKERS" label sits at y=144, 22 px below the marker flags at y=122. | `TimelinePanel.tsx` → align the gutter labels to their rows. |
| V4 | Samples readout row | a017, a020 | "Loop · 00:00.200–00:01.100 [-] outside the trim · silent" for a loop inside the trim (it describes the playhead), and "⚑ tyre_smoke" while Squeal peak is selected. | Readout in `TimelinePanel.tsx` → label which item each chip refers to ("Playhead: outside the trim"). |
| V5 | Outline | a017, a152 | The selected loop row's time runs to the panel edge; "Loo…" truncated by the hand glyph. | `OutlinePanel.tsx` → name min-width with ellipsis on the name, not the label. |
| V6 | Playlists Library | a042, a048 | Thumbnails carry a large ▶ overlay that covers the waveform; rows are 42 px tall (prototype rows are text-only). | `LibraryList.tsx`, `playlists.css` → a small play button on hover, a shorter waveform. |
| V7 | Blend view | a054 | "▲ 8000" handle label clipped at the right edge; column header "AT WEIGHT 0"; entries show icons in the At column instead of positions. | `BlendView.tsx` → inset the end labels; header "AT" + the per-entry rpm value field. |
| V8 | Switch view | a063, a067, a093 | Rule-row and "By" selects show no chevron (they look like text fields); a stray "···" under the toolbar (y≈152); "GAME STATE" header wraps. | `SwitchView.tsx`, `playlists.css` → use the shared `.kit-select` styling; remove the orphan glyph; `white-space:nowrap` on headers. |
| V9 | Playlists Inspector, Playback | a102 | "When full" and "Priority" labels indented 8 px more than Output/Plays/Cooldown. Section headers mix styles ("PLAYBACK" uppercase vs "Loops · 1", "Parameters" title case, a074 / a086). | `PlaylistInspector.tsx` → one row component; one heading style. |
| V10 | Mixer live board | a108, a110 | Strip dB fields overlapped by the fader cap ("0.(" / "-6.0" clipped); "Ambie…" truncated. Mixer Inspector "Mute" is a full-width "M" bar; Voice limit shows "None / Limit" *and* a "No limit" chip. Loudness panel's 60 s graph cut at the bottom. | `BusesPanel.tsx` (`.mx-board`), `mixer.css` → put the value under the fader track; a compact M toggle; drop the redundant chip. |
| V11 | Spatial plan | a129, a131 | The selected object's floating toolbar covers other labels ("Player 1 · listening", "Emitter 1 ↓3 m"); emitter and obstacle labels overlap. | `screens/spatial/*` → offset the toolbar above the selection's bounds and avoid labels; collide labels. |
| V12 | Profiler player bar | a008, a145 | Record is a lone 10 px grey dot with no label or ring, centred where the transport normally is. | `profiler/RecordButton.tsx` → the standard transport button with the record glyph and "Record" text. |
| V13 | Sequence | a072, a091 | Track names truncate to "P…" beside the "Playlist" badge and the bus to "Sequ…"; the inspector header is duplicated ("Sequence Brake" + "SEQ Brake Sequence · 0 entries"); the player bar badge "SQ" vs the tree "SEQ"; the Parameters rpm field shows "100(" (value clipped). | `playlists/sequence/*`, `PlaylistInspector.tsx` → widen the track header or move the badge; one header; badge code SEQ; field width ≥ 5 digits. |
| V14 | Automation curves window | a083 | Dope-sheet labels "Low-pass · Cutoff" / "Low-pass · Resonance" wrap into the next row. | Curve editor dope sheet CSS → single-line ellipsis with a tooltip. |
| V15 | Toasts | a042 | Three "Created … Undo" toasts stack over the centre. | Toast host → merge repeats ("Created 3 playlists · Undo") or cap at one visible. |
| V16 | Take timeline | a142 | Instance lanes overflow; the game-parameter lanes are off-screen below the instances; Inspector title "Instance 00:08.644 …" truncated. | `screens/take/*` → collapse a track's instances into one lane by default; wrap the inspector title. |

Not defects (checked): the −16.5 dB on the Voice bus in a106 came from my own script clicking a bus row's fader. Avoid-last 2 of 3
picking 1, 2, 3 in order is the correct behaviour.
