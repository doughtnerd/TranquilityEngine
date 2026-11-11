# Audio M3 (spatial): working notes for whoever runs this design or its build

Rules learned while running M3's design, for the coordinator and every brief. Read with [goal.md](goal.md).

## Don't spend compute on runs that can't change a decision (owner, 2026-11-11)
The convolution spike's Chromium main-thread run (7 × 20,000 quanta, ≈ 30 minutes) was stopped at the owner's question: it timed the same wasm in the same V8 engine as the Node run that had just finished, on the page's main thread rather than in the AudioWorklet, and the bed spike had already measured the Chromium worklet. The owner: don't do useless work like that again.

Before starting any long run (a benchmark, a soak, a full test suite, a long agent task), check:
1. **Will its result change a decision or a number the design cites?** If another run already answers it (same code, same engine, same host), skip it or run a short sample to confirm the ratio.
2. **Is it the host that matters?** A main-thread run says nothing new about the AudioWorklet; measure in the real host once, not in every lookalike.
3. **Can this machine answer it at all?** Tails (p99.9, max) on the shared container track the VM's scheduling, not the code; long runs to sharpen them here are wasted. They belong on the lab VM.
4. **Size the run to the question:** enough runs for a stable p50/p99 (≥ 5), not more; say the expected duration before starting, and offer to cut it.
