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

use myco_curve::{bake, SourceKey, INTERP_BEZIER};

pub use myco_curve::{eval, Key};

/// Floats per key.
pub const KEY_FLOATS: usize = 7;

/// The most keys a curve holds (`src/engine/animation/tracks.ts` `TRACK_LIMITS.keys`).
pub const MAX_KEYS: usize = 65_536;

/// Why keys were refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CurveError {
    /// Not a whole number of keys, a number that isn't finite, or keys out of x order.
    Malformed,
    /// More than [`MAX_KEYS`] keys.
    TooLarge,
}

/// Reads and bakes keys ([`KEY_FLOATS`] floats each) for [`eval`].
pub fn parse_keys(floats: &[f32]) -> Result<Vec<Key<f32>>, CurveError> {
    if !floats.len().is_multiple_of(KEY_FLOATS) {
        return Err(CurveError::Malformed);
    }
    let n = floats.len() / KEY_FLOATS;
    if n > MAX_KEYS {
        return Err(CurveError::TooLarge);
    }
    let mut src: Vec<SourceKey<f32>> = Vec::with_capacity(n);
    for k in floats.as_chunks::<KEY_FLOATS>().0 {
        if !k.iter().all(|v| v.is_finite()) {
            return Err(CurveError::Malformed);
        }
        if src.last().is_some_and(|p| p.0 > k[0]) {
            return Err(CurveError::Malformed);
        }
        let code = k[2];
        let interp = if code >= 0.0 && code <= INTERP_BEZIER as f32 && code == (code as u8) as f32 {
            code as u8
        } else {
            0
        };
        src.push((k[0], k[1], interp, [k[3], k[4], k[5], k[6]]));
    }
    let mut keys = vec![Key::default(); n];
    bake(&src, &mut keys);
    Ok(keys)
}

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
