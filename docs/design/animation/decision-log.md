# Animation build: decision log

Decisions made during the build that the records didn't settle. Each entry: the question, the choice, why, how to revert. Numbered D1, D2…

- **D1 (planning).** *Value tracks before gate A.* Compiled clips store uniformly resampled values (0341), so value tracks play linearly from the resampled data before the shared Bézier evaluator exists. T70 adds the evaluator for source curves, tween easing curves and runtime curve tracks. *Revert:* make T20a wait for gate A.
- **D2 (planning).** *Toolchain.* `native/anim/` pins Rust 1.99.1 (audio's pin) and uses wasm-bindgen 0.2.130 (nav's pin) for setup glue. Per-frame data crosses through typed-array views, as 0340 says.
- **D3 (planning, owner).** *Build order.* Phase R builds the Rust core now; the audio branch merges (gate A); Phase B builds everything else on top of it. 0340's sentence on the curve-crate move was updated to say so. *Revert:* none needed; the order changes nothing in the records' requirements.
- **D4 (review).** *0345 was factually wrong:* `BallJoint` already had twist and scalar swing limits. The record's context and decision were corrected in place (noted in the record): T43 migrates `swingLimit` to elliptical `swing` and adds the drive. *Revert:* n/a.
- **D5 (review).** *`play()` without a graph* runs through a minimal graph program from T13r, so there is one evaluation path (0342's implicit single-layer graph). *Revert:* a separate clip-player path in T13r, rebuilt later.
- **D6 (T02).** *Crate edges:* `anim-graph` depends on `rig`, `retarget`, `match`, `physics` and `plugin-sdk` (its node families call them); those depend only on `math`, `format`, `pose` (and `sample` for `match`). *Revert:* move node families into the solver crates.
- **D7 (T02).** *`anim-format` has no dependencies; `anim-offline` depends only on `format`,* so the reference shares no code with the fast path and there's no dev-dependency cycle.
- **D8 (T02).** *`+simd128` in `native/anim/.cargo/config.toml`,* included in the source hash; `build.mjs` clears inherited RUSTFLAGS. *Revert:* pass the flag from `build.mjs` as audio does.
- **D9 (T02).** *Opcode = family id << 8 | kind;* per-family versions with exact-match decoding; test vectors as per-family JSON in the crate (no test-only TypeScript exports).
- **D10 (T10).** *Bone matrices are row-major 3×4* (three vec4 rows, translation in the fourth column), 12 floats per bone. *Revert:* transpose in `Mat3x4T`.
- **D11 (T10).** *TRS follows Unreal's `FTransform`:* per-component scale, no shear; the TRS inverse is exact for uniform scale, `Mat3x4T::inverse_or` is exact always. *Revert:* accumulate in matrices.
- **D12 (T10).** *Skeleton parents are `u16` with `NO_PARENT = 0xFFFF`, parents first.* T03r was told to match.
- **D13 (T10).** *glam only for conversions,* because its backends order operations differently and would break bit-identity between wasm and native.
- **D14 (T03r).** *Formats refuse unknown sections and flag bits* and require canonical layouts; writers re-parse their output. *Revert:* skip unknown kinds in `container::parse`.
- **D15 (T03r).** *Compressed bone tracks split into rotation (drop-w or full), translation and scale channels,* with an 8-bit range per channel per segment and bit rates {0, 3–16, 19, 23, 32 = raw}.
- **D16 (T03r).** *Every key is 32 bytes* with per-kind meaning, so TypeScript indexes one table.
- **D17 (T12).** *Blends use nlerp;* no positive weight gives the rest pose.
- **D18 (T12).** *Mirror is a local sign flip assuming mirrored local frames.* Rigs with flipped-axis conventions need a per-bone flip table in the skeleton profile: added to T41's scope.
- **D19 (T12).** *Inertialization:* a scalar offset per channel (translation vector, rotation axis-angle), a0 = 0, blend time clamped to `min(T, 2.5·|x0|/|v0|)` (the exact no-overshoot bound for a0 = 0 is 2.50087; Bollo's 5 overshoots); scale isn't inertialized; under 1e-4 s is a cut.
- **D20 (T12).** *Sync phase* = (marker index, id, fraction, normalised time), falling back to normalised time when a clip lacks the marker.
- **D21 (T11).** *Shell distance per bone* = max(3 cm, longest child offset in the rest pose).
- **D22 (T11).** *Bit-rate search* raises the channel with the best drop in excess error per added bit (excess = Σ max(0, e − bound) over the segment's frames). A plain lowest-maximum rule pushed root channels to raw and cost about 12%.
- **D23 (T11).** *Default and constant detection* at 0.1 × bound locally, screened in model space at 0.2 × bound, with a fallback that animates the worst channel and reruns.
- **D24 (T11).** *Rotations drop w by default;* both formats are tried when any |w| < 0.1.
- **D25 (T11).** *Root yaw* is the swing-twist yaw about +Y, relative to frame 0 and unwrapped, through anim-math's deterministic `atan2`.
- **D26 (T11).** *Additive clips* get constant detection only; their error is measured on the delta pose (an approximation).
