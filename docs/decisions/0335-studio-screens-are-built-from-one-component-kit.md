# 0335. Studio screens are built from one component kit: generic parts in the editor UI, audio parts in `src/studio/components/`

- **Status:** Proposed
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0025, 0116, 0145, 0174, 0219, 0235, 0278, 0327, 0332

## Context

The prototype's six screens each paste the same shell (about 120 lines of CSS and logic: header, device menu with
calibration, dock, player bar, status bar), and repeat the same parts with small differences: a folder tree with
context menu, Move-to dialog and a 10 s undo toast (Samples, Playlists, Mixer snapshots, Spatial scenes, Takes,
Captures); effect, send and ducking rows; parameter rows; faders and meters; a sound picker with type badges; time
rulers and lanes; four separate history implementations; two effect catalogues and two curve formats. Its tokens match
the engine's theme names, but it hard-codes colours (marker and range colours, filter-curve colours) and defines a few
tokens the engine lacks.

The engine already has many of these parts: `DockLayout`, `TreeView` (0278, which draws the hierarchy and asset
folders), `UndoTree`, `openPopover`, `ConfirmDialog`, settings and value controls, label drag on number fields
(`fieldDrag.ts`), `StatusBar`, `MenuBar`, Storybook with the editor theme (0219, 0235). The owner asked for shareable,
reusable components and no duplication across screens.

## Decision

We will build every Studio screen from one kit, putting each part where its users are.

**Generic parts go in the editor's UI** (`src/editor/ui/`, exported from the SDK where plugins may want them), used by
the scene editor and the Studio alike: the dock (`DockLayout`, with 0327's per-host store), `TreeView` (every Studio
tree: samples, playlists, snapshots, scenes, takes, captures), the curve editor (0332), `UndoTree` and a
`HistoryPopover` over `activeHistory`, `EmptyState`, `UndoToast`, `ContextMenu`, `MoveToDialog` (folder picker that
disables the current folder and its descendants), `SegmentedControl`, `Chip`, number fields with label scrubbing
(`fieldDrag.ts`, gaining timecode and Alt-fine steps), `ConfirmDialog`, `ColorField`, `KeyboardShortcutsDialog`.

**Audio parts go in `src/studio/components/`**, used by several Studio screens: `PlayerBar` (the "Layout A" frame
with slots), `AudioDeviceMenu` and `LatencyCalibrationDialog`, `StudioStatusBar`, `Fader` (horizontal and vertical,
with VCA tick), `Meter`, `EffectChain` and `EffectCard` (from the catalogue, 0331), `SendRow`, `DuckRow`,
`ParameterRow` and `ParameterPanel` (test values), `SoundPicker` (playlists and samples with type badges), `Waveform`
(peaks from the shared decoder worker), `TimeRuler` with `Playhead`, `ValueLane`, `SpanLane` (instances and voices),
`GainLanes`, `CausalChain`. A component used by one screen stays in that screen's folder until a second screen needs
it.

**Every component is a pure model plus a thin Preact view** with injected hosts (the audio editor's existing rule), has
a `*.stories.tsx` beside it (0219), and is tested through its model's interface.

**Navigation between screens** is a Studio router (`src/studio/shell/route.ts`): `open({ screen, asset, select })`,
reflected in the URL hash so the editor's handoff (0327) and a second window can open a screen on an asset. It replaces
the prototype's `myco.nav` hand-off.

**Theme.** Studio CSS uses the engine's tokens only. The colours the prototype hard-codes become tokens in
`src/editor/theme.ts` (derived per preset, so Appearance themes them): marker types (`--marker-exit`, `--marker-hit`,
`--marker-cue`, `--marker-note`), reserved ranges (`--range-trim`, `--range-loop`, `--range-pickup`, `--range-tail`)
and a series palette for curve lanes (`--series-1`…`--series-8`). The prototype's light-theme contrast tweaks are
proposed as token changes, not hard-coded.

**Keyboard.** One Studio keymap registry: global keys (screen switch Ctrl/⌘+1…6, F6 panel cycle, ? for the shortcut
list), screen keys and panel keys, with a per-user "single-key shortcuts" preference; Undo and Redo go through the
editor's `shortcuts.ts` routing.

## Alternatives considered

- **A separate Studio UI library** — duplicates parts the editor already has and drifts from its theme and undo.
- **Everything in the editor's UI** — audio-only parts (faders, effect cards) would grow the editor bundle for panels
  the editor no longer has.

## Consequences

**Positive**
- Each part is written once; the scene editor gains the curve editor, empty states and toasts.
- Storybook shows the whole kit in every theme.

**Negative / costs**
- Generalising `TreeView`, `fieldDrag.ts` and the dock costs some editor work up front.
- New theme tokens need values in every preset, high-contrast included.

## Deprecates

- Nothing directly; the editor audio panels' views are removed by 0327.

## Open questions

- None.

## References

- Prototype shell and shared parts (all Studio screens); `src/editor/ui/`, `src/editor/layout/`, `src/editor/theme.ts`,
  `src/editor/ui/fieldDrag.ts`, `.storybook/`.
