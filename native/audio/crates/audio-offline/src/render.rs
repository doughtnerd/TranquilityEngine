//! The render: a sample's baked chain over its edited PCM (ADR 0342 "Baked effects are rendered
//! offline").
//!
//! The chain runs in **stages**. Consecutive streaming effects (the runtime kernels, fades and the
//! envelope) form one stage, run block by block over the stage's input and then over silence for
//! its tail; reverse and noise reduction need the whole signal and are a stage each. A bypassed
//! effect (`on` 0) is left out.
//!
//! - **Channels.** The kernels are stereo: channels run in pairs (0-1, 2-3, …), each pair with
//!   its own copy of the chain; an odd last channel runs as the left of a pair whose right is a
//!   copy of it, and only its left is kept.
//! - **Automation** (`fx:<id>:<param>` lanes over source seconds): each [`CONTROL`]-frame block
//!   evaluates the lanes at the source second of the block's end ([`TimeMap`]) and clamps each to
//!   its range; the effect glides to the new values across that block (per sample for the
//!   parameters a kernel ramps: gain, delay time, reverb size, pitch; filters are redesigned once
//!   a block).
//! - **Tails.** A stage with an effect that rings on (delay, reverb, chorus, pitch and formant
//!   shift) keeps running on silence after its input until its output has stayed below
//!   [`TAIL_FLOOR_DB`] for a hold (a quarter second, plus the longest delay when there is a delay),
//!   or the spec's tail cap past the input's end is reached (a warning). The output ends at the
//!   last sample above the floor, never before the input's end.
//! - **Fades and the envelope** shape the stage's input span: fade in from its first frame, fade
//!   out ending on its last; the envelope (`audio_dsp::adsr`, ADR 0362: the one a sequence clip's
//!   Amp envelope plays live) its attack, hold, decay and sustain from the first frame and its
//!   release ending on the last, the stages squeezed in that order into a short span. Both are
//!   silent after the input's end (a tail from an earlier effect in the same stage is cut there).
//! - **Plugin effects** (ADR 0352 §7) stream like the kernels, through the `myco_ext` import the
//!   caller binds (`audio_core::ext`, the same calls the core's chains make: an instance per channel
//!   pair, the glide, the flags and the budget). Each control block grants a quantum's shared fuel
//!   for its frames. A block the plugin can't run (not loaded, no free instance, a fault, the fuel)
//!   passes through dry and sets [`warn::PLUGIN_DRY`]. Their tails are rendered as a reverb's are.

use audio_core::ext;
use audio_dsp::adsr::Adsr;
use audio_dsp::fx::{self, delay::DELAY_MAX_MS, kind, Ctx, Effect, PARAMS};

use crate::lane::Lane;
use crate::nr;
use crate::spec::{FxSpec, Op, Spec};
use crate::timemap::TimeMap;

/// Frames per control block (automation and tail checks).
pub const CONTROL: usize = 64;
/// The level a tail must stay under to end, dBFS.
pub const TAIL_FLOOR_DB: f32 = -90.0;
/// The quiet time that ends a tail, seconds (plus the longest delay when the stage has a delay).
pub const TAIL_HOLD_S: f64 = 0.25;

/// Warning bits ([`Output::warnings`]).
pub mod warn {
    /// An effect type this build doesn't know passed the signal through.
    pub const UNKNOWN_TYPE: u32 = 1;
    /// A tail was still sounding at the tail cap and was cut there.
    pub const TAIL_CAPPED: u32 = 2;
    /// Noise reduction passed a signal too short to measure.
    pub const NOISE_TOO_SHORT: u32 = 4;
    /// A plugin effect passed one or more blocks through dry (not loaded, no instance, a fault).
    pub const PLUGIN_DRY: u32 = 8;
}

pub struct Output {
    /// Interleaved, `frames × channels`.
    pub pcm: Vec<f32>,
    pub frames: usize,
    pub warnings: u32,
}

/// One effect of a stage with its automation.
struct Item {
    fx: FxSpec,
    lanes: Vec<(usize, f32, f32, Lane)>,
}

/// Renders `input` (`channels` interleaved at `rate`) through `spec`'s chain.
pub fn render(input: &[f32], channels: usize, rate: f32, spec: &Spec) -> Output {
    let channels = channels.max(1);
    let frames = input.len() / channels;
    let mut buf = input[..frames * channels].to_vec();
    let mut len = frames;
    let mut warnings = 0;
    let mut time = TimeMap::new(spec.segments.clone(), rate as f64);
    let mut lanes: Vec<Option<Vec<(usize, f32, f32, Lane)>>> = (0..spec.effects.len()).map(|_| Some(Vec::new())).collect();
    for l in &spec.lanes {
        if let Some(Some(v)) = lanes.get_mut(l.effect) {
            v.push((l.param, l.min, l.max, Lane::new(l.keys.clone())));
        }
    }
    let mut stage: Vec<Item> = Vec::new();
    for (index, fx) in spec.effects.iter().enumerate() {
        if !fx.on {
            continue;
        }
        let item = Item { fx: *fx, lanes: lanes[index].take().unwrap_or_default() };
        match fx.op {
            Op::Stream(_) | Op::Fades | Op::Envelope | Op::Plugin(_) => stage.push(item),
            Op::Unknown => warnings |= warn::UNKNOWN_TYPE,
            Op::Reverse | Op::NoiseReduction => {
                if !stage.is_empty() {
                    let (b, n, w) = run_stage(&buf, len, channels, rate, &mut stage, &time, spec.tail_cap);
                    (buf, len, warnings) = (b, n, warnings | w);
                    stage.clear();
                }
                if fx.op == Op::Reverse {
                    reverse(&mut buf, channels);
                    time.reverse(len);
                } else {
                    let mut item = item;
                    warnings |= denoise(&mut buf, len, channels, rate, &mut item, &time);
                }
            }
        }
    }
    if !stage.is_empty() {
        let (b, n, w) = run_stage(&buf, len, channels, rate, &mut stage, &time, spec.tail_cap);
        (buf, len, warnings) = (b, n, warnings | w);
    }
    Output { pcm: buf, frames: len, warnings }
}

/// Reverses the frames of `buf` (interleaved).
fn reverse(buf: &mut [f32], channels: usize) {
    let frames = buf.len() / channels;
    for i in 0..frames / 2 {
        let j = frames - 1 - i;
        for c in 0..channels {
            buf.swap(i * channels + c, j * channels + c);
        }
    }
}

/// The parameters of `item` at source second `t`: its own, lanes applied.
fn params_at(item: &mut Item, t: f32) -> [f32; PARAMS] {
    let mut p = item.fx.p;
    for (param, min, max, lane) in item.lanes.iter_mut() {
        let v = lane.at(t);
        p[*param] = if v.is_finite() { v.clamp(*min, *max) } else { p[*param] };
    }
    p
}

fn denoise(buf: &mut [f32], len: usize, channels: usize, rate: f32, item: &mut Item, time: &TimeMap) -> u32 {
    let mut channel = vec![0.0f32; len];
    let mut short = false;
    for c in 0..channels {
        for f in 0..len {
            channel[f] = buf[f * channels + c];
        }
        let mut amount = |f: usize| params_at(item, time.at(f as f64) as f32)[0] / 100.0;
        if nr::process(&mut channel, rate, &mut amount) {
            for f in 0..len {
                buf[f * channels + c] = channel[f];
            }
        } else {
            short = true;
        }
    }
    if short {
        warn::NOISE_TOO_SHORT
    } else {
        0
    }
}

/// True when an effect of `op` rings on after its input stops.
fn rings(op: Op) -> bool {
    matches!(op, Op::Stream(kind::DELAY | kind::REVERB | kind::CHORUS | kind::PITCH | kind::FORMANT) | Op::Plugin(_))
}

/// The gain of the fades (`in_ms`, `out_ms`) at frame `f` of an input of `len` frames.
pub fn fade_gain(f: usize, len: usize, rate: f32, in_ms: f32, out_ms: f32) -> f32 {
    if f >= len {
        return 0.0;
    }
    let fin = (in_ms.max(0.0) * rate / 1000.0) as f64;
    let fout = (out_ms.max(0.0) * rate / 1000.0) as f64;
    let mut g = 1.0f64;
    if (f as f64) < fin {
        g *= f as f64 / fin;
    }
    let left = (len - f) as f64;
    if left < fout {
        g *= left / fout;
    }
    g as f32
}

/// The catalogue's `envelope` (ADR 0362: attack, hold, decay ms, sustain %, release ms, in the catalogue's order) over an
/// input of `len` frames at `rate`: `audio_dsp::adsr`'s envelope fitted to the span (the stages squeezed in order, the
/// release ending on the last frame), the same numbers a sequence clip's Amp envelope plays live (the core's
/// AMP_ENVELOPE, whose frames the runtime works out the same way).
pub fn envelope_of(p: &[f32; PARAMS], len: usize, rate: f32) -> Adsr {
    let frames = |ms: f32| -> u32 { (ms.max(0.0) as f64 * rate as f64 / 1000.0).round().min(u32::MAX as f64 - 1.0) as u32 };
    let len = len.min(u32::MAX as usize - 1) as u32;
    Adsr::fit(frames(p[0]), frames(p[1]), frames(p[2]), (p[3] / 100.0).clamp(0.0, 1.0), frames(p[4]), Some(len))
}

/// Runs one streaming stage over `len` frames of `buf`; returns the output, its length and warnings.
fn run_stage(buf: &[f32], len: usize, channels: usize, rate: f32, items: &mut [Item], time: &TimeMap, tail_cap: f64) -> (Vec<f32>, usize, u32) {
    let pairs = channels.div_ceil(2);
    let any_ring = items.iter().any(|i| rings(i.fx.op));
    let has_delay = items.iter().any(|i| i.fx.op == Op::Stream(kind::DELAY));
    let hold = ((TAIL_HOLD_S + if has_delay { DELAY_MAX_MS as f64 / 1000.0 } else { 0.0 }) * rate as f64) as usize;
    let cap = len + (tail_cap * rate as f64) as usize;
    let floor = libm::powf(10.0, TAIL_FLOOR_DB / 20.0);

    // Each pair's copy of the chain: the effect slot and its memory (sized for the longest delay).
    let start = time.at(0.0) as f32;
    let mut slots: Vec<Vec<(Effect, Vec<f32>)>> = (0..pairs)
        .map(|_| {
            items
                .iter_mut()
                .map(|item| {
                    let mut e = Effect::default();
                    let mut mem = Vec::new();
                    if let Op::Plugin(pe) = item.fx.op {
                        let p = params_at(item, start);
                        e.configure(kind::PLUGIN_BASE + pe, true, &p, rate);
                        ext::configure(&mut e, true, 0, 0);
                    }
                    if let Op::Stream(k) = item.fx.op {
                        let p = params_at(item, start);
                        e.configure(k, true, &p, rate);
                        let mut sizing = p;
                        if k == kind::DELAY {
                            sizing[0] = DELAY_MAX_MS;
                        }
                        mem = vec![0.0f32; fx::mem_floats(k, &sizing, rate)];
                    }
                    (e, mem)
                })
                .collect()
        })
        .collect();

    let mut out: Vec<f32> = Vec::with_capacity(len * channels);
    let (mut l, mut r) = ([0.0f32; CONTROL], [0.0f32; CONTROL]);
    let ctx = Ctx::default();
    let mut pos = 0usize;
    let mut loud_end = len; // one past the last frame above the floor (at least the input's end)
    let mut capped = false;
    let mut dry = false;
    let any_plugin = items.iter().any(|i| matches!(i.fx.op, Op::Plugin(_)));
    loop {
        if pos >= len {
            if !any_ring || pos >= loud_end + hold {
                break;
            }
            if pos >= cap {
                capped = true;
                break;
            }
        }
        let n = if pos < len { CONTROL.min(len - pos) } else { CONTROL.min(cap - pos) };
        // Automation at the block's end.
        let t = time.at((pos + n) as f64) as f32;
        let mut params: Vec<Option<[f32; PARAMS]>> = Vec::with_capacity(items.len());
        for item in items.iter_mut() {
            params.push(if item.lanes.is_empty() { None } else { Some(params_at(item, t)) });
        }
        for (pair, chain) in slots.iter_mut().enumerate() {
            let (c0, c1) = (2 * pair, (2 * pair + 1).min(channels - 1));
            for i in 0..n {
                let f = pos + i;
                if f < len {
                    l[i] = buf[f * channels + c0];
                    r[i] = buf[f * channels + c1];
                } else {
                    l[i] = 0.0;
                    r[i] = 0.0;
                }
            }
            let mut fuel = ext::Fuel::quantum(n);
            for (k, (item, (e, mem))) in items.iter().zip(chain.iter_mut()).enumerate() {
                match item.fx.op {
                    Op::Plugin(pe) => {
                        if let Some(p) = &params[k] {
                            e.configure(kind::PLUGIN_BASE + pe, true, p, rate);
                            if e.running != 0 && e.glide > 0 {
                                e.glide = n as u32;
                            }
                        }
                        if ext::process(e, &mut l[..n], &mut r[..n], &mut fuel) < 0 {
                            dry = true;
                        }
                    }
                    Op::Stream(kd) => {
                        if let Some(p) = &params[k] {
                            e.configure(kd, true, p, rate);
                            if e.running != 0 && e.glide > 0 {
                                e.glide = n as u32; // land on the block's end value
                            }
                        }
                        e.process(mem, &mut l[..n], &mut r[..n], &ctx);
                    }
                    Op::Fades => {
                        let p = item.fx.p;
                        for i in 0..n {
                            let g = fade_gain(pos + i, len, rate, p[0], p[1]);
                            l[i] *= g;
                            r[i] *= g;
                        }
                    }
                    Op::Envelope => {
                        // Silent past the input's end: its key-off ends the release on the last frame.
                        envelope_of(&item.fx.p, len, rate).apply(pos as u64, &mut l[..n], &mut r[..n]);
                    }
                    _ => {}
                }
            }
            if pair == 0 {
                out.resize((pos + n) * channels, 0.0);
            }
            for i in 0..n {
                let f = pos + i;
                out[f * channels + c0] = l[i];
                if c1 != c0 {
                    out[f * channels + c1] = r[i];
                }
                if f >= len && (l[i].abs() > floor || (c1 != c0 && r[i].abs() > floor)) {
                    loud_end = loud_end.max(f + 1);
                }
            }
        }
        pos += n;
    }
    // The plugin instances go back to the host: a sweep that lists none releases every handle.
    if any_plugin {
        ext::sweep(|_| {});
    }
    // A capped tail keeps every frame to the cap; one that died away ends at its last audible frame.
    let frames = if capped { pos } else if any_ring { loud_end.min(pos) } else { len };
    out.truncate(frames * channels);
    (out, frames, (if capped { warn::TAIL_CAPPED } else { 0 }) | (if dry { warn::PLUGIN_DRY } else { 0 }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::{LaneSpec, CATALOGUE};

    const RATE: f32 = 48_000.0;

    fn ty(op: Op) -> Op {
        assert!(CATALOGUE.contains(&op));
        op
    }

    fn fx(op: Op, p: &[f32]) -> FxSpec {
        let mut q = [0.0; PARAMS];
        q[..p.len()].copy_from_slice(p);
        FxSpec { op: ty(op), on: true, p: q }
    }

    fn spec(effects: Vec<FxSpec>, lanes: Vec<LaneSpec>) -> Spec {
        Spec { effects, lanes, segments: vec![], tail_cap: 10.0 }
    }

    fn impulse(frames: usize, channels: usize) -> Vec<f32> {
        let mut v = vec![0.0; frames * channels];
        for c in 0..channels {
            v[c] = 1.0;
        }
        v
    }

    #[test]
    fn an_empty_chain_is_the_identity() {
        let input: Vec<f32> = (0..1000).map(|i| (i as f32 * 0.01).sin()).collect();
        let out = render(&input, 2, RATE, &spec(vec![], vec![]));
        assert_eq!((out.frames, out.pcm.as_slice(), out.warnings), (500, input.as_slice(), 0));
    }

    #[test]
    fn gain_automation_moves_the_gain_over_source_time() {
        // One second of DC at 0.5, mono; a gain lane from −24 dB at 0 s to 0 dB at 1 s.
        let input = vec![0.5f32; RATE as usize];
        let lane = LaneSpec { effect: 0, param: 0, min: -24.0, max: 24.0, keys: vec![(0.0, -24.0, 0, [0.0; 4]), (1.0, 0.0, 0, [0.0; 4])] };
        let out = render(&input, 1, RATE, &spec(vec![fx(Op::Stream(kind::GAIN), &[-6.0])], vec![lane]));
        assert_eq!(out.frames, input.len());
        let db = |f: usize| 20.0 * (out.pcm[f] / 0.5).log10();
        // Block-accurate: within a block's worth of the ramp's slope (24 dB/s × 64/48k ≈ 0.03 dB).
        for &(f, want) in &[(12_000usize, -18.0f32), (24_000, -12.0), (36_000, -6.0), (47_000, -0.5)] {
            assert!((db(f) - want).abs() < 0.1, "frame {f}: {} dB, want {want}", db(f));
        }
        // Without the lane the gain is the effect's own −6 dB.
        let flat = render(&input, 1, RATE, &spec(vec![fx(Op::Stream(kind::GAIN), &[-6.0])], vec![]));
        assert!((20.0 * (flat.pcm[24_000] / 0.5).log10() + 6.0).abs() < 1e-3);
    }

    #[test]
    fn lanes_follow_the_time_map_through_trims_and_gaps() {
        // The output starts at source second 0.5 (a trim): the lane's value there, not at 0.
        let input = vec![0.5f32; 4800];
        let lane = LaneSpec { effect: 0, param: 0, min: -24.0, max: 24.0, keys: vec![(0.0, -24.0, 0, [0.0; 4]), (1.0, 0.0, 0, [0.0; 4])] };
        let mut s = spec(vec![fx(Op::Stream(kind::GAIN), &[0.0])], vec![lane]);
        s.segments = vec![(0.0, 0.5)];
        let out = render(&input, 1, RATE, &s);
        let db = 20.0 * (out.pcm[2400] / 0.5).log10();
        assert!((db - (-24.0 + 24.0 * 0.55)).abs() < 0.2, "{db}");
    }

    #[test]
    fn a_delay_echoes_at_its_time_and_its_tail_is_rendered() {
        // A 10 ms impulse sample through a 300 ms delay, no feedback, 50 % mix.
        let frames = 480;
        let input = impulse(frames, 2);
        let out = render(&input, 2, RATE, &spec(vec![fx(Op::Stream(kind::DELAY), &[300.0, 0.0, 50.0])], vec![]));
        let echo = (0.3 * RATE) as usize;
        assert!(out.frames > echo, "the tail holds the echo: {} frames", out.frames);
        let (peak_at, peak) = (frames..out.frames).map(|f| (f, out.pcm[f * 2].abs())).fold((0, 0.0f32), |a, b| if b.1 > a.1 { b } else { a });
        assert!((peak_at as i64 - echo as i64).abs() <= 1, "echo at {peak_at}, want {echo}");
        assert!((peak - 0.5).abs() < 0.05, "echo level {peak}");
        assert!(out.frames < echo + 4_800, "the tail ends after the echo dies: {}", out.frames);
        assert_eq!(out.warnings, 0);
    }

    #[test]
    fn a_reverb_tail_runs_past_the_end_until_it_falls_below_the_floor_or_the_cap() {
        let input = impulse(4_800, 2);
        let out = render(&input, 2, RATE, &spec(vec![fx(Op::Stream(kind::REVERB), &[0.6, 1.5, 50.0])], vec![]));
        assert!(out.frames > 4_800 + RATE as usize / 2, "a 1.5 s decay rings well past the end: {}", out.frames);
        let last = &out.pcm[(out.frames - 64) * 2..];
        assert!(last.iter().any(|v| v.abs() > 0.0));
        let mut capped = spec(vec![fx(Op::Stream(kind::REVERB), &[1.0, 20.0, 100.0])], vec![]);
        capped.tail_cap = 0.5;
        let out = render(&input, 2, RATE, &capped);
        assert_eq!(out.frames, 4_800 + RATE as usize / 2);
        assert_eq!(out.warnings, warn::TAIL_CAPPED);
    }

    #[test]
    fn reverse_reverses_and_mirrors_the_automation_time() {
        let input: Vec<f32> = (0..1000).map(|i| i as f32 / 1000.0).collect();
        let out = render(&input, 1, RATE, &spec(vec![fx(Op::Reverse, &[])], vec![]));
        assert_eq!(out.frames, 1000);
        assert_eq!(out.pcm[0], 0.999);
        assert_eq!(out.pcm[999], 0.0);
        // After a reverse, a gain lane reads the source second each frame came from.
        let ones = vec![1.0f32; 4800];
        let lane = LaneSpec { effect: 1, param: 0, min: -60.0, max: 24.0, keys: vec![(0.0, -60.0, 1, [0.0; 4]), (0.05, 0.0, 0, [0.0; 4])] };
        let out = render(&ones, 1, RATE, &spec(vec![fx(Op::Reverse, &[]), fx(Op::Stream(kind::GAIN), &[0.0])], vec![lane]));
        // Source 0..0.05 s (step at −60 dB) ends up last.
        assert!((out.pcm[100] - 1.0).abs() < 1e-3 && out.pcm[4700] < 0.01, "{} {}", out.pcm[100], out.pcm[4700]);
    }

    #[test]
    fn stereo_and_odd_channel_counts_keep_their_channels() {
        let input: Vec<f32> = (0..300).map(|i| [0.1, 0.2, 0.3][i % 3]).collect();
        let out = render(&input, 3, RATE, &spec(vec![fx(Op::Stream(kind::GAIN), &[6.0])], vec![]));
        let g = libm::powf(10.0, 6.0 / 20.0);
        assert_eq!(out.frames, 100);
        for f in 0..100 {
            for (c, v) in [0.1f32, 0.2, 0.3].iter().enumerate() {
                assert!((out.pcm[f * 3 + c] - v * g).abs() < 1e-5);
            }
        }
    }

    #[test]
    fn fades_and_the_envelope_shape_the_input_span() {
        let input = vec![1.0f32; 48_000];
        let out = render(&input, 1, RATE, &spec(vec![fx(Op::Fades, &[100.0, 200.0])], vec![]));
        assert_eq!(out.pcm[0], 0.0);
        assert!((out.pcm[2_400] - 0.5).abs() < 1e-3, "half way into the fade in");
        assert_eq!(out.pcm[24_000], 1.0);
        assert!((out.pcm[48_000 - 4_800] - 0.5).abs() < 1e-3, "half way through the fade out");
        // Attack 10 ms, hold 5 ms, decay 10 ms to 50 %, release 100 ms (ADR 0362's order).
        let env = render(&input, 1, RATE, &spec(vec![fx(Op::Envelope, &[10.0, 5.0, 10.0, 50.0, 100.0])], vec![]));
        assert!((env.pcm[240] - 0.5).abs() < 1e-3, "attack");
        assert!((env.pcm[480] - 1.0).abs() < 1e-3, "peak");
        assert!((env.pcm[700] - 1.0).abs() < 1e-3, "hold");
        assert!((env.pcm[10_000] - 0.5).abs() < 1e-3, "sustain");
        assert!((env.pcm[48_000 - 2_400] - 0.25).abs() < 1e-3, "half way through the release");
        // Every frame is `audio_dsp::adsr`'s, fitted to the input (what a clip's AMP_ENVELOPE plays).
        let e = Adsr::fit(480, 240, 480, 0.5, 4_800, Some(48_000));
        assert!(env.pcm.iter().enumerate().all(|(t, &x)| x.to_bits() == e.gain(t as u64).to_bits()));
        // A span shorter than the stages squeezes them in order: the release goes first.
        let short = render(&input[..960], 1, RATE, &spec(vec![fx(Op::Envelope, &[10.0, 5.0, 10.0, 50.0, 100.0])], vec![]));
        let e = Adsr::fit(480, 240, 480, 0.5, 4_800, Some(960));
        assert_eq!((e.decay, e.release), (240, 0));
        assert!(short.pcm.iter().enumerate().all(|(t, &x)| x.to_bits() == e.gain(t as u64).to_bits()));
    }

    #[test]
    fn bypassed_and_unknown_effects_pass_through_and_unknown_ones_warn() {
        let input = vec![0.5f32; 256];
        let mut off = fx(Op::Stream(kind::GAIN), &[-20.0]);
        off.on = false;
        let unknown = FxSpec { op: Op::Unknown, on: true, p: [0.0; PARAMS] };
        let out = render(&input, 1, RATE, &spec(vec![off, unknown], vec![]));
        assert_eq!(out.pcm, input);
        assert_eq!(out.warnings, warn::UNKNOWN_TYPE);
    }

    /// A `myco_ext` host for the tests: plugin effect 0 scales by its parameter 15 (the 16th, past the old 8)
    /// at the block's end; it counts the instances it gave and has back.
    struct ScaleHost {
        given: std::rc::Rc<std::cell::Cell<i32>>,
        next: u32,
    }

    impl ext::Host for ScaleHost {
        fn acquire(&mut self, e: u32) -> u32 {
            if e != 0 {
                return 0;
            }
            self.given.set(self.given.get() + 1);
            self.next += 1;
            self.next
        }
        fn release(&mut self, _handle: u32) {
            self.given.set(self.given.get() - 1);
        }
        fn describe(&mut self, _e: u32, what: u32) -> u32 {
            if what == ext::DESCRIBE_BUDGET {
                10
            } else {
                1 << (16 + 15) // parameter 15 steps
            }
        }
        fn process(&mut self, _h: u32, l: &mut [f32], r: &mut [f32], _p0: &[f32; 16], p1: &[f32; 16], _flags: u32, fuel: u32) -> i32 {
            if fuel == 0 {
                return -3;
            }
            for x in l.iter_mut().chain(r.iter_mut()) {
                *x *= p1[15];
            }
            (l.len() as i32) << 1
        }
        fn sweep(&mut self, handles: &[u32], last: bool) {
            if last && handles.is_empty() {
                self.given.set(0);
            }
        }
    }

    #[test]
    fn a_plugin_effect_runs_through_the_import_with_sixteen_parameters_and_gives_its_instances_back() {
        let given = std::rc::Rc::new(std::cell::Cell::new(0));
        let before = ext::install(Some(Box::new(ScaleHost { given: given.clone(), next: 0 })));
        let input = vec![0.5f32; 3 * 1000];
        let mut p = [0.0f32; 16];
        p[15] = 0.5;
        let out = render(&input, 3, RATE, &spec(vec![FxSpec { op: Op::Plugin(0), on: true, p }], vec![]));
        assert_eq!(out.frames, 1000, "a silent tail ends at the input's end");
        assert!(out.pcm.iter().all(|v| (v - 0.25).abs() < 1e-6), "every channel (a pair and an odd one) scaled");
        assert_eq!(out.warnings, 0);
        assert_eq!(given.get(), 0, "both pairs' instances went back");
        // Effect 1 has no instance from the host: its blocks pass dry, with the warning.
        let out = render(&input, 3, RATE, &spec(vec![FxSpec { op: Op::Plugin(1), on: true, p }], vec![]));
        assert_eq!(out.pcm, input);
        assert_eq!(out.warnings, warn::PLUGIN_DRY);
        ext::install(before);
        // No host at all (nothing bound): dry too.
        let out = render(&input, 3, RATE, &spec(vec![FxSpec { op: Op::Plugin(0), on: true, p }], vec![]));
        assert_eq!((out.pcm == input, out.warnings), (true, warn::PLUGIN_DRY));
    }

    #[test]
    fn a_lowpass_cutoff_lane_changes_the_tone_over_time() {
        // White-ish noise; the cutoff sweeps 200 Hz → 20 kHz: the first half is much darker.
        let mut seed = 99u32;
        let input: Vec<f32> = (0..48_000)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5
            })
            .collect();
        let lane = LaneSpec { effect: 0, param: 0, min: 20.0, max: 20_000.0, keys: vec![(0.0, 200.0, 0, [0.0; 4]), (0.5, 200.0, 0, [0.0; 4]), (0.5, 20_000.0, 0, [0.0; 4])] };
        let out = render(&input, 1, RATE, &spec(vec![fx(Op::Stream(kind::LOWPASS), &[20_000.0, 0.0, 0.0])], vec![lane]));
        let diff = |a: usize, b: usize| (a + 1..b).map(|f| (out.pcm[f] - out.pcm[f - 1]).powi(2)).sum::<f32>();
        assert!(diff(4_000, 20_000) * 20.0 < diff(28_000, 44_000), "{} vs {}", diff(4_000, 20_000), diff(28_000, 44_000));
    }
}
