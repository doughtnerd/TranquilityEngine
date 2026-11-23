# UI pass, wave 2 (shared kit, chrome, journey blockers): shared brief

Base: `4a556526` (or a descendant) on `ccr-8460d665-umr8or`; if your worktree HEAD isn't, `git checkout -b <branch> 4a556526`.

Read first: `docs/design/audio-studio/ui-pass/brief-wave1.md` (context, test and shell rules — they all apply),
`ui-pass/decisions.md` (owner decisions = requirements), `ui-pass/shared-requests.md` (fixes wave 1 asked for),
and the audit at `/tmp/claude-0/-home-user-TranquilityEngine/e6b33545-4057-5445-a314-ce7b95763852/scratchpad/audit/`:
`shell-gaps.md` (chrome + journeys; the main source for this wave) and the other `*-gaps.md` rows that name shared
components. LOOK at the paired screenshots (prototype `audit/<x>/NNN-*.png` vs Studio `audit/<x>/real/*.png`) and the
prototype markup/CSS in `.../scratchpad/artifact-files/b2fc9617-dfc4-413a-9f6c-7044a526dccb/project/*.dc.html` for exact
sizes and tokens. The prototype renders at http://localhost:3101/project/<File>.dc.html (running; don't start
another). Owner's spec: `docs/design/audio-studio/owner-spec.md` (§1.3 principles, §3 shell).

The goal is visual and behavioural fidelity to the owner's prototype: match sizes, tokens, typography, states and
interactions — not "close enough". Use theme tokens (CLAUDE.md), never hard-coded colours.

Differences from wave 1:
- You own the files listed in your task; other wave-2 agents own theirs (listed below). Don't edit screen folders
  (src/studio/screens/**) except where your task says (minimal call-site changes for an API you changed — note them).
- Run the Storybook play tests for the stories of components you change (`npm run test:stories -- <file>` or Vitest
  browser mode; from a worktree you may need a config with `server.fs.allow` for the parent node_modules — see
  `/tmp/claude-0/-home-user-TranquilityEngine/e6b33545-4057-5445-a314-ce7b95763852/scratchpad/mx/stories.config.mts`).
  Add/adjust stories for new states. Still no Playwright e2e.
- Visual check: you MAY screenshot your components in Storybook/static pages with Playwright (`require("playwright")`)
  to compare against the prototype screenshots — not the e2e suite. Close browsers; 4-core machine.

Owners in this wave:
- W2-A kit: src/editor/ui/{SegmentedControl,PanelFields,ContextMenu,ConfirmDialog,MoveToDialog,Chip,EmptyState,
  RenameField}.tsx, src/editor/ui/kit.css (or wherever kit styles live), Studio-scoped form rules (new file
  src/studio/components/formControls.css or in audioParts.css), src/studio/components/{Fader,Meter,ParameterRow,
  ParameterPanel,TypeBadge,typeBadgeModel,Waveform,FadeShapeSelect,EffectCard,EffectChain,SendRow,DuckRow,GainLanes}
  and new shared components (NumberField with label scrubbing, SliderField, Checkbox, ColourPicker, InfoTip/hint,
  Toast if not shell).
- W2-B chrome: src/studio/shell/**, src/studio/studio.css, src/studio/components/{PlayerBar,StudioStatusBar,
  AudioDeviceMenu,LatencyCalibrationDialog,HearAsControl,ReplayControls,replayControls.css,Icon,studioIcons.css},
  the player-bar and header sections of studioComponents.css, src/editor/ui/HistoryPopover.tsx.
- W2-C journey blockers: src/studio/components/{SoundPicker,soundPickerModel}, src/studio/screens/spatial/**,
  parameter-choosing UIs outside src/studio/screens/playlists (playlists is busy until its wave-1 branch merges —
  write the playlists-side change in your report), new-project defaults, project-tree filters (where shared).
