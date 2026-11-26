//! Family `tween`: the tween table's create and control commands and its output records (ADR
//! 0371, 0372).
//!
//! Moved here from `anim-wire` (ADR 0420 spike); `anim_wire::tween` re-exports this module, and
//! `anim-wire`'s generator still writes `wire/tween.ts` from [`FAMILY`] (byte for byte as before:
//! the family's doc string is unchanged, so it still names its old path).
//!
//! # The table
//!
//! A tween is a one-track clip built in code: a value of 1 to 4 floats (a float, a vec2/3/4 or a
//! colour) or a quaternion, from `from` to `to` (or by a relative amount) over `duration` seconds
//! after `delay`, through an easing, repeated `loops` times (restart or yoyo), advancing by the
//! scaled, unscaled or fixed-pass time.
//!
//! - **Create:** `tween_create(TWEEN_CREATE)` returns a handle (`generation << 16 | index`, never
//!   0; 0 means refused and `last_status()` says why: `STATUS_FULL` when the table is full,
//!   `STATUS_BAD_RECORD` for a malformed record). The host chooses `column`, an id the core echoes
//!   next to the tween's values, and `host_id`, an id echoed in the state records (the host's
//!   promise key). Capacity comes from `tweens_configure(max_tweens)` (default
//!   [`DEFAULT_MAX_TWEENS`]); creating allocates nothing, `evaluate` never does.
//! - **Control:** `tween_control(TWEEN_CONTROL)` pauses, resumes, kills (the host cancelled it) or
//!   marks a tween's target destroyed. A stale handle answers `STATUS_STALE_HANDLE` and does
//!   nothing. A kill or destroy takes effect at once (the tween outputs nothing more) and its
//!   state record is written by the next `evaluate`.
//!
//! # Per frame
//!
//! `evaluate(world, pass, …)` advances every tween of `world` whose time mode belongs to the
//! pass: `TIME_SCALED` and `TIME_UNSCALED` in `PASS_NORMAL`, `TIME_FIXED` in `PASS_FIXED`.
//! `write_inputs` clears the outputs, so both passes of a frame append to them. Read:
//!
//! - **values:** `tween_values_count()` rows; row `i` is `tween_columns_ptr()[i]` (the tween's
//!   `column`, `u32`) and the four `f32`s at `tween_values_ptr() + 16·i` (components past the
//!   tween's width are 0; a quaternion is x, y, z, w). A tween outputs once per frame while it
//!   runs (not paused, past its delay, not killed) and once more on the frame it completes, with
//!   its exact end value (`to`, or `from` after an odd number of yoyo cycles).
//! - **changes:** `tween_changes_count()` [`TweenChange`] records at `tween_changes_ptr()`.
//!
//! # Timing
//!
//! Elapsed time accumulates in f64. During `delay` nothing is output. With `FLAG_YOYO` odd cycles
//! run backwards through the same easing (`ease(1 − p)`, as DOTween). `loops` 0 counts as 1;
//! [`LOOPS_INFINITE`] never completes. A zero-duration tween jumps to its end value on the first
//! frame after its delay and completes. `speed` scales this tween's time (negative counts as 0).
//! At most one `CHANGE_LOOP` record is written per tween per frame, naming the cycle reached.
//!
//! # Easing ids
//!
//! `EASE_LINEAR` is 0; the others are `EASE_<IN|OUT|IN_OUT>_<FAMILY>` = `1 + 3·family + mode`
//! (families quad, cubic, quart, quint, sine, expo, circ, back, elastic, bounce). Formulas:
//! [`crate::ease`].
//!
//! # Engine curves (T70)
//!
//! An `ease` above `EASE_IN_OUT_BOUNCE` (30) is a **curve asset's handle** (handles are never
//! below `1 << 16`): the cycle's progress `p` is read through the curve, `evalCurve(curve, p)` in
//! `src/engine/core/curve.ts`'s terms, by the shared `myco-curve` evaluator (the audio core's;
//! ADR 0370). The endpoint rule still holds: an eased 0 gives `from` and 1 gives `to` exactly;
//! other values (a curve may overshoot) mix `from·(1 − e) + to·e`. A released handle, or one
//! that isn't a curve, eases linearly, as an unknown id. Sequence members (`timeline` family)
//! take curve handles the same way.
//!
//! - `load_curve(keys: f32[])` loads a curve: [`CURVE_KEY_FLOATS`] floats per key, `x, y, interp,
//!   inDx, inDy, outDx, outDy`, sorted by x, at most [`MAX_CURVE_KEYS`] keys. `interp` is
//!   `curve.ts`'s code (0 linear, 1 step, 2 smooth, 3 easeIn, 4 easeOut, 5 Bézier; anything else
//!   linear); the handles are a Bézier key's `in` and `out` offsets. It returns the handle, or 0
//!   with `last_status()` `STATUS_BAD_ASSET` (not whole keys, a non-finite number, keys out of
//!   order) or `STATUS_TOO_LARGE`. `release(handle)` frees it.
//! - `curve_sample(curve, rate, end, frames)` writes the curve at frame `i`'s
//!   x = `min(i / rate, end)` for `frames` frames (at most [`MAX_CURVE_SAMPLES`]) to the `f32`
//!   view at `curve_samples_ptr()`, valid until the next call; it returns a status. Hosts sample
//!   runtime curve tracks with it, so the core's evaluator gives their values.

use alloc::vec;
use alloc::vec::Vec;
use myco_wire::{wire_record, Const, FamilyDesc, Vector, WireRecord};

/// The family id (the opcodes' high byte).
pub const ID: u8 = 6;
/// The family version. Bump it when a record's layout changes.
pub const VERSION: u16 = 1;

/// Tweens the table holds unless `tweens_configure` says otherwise.
pub const DEFAULT_MAX_TWEENS: u32 = 4096;

/// [`TweenCreate::value_kind`]: `width` floats, interpolated linearly.
pub const KIND_VALUE: u32 = 0;
/// [`TweenCreate::value_kind`]: a quaternion (x, y, z, w), normalised lerp.
pub const KIND_QUAT_NLERP: u32 = 1;
/// [`TweenCreate::value_kind`]: a quaternion, spherical interpolation.
pub const KIND_QUAT_SLERP: u32 = 2;

/// [`TweenCreate::flags`]: `to` is relative: a float vector's `to = from + by`, a quaternion's
/// `to = from · by` (the rotation `by` applied after `from`).
pub const FLAG_RELATIVE: u32 = 1;
/// [`TweenCreate::flags`]: odd cycles run backwards.
pub const FLAG_YOYO: u32 = 2;

/// [`TweenCreate::time_mode`]: scaled time (`evaluate`'s `dtScaled`, normal pass).
pub const TIME_SCALED: u32 = 0;
/// [`TweenCreate::time_mode`]: unscaled time (`dtUnscaled`, normal pass).
pub const TIME_UNSCALED: u32 = 1;
/// [`TweenCreate::time_mode`]: the fixed pass (`dtScaled` of the fixed step).
pub const TIME_FIXED: u32 = 2;

/// [`TweenCreate::loops`]: repeat forever.
pub const LOOPS_INFINITE: u32 = 0xFFFF_FFFF;

/// Floats per key of `load_curve`: x, y, interp, inDx, inDy, outDx, outDy.
pub const CURVE_KEY_FLOATS: u32 = 7;
/// The most keys `load_curve` takes (`src/engine/animation/tracks.ts` `TRACK_LIMITS.keys`).
pub const MAX_CURVE_KEYS: u32 = 65_536;
/// The most frames one `curve_sample` writes (above an hour at 240 Hz).
pub const MAX_CURVE_SAMPLES: u32 = 1 << 20;

/// [`TweenControl::op`]: stop advancing.
pub const OP_PAUSE: u32 = 1;
/// [`TweenControl::op`]: continue.
pub const OP_RESUME: u32 = 2;
/// [`TweenControl::op`]: the host cancelled it (`CHANGE_KILLED`).
pub const OP_KILL: u32 = 3;
/// [`TweenControl::op`]: its target is gone (`CHANGE_DESTROYED`).
pub const OP_DESTROYED: u32 = 4;

/// [`TweenChange::kind`]: ran to its end.
pub const CHANGE_COMPLETED: u32 = 1;
/// [`TweenChange::kind`]: killed by the host.
pub const CHANGE_KILLED: u32 = 2;
/// [`TweenChange::kind`]: stopped because its target was destroyed.
pub const CHANGE_DESTROYED: u32 = 3;
/// [`TweenChange::kind`]: reached a new cycle (`cycle`).
pub const CHANGE_LOOP: u32 = 4;

wire_record! {
    /// Command: create a tween.
    pub struct TweenCreate: family(ID, VERSION), kind(1) {
        /// The World it runs in (`evaluate`'s `world`).
        world: u32,
        /// The host's id for this tween, echoed in its state changes.
        host_id: u32,
        /// The host's id for the target column, echoed next to the values.
        column: u32,
        /// `KIND_VALUE`, `KIND_QUAT_NLERP` or `KIND_QUAT_SLERP`.
        value_kind: u32,
        /// Floats of a `KIND_VALUE` tween, 1 to 4 (a quaternion always has 4).
        width: u32,
        /// An easing id (`EASE_*`), or a curve asset's handle (`load_curve`; module docs).
        ease: u32,
        /// `FLAG_RELATIVE`, `FLAG_YOYO`.
        flags: u32,
        /// `TIME_SCALED`, `TIME_UNSCALED` or `TIME_FIXED`.
        time_mode: u32,
        /// Cycles to play (0 counts as 1), or `LOOPS_INFINITE`.
        loops: u32,
        /// Seconds per cycle.
        duration: f32,
        /// Seconds before the first cycle.
        delay: f32,
        /// Time scale of this tween (1 normal).
        speed: f32,
        from0: f32,
        from1: f32,
        from2: f32,
        from3: f32,
        /// The end value, or with `FLAG_RELATIVE` the change.
        to0: f32,
        to1: f32,
        to2: f32,
        to3: f32,
    }
}

wire_record! {
    /// Command: pause, resume, kill or destroy a tween.
    pub struct TweenControl: family(ID, VERSION), kind(2) {
        /// The tween handle.
        handle: u32,
        /// `OP_PAUSE`, `OP_RESUME`, `OP_KILL` or `OP_DESTROYED`.
        op: u32,
    }
}

wire_record! {
    /// Output: a tween's state changed (resolves or rejects its promise).
    pub struct TweenChange: family(ID, VERSION), kind(3) {
        /// The host's id from `TWEEN_CREATE`.
        host_id: u32,
        /// The tween handle (stale after a completed, killed or destroyed change).
        handle: u32,
        /// `CHANGE_COMPLETED`, `CHANGE_KILLED`, `CHANGE_DESTROYED` or `CHANGE_LOOP`.
        kind: u32,
        /// For `CHANGE_LOOP` the cycle reached (1 after the first loop), else the cycles played.
        cycle: u32,
    }
}

/// The family's vectors.
fn vectors() -> Vec<Vector> {
    vec![
        Vector::of(
            "tween_create_vec3",
            &TweenCreate {
                world: 1,
                host_id: 0x0102_0304,
                column: 77,
                value_kind: KIND_VALUE,
                width: 3,
                ease: EASE_OUT_BACK,
                flags: FLAG_YOYO,
                time_mode: TIME_UNSCALED,
                loops: LOOPS_INFINITE,
                duration: 0.4,
                delay: 0.25,
                speed: 1.0,
                from0: 0.0,
                from1: -1.5,
                from2: 2.0,
                from3: 0.0,
                to0: 0.0,
                to1: 2.0,
                to2: 0.0,
                to3: 0.0,
            },
        ),
        Vector::of(
            "tween_create_quat_relative",
            &TweenCreate {
                world: 0,
                host_id: 9,
                column: u32::MAX,
                value_kind: KIND_QUAT_SLERP,
                width: 4,
                ease: EASE_IN_OUT_SINE,
                flags: FLAG_RELATIVE,
                time_mode: TIME_FIXED,
                loops: 2,
                duration: 1.0,
                delay: 0.0,
                speed: 0.5,
                from0: 0.0,
                from1: 0.0,
                from2: 0.0,
                from3: 1.0,
                to0: 0.0,
                to1: 0.70710677,
                to2: 0.0,
                to3: 0.70710677,
            },
        ),
        Vector::of(
            "tween_control_kill",
            &TweenControl {
                handle: 0x0003_0009,
                op: OP_KILL,
            },
        ),
        Vector::of(
            "tween_change_destroyed",
            &TweenChange {
                host_id: 12,
                handle: 0x0001_0002,
                kind: CHANGE_DESTROYED,
                cycle: 0,
            },
        ),
        Vector::of(
            "tween_change_loop",
            &TweenChange {
                host_id: u32::MAX,
                handle: 5,
                kind: CHANGE_LOOP,
                cycle: 3,
            },
        ),
    ]
}

macro_rules! eases {
    ($($name:ident = $value:expr, $doc:literal;)*) => {
        $(#[doc = $doc] pub const $name: u32 = $value;)*
        /// Every easing constant, for the generated TypeScript.
        const EASE_CONSTS: &[Const] = &[
            $(Const { name: stringify!($name), value: $name, doc: $doc }),*
        ];
    };
}

eases! {
    EASE_LINEAR = 0, "Easing: linear.";
    EASE_IN_QUAD = 1, "Easing: in quad (`t²`).";
    EASE_OUT_QUAD = 2, "Easing: out quad.";
    EASE_IN_OUT_QUAD = 3, "Easing: in-out quad.";
    EASE_IN_CUBIC = 4, "Easing: in cubic.";
    EASE_OUT_CUBIC = 5, "Easing: out cubic.";
    EASE_IN_OUT_CUBIC = 6, "Easing: in-out cubic.";
    EASE_IN_QUART = 7, "Easing: in quart.";
    EASE_OUT_QUART = 8, "Easing: out quart.";
    EASE_IN_OUT_QUART = 9, "Easing: in-out quart.";
    EASE_IN_QUINT = 10, "Easing: in quint.";
    EASE_OUT_QUINT = 11, "Easing: out quint.";
    EASE_IN_OUT_QUINT = 12, "Easing: in-out quint.";
    EASE_IN_SINE = 13, "Easing: in sine.";
    EASE_OUT_SINE = 14, "Easing: out sine.";
    EASE_IN_OUT_SINE = 15, "Easing: in-out sine.";
    EASE_IN_EXPO = 16, "Easing: in expo.";
    EASE_OUT_EXPO = 17, "Easing: out expo.";
    EASE_IN_OUT_EXPO = 18, "Easing: in-out expo.";
    EASE_IN_CIRC = 19, "Easing: in circ.";
    EASE_OUT_CIRC = 20, "Easing: out circ.";
    EASE_IN_OUT_CIRC = 21, "Easing: in-out circ.";
    EASE_IN_BACK = 22, "Easing: in back.";
    EASE_OUT_BACK = 23, "Easing: out back.";
    EASE_IN_OUT_BACK = 24, "Easing: in-out back.";
    EASE_IN_ELASTIC = 25, "Easing: in elastic.";
    EASE_OUT_ELASTIC = 26, "Easing: out elastic.";
    EASE_IN_OUT_ELASTIC = 27, "Easing: in-out elastic.";
    EASE_IN_BOUNCE = 28, "Easing: in bounce.";
    EASE_OUT_BOUNCE = 29, "Easing: out bounce.";
    EASE_IN_OUT_BOUNCE = 30, "Easing: in-out bounce.";
}

/// The easing names in id order (`EASE_` stripped, lower case words joined by `_`), for tests and
/// for hosts that build the table of names.
pub const EASE_NAMES: [&str; 31] = [
    "linear",
    "in_quad",
    "out_quad",
    "in_out_quad",
    "in_cubic",
    "out_cubic",
    "in_out_cubic",
    "in_quart",
    "out_quart",
    "in_out_quart",
    "in_quint",
    "out_quint",
    "in_out_quint",
    "in_sine",
    "out_sine",
    "in_out_sine",
    "in_expo",
    "out_expo",
    "in_out_expo",
    "in_circ",
    "out_circ",
    "in_out_circ",
    "in_back",
    "out_back",
    "in_out_back",
    "in_elastic",
    "out_elastic",
    "in_out_elastic",
    "in_bounce",
    "out_bounce",
    "in_out_bounce",
];

macro_rules! consts {
    ($($name:ident: $doc:literal),* $(,)?) => {
        &[$(Const { name: stringify!($name), value: $name, doc: $doc }),*]
    };
}

const CONTROL_CONSTS: &[Const] = consts![
    DEFAULT_MAX_TWEENS: "Tweens the table holds unless `tweens_configure` says otherwise.",
    KIND_VALUE: "`TWEEN_CREATE.valueKind`: `width` floats, linear.",
    KIND_QUAT_NLERP: "`TWEEN_CREATE.valueKind`: a quaternion, normalised lerp.",
    KIND_QUAT_SLERP: "`TWEEN_CREATE.valueKind`: a quaternion, slerp.",
    FLAG_RELATIVE: "`TWEEN_CREATE.flags`: `to` is relative (vector: from + by; quaternion: from * by).",
    FLAG_YOYO: "`TWEEN_CREATE.flags`: odd cycles run backwards.",
    TIME_SCALED: "`TWEEN_CREATE.timeMode`: scaled time.",
    TIME_UNSCALED: "`TWEEN_CREATE.timeMode`: unscaled time.",
    TIME_FIXED: "`TWEEN_CREATE.timeMode`: the fixed pass.",
    LOOPS_INFINITE: "`TWEEN_CREATE.loops`: repeat forever.",
    CURVE_KEY_FLOATS: "`load_curve`: floats per key (x, y, interp, inDx, inDy, outDx, outDy).",
    MAX_CURVE_KEYS: "`load_curve`: the most keys a curve holds.",
    MAX_CURVE_SAMPLES: "`curve_sample`: the most frames one call writes.",
    OP_PAUSE: "`TWEEN_CONTROL.op`: pause.",
    OP_RESUME: "`TWEEN_CONTROL.op`: resume.",
    OP_KILL: "`TWEEN_CONTROL.op`: the host cancelled it.",
    OP_DESTROYED: "`TWEEN_CONTROL.op`: its target is gone.",
    CHANGE_COMPLETED: "`TWEEN_CHANGE.kind`: ran to its end.",
    CHANGE_KILLED: "`TWEEN_CHANGE.kind`: killed by the host.",
    CHANGE_DESTROYED: "`TWEEN_CHANGE.kind`: its target was destroyed.",
    CHANGE_LOOP: "`TWEEN_CHANGE.kind`: reached a new cycle.",
];

/// Every constant: the controls, then the easings.
const ALL_CONSTS: [&[Const]; 2] = [CONTROL_CONSTS, EASE_CONSTS];

/// The family.
pub const FAMILY: FamilyDesc = FamilyDesc {
    name: "tween",
    id: ID,
    version: VERSION,
    doc: "Wire family `tween`: the tween table's create and control commands and its output records (ADR 0371, 0372).\nnative/anim/crates/anim-wire/src/tween.rs documents the table, its views, its timing and engine curves (`load_curve`, curve easing, `curve_sample`).",
    records: &[TweenCreate::DESC, TweenControl::DESC, TweenChange::DESC],
    consts: &FLAT,
    vectors,
};

const FLAT_LEN: usize = 21 + 31;

/// `ALL_CONSTS` flattened (a `const` can't concatenate slices, so this builds the array).
const FLAT: [Const; FLAT_LEN] = {
    let mut out = [Const {
        name: "",
        value: 0,
        doc: "",
    }; FLAT_LEN];
    let mut at = 0;
    let mut g = 0;
    while g < ALL_CONSTS.len() {
        let group = ALL_CONSTS[g];
        let mut i = 0;
        while i < group.len() {
            out[at] = group[i];
            at += 1;
            i += 1;
        }
        g += 1;
    }
    out
};
