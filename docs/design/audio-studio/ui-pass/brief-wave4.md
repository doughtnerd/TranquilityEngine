# UI pass, wave 4 (engine and format work behind the new UI): shared brief

Base: the tip of `ccr-8460d665-umr8or` (32154520 or later); if your worktree HEAD is older,
`git checkout -b <branch> ccr-8460d665-umr8or`.

Requirement source: ADR 0362 (`docs/decisions/0362-*.md`) — read it fully; your task names its items. Also read
`brief-wave1.md` (test rules, shell hygiene), `brief-wave3.md` (visual verification on your own dev server port, the
Vite watcher caveat: worktrees under `.claude/` aren't watched — restart the server or use a local config), CLAUDE.md
(public API rules, Babylon/Rapier never in the public API, size gates are tripwires: raise with a logged reason, wasm
rebuild rules for native/ crates — rebuild and commit generated output with the source), and the audio ground rules
`docs/design/audio-studio/ground-rules.md`.

Rules this wave:
- Engine behaviour gets unit tests through the public interface (and loopback/offline tests where the audio repo has
  them), each failing before the change. Rust changes get `cargo test` in their crate; rebuild wasm with
  `npm run build:audio` and commit the output; run the metered gate if your crate has one.
- The Studio side must actually use the new engine feature (no inert controls). Verify it in the real Studio on your
  dev server with screenshots, as in wave 3.
- Typecheck always; `npx vitest related` on changed files; the Studio, engine-audio and plugins-audio suites for your
  area; story play tests for the stories you touch. No Playwright e2e.
- Don't edit coordinator files (docs/README.md, implementation-status, decision log, build-log, ADRs); put doc text
  in your report. Update `docs/wiki/guide/*` user docs for what you add if a guide covers it.
- Report: branch, commits, ADR 0362 items done, tests (fail-before checked), sizes/gates changed, screenshots, doc
  text, anything for the owner.
