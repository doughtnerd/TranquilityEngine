//! The render spec: what the TypeScript side (`src/engine/audio/sample/sampleRender.ts`) sends,
//! as one `f64` array (frames past 2^24 stay exact).
//!
//! ```text
//! header   version (1), effects E, lanes A, time segments T, tail cap (seconds past the end)
//! E ×      type (the catalogue's `EFFECT_TYPES` index), on (0/1), p[0..8] (the catalogue's
//!          parameters in its order, defaults filled in, padded with 0)
//! T ×      output frame, source seconds   (sorted by frame; see `timemap.rs`)
//! A ×      effect index, parameter index, min, max, key count K, then K × (x, y, interp,
//!          inDx, inDy, outDx, outDy)   (x in source seconds, `curve.ts`'s keys)
//! ```
//!
//! A malformed spec (short, a count that doesn't fit, a wrong version) is refused whole: `parse`
//! returns `None`. Values are taken as sent; the kernels clamp their own parameters and each
//! lane is clamped to its `min..max`.

use audio_dsp::fx::{kind, PARAMS};

/// The spec's version (its first value).
pub const VERSION: f64 = 1.0;
/// Values in the header.
pub const HEADER: usize = 5;
/// Parameters per effect in a spec: 8, the catalogue's built-ins' most. The core's records carry 16 from ABI
/// 5.0 (`PARAMS`, ADR 0338); plugin effects in offline renders are B5's, which widens this with its spec version.
pub const SPEC_PARAMS: usize = 8;
/// Values per effect.
pub const EFFECT_STRIDE: usize = 2 + SPEC_PARAMS;
/// Values per lane before its keys.
pub const LANE_HEADER: usize = 5;
/// Values per key.
pub const KEY_STRIDE: usize = 7;
/// The most effects, lanes, segments or keys a spec may name (a guard against nonsense counts).
pub const MAX_ITEMS: usize = 1 << 20;

/// What an effect of the chain does here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    /// A runtime kernel (`audio_dsp::fx::kind`), run block by block.
    Stream(u32),
    /// Offline only: the catalogue's `fades` (in, out ms).
    Fades,
    /// The catalogue's `envelope` (ADSR: attack ms, decay ms, sustain %, release ms).
    Envelope,
    /// Offline only: `noiseReduction` (amount %), a spectral gate over the whole signal.
    NoiseReduction,
    /// Offline only: `reverse`.
    Reverse,
    /// A type index this build doesn't know: passed through, with a warning.
    Unknown,
}

/// The catalogue's types in `EFFECT_TYPES` order (`src/engine/audio/effects/types.ts`) and what
/// each one does offline. A new catalogue type is appended there and here.
pub const CATALOGUE: [Op; 20] = [
    Op::Stream(kind::EQ),         // eq
    Op::Stream(kind::LOWPASS),    // lowpass
    Op::Stream(kind::HIGHPASS),   // highpass
    Op::Stream(kind::BANDPASS),   // bandpass
    Op::Stream(kind::COMPRESSOR), // compressor
    Op::Stream(kind::SIDECHAIN),  // sidechainCompressor (no key offline: unity)
    Op::Stream(kind::LIMITER),    // limiter
    Op::Stream(kind::GAIN),       // gain
    Op::Stream(kind::SATURATION), // saturation
    Op::Stream(kind::DISTORTION), // distortion
    Op::Stream(kind::BITCRUSH),   // bitcrush
    Op::Stream(kind::FORMANT),    // formantShift
    Op::Stream(kind::PITCH),      // pitchShift
    Op::Stream(kind::CHORUS),     // chorus
    Op::Stream(kind::DELAY),      // delay
    Op::Stream(kind::REVERB),     // reverb
    Op::Envelope,                 // envelope
    Op::Fades,                    // fades
    Op::NoiseReduction,           // noiseReduction
    Op::Reverse,                  // reverse
];

/// The op of catalogue type index `ty`.
pub fn op_of(ty: f64) -> Op {
    if ty >= 0.0 && ty.fract() == 0.0 && (ty as usize) < CATALOGUE.len() {
        CATALOGUE[ty as usize]
    } else {
        Op::Unknown
    }
}

/// One effect of the chain.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FxSpec {
    pub op: Op,
    pub on: bool,
    pub p: [f32; PARAMS],
}

/// A curve key as `audio_core::automation::Curve::from_keys` takes it.
pub type Key = (f32, f32, u8, [f32; 4]);

/// One automation lane: a parameter of an effect over source seconds.
#[derive(Clone, Debug, PartialEq)]
pub struct LaneSpec {
    pub effect: usize,
    pub param: usize,
    pub min: f32,
    pub max: f32,
    pub keys: Vec<Key>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Spec {
    pub effects: Vec<FxSpec>,
    pub lanes: Vec<LaneSpec>,
    /// `(output frame, source seconds)`, sorted by frame.
    pub segments: Vec<(f64, f64)>,
    /// Seconds a tail may run past the end of its input.
    pub tail_cap: f64,
}

fn count(v: f64) -> Option<usize> {
    (v >= 0.0 && v.fract() == 0.0 && (v as usize) <= MAX_ITEMS).then_some(v as usize)
}

fn interp(v: f64) -> u8 {
    if v >= 0.0 && v <= 255.0 {
        v as u8
    } else {
        0
    }
}

/// The spec in `s`, or `None` when it is malformed.
pub fn parse(s: &[f64]) -> Option<Spec> {
    if s.len() < HEADER || s[0] != VERSION {
        return None;
    }
    let (ne, na, nt) = (count(s[1])?, count(s[2])?, count(s[3])?);
    let tail_cap = if s[4].is_finite() { s[4].clamp(0.0, 600.0) } else { 0.0 };
    let mut at = HEADER;
    let take = |at: &mut usize, n: usize| -> Option<core::ops::Range<usize>> {
        let end = at.checked_add(n)?;
        if end > s.len() {
            return None;
        }
        let r = *at..end;
        *at = end;
        Some(r)
    };
    let mut effects = Vec::with_capacity(ne);
    for _ in 0..ne {
        let v = &s[take(&mut at, EFFECT_STRIDE)?];
        let mut p = [0.0f32; PARAMS];
        for (i, x) in p.iter_mut().take(SPEC_PARAMS).enumerate() {
            *x = v[2 + i] as f32;
        }
        effects.push(FxSpec { op: op_of(v[0]), on: v[1] != 0.0, p });
    }
    let mut segments = Vec::with_capacity(nt);
    for _ in 0..nt {
        let v = &s[take(&mut at, 2)?];
        if !(v[0].is_finite() && v[1].is_finite()) {
            return None;
        }
        segments.push((v[0], v[1]));
    }
    segments.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut lanes = Vec::with_capacity(na);
    for _ in 0..na {
        let h = &s[take(&mut at, LANE_HEADER)?];
        let (effect, param, nk) = (count(h[0])?, count(h[1])?, count(h[4])?);
        if effect >= ne || param >= PARAMS {
            return None;
        }
        let kv = &s[take(&mut at, nk.checked_mul(KEY_STRIDE)?)?];
        let keys = kv
            .chunks_exact(KEY_STRIDE)
            .map(|k| (k[0] as f32, k[1] as f32, interp(k[2]), [k[3] as f32, k[4] as f32, k[5] as f32, k[6] as f32]))
            .collect();
        let (lo, hi) = (h[2] as f32, h[3] as f32);
        let (min, max) = if lo <= hi { (lo, hi) } else { (f32::NEG_INFINITY, f32::INFINITY) };
        lanes.push(LaneSpec { effect, param, min, max, keys });
    }
    if at != s.len() {
        return None;
    }
    Some(Spec { effects, lanes, segments, tail_cap })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_effects_segments_and_lanes_and_refuses_what_does_not_fit() {
        let mut s = vec![1.0, 2.0, 1.0, 1.0, 10.0];
        s.extend([7.0, 1.0, -6.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]); // gain
        s.extend([19.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]); // reverse, off
        s.extend([0.0, 0.5]);
        s.extend([0.0, 0.0, -24.0, 24.0, 2.0]);
        s.extend([0.0, -24.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 5.0, 0.0, 0.0, 0.0, 0.0]);
        let spec = parse(&s).expect("well formed");
        assert_eq!(spec.effects[0].op, Op::Stream(kind::GAIN));
        assert_eq!(spec.effects[0].p[0], -6.0);
        assert_eq!((spec.effects[1].op, spec.effects[1].on), (Op::Reverse, false));
        assert_eq!(spec.segments, vec![(0.0, 0.5)]);
        assert_eq!(spec.lanes[0].keys.len(), 2);
        assert_eq!(spec.lanes[0].keys[1].2, 5);
        assert!(parse(&s[..s.len() - 1]).is_none(), "short");
        let mut long = s.clone();
        long.push(0.0);
        assert!(parse(&long).is_none(), "trailing values");
        let mut v2 = s.clone();
        v2[0] = 2.0;
        assert!(parse(&v2).is_none(), "version");
        assert_eq!(op_of(42.0), Op::Unknown);
    }
}
