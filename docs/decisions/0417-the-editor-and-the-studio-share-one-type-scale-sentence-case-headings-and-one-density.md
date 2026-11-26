# 0417. The editor and the Studio share one type scale, sentence-case headings and one density

- **Status:** Proposed
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0025, 0116, 0219, 0349, 0361

## Context

A design review of the scene editor (`editor.html`, Flappy sample) and all eight Studio screens (`studio.html`, Sound
Lab sample) from screenshots in headless Chromium found that the palette and theme system (0025, 0116) hold up, but
typography, spacing and a few shared parts have drifted:

- **No type scale.** The editor and Studio CSS set `font-size` about 800 times with 17 distinct sizes, from 7 px to
  28 px. 104 of them are hard-coded `px` that ignore Settings > Appearance's UI size (`--ui-scale`). Body text is 11 px
  in some panels and 12 px in others; the UI font size setting defaults to 13 px, which almost nothing uses.
- **All caps everywhere.** `text-transform: uppercase` appears 71 times across 29 stylesheets: dock tabs, panel
  headings, Studio header tabs, section headings, asset-tile captions ("FOLDER", "JSON"), the status of a message.
  Small tracked capitals are harder to read than sentence case at 10–11 px, and the walkthrough already logged mixed
  heading styles ("PLAYBACK" beside "Parameters", `docs/design/audio-studio/ui-pass/journeys-walk-2.md` V9).
- **No spacing scale.** Paddings are written per rule (3, 4, 5, 6, 8, 10, 12 px…); row heights differ between the
  Hierarchy, the asset tree and the Studio trees.
- **Inconsistent shared parts.**
  - Empty states: `EmptyState` (0349) is used in 32 places, but at least 20 class names draw their own (`empty`,
    `sq-empty`, `pl-empty-box`, `smp-empty-card`…). Spatial's centre draws a centred card with a filled teal button,
    Playlists uses the kit's green outline positive button, Take a left-aligned title with a teal fill.
  - Button states: `button.active` (a solid accent fill with a glow) is used both for the current choice of a mode
    switch (2D/3D) and for on/off toggles (Preview, 2D Lights), so in the scene toolbar two toggles outshine the mode.
  - The Hierarchy fills every row with a background, so the tree reads as a stack of blocks instead of a list.
  - The Studio header's app mark renders as an empty teal square.
  - Layout faults: Spatial > Scene settings wraps its labels and loses its value column; the Take screen's mixer strips
    are clipped at the right with no sign they scroll.

## Decision

We will give both apps one type scale, sentence-case text, one spacing and density scale, and fix the shared parts,
keeping the Myco palette, the fonts offered in Settings and every screen's layout.

**Type scale.** Five size tokens in `editor.css`'s `:root`, all scaled by `--ui-scale`, so the Appearance UI size
keeps working:

| Token | Size at default scale | Use |
| --- | --- | --- |
| `--fs-xs` | 10 px | Type badges (CLP, SEQ), unit suffixes, tiny counts |
| `--fs-sm` | 11 px | Secondary text: row meta ("Loop · 1.3 s"), status bar, hints |
| `--fs-md` | 12 px | Body: rows, fields, buttons, menus, dock tabs, panel headings |
| `--fs-lg` | 14 px | Inspector titles, dialog titles |
| `--fs-xl` | 16 px | A full empty state's title, start screens' section titles |

Larger display sizes stay where they are (start screens, brand). Rules use `font-size: var(--fs-*)`; a `px` font size
that ignores `--ui-scale` is a bug. Weight carries hierarchy: 600 for headings and the active tab, 400 elsewhere.
Numbers in meters, faders and readouts use `font-variant-numeric: tabular-nums`.

**Sentence case.** Dock tabs, panel headings, section headings, Studio header tabs, menu group titles and captions are
written and shown in sentence case, with no letter-spacing. Capitals stay only where the text is a code: the playlist
type badges (CLP, QUE, SW, 1D, 2D, LAY, SEQ, 0349's ui-pass decision), key names and file extensions shown as badges.
This changes the look of the owner's Studio prototype, which draws tabs in capitals; the owner chose it on 2026-11-26.

**Spacing and density.** Spacing tokens `--sp-1`…`--sp-5` = 2, 4, 8, 12, 16 px and one list row height
`--row-h` = 24 px (× `--ui-scale`) for every tree and list (Hierarchy, Assets, the Studio trees). Coarse pointers keep
0361's larger targets.

**Shared parts.**
- **Empty states** go through `EmptyState` only; the ad-hoc classes are removed. Its full look stays as 0349 and the
  owner spec (§1.3, §3.9) define it: icon, title, one line, one primary action, drawn with the kit's positive button.
- **Choice vs toggle.** The current option of a segmented control or mode switch keeps the solid accent fill. An on/off
  toggle that is on (`aria-pressed="true"`) is drawn quietly: accent text and border on `--accent-faint`, no glow.
- **Lists** have no per-row fill: rows are transparent, with `--hover` on hover and `--selection` when selected; tags
  in a row use one neutral chip style unless the colour means something.
- **Studio mark** shows the Studio's brand mark (`src/editor/ui/brand/`), not an empty square.
- **Layout fixes** in Spatial > Scene settings (one label column and one value column, no wrapping at the dock's
  default width) and the Take mixer (a horizontal scroll with a fade at the clipped edge).

**Where it lives.** Tokens in `src/editor/ui/editor.css` (the Studio already loads it); no new theme keys, because
sizes and spacing are not per-preset. Storybook stories (0219) show the scale and the button states.

## Alternatives considered

- **Polish only, keep capitals and per-rule sizes** — fixes the visible faults but leaves 17 sizes and two heading
  styles to drift again; the owner chose the refresh.
- **A new visual identity (palette and typeface)** — a larger change that would override the owner's prototype and the
  three presets users already pick from; not asked for.
- **Size tokens as theme keys in `theme.ts`** — would let a theme change the scale, but no preset needs to, and the
  UI size setting already scales everything.

## Consequences

**Positive**
- One place to change sizes and spacing; the Appearance UI size reaches every label.
- Headings, tabs and buttons read the same in both apps; mode switches are easy to tell apart from toggles.

**Negative / costs**
- A broad CSS change (about 800 font sizes, 71 uppercase rules, 20 empty-state classes) touching most stylesheets;
  screenshots in e2e specs and visual baselines, if any, change.
- E2e specs that find text by its rendered capitals ("SAMPLES") must read the sentence-case text.
- The Studio looks different from the owner's prototype in casing.

## Deprecates

The ad-hoc empty-state classes (`empty`, `sq-empty`, `pl-empty-box`, `smp-empty-card`, …), removed as their panels
move to `EmptyState`. Hard-coded `px` font sizes and `text-transform: uppercase` outside code badges.

## Open questions

- Whether the scale should become a Storybook "foundations" page beside the theme presets.

## References

- Review screenshots: scene editor with Flappy; Studio Samples, Playlists, Mixer, Spatial, Take, Profiler with Sound Lab.
- `src/editor/ui/editor.css` (tokens), `src/editor/ui/kit.css` and `EmptyState.tsx` (0349), `src/studio/studio.css`.
- `docs/design/audio-studio/owner-spec.md` §1.3, §3.2, §3.9; `docs/design/audio-studio/ui-pass/journeys-walk-2.md` V9.
