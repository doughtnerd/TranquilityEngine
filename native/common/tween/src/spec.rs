//! [`Spec`]: one tween's description and its value function, shared by the tween table
//! ([`crate::Tweens`]) and sequence members ([`crate::seq`]). [`Spec::eval`] gives the value at an
//! elapsed time.
//!
//! Elapsed time is f64; values are f32 (`from·(1 − e) + to·e`, so the end values are exact;
//! quaternions use `anim-math`'s nlerp or slerp with the same endpoint rule).
//!
//! Moved from `anim-wasm/src/tweens.rs` (ADR 0420 spike), unchanged but for the curve lookup, which
//! was the animation core's asset arena and is now the [`Curves`] type parameter.

use anim_math::AosQuat;
use myco_curve::{eval as eval_curve, Key};

use crate::ease::{ease, LAST_ID};
use crate::wire::{
    TweenCreate, FLAG_RELATIVE, FLAG_YOYO, KIND_QUAT_NLERP, KIND_QUAT_SLERP, LOOPS_INFINITE,
};

/// The host's curve store: curve easings (an `ease` above [`LAST_ID`]) read their keys through it.
///
/// A type parameter of [`Spec::eval`] and [`crate::Tweens::update`], so each module monomorphises
/// its own lookup: the animation core's asset arena, the standalone module's [`crate::curves::CurveStore`].
pub trait Curves {
    /// The keys of curve `handle`, or `None` (released, or not a curve: the easing is then linear).
    fn curve(&self, handle: u32) -> Option<&[Key<f32>]>;
}

/// No curves: every curve easing is linear.
impl Curves for () {
    #[inline]
    fn curve(&self, _handle: u32) -> Option<&[Key<f32>]> {
        None
    }
}

pub(crate) fn finite_or(x: f32, default: f32) -> f32 {
    if x.is_finite() {
        x
    } else {
        default
    }
}

/// One tween's description (see the `tween` wire docs).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spec {
    /// `KIND_VALUE`, `KIND_QUAT_NLERP` or `KIND_QUAT_SLERP`.
    pub kind: u32,
    /// Floats of a value tween (4 for a quaternion).
    pub width: usize,
    /// An easing id, or (above [`LAST_ID`]) a curve asset's handle (T70).
    pub ease: u32,
    /// Odd cycles run backwards.
    pub yoyo: bool,
    /// Cycles (at least 1), or `LOOPS_INFINITE`.
    pub loops: u32,
    /// Seconds per cycle (≥ 0).
    pub duration: f32,
    /// Seconds before the first cycle (≥ 0).
    pub delay: f32,
    pub from: [f32; 4],
    /// The end value, with a relative tween already resolved.
    pub to: [f32; 4],
}

/// The state of a tween at an elapsed time (see [`Spec::eval`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Eval {
    /// Past its delay: the value was written.
    pub started: bool,
    /// The cycle reached (0 for the first); cycles played once done.
    pub cycle: u32,
    /// Ran to its end.
    pub done: bool,
}

fn quat(v: &[f32; 4]) -> AosQuat {
    AosQuat::new(v[0], v[1], v[2], v[3])
}

fn quat_array(q: AosQuat) -> [f32; 4] {
    [q.x, q.y, q.z, q.w]
}

impl Spec {
    /// The spec of a create command (or a sequence member's fields): sanitised (non-finite
    /// numbers read as 0, negative times as 0), a relative `to` resolved, quaternions
    /// normalised. `None` for a width outside 1..=4 or an unknown value kind.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        kind: u32,
        width: u32,
        ease: u32,
        flags: u32,
        loops: u32,
        duration: f32,
        delay: f32,
        from: [f32; 4],
        to: [f32; 4],
    ) -> Option<Spec> {
        let quat_kind = kind == KIND_QUAT_NLERP || kind == KIND_QUAT_SLERP;
        if kind > KIND_QUAT_SLERP || (!quat_kind && !(1..=4).contains(&width)) {
            return None;
        }
        let width = if quat_kind { 4 } else { width as usize };
        let clean = |v: [f32; 4]| v.map(|x| finite_or(x, 0.0));
        let (mut from, mut to) = (clean(from), clean(to));
        if quat_kind {
            from = quat_array(quat(&from).normalize_or_identity());
            let by = quat(&to).normalize_or_identity();
            to = if flags & FLAG_RELATIVE != 0 {
                quat_array((quat(&from) * by).normalize_or_identity())
            } else {
                quat_array(by)
            };
        } else if flags & FLAG_RELATIVE != 0 {
            for i in 0..4 {
                to[i] += from[i];
            }
        }
        for i in width..4 {
            from[i] = 0.0;
            to[i] = 0.0;
        }
        Some(Spec {
            kind,
            width,
            ease,
            yoyo: flags & FLAG_YOYO != 0,
            loops: if loops == 0 { 1 } else { loops },
            duration: finite_or(duration, 0.0).max(0.0),
            delay: finite_or(delay, 0.0).max(0.0),
            from,
            to,
        })
    }

    /// The spec of a [`TweenCreate`] record.
    pub fn from_create(c: &TweenCreate) -> Option<Spec> {
        Spec::new(
            c.value_kind,
            c.width,
            c.ease,
            c.flags,
            c.loops,
            c.duration,
            c.delay,
            [c.from0, c.from1, c.from2, c.from3],
            [c.to0, c.to1, c.to2, c.to3],
        )
    }

    /// Seconds from the start (the delay's start) to the end: infinite for endless loops.
    pub fn total(&self) -> f64 {
        if self.duration <= 0.0 {
            return self.delay as f64;
        }
        if self.loops == LOOPS_INFINITE {
            return f64::INFINITY;
        }
        self.delay as f64 + self.duration as f64 * self.loops as f64
    }

    /// Progress `p` through the easing: a Penner id ([`crate::ease`]), or a curve of `curves`
    /// read at `p` (T70: the shared `myco-curve` evaluator, as `curve.ts`'s `evalCurve`; a
    /// released handle, or one that isn't a curve, is linear, as an unknown id is).
    #[inline]
    fn eased<C: Curves + ?Sized>(&self, p: f32, curves: &C) -> f32 {
        if self.ease <= LAST_ID {
            return ease(self.ease, p);
        }
        match curves.curve(self.ease) {
            Some(keys) => eval_curve(keys, p),
            None => p,
        }
    }

    /// The value at progress `p` of a cycle (before easing), with exact endpoints.
    #[inline]
    fn value<C: Curves + ?Sized>(&self, p: f32, curves: &C, out: &mut [f32; 4]) {
        let e = self.eased(p, curves);
        if e == 0.0 {
            *out = self.from;
        } else if e == 1.0 {
            *out = self.to;
        } else if self.kind == KIND_QUAT_NLERP {
            *out = quat_array(quat(&self.from).nlerp(quat(&self.to), e));
        } else if self.kind == KIND_QUAT_SLERP {
            *out = quat_array(quat(&self.from).slerp(quat(&self.to), e));
        } else {
            for ((o, a), b) in out.iter_mut().zip(self.from).zip(self.to) {
                *o = a * (1.0 - e) + b * e;
            }
        }
    }

    /// The tween at elapsed time `t` seconds since its start (the delay's start): writes the value
    /// into `out` once past the delay, and says which cycle it is in and whether it is done. A
    /// finished tween holds its end value (`to`, or `from` after an odd number of yoyo cycles).
    /// With `yoyo` an odd cycle runs backwards through the same easing (`ease(1 − p)`). A curve
    /// easing is read from `curves` (the host's curve store, a type parameter: monomorphised, no
    /// dynamic dispatch on the per-frame path).
    pub fn eval<C: Curves + ?Sized>(&self, t: f64, curves: &C, out: &mut [f32; 4]) -> Eval {
        let delay = self.delay as f64;
        if t.is_nan() || t < delay {
            return Eval {
                started: false,
                cycle: 0,
                done: false,
            };
        }
        let u = t - delay;
        let dur = self.duration as f64;
        let n = if dur <= 0.0 && self.loops == LOOPS_INFINITE {
            1
        } else {
            self.loops
        };
        let end_progress = |cycles: u32| {
            if self.yoyo && (cycles - 1) % 2 == 1 {
                0.0
            } else {
                1.0
            }
        };
        if dur <= 0.0 || (n != LOOPS_INFINITE && u >= dur * n as f64) {
            self.value(end_progress(n), curves, out);
            return Eval {
                started: true,
                cycle: n,
                done: true,
            };
        }
        let cyc = (u / dur).floor().min(u32::MAX as f64 - 1.0);
        let frac = ((u - cyc * dur) / dur).clamp(0.0, 1.0) as f32;
        let cycle = cyc as u32;
        let p = if self.yoyo && cycle % 2 == 1 {
            1.0 - frac
        } else {
            frac
        };
        self.value(p, curves, out);
        Eval {
            started: true,
            cycle,
            done: false,
        }
    }
}
