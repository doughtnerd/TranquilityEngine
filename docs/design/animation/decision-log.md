# Animation build: decision log

Decisions made during the build that the records didn't settle. Each entry: the question, the choice, why, how to revert. Numbered D1, D2…

- **D1 (planning).** *Value tracks before gate A.* Compiled clips store uniformly resampled values (0341), so value tracks play linearly from the resampled data before the shared Bézier evaluator exists. T70 adds the evaluator for source curves, tween easing curves and runtime curve tracks. *Revert:* make T20a wait for gate A.
- **D2 (planning).** *Toolchain.* `native/anim/` pins Rust 1.99.1 (audio's pin) and uses wasm-bindgen 0.2.130 (nav's pin) for setup glue. Per-frame data crosses through typed-array views, as 0340 says.
