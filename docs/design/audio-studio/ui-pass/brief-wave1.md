# UI pass, wave 1 (broken items): shared brief

Base: `abb31151` on `ccr-8460d665-umr8or`. First check HEAD is abb31151 or a descendant; if not,
`git checkout -b <your branch> abb31151`.

Context: the owner said the Studio "barely followed" their prototype, left out components and styles, and that the
designed workflows weren't validated. Seven auditors compared the rendered prototype and the owner's spec
(`docs/design/audio-studio/owner-spec.md`) against the real Studio. Their gaps files are in
`/tmp/claude-0/-home-user-TranquilityEngine/e6b33545-4057-5445-a314-ce7b95763852/scratchpad/audit/<screen>-gaps.md`
with paired screenshots (prototype `audit/<screen>/NNN-*.png`, Studio `audit/<screen>/real/*.png`; Read them).
Owner decisions for this pass: `docs/design/audio-studio/ui-pass/decisions.md` (requirements).
Ground rules: `docs/design/audio-studio/ground-rules.md` and CLAUDE.md (tests through public interfaces, no
test-only exports, never bypass interfaces into engine internals).

## This wave: fix the rows of severity "broken" in your gaps file(s) — behaviour, not restyling
- Fix each broken row's actual defect (logic, wiring, layout breakage such as overlap/clipping/overflow inside your
  screen's own files). Also do any decision-file item named in your task.
- Do NOT restyle or edit shared kit: `src/studio/components/**`, `src/studio/studio.css`, `src/studio/shell/**`,
  `src/editor/**`. If a broken row needs a shared change, write the exact change in your report instead (wave 2 owns
  the shared kit). Exception: a one-line bug fix in a shared file your row clearly needs — say so in the report.
- Each fix gets a unit test through the module's own interface (Vitest; stories where the repo has them) that FAILS
  without the fix: revert the source, run the test, see it fail, restore. Say in the report which you checked.
- Checks: `npm run typecheck` (always), `npx vitest related <changed files> --run`, and the guard tests by name:
  `src/plugins/boundary.test.ts` if it exists, `npx vitest run src/studio`. No Playwright, no dev servers on 3100/3101
  (the coordinator's), no full suite.
- Commit early and often on your branch. Shell hygiene: run from your worktree root with relative paths; write files
  with the edit tools; one command per call where possible.
- Don't edit coordinator files: docs/README.md, implementation-status.md, the decision log, build-log, package.json.
  Put suggested doc text in your report.
- Report: branch, commits, each broken row ID → fixed / not fixed (why), tests added (fail-before checked?), shared
  changes you need, and anything else you noticed.
