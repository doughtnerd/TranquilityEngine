# UI pass, wave 3 (per-screen fidelity): shared brief

Base: the tip of `ccr-8460d665-umr8or` (1e420173 or later). If your worktree HEAD is older, `git checkout -b <branch> ccr-8460d665-umr8or`
after `git fetch`/using the local branch.

Read first: `brief-wave1.md` (context, test rules, shell hygiene — all apply), `brief-wave2.md` (prototype paths, the
running prototype server on :3101), `decisions.md` (owner decisions = requirements), `shared-requests.md` (wave-3
follow-ups at the end), and your screen's gaps file(s) in
`/tmp/claude-0/-home-user-TranquilityEngine/e6b33545-4057-5445-a314-ce7b95763852/scratchpad/audit/` with the prototype
inventory `<screen>-prototype.md` and paired screenshots. Owner's spec: `docs/design/audio-studio/owner-spec.md`.

The owner's words: "I worked hard to provide you with good looking UI and you barely followed it, you completely left
out many components and styles, made odd ui design choices, didn't validate all the workflows I designed". The bar is
the prototype: every component, style, state, menu, dialog and workflow in your inventory, built and working.

## Your job
Work through EVERY remaining row of your gaps file(s) — missing, wrong look, polish, and broken rows wave 1 left
open — plus the "wave 3 follow-ups" for your screen in shared-requests.md. Skip only rows that a decision in
decisions.md overrides (say which). Mark each row done/not done in your report.

## The kit is ready — use it, don't re-invent
Wave 2 shipped (read the source): Studio form controls (formControls.css, automatic), `NumberField`, `SliderField`
(typed box beside every slider), label scrubbing (installed globally), `Checkbox`, `ColourPicker`,
`src/editor/ui/InfoTip.tsx` + `Section hint` (§1.3: delete helper `<p>` paragraphs, move the sentence into a tip),
`KitDialog` (header band + ×, footer), `ContextMenu` (checked, note, submenu, group entries), `SegmentedControl`
(`look="fill"`), `EmptyState compact`, `TypeBadge` tones + placeholder, `Fader`/`Meter`/`Waveform`, `FloatingPortal`
(any floating UI), `Icon` set, `NewParameterDialog`, `contentFolders` (projectFolders.ts), `PlayerBar` slots,
`screenDock` arrangements. If the kit lacks something you need, add it in your own screen folder, or make a minimal,
backward-compatible addition to the kit file and say so in the report (other wave-3 agents edit other screens; kit
edits must not break them).

## Visual verification is required this wave
- Run your own Vite dev server from your worktree on YOUR port (given in your task) — `npx vite --port <port> --strictPort`
  — and drive the real Studio with Playwright (`require("playwright")`), screenshot at 1440x1000 deviceScaleFactor 1,
  and Read the png next to the prototype screenshot for the same state. Iterate until they match. Use the auditors'
  harness scripts for an editable project (fake folder picker: tests/e2e/fakeFolders.ts; examples in
  `scratchpad/audit/*-scripts/`, `scratchpad/seqwork/rh.cjs`, `scratchpad/audit/rl-lib.cjs`).
- Stop your dev server when done. Keep one browser per script run; 4-core machine shared with 5 other agents.
- This is not the e2e suite: don't run `npm run test:e2e`.
- Stories: run the play tests for your screen's stories and the kit stories you touch (config example:
  `scratchpad/w2kit/stories.config.mts`); fix failing ones in your area (known failing: Spatial — Inspector Sound
  Narrow, From Take No Takes, Keys Under The Pointer, Add Two D Sound; Playlists — Blend 1D Region).
- Unit tests for behaviour, failing before the fix, as before. Typecheck always.

## Report
Branch, commits; a table of every gaps row → done / partly / not done (+why); screenshots pairs you compared
(paths); kit additions; doc text for implementation-status and the decision log; anything for the owner.
