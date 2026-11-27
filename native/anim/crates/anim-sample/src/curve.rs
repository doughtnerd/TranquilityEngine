//! Engine curves in the animation core (ADR 0370, 0371; T70): keys from the host, read and
//! evaluated by the shared `myco-curve` crate, the evaluator the audio core links, held to
//! `src/engine/core/curve.ts` by its parity test.
//!
//! Users: curve assets (`anim-wasm` `load_curve`) as tween and sequence easing and for
//! [`sample_uniform`] (runtime curve tracks a host builds into a raw clip), and the editor module's
//! sampling of source value curves at compile time.
//!
//! # Keys
//!
//! [`KEY_FLOATS`] f32 per key, sorted by x: `x, y, interp, inDx, inDy, outDx, outDy`. `interp`
//! is `curve.ts`'s code (0 linear, 1 step, 2 smooth, 3 easeIn, 4 easeOut, 5 Bézier); any other
//! value reads as linear, as `curve.ts`'s default. The handles are a Bézier key's offsets (`in`,
//! `out`), ignored for other keys. At most [`MAX_KEYS`] keys (`TRACK_LIMITS.keys`).

// The key parser is `myco-curve`'s (feature `alloc`, ADR 0424: the standalone tween module's curve
// store needs it, and that module doesn't link this crate); re-exported unchanged.
pub use myco_curve::{eval, parse_keys, CurveError, Key, KEY_FLOATS, MAX_KEYS};

/// Samples a curve at `out.len()` frames of `rate` Hz from 0, clamped to `end` seconds: frame `i`
/// reads x = `min(i / rate, end)` (worked out in f64, then read in f32), as the compile step and
/// the timeline builder sample source curves. A non-positive or non-finite `rate` reads every
/// frame at 0.
pub fn sample_uniform(keys: &[Key<f32>], rate: f64, end: f64, out: &mut [f32]) {
    let ok = rate.is_finite() && rate > 0.0;
    for (i, o) in out.iter_mut().enumerate() {
        let t = if ok { (i as f64 / rate).min(end) } else { 0.0 };
        *o = eval(keys, t as f32);
    }
}
