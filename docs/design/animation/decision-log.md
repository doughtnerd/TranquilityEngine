# Animation build: decision log

Decisions made during the build that the records didn't settle. Each entry: the question, the choice, why, how to revert. Numbered D1, D2…

- **D1 (planning).** *Value tracks before gate A.* Compiled clips store uniformly resampled values (0341), so value tracks play linearly from the resampled data before the shared Bézier evaluator exists. T70 adds the evaluator for source curves, tween easing curves and runtime curve tracks. *Revert:* make T20a wait for gate A.
- **D2 (planning).** *Toolchain.* `native/anim/` pins Rust 1.99.1 (audio's pin) and uses wasm-bindgen 0.2.130 (nav's pin) for setup glue. Per-frame data crosses through typed-array views, as 0340 says.
- **D3 (planning, owner).** *Build order.* Phase R builds the Rust core now; the audio branch merges (gate A); Phase B builds everything else on top of it. 0340's sentence on the curve-crate move was updated to say so. *Revert:* none needed; the order changes nothing in the records' requirements.
- **D4 (review).** *0345 was factually wrong:* `BallJoint` already had twist and scalar swing limits. The record's context and decision were corrected in place (noted in the record): T43 migrates `swingLimit` to elliptical `swing` and adds the drive. *Revert:* n/a.
- **D5 (review).** *`play()` without a graph* runs through a minimal graph program from T13r, so there is one evaluation path (0342's implicit single-layer graph). *Revert:* a separate clip-player path in T13r, rebuilt later.
