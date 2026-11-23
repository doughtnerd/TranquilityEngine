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
