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
