# Audio M3 (spatial): working notes for whoever runs this design or its build

Rules learned while running M3's design, for the coordinator and every brief. Read with [goal.md](goal.md).

## Don't spend compute on runs that can't change a decision (owner, 2026-11-11)
The convolution spike's Chromium main-thread run (7 × 20,000 quanta, ≈ 30 minutes) was stopped at the owner's question: it timed the same wasm in the same V8 engine as the Node run that had just finished, on the page's main thread rather than in the AudioWorklet, and the bed spike had already measured the Chromium worklet. The owner: don't do useless work like that again.

Before starting any long run (a benchmark, a soak, a full test suite, a long agent task), check:
1. **Will its result change a decision or a number the design cites?** If another run already answers it (same code, same engine, same host), skip it or run a short sample to confirm the ratio.
2. **Is it the host that matters?** A main-thread run says nothing new about the AudioWorklet; measure in the real host once, not in every lookalike.
3. **Can this machine answer it at all?** Tails (p99.9, max) on the shared container track the VM's scheduling, not the code; long runs to sharpen them here are wasted. They belong on the lab VM.
4. **Size the run to the question:** enough runs for a stable p50/p99 (≥ 5), not more; say the expected duration before starting, and offer to cut it.

## Follow industry standards as much as possible (owner, 2026-11-11)
When a design choice comes up (bus routing, beds, reverb zones, occlusion, parameters, editor tools), start from what the established middleware and engines do (Wwise, FMOD, Steam Audio, Unity, Unreal) and match it unless there's a measured reason not to; when M3 differs, say so and why. Example: beds per bus with `own` / `parent` / `none` and a priority follow Wwise's per-bus ambisonic configuration with children mixing into the parent.

## No feature flags or compatibility defaults (owner, 2026-11-11)
The engine is unpublished; the samples are the only projects. Don't add flags or "existing projects unchanged" defaults; update the samples instead.

## Run intensive tests at wave end, not per task (owner, 2026-11-11)
To save compute during the build:
- **Per task (agents and leaves):** `npm run typecheck`, the tests for the files touched (`npx vitest related <files>` or the file's own tests), and `cargo test -p <crate>` for a touched crate. Only a single e2e spec that the task itself adds or changes, if any.
- **Wave end (coordinator, after merging the wave):** full `npm test`, `npm run build`, `npm run test:e2e` (non-slow), `npm run check:audio-metered`, and the benches a wave's tasks touch (short runs).
- **Milestone end (before merging to master):** `npm run test:e2e:slow`, WebKit when the milestone touches the browser layer, long benches and soaks; the lab-VM run stays the owner's.
- A failure at wave end goes back to the task that caused it; rerun only the failing spec or test file, not the whole suite, until the fix is in. Known flakes (see the M2 handoff) are rerun alone once before being treated as failures.

## Lessons from the M3 design session (owner-requested retrospective, 2026-11-11)
For the next design or build session; the same lessons are folded into the design-subsystem, coordinate-subagents, plan-milestone-build and run-milestone-build skills.
1. **Plain language in chat.** Explain every domain term the first time a message uses it, with a "what this means for you" line per decision. A glossary in the record doesn't count.
2. **Ask who uses it today** before proposing compatibility work. The engine is unpublished, so feature flags and "existing projects unchanged" defaults were wasted effort.
3. **Read today's real values first** (settings, presets, limits). The record and spikes assumed 16 HRTF voices on high; the preset was 32.
4. **Cost every long run** (what it decides, how long it takes) and skip duplicates; commit results per stage so a container restart loses nothing.
5. **Calibrate provisional estimates** from the previous milestone's actuals and price tests, benches and tooling; the M3 estimate drifted 17 → 22 → 32.7 → 35.6 → 36.7 person-weeks.
6. **One owner per shared contract** in a two-author design (the senior engineer owns wire, settings and formats); parallel drafts of the same layout cost a ruling round.
7. **Short, section-level must-read lists, and check the "what I read" reply;** skipped reading came back as errors.
8. **Don't edit files an author is still revising; send rulings in one batch;** have authors commit in their own worktrees so stop hooks don't commit half-written drafts.
9. **One owner decision list, after verification,** so the numbers don't move after the owner decides.
10. **Hand off after the owner accepts the direction** (step 5) instead of letting a long design session compact.
11. **Keep verification scripts:** render Mermaid with the npm `mermaid` package (CDNs are blocked here) and re-sum task tables by script.

## Lessons from the M4 design session (owner-requested retrospective, 2026-11-12)

These come from the session that ran steps 1–5 for ADR 0166 (interactive music). The same lessons are folded into the design-subsystem skill.

1. **Keep record numbers out of names until the record is written, then fetch main right before allocating one.** Main took 0163–0165 mid-session, and the `docs/design/0163-audio-music/` folder had to be renumbered to 0166.
2. **Verify every spike claim the record will rely on, not one per report.** S4's "a stamped start doesn't split the quantum" went into the record unchecked. The senior reviewer found that every stamped record splits (`native/audio/crates/audio-core/src/voices.rs:310-325`).
3. **A timing harness needs a truth reference far more accurate than the error it judges.** S3 fitted true time as one straight line per 60 s run and reported 7–95 ms of fake error. One 70 s run with a sliding-window fit showed 0.04 ms. When a smoke run and the full run disagree, check the reference before the code.
4. **At acceptance (step 5), ask only "accept the direction?".** Six detailed decisions, including the estimate, were asked at acceptance and recorded from a bare "I accept", while the estimate had already moved (38–46 → 45–55 person-weeks). Detailed choices belong on step 8's single list after verification. A bare "accept" is never an answer to a decision list: ask, or record visibly provisional defaults.
5. **Spike, review and author agents work in their own worktrees and commit there.** Agents in the main checkout made the stop hook force about eight commits of half-written drafts.
6. **Probe network access before the survey.** The proxy blocks the documentation hosts (Audiokinetic, FMOD, Epic, MDN, docs.rs). The S0 survey needed a second pass against primary sources on GitHub (source repositories, vendored headers, MDN browser-compat-data, spec sources), which work.
7. **Read each reviewer's "what I read" line first** and send back any who skipped reading their points depend on. Three of five skipped some required items.
8. **Kept from this session:** agents build and smoke-test; the coordinator runs every timed run sequentially on an idle machine from one script that commits per stage (`spikes/audio-music/timed-runs.sh`); runs that can't change a decision are cut with the reason stated.
