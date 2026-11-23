//! Generators rendered offline (ADR 0360 §6, offline ABI 1.2): one generator voice of any kind, by the same
//! `audio_dsp::gen` kernels the core's generator voice runs, to mono `f32` at the requested rate. What the Bake and the
//! Babylon fallback's render-and-cache path play, and what the Studio's waveform preview draws.
//!
//! **Driven as the core drives it.** The core (`audio-core/src/generator.rs`, `voices::render_gen_voice`) starts a
//! voice at its kind's defaults, takes the PLAY's GEN (every parameter at once, the voice not sounding yet; a non-zero
//! seed re-seeds the noise), renders in quanta of [`QUANTUM`] frames from the voice's first frame, keys the voice off
//! at its `length` (the frame `round(length × rate)`, at least 1; splitting the quantum there) and ends it when the
//! kernel says it has ended (the amp envelope done after the key-off, a blip at the end of its envelope). This module
//! does exactly that, so **at pitch 1 with no lanes the output is bit-identical to the core voice's mono signal
//! before its gain** (`tests/golden_core.rs` renders both). Parameters pass through by **catalogue index** (the wire
//! order): `values[i]` is parameter `i` of the kind, whatever the kind holds (a parameter appended to the catalogue
//! needs nothing here).
//!
//! **Lanes** (ADR 0360 §6: "time-keyed parameter and pitch lanes"): a parameter lane replaces its parameter once a
//! quantum, read at the quantum's first frame in voice seconds and glided over the quantum (at once in the first),
//! as the core's AUTOMATE target 5 does; the pitch lane is a ratio read per frame, times the spec's pitch.
//!
//! **The spec** (`f64`, optional: null and length 0 mean pitch 1 and no lanes):
//!
//! ```text
//! header   version (1), pitch (a ratio, > 0), lanes A
//! A ×      target (a parameter index, or -1 for pitch), min, max, log (1: the curve is in log2 of the value),
//!          key count K, then K × (x, y, interp, inDx, inDy, outDx, outDy)   (x in voice seconds, `curve.ts`'s keys)
//! ```
//!
//! **The end.** The output stops where the voice ended (the samples after its last non-zero one dropped), or at
//! `frames` when it is still sounding there (an endless oscillator or synth renders exactly `frames`). A silence is
//! `length` seconds of zeros.

use audio_core::QUANTUM;
use audio_dsp::gen::{self, GenVoice};

use crate::lane::Lane;
use crate::render::Output;
use crate::spec::{Key, KEY_STRIDE, MAX_ITEMS};

/// The generate spec's version (its first value).
pub const VERSION: f64 = 1.0;
/// Values in the header.
pub const HEADER: usize = 3;
/// Values per lane before its keys.
pub const LANE_HEADER: usize = 5;
/// A lane's target for the pitch ratio.
pub const PITCH_TARGET: f64 = -1.0;
/// The most frames one call renders (a guard: 46 minutes at 96 kHz).
pub const MAX_FRAMES: usize = 1 << 28;

/// What a lane drives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Param(usize),
    Pitch,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GenLaneSpec {
    pub target: Target,
    pub min: f32,
    pub max: f32,
    pub log: bool,
    pub keys: Vec<Key>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GenSpec {
    pub pitch: f32,
    pub lanes: Vec<GenLaneSpec>,
}

impl Default for GenSpec {
    fn default() -> GenSpec {
        GenSpec { pitch: 1.0, lanes: Vec::new() }
    }
}

fn count(v: f64) -> Option<usize> {
    (v >= 0.0 && v.fract() == 0.0 && (v as usize) <= MAX_ITEMS).then_some(v as usize)
}

/// The spec in `s` (empty: the default), or `None` when it is malformed.
pub fn parse(s: &[f64]) -> Option<GenSpec> {
    if s.is_empty() {
        return Some(GenSpec::default());
    }
    if s.len() < HEADER || s[0] != VERSION || !(s[1] > 0.0 && s[1].is_finite()) {
        return None;
    }
    let na = count(s[2])?;
    let mut at = HEADER;
    let mut lanes = Vec::with_capacity(na.min(64));
    for _ in 0..na {
        let h = s.get(at..at.checked_add(LANE_HEADER)?)?;
        at += LANE_HEADER;
        let target = if h[0] == PITCH_TARGET {
            Target::Pitch
        } else {
            let i = count(h[0])?;
            if i >= gen::PARAMS_MAX {
                return None;
            }
            Target::Param(i)
        };
        let nk = count(h[4])?;
        let len = nk.checked_mul(KEY_STRIDE)?;
        let kv = s.get(at..at.checked_add(len)?)?;
        at += len;
        if nk == 0 {
            continue;
        }
        let keys = kv
            .chunks_exact(KEY_STRIDE)
            .map(|k| (k[0] as f32, k[1] as f32, if (0.0..=255.0).contains(&k[2]) { k[2] as u8 } else { 0 }, [k[3] as f32, k[4] as f32, k[5] as f32, k[6] as f32]))
            .collect();
        let (lo, hi) = (h[1] as f32, h[2] as f32);
        let (min, max) = if lo <= hi { (lo, hi) } else { (f32::NEG_INFINITY, f32::INFINITY) };
        lanes.push(GenLaneSpec { target, min, max, log: h[3] != 0.0, keys });
    }
    if at != s.len() {
        return None;
    }
    Some(GenSpec { pitch: s[1] as f32, lanes })
}

/// The index of `kind`'s `length` parameter, for the kinds the core keys off by it (oscillator and synth).
fn length_index(kind: u8) -> Option<usize> {
    match kind {
        gen::OSCILLATOR => Some(gen::osc_p::LENGTH),
        gen::SYNTH => Some(gen::synth_p::LENGTH),
        _ => None,
    }
}

/// `seconds` as a key-off frame, as the core works it out (`generator::frames`: rounded, at least 1).
#[inline]
fn keyoff_frame(seconds: f64, rate: f32) -> u64 {
    libm::round(seconds * rate as f64).clamp(1.0, u32::MAX as f64) as u64
}

struct LiveLane {
    target: Target,
    min: f32,
    max: f32,
    log: bool,
    lane: Lane,
}

impl LiveLane {
    fn at(&mut self, seconds: f32) -> f32 {
        let y = self.lane.at(seconds);
        let y = if self.log { libm::exp2f(y) } else { y };
        y.clamp(self.min, self.max)
    }
}

/// Renders a generator of `kind` (1 oscillator, 2 synth, 3 blip, 4 silence) with parameters `values` (catalogue order;
/// missing ones at their defaults, extra ones ignored), noise seed `seed` (0 keeps the start's seed, as GEN does), at
/// `rate` Hz, for at most `frames` frames. `None` for an unknown kind, a bad rate or too many frames.
pub fn generate(kind: u8, values: &[f32], seed: u32, rate: f32, frames: usize, spec: &GenSpec) -> Option<Output> {
    let specs = gen::params(kind);
    if specs.is_empty() || !(rate > 0.0 && rate.is_finite()) || frames > MAX_FRAMES {
        return None;
    }
    if kind == gen::SILENCE {
        let length = values.get(gen::silence_p::LENGTH).map_or(specs[gen::silence_p::LENGTH].default, |&v| gen::clamp_param(&specs[gen::silence_p::LENGTH], v));
        let n = (keyoff_frame(length as f64, rate) as usize).min(frames);
        return Some(Output { pcm: vec![0.0; n], frames: n, warnings: 0 });
    }
    let mut voice: Box<GenVoice> = Box::default();
    // The core's PLAY, then its GEN (the voice not started: every value at once; a non-zero seed re-seeds).
    voice.start(kind, rate, seed);
    for (i, &v) in values.iter().enumerate().take(specs.len()) {
        voice.set(i, v, 0);
    }
    if seed != 0 {
        voice.reseed(seed);
    }
    let keyoff_at = length_index(kind).map_or(0, |i| {
        let s = voice.value(i) as f64;
        if s > 0.0 {
            keyoff_frame(s, rate)
        } else {
            0
        }
    });
    let mut lanes: Vec<LiveLane> = spec.lanes.iter().map(|l| LiveLane { target: l.target, min: l.min, max: l.max, log: l.log, lane: Lane::new(l.keys.clone()) }).collect();
    let has_pitch_lane = lanes.iter().any(|l| l.target == Target::Pitch);
    let mut out = vec![0.0f32; frames];
    let mut steps = [spec.pitch; QUANTUM];
    let mut pos = 0usize;
    let mut keyed = false;
    let mut ended = false;
    let inv_rate = 1.0 / rate as f64;
    while pos < frames {
        let n = (frames - pos).min(QUANTUM);
        let t0 = pos as u64;
        // Parameter lanes: once a quantum at its first frame, glided over it (at once in the first), as AUTOMATE 5.
        for l in lanes.iter_mut() {
            if let Target::Param(i) = l.target {
                let y = l.at((t0 as f64 * inv_rate) as f32);
                voice.set(i, y, if pos == 0 { 0 } else { QUANTUM as u32 });
            }
        }
        if has_pitch_lane {
            for (j, step) in steps[..n].iter_mut().enumerate() {
                let t = ((t0 + j as u64) as f64 * inv_rate) as f32;
                *step = spec.pitch * lanes.iter_mut().filter(|l| l.target == Target::Pitch).fold(1.0f32, |r, l| r * l.at(t));
            }
        }
        // The key-off by length (`voices::render_gen_voice`): the frames of this quantum before it.
        let pending = !keyed && keyoff_at != 0;
        let split = if pending { keyoff_at.saturating_sub(t0).min(n as u64) as usize } else { n };
        let keys_off = split < n || (pending && t0 + n as u64 >= keyoff_at);
        let block = &mut out[pos..pos + n];
        let mut alive = voice.render(&steps[..split], &mut block[..split], false);
        if split < n {
            voice.key_off();
            alive = voice.render(&steps[split..n], &mut block[split..n], false);
        } else if keys_off {
            voice.key_off();
        }
        pos += n;
        if keys_off {
            keyed = true;
        }
        if !alive {
            ended = true;
            break;
        }
    }
    let mut len = pos;
    if ended {
        while len > 0 && out[len - 1] == 0.0 {
            len -= 1;
        }
    }
    out.truncate(len);
    Some(Output { frames: len, pcm: out, warnings: 0 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pitch_and_lanes_and_refuses_what_does_not_fit() {
        assert_eq!(parse(&[]), Some(GenSpec::default()));
        let mut s = vec![1.0, 2.0, 2.0];
        s.extend([2.0, 20.0, 20_000.0, 1.0, 2.0]);
        s.extend([0.0, 8.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 10.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
        s.extend([-1.0, 0.5, 2.0, 0.0, 1.0, 0.0, 1.5, 1.0, 0.0, 0.0, 0.0, 0.0]);
        let spec = parse(&s).expect("well formed");
        assert_eq!(spec.pitch, 2.0);
        assert_eq!(spec.lanes[0].target, Target::Param(2));
        assert!(spec.lanes[0].log);
        assert_eq!(spec.lanes[1].target, Target::Pitch);
        assert!(parse(&s[..s.len() - 1]).is_none(), "short");
        let mut v = s.clone();
        v[0] = 2.0;
        assert!(parse(&v).is_none(), "version");
        let mut p = s.clone();
        p[1] = 0.0;
        assert!(parse(&p).is_none(), "pitch");
        let mut t = s.clone();
        t[3] = 40.0;
        assert!(parse(&t).is_none(), "a parameter past the mask");
    }

    #[test]
    fn unknown_kinds_and_bad_rates_are_refused() {
        assert!(generate(0, &[], 1, 48_000.0, 10, &GenSpec::default()).is_none());
        assert!(generate(9, &[], 1, 48_000.0, 10, &GenSpec::default()).is_none());
        assert!(generate(gen::OSCILLATOR, &[], 1, 0.0, 10, &GenSpec::default()).is_none());
        assert!(generate(gen::OSCILLATOR, &[], 1, 48_000.0, MAX_FRAMES + 1, &GenSpec::default()).is_none());
    }
}
