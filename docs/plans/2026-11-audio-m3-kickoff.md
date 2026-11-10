# Audio M3 (spatial): kickoff prompt for a new session

Paste the block below as the first message of a new Claude Code session on this repository. It is self-contained; the session should read the files it names rather than rely on this summary.

```text
Start audio milestone M3 (spatial) for Myco Engine. M2 (audio events and parameters, ADR 0158) is complete and on master; M3 is the next item on ADR 0157's roadmap and, like every roadmap milestone, needs its own decision record before any build.

## Start from the truth
Fetch master and check: the latest commits, `git worktree list`, open branches. Master holds M2 complete (the last M2 commits are "Docs: M2 complete (owner)" and the follow-ups F1-F3). If the repository disagrees with this prompt, the repository wins: say so.

## Read first, in this order
1. CLAUDE.md and docs/README.md (the index of records and guides).
2. docs/decisions/0157-audio-runs-on-an-engine-owned-rust-core-in-an-audioworklet.md: the "Roadmap" section names M3: "A 3rd-order ambisonic bed for distant voices (per-voice HRTF moved into M1). Occlusion through physics ray queries under a frame-share budget. Reverb zones; non-uniform convolution; Doppler."
3. docs/decisions/0158-audio-events-and-parameters.md: how M2 split the work (main does only event-driven work; the core does everything continuous per quantum; voices stay in main's voice table and selection), and its open questions that point at M3 ("Effects per event (an event's own filter or send) would need core work; deferred to M3 with reverb zones").
4. docs/design/0157-audio-core/README.md, architecture.md and api-and-models.md: the core's design, its budgets and file layout. Note README line "The reserve is nearly spent. The high preset's budget leaves ~0.11 ms for M2-M4. M3's ambisonic bed will need its own budget, or fewer HRTF voices," and that M2's automation is measured at 39-56 µs p99.9 on the shared container (lab-VM run still pending), from the same reserve.
5. docs/design/0157-audio-core/m2-decisions.md (summary at the top) and the build log's M2 entries (docs/design/0157-audio-core/build-log.md): what M2 built, the decisions the owner confirmed, the lessons.
6. docs/plans/2026-11-audio-events-m2-handoff.md: M2's final state, gotchas, and the owner items still open.

## What to do
Design M3 before building it, using the repository's decision-record process (the `adr` skill; the `design-subsystem` skill if it is available, for a subsystem this size):
- Interview me (the owner) on M3's goals and scope first: which of ambisonic bed, occlusion, reverb zones, non-uniform convolution and Doppler are in M3, what "distant voice" means, and the budget I'll accept against the remaining audio-thread reserve.
- Gather measured numbers where a decision depends on them (the core's per-quantum cost on the metered bench, `npm run check:audio-metered`; the physics ray-query cost; convolution cost per zone), as spikes if needed, labelled as estimates when they aren't measured on the lab VM.
- Write ADR 0162 (the next free number after 0161) as Proposed, with alternatives and consequences, and the technical design beside the 0157 design docs. Then stop for my review. Building waits for acceptance; planning the build afterwards uses the plan-milestone-build skill, as M2 did.

## Constraints that carry over
- Babylon.js (rendering), three.js loaders, Rapier and Howler never appear in public API (ADR 0010); Babylon is imported module by module.
- Every Vite/Vitest config uses the typescriptTranspile() plugin from vite.shared.ts with oxc: false.
- The audio core is Rust in native/audio/ compiled to wasm; the committed wasm must match its source hash (npm run build:audio); size gates are tripwires for bloat, not design limits (owner, M2).
- Plugins reach the editor only through src/editor/sdk (src/plugins/plugins.test.ts).
- Editor CSS uses theme tokens only.
- Significant decisions get a record; accepted records aren't rewritten.

## Owner items still open (don't block M3's design on them)
- M2: the lab-VM bench run (E5.5): ./native/audio/target/release/audio-bench mode=scene name=automation-probe seconds=20 runs=5 and npm run bench:audio-events; the listening-pass re-check of the blended engine and sign-off (docs/design/0157-audio-core/m2-listening-pass.md).
- Proposed, saved for later: ADR 0161 (Assets caches lookups behind a source generation).
- Not M2: tests/e2e/selection.spec.ts:77 (Alt+click node list) fails on master; recorded in the M2 build log.
- From M1: the remaining C3 soaks, reference-machine budgets, the signed M1 listening pass, Flappy's music licence, the public seek API proposal, band-limited resampling (#110); GitHub issues #50, #100, #104.

## Working notes from M2 (environment)
- Agent worktrees start at master: brief every agent with a base check.
- With several agents on 4 cores, timing tests fail; known flakes that pass alone: navSample, core/selectionBench, server.test.ts, piratesSample, hrtfLoopback, streamRebuild, gltf.test.ts, e2e codefiles.spec.ts, and audio-core.spec.ts beside other audio specs. Rerun a failing file alone before calling it a flake.
- In a worktree, make node_modules a real directory of per-entry links to the main checkout's (a single symlink shares .vitest-cache and collides).
- `playwright install` is blocked; the config falls back to /opt/pw-browsers/chromium.
- Brief agents to use only file, shell and test tools.
```
