# Shared-kit changes requested by wave 1 (for wave 2)

## From Spatial (ui/w1-spatial)
- MoveToDialog.tsx / kit.css (SC7): optional itemName/title prop, title "Move “name” to"; `.kit-move-dialog h2` no
  caps (same `.panel h2` override issue as SC10); `.kit-move-search` input-bg/border/3px radius; `.kit-move-matches li`
  not monospace, 12px, 28px rows; search results always list the root "Top level" (searchFolders drops ""); current
  folder disabled, "here now"; single click on an allowed row moves (Enter kept).
- Player bar (PB1), studioComponents.css: right column `minmax(min-content, 1fr)`; `.studio-player-status{flex:1 1 auto}`;
  `.studio-player-right > :not(.studio-player-status){flex:none}` so status text gives way and Hear as never clips.
- TypeBadge: accept a placeholder code ("—") for an empty sound chip (IN2, spec).
- General: `.panel h2` outranks screen dialog title classes (caps titles in dialogs); fix at the source.

## From Take/Profiler (ui/w1-take)
- G05 player bar: `.studio-player-status{flex:0 0 auto; width:210px; min-width:120px}` (ellipsis past that), shrink
  the "Hear as" label first; `title={props.status}` on the status span in PlayerBar.tsx. (Reconcile with PB1 above.)
- G70 dock defaults: let a screen give its own default layout — optional `defaults` on `screenDock(...)`
  (shell/studioPanels.ts → createLayoutStore({defaults})) or a `stack?: "below"` fact on StudioPanel. Needed for
  stacked side panels on every screen (prototype stacks; Profiler: At cursor over Voice; Mixer: Inspector over Game
  parameters, etc.).
- G31: move `.studio-span-held { background: var(--accent2-soft); border-left: none; }` into components/audioParts.css
  (take.css has a local override to remove).
- G03: global `input[type=search], input[type=text], input:not([type]), textarea` rule in editor.css with editor
  tokens; then remove local .tk-search/.pf-search/.tk-field rules.

## From Samples (ui/w1-samples)
- S-03 Calibrate… does nothing: `.studio-header{container: studio-header / inline-size}` makes the header the
  containing block for position:fixed children, so the calibration dialog is laid out inside the ~40px header. Render
  dialogs/popovers through a portal to document.body (AudioDeviceMenu → LatencyCalibrationDialog), or move the
  container to an inner wrapper. Same trap in `.studio-player` and `.smp-timeline > .panel-toolbar`; audit every
  fixed popover/dialog under a container-type element.
- S-10 status truncation: `.studio-player-status{flex:none; max-width:220px}`; grid `minmax(160px,1fr) minmax(240px,2fr)
  minmax(min-content,1fr)`; hide `.studio-hear-as-label` at `@container (max-width:1500px)`. (Reconcile with PB1/G05.)
- HistoryPopover.tsx: Icon undo/redo/history instead of "↶ ↷ History".
- Waveform.tsx: filled mirrored path, colour --badge-text at .5 (match prototype); redraw on height change too.
- Icon set: add `save` (Save uses `check` for now).
- Context menu: `.context-menu button{justify-content:space-between}` pushes labels right; menus should left-align
  labels with a right column for shortcuts/notes (Samples overrides locally with .smp-menu).

## From Playlists (ui/w1-playlists) — forwarded to W2-B (PlayerBar scrub row, editorFocus) and W2-A (ParameterPanel)

## Wave 3 follow-ups noted
- Nested playlist audition doesn't apply parents' playlist effects (auditionSource.ts).
- Engine lint `overlappingSyncLoops` still fires for parallel stems (decision 4); UI ignores it. Align the lint
  (src/engine/audio/playlist/lint.ts) and the Sound Lab tests.
- Playlists header Undo/Redo/History buttons (H3 rest); Blend 2D Nodes list; Parameters live marker on lanes.
- Mixer: MX-23 strip right-click menu; snapshot folder renames into History labels; extraFolders not in undo.
- Load-sensitive test recurring 3×: src/studio/encoding/encoding.test.ts "encode a planned sound once…" — investigate.

## Wave 4 follow-ups (from wave 3 Mixer and Sequence)
- Amp envelope on clips: the Studio offers it and draws handles, but `clipEffects` parsing flags `envelope` ("no
  submix runs it") and the runtime doesn't apply it on clips (ADR 0345 lists it). Implement in format + runtime.
- Reverse: runtime plays reversed clips forward (warning in sequence.ts).
- Marker colour and note (sequence I22) need format fields. Saved custom colours live in localStorage; no project
  palette store.
- Sequence L4 point marquee, L5 Latch/Read write modes, L6 sequence-level lanes (spec [Planned]).
- Player bar: Play label names what will play (sequence W-2).
- Mixer MX-30 EffectCard summary, MX-31 Add effect caption (+Formant/Pitch on buses per 0345), MX-33 DuckRow
  "Ducked by" native select, MX-43 MoveToDialog leftovers, MX-63 per-project loudness targets + integrated over a take.
- Format additions needing an ADR: audio.json `snapshotFolders`, `Bus.colour`, parameter `type: bool|text`, condition
  ops `contains`/`starts`.
- Dev note: Vite's watcher misses edits with several servers (inotify); use CHOKIDAR_USEPOLLING=1.
