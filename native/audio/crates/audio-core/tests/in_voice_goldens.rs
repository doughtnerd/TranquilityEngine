//! Z3, the in-voice goldens (0166 M4-0; api-and-models §9 "Golden", §10 row Z3; architecture §4.4).
//!
//! Each scene is rendered natively here and checked three ways:
//! - **against the offline reference** (`in_voice_reference`): a class G scene's output nulls to
//!   1e-5 against the same-knot piecewise-linear control-rate law and to 1e-4 against the exact
//!   curve (README "Notes for the build"); a class S scene with a closed form (pitch, pause, seek,
//!   loop, bus move: `class_s.rs`' expectations on an integer-built clip) to 1e-6;
//! - **its split counters**: `splitQuanta` reads 0 in every scene (M4-0's exit check), and
//!   `voiceSplits` what the in-voice design says;
//! - **its fixture**, `src/plugins/audio/runtime/golden/m4-<scene>.json`: the scene's records as
//!   bytes, its clips, its output's FNV-1a 64 digest and counters. The wasm half
//!   (`golden/audioGoldenM4.test.ts`) replays the fixture on the loopback host with the real wasm
//!   and must get the same digest (**native equals wasm**). `UPDATE_GOLDENS=1 cargo test -p
//!   audio-core --test in_voice_goldens` rewrites the fixtures; without it a fixture that differs
//!   from the scene's fails.
//!
//! Every record lands at sample [`K`] (50) of its quantum unless a scene says otherwise.

mod common;
mod in_voice_reference;

use audio_core::{status, voices, QUANTUM};
use audio_wire::generated as wire;
use common::*;
use in_voice_reference::{max_error, shape, Fade, Law};

const K: usize = 50;
const Q: usize = QUANTUM;
const V1: u32 = 0x0001_0001;
const V2: u32 = 0x0001_0002;
const V3: u32 = 0x0001_0003;
/// The integer-built noise clip (fixture fill `lcg`).
const NOISE: u32 = 2;
const NOISE_FRAMES: usize = 4_000;
const NOISE_SEED: u32 = 0x1234_5678;
const NOISE_AMP: f32 = 0.5;
const FADE_ZERO: u16 = wire::PLAY_FLAGS_FADE_ZERO;
/// Same-knot and exact-curve bounds (README "Notes for the build").
const SAME_KNOT: f64 = 1e-5;
const EXACT: f64 = 1e-4;
/// A class S closed form's bound (`class_s.rs`' `TOL_OUT`).
const CLOSED: f64 = 1e-6;
/// The 5 ms mix fade a pause or a seek ramps over.
const MIX_FADE: usize = 240;
/// Common's `params(4)`, the fixture's preset.
const PRESET: (u32, u32, u32) = (64, 16, 4);

// --- The scene recorder ------------------------------------------------------------------------

/// A scene: a mixer (no look-ahead, so frames are core frames) and the fixture it writes.
struct Scene {
    name: &'static str,
    about: &'static str,
    m: Mixer,
    clips: Vec<String>,
    steps: Vec<String>,
    left: Vec<f32>,
    right: Vec<f32>,
}

impl Scene {
    fn new(name: &'static str, about: &'static str) -> Scene {
        let mut m = Mixer::new(PRESET.2);
        m.set_lookahead(0.0);
        // `Mixer::over` loaded the DC clip: 64 frames of 1.0.
        Scene { name, about, m, clips: vec![format!("{{\"id\":{DC},\"frames\":64,\"fill\":\"dc\",\"value\":1}}")], steps: Vec::new(), left: Vec::new(), right: Vec::new() }
    }

    /// Loads the noise clip (see `lcg`).
    fn noise(&mut self) {
        let samples = lcg(NOISE_SEED, NOISE_AMP, NOISE_FRAMES);
        self.m.load_clip(NOISE, &samples);
        self.clips.push(format!("{{\"id\":{NOISE},\"frames\":{NOISE_FRAMES},\"fill\":\"lcg\",\"seed\":{NOISE_SEED},\"amp\":{NOISE_AMP}}}"));
    }

    /// One BATCH at the current frame.
    fn send(&mut self, recs: &[Rec]) {
        let bytes = batch(self.m.frame as f64, recs);
        let hex: String = bytes[32..].iter().map(|b| format!("{b:02x}")).collect();
        self.steps.push(format!("{{\"send\":\"{hex}\",\"count\":{}}}", recs.iter().map(Rec::count).sum::<usize>()));
        self.m.submit(recs);
    }

    /// Renders `quanta` quanta into the output.
    fn run(&mut self, quanta: usize) {
        self.steps.push(format!("{{\"run\":{quanta}}}"));
        let (l, r) = self.m.render_n(quanta);
        self.left.extend(l);
        self.right.extend(r);
    }

    fn splits(&self) -> (u32, u32) {
        let music = &status::counters(&self.m.core).music;
        (music.split_quanta, music.voice_splits)
    }

    /// Checks the counters, then writes (`UPDATE_GOLDENS=1`) or compares the fixture. `null` is
    /// the scene's largest error against its reference and that reference's bound.
    fn finish(self, splits: (u32, u32), null: Option<(f64, f64)>) {
        let got = self.splits();
        assert_eq!(got, splits, "{}: (splitQuanta, voiceSplits)", self.name);
        assert_eq!(got.0, 0, "{}: M4-0's exit check, splitQuanta 0", self.name);
        assert!(self.left.iter().chain(&self.right).all(|x| x.is_finite()), "{}: finite output", self.name);
        let peak = self.left.iter().chain(&self.right).fold(0.0f32, |p, x| p.max(x.abs()));
        assert!(peak > 0.01, "{}: audible (peak {peak})", self.name);
        let null = match null {
            Some((err, tol)) => {
                eprintln!("{}: null {err:e} (bound {tol:e})", self.name);
                assert!(err <= tol, "{}: null {err:e} over {tol:e}", self.name);
                format!(",\"null\":{{\"maxError\":{err:e},\"tolerance\":{tol:e}}}")
            }
            None => String::new(),
        };
        let json = format!(
            "{{\"scene\":\"{}\",\"about\":\"{}\",\"preset\":{{\"maxLogical\":{},\"maxMixed\":{},\"maxBuses\":{},\"limiterLookaheadMs\":0}},\"clips\":[{}],\"steps\":[{}],\"frames\":{},\"fnv1a64\":\"{}\",\"splits\":{{\"splitQuanta\":{},\"voiceSplits\":{}}}{null}}}\n",
            self.name,
            self.about,
            PRESET.0,
            PRESET.1,
            PRESET.2,
            self.clips.join(","),
            self.steps.join(","),
            self.left.len(),
            fnv1a64(&self.left, &self.right),
            got.0,
            got.1,
        );
        let path = format!("{}/../../../../src/plugins/audio/runtime/golden/{}.json", env!("CARGO_MANIFEST_DIR"), self.name);
        if std::env::var("UPDATE_GOLDENS").as_deref() == Ok("1") {
            std::fs::write(&path, json).unwrap();
            return;
        }
        let want = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("{}: no fixture; run UPDATE_GOLDENS=1 cargo test -p audio-core --test in_voice_goldens", self.name));
        assert!(want == json, "{}: the scene no longer matches golden/{}.json (rerun with UPDATE_GOLDENS=1 and review the diff)", self.name, self.name);
    }
}

/// The fixture's `lcg` clip: `state = state·1,664,525 + 1,013,904,223` (mod 2³²) before each
/// sample; the sample is `amp·((state >> 8)/2²⁴ − 0.5)` (every step exact in f32).
fn lcg(seed: u32, amp: f32, frames: usize) -> Vec<f32> {
    let mut state = seed;
    (0..frames)
        .map(|_| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            amp * ((state >> 8) as f32 / 16_777_216.0 - 0.5)
        })
        .collect()
}

/// FNV-1a 64 over the left channel's f32 bytes (little-endian), then the right's.
fn fnv1a64(left: &[f32], right: &[f32]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for x in left.iter().chain(right) {
        for b in x.to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("{h:016x}")
}

// --- Records -----------------------------------------------------------------------------------

fn play_at(voice: u32, clip: u32, bus: u16, flags: u16, gain: f32, at: u32) -> Rec {
    let Rec::Play(mut p) = play(voice, clip, bus, flags) else { unreachable!() };
    p.gain = gain;
    p.frame_offset = at;
    Rec::Play(p)
}

fn played(voice: u32, clip: u32, flags: u16, gain: f32) -> Rec {
    play_at(voice, clip, ROOT, flags, gain, wire::ASAP)
}

fn fade_at(voice: u32, target: f32, frames: usize, stop: bool, shape: u32, at: usize) -> Rec {
    let mut b = vec![0u8; wire::Fade::FIXED_END];
    let flags = if stop { wire::FADE_FLAGS_STOP_AT_END } else { 0 };
    wire::Fade { voice_id: voice, frame_offset: at as u32, target, frames: frames as u32, flags, shape }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

fn stop_at(voice: u32, fade_frames: usize, shape: u32, at: usize) -> Rec {
    let mut b = vec![0u8; wire::Stop::FIXED_END];
    wire::Stop { voice_id: voice, frame_offset: at as u32, fade_frames: fade_frames as u32, reason: 0, shape }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

fn gain_at(voice: u32, gain: f32, ramp: usize, shape: u32, at: usize) -> Rec {
    Rec::Set(wire::SetParams { voice_id: voice, frame_offset: at as u32, mask: wire::SET_PARAMS_MASK_GAIN, gain, ramp_frames: ramp as u32, shape, ..Default::default() })
}

fn pitch_at(voice: u32, pitch: f32, at: usize) -> Rec {
    Rec::Set(wire::SetParams { voice_id: voice, frame_offset: at as u32, mask: wire::SET_PARAMS_MASK_PITCH, pitch, ..Default::default() })
}

fn lowpass_at(voice: u32, hz: f32, ramp: usize, at: usize) -> Rec {
    Rec::Set(wire::SetParams { voice_id: voice, frame_offset: at as u32, mask: wire::SET_PARAMS_MASK_LP_HZ, lp_hz: hz, ramp_frames: ramp as u32, ..Default::default() })
}

fn direction_at(voice: u32, dir: [f32; 3], at: usize) -> Rec {
    Rec::Set(wire::SetParams { voice_id: voice, frame_offset: at as u32, mask: wire::SET_PARAMS_MASK_DIR, dir_x: dir[0], dir_y: dir[1], dir_z: dir[2], ..Default::default() })
}

fn bus_at(voice: u32, bus: u32, at: usize) -> Rec {
    Rec::Set(wire::SetParams { voice_id: voice, frame_offset: at as u32, mask: wire::SET_PARAMS_MASK_BUS, bus, ..Default::default() })
}

fn paused_at(voice: u32, paused: bool, at: usize) -> Rec {
    let mut b = vec![0u8; wire::SetPaused::FIXED_END];
    wire::SetPaused { voice_id: voice, frame_offset: at as u32, paused: paused as u32 }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

fn seek_at(voice: u32, clip_frame: u32, at: usize) -> Rec {
    let mut b = vec![0u8; wire::Seek::FIXED_END];
    wire::Seek { voice_id: voice, frame_offset: at as u32, clip_frame, epoch: 0 }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

fn loop_at(voice: u32, start: u32, end: u32, at: usize) -> Rec {
    let mut b = vec![0u8; wire::SetLoop::FIXED_END];
    wire::SetLoop { voice_id: voice, frame_offset: at as u32, loop_start_frame: start, loop_end_frame: end, flags: wire::SET_LOOP_FLAGS_LOOPING }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

/// SET_VOICE_FX of sends (0.5, 0.25) and a 200 Hz high-pass (`class_s.rs`' `sends_at`).
fn sends_at(voice: u32, at: usize) -> Rec {
    let mut b = vec![0u8; wire::SetVoiceFx::FIXED_END];
    let mask = wire::SET_VOICE_FX_MASK_SENDS | wire::SET_VOICE_FX_MASK_HP_HZ;
    wire::SetVoiceFx { voice_id: voice, frame_offset: at as u32, mask, ramp_frames: 0, hp_hz: 200.0, send: [0.5, 0.25, 0.0, 0.0], yaw: 0.0, aux_level: 0.0, aux_bus: wire::AUX_BUS_NONE as u16, reserved: 0 }
        .write(&mut b, 0)
        .unwrap();
    Rec::Raw(b)
}

fn spatial_noise(voice: u32, dir: [f32; 3], at: u32) -> Rec {
    let Rec::Play(mut p) = play(voice, NOISE, ROOT, MIXED | LOOP | SPATIAL) else { unreachable!() };
    p.gain = 0.5;
    p.frame_offset = at;
    p.dir_x = dir[0];
    p.dir_y = dir[1];
    p.dir_z = dir[2];
    Rec::Play(p)
}

// --- Class G ------------------------------------------------------------------------------------

/// The null of `out` against `terms` (each a gain on a DC voice and its fade; `base` from the
/// other voices) over the whole output, same-knot and exact. Returns the same-knot error (the
/// fixture's; the caller asserts 1e-5).
///
/// The exact curve: a seam (`seam`, the 250 ms crossfade) is held to the README's 1e-4. A shorter
/// fade can't be: control rate interpolates linearly over 128-frame pieces, so its distance from
/// the law is the interpolation error `h²/8 · max|law''| · |b − a|` with `h = 128·(1 − u0)/N` (in
/// phase), which for a 600-frame S-curve is 2e-2. Those are held to that bound (plus the same-knot
/// bound, 1e-5, for rounding) instead: the error must be the interpolation's and nothing else.
fn null_g(out: &[f32], base: f64, terms: &[(f64, Fade)], seam: bool) -> f64 {
    let knot = max_error(out, 0..out.len(), |t| base + terms.iter().map(|(g, f)| g * f.at(t)).sum::<f64>());
    let exact = max_error(out, 0..out.len(), |t| base + terms.iter().map(|(g, f)| g * f.exact(t)).sum::<f64>());
    let interpolation: f64 = terms
        .iter()
        .map(|(g, f)| {
            let curvature = match f.law {
                Law::Linear => 0.0,
                Law::SCurve => 6.0,
                Law::EqualPowerIn | Law::EqualPowerOut => core::f64::consts::FRAC_PI_2.powi(2),
            };
            let h = Q as f64 * (1.0 - f.u0) / f.n as f64;
            g.abs() * (f.b - f.a).abs() * h * h / 8.0 * curvature
        })
        .sum();
    let bound = if seam { EXACT } else { interpolation + SAME_KNOT };
    eprintln!("  same knot {knot:e}; exact curve {exact:e} (bound {bound:e})");
    assert!(knot <= SAME_KNOT, "same knot {knot:e} over {SAME_KNOT:e}");
    assert!(exact <= bound, "exact curve {exact:e} over {bound:e}");
    knot
}

/// Exact fade start: a linear FADE stamped at sample K moves its voice from that sample; the
/// samples before it are bit-identical to an unfaded voice.
#[test]
fn fade_start() {
    let mut s = Scene::new("m4-fade-start", "a linear FADE stamped at sample 50 of quantum 1: the voice is untouched before it and fades from it");
    s.send(&[played(V1, DC, MIXED | LOOP, 0.5), played(V2, DC, MIXED | LOOP, 0.25)]);
    s.run(1);
    s.send(&[fade_at(V1, 0.2, 300, false, 0, K)]);
    s.run(6);
    let f = Q + K;
    assert!(s.left[..f].iter().all(|&x| x == 0.75), "bit-exact before the fade's sample");
    assert!(s.left[f] < 0.75, "moving at the fade's sample");
    let err = null_g(&s.left, 0.25, &[(0.5, Fade::new(Law::Linear, 1.0, 0.2, f, 300))], false);
    s.finish((0, 0), Some((err, SAME_KNOT)));
}

/// An S-curve FADE with start phase 0.25 (REPLAY's case) over 2,000 frames.
#[test]
fn fade_scurve_phase() {
    let mut s = Scene::new("m4-fade-scurve-phase", "an S-curve FADE from start phase 0.25, stamped at sample 50, over 2,000 frames");
    s.send(&[played(V1, DC, MIXED | LOOP, 0.5)]);
    s.run(1);
    s.send(&[fade_at(V1, 0.2, 2_000, false, shape(Law::SCurve, 0.25), K)]);
    s.run(20);
    let fade = Fade { u0: 0.25, ..Fade::new(Law::SCurve, 1.0, 0.2, Q + K, 2_000) };
    let err = null_g(&s.left, 0.0, &[(0.5, fade)], false);
    s.finish((0, 0), Some((err, SAME_KNOT)));
}

/// The power-complementary crossfade: a voice fades out (`equalPowerOut`, `stopAtEnd`) while a
/// PLAY with `fadeZero` fades in (`equalPowerIn`), both stamped at the same sample, 250 ms.
fn crossfade(out_side: bool, in_side: bool) -> Scene {
    const N: usize = 12_000;
    let mut s = Scene::new("m4-crossfade-equal-power", "a 250 ms equal-power crossfade: FADE out with stopAtEnd and a fadeZero PLAY with FADE in, all stamped at sample 50");
    if out_side {
        s.send(&[played(V1, DC, MIXED | LOOP, 0.5)]);
    }
    s.run(1);
    let mut recs = Vec::new();
    if in_side {
        recs.push(play_at(V2, DC, ROOT, MIXED | LOOP | FADE_ZERO, 0.5, K as u32));
        recs.push(fade_at(V2, 1.0, N, false, shape(Law::EqualPowerIn, 0.0), K));
    }
    if out_side {
        recs.push(fade_at(V1, 0.0, N, true, shape(Law::EqualPowerOut, 0.0), K));
    }
    s.send(&recs);
    s.run((Q + K + N) / Q + 3 - 1);
    s
}

#[test]
fn crossfade_equal_power() {
    const N: usize = 12_000;
    let f = Q + K;
    let s = crossfade(true, true);
    let out = Fade::new(Law::EqualPowerOut, 1.0, 0.0, f, N);
    let inn = Fade::new(Law::EqualPowerIn, 0.0, 1.0, f, N);
    let err = null_g(&s.left, 0.0, &[(0.5, out), (0.5, inn)], true);
    // Power, from each side alone (the scene's own output is their sum).
    let (a, b) = (crossfade(false, true), crossfade(true, false));
    let power = (0..a.left.len()).map(|t| ((a.left[t] as f64 / 0.5).powi(2) + (b.left[t] as f64 / 0.5).powi(2) - 1.0).abs()).fold(0.0, f64::max);
    eprintln!("  in² + out² − 1: {power:e}");
    assert!(power < 1e-4, "power {power:e}");
    assert_eq!(voices::slots(&s.m.core)[1].state, voices::state::FREE, "the faded-out voice ended");
    s.finish((0, 0), Some((err, SAME_KNOT)));
}

/// Stamped STOP: a hard STOP cuts at sample K; a STOP with an `equalPowerOut` fade of 1,000 frames
/// two quanta later fades its voice from its sample and ends it.
#[test]
fn stop_stamped() {
    let mut s = Scene::new("m4-stop-stamped", "a hard STOP at sample 50 of quantum 1, then a STOP with a 1,000-frame equalPowerOut fade at sample 50 of quantum 3");
    s.send(&[played(V1, DC, MIXED | LOOP, 0.5), played(V2, DC, MIXED | LOOP, 0.25)]);
    s.run(1);
    s.send(&[stop_at(V1, 0, 0, K)]);
    s.run(2);
    s.send(&[stop_at(V2, 1_000, shape(Law::EqualPowerOut, 0.0), K)]);
    s.run(12);
    let cut = Fade::new(Law::Linear, 1.0, 0.0, Q + K, 1);
    let out = Fade::new(Law::EqualPowerOut, 1.0, 0.0, 3 * Q + K, 1_000);
    assert!(s.left[..Q + K].iter().all(|&x| x == 0.75) && s.left[Q + K] == 0.25, "the hard stop cuts at its sample");
    let err = null_g(&s.left, 0.0, &[(0.5, cut), (0.25, out)], false);
    assert!(s.left[3 * Q + K + 1_000..].iter().all(|&x| x == 0.0), "both voices ended");
    let slots = voices::slots(&s.m.core);
    assert!(slots[1].state == voices::state::FREE && slots[2].state == voices::state::FREE, "freed");
    s.finish((0, 0), Some((err, SAME_KNOT)));
}

/// A gain-only SET_PARAMS with an S-curve over 600 frames (class G: the gain ramp).
#[test]
fn gain_shaped() {
    let mut s = Scene::new("m4-gain-shaped", "a gain-only SET_PARAMS with an S-curve, 0.8 to 0.2 over 600 frames, stamped at sample 50");
    s.send(&[played(V1, DC, MIXED | LOOP, 0.8)]);
    s.run(1);
    s.send(&[gain_at(V1, 0.2, 600, shape(Law::SCurve, 0.0), K)]);
    s.run(7);
    let err = null_g(&s.left, 0.0, &[(1.0, Fade::new(Law::SCurve, 0.8, 0.2, Q + K, 600))], false);
    s.finish((0, 0), Some((err, SAME_KNOT)));
}

/// Two class G records for one voice in one quantum (a FADE at 20, a gain SET_PARAMS at 90): the
/// second splits the voice once (Z2c's two-class-G boundary), never the quantum.
#[test]
fn two_class_g() {
    let mut s = Scene::new("m4-two-class-g", "a linear FADE at sample 20 and a linear gain SET_PARAMS at sample 90 of one quantum for one voice");
    s.send(&[played(V1, DC, MIXED | LOOP, 0.8)]);
    s.run(1);
    s.send(&[fade_at(V1, 0.5, 64, false, 0, 20), gain_at(V1, 0.4, 100, 0, 90)]);
    s.run(4);
    let fade = Fade::new(Law::Linear, 1.0, 0.5, Q + 20, 64);
    let gain = Fade::new(Law::Linear, 0.8, 0.4, Q + 90, 100);
    let err = max_error(&s.left, 0..s.left.len(), |t| fade.at(t) * gain.at(t));
    s.finish((0, 1), Some((err, CLOSED)));
}

// --- Class S ------------------------------------------------------------------------------------

/// `class_s.rs`' scene on the noise clip: voices 1 and 2 DC loops at gain 0.1 and voice 3 the
/// noise (flags `flags3`, gain 0.5), rendered one quantum.
fn three_voices(name: &'static str, about: &'static str, flags3: u16) -> Scene {
    let mut s = Scene::new(name, about);
    s.noise();
    s.send(&[played(V1, DC, MIXED | LOOP, 0.1), played(V2, DC, MIXED | LOOP, 0.1), played(V3, NOISE, flags3, 0.5)]);
    s.run(1);
    s
}

fn noise_at(p: usize) -> f64 {
    lcg(NOISE_SEED, NOISE_AMP, NOISE_FRAMES)[p] as f64
}

#[test]
fn s_pitch() {
    let mut s = three_voices("m4-s-pitch", "SET_PARAMS pitch 2 at sample 50: voice 3 reads one clip frame a sample before it and two after", MIXED);
    s.send(&[pitch_at(V3, 2.0, K)]);
    s.run(3);
    let f = Q + K;
    let clip = lcg(NOISE_SEED, NOISE_AMP, NOISE_FRAMES);
    let err = max_error(&s.left, 0..s.left.len(), |t| 0.2 + 0.5 * clip[if t < f { t } else { f + 2 * (t - f) }] as f64);
    s.finish((0, 1), Some((err, CLOSED)));
}

#[test]
fn s_lowpass() {
    let mut s = three_voices("m4-s-lowpass", "SET_PARAMS lpHz 500 at once at sample 50 on a looping noise voice", MIXED | LOOP);
    s.send(&[lowpass_at(V3, 500.0, 0, K)]);
    s.run(4);
    s.finish((0, 1), None);
}

#[test]
fn s_lowpass_ramp() {
    let mut s = three_voices("m4-s-lowpass-ramp", "SET_PARAMS lpHz 500 over 960 frames (the quantised 20 ms ramp) from sample 50: the start splits the voice, the ramp runs inside it", MIXED | LOOP);
    s.send(&[lowpass_at(V3, 500.0, 960, K)]);
    s.run(10);
    s.finish((0, 1), None);
}

#[test]
fn s_direction() {
    let mut s = Scene::new("m4-s-direction", "a spatial noise voice's direction flips from [0.6, 0, -0.8] to [-0.6, 0, -0.8] at sample 50");
    s.noise();
    s.send(&[played(V1, DC, MIXED | LOOP, 0.1), spatial_noise(V3, [0.6, 0.0, -0.8], wire::ASAP)]);
    s.run(1);
    s.send(&[direction_at(V3, [-0.6, 0.0, -0.8], K)]);
    s.run(4);
    s.finish((0, 1), None);
}

/// The acceptance's stamped spatial play with sends (`class_s.rs`, `in_voice_hooks.rs`): the PLAY
/// and its SET_VOICE_FX at sample 50 split nothing; a direction change at sample 50 two quanta on
/// splits its voice once.
#[test]
fn s_direction_sends() {
    let mut s = Scene::new("m4-s-direction-sends", "a stamped spatial PLAY with sends at sample 50, then its direction flips at sample 50 of the next quantum");
    s.noise();
    s.send(&[played(V1, DC, MIXED | LOOP, 0.1), played(V2, DC, MIXED | LOOP, 0.1)]);
    s.run(1);
    s.send(&[spatial_noise(V3, [0.6, 0.0, -0.8], K as u32), sends_at(V3, K)]);
    s.run(1);
    assert_eq!(s.splits(), (0, 0), "a start at K splits nothing");
    s.send(&[direction_at(V3, [-0.6, 0.0, -0.8], K)]);
    s.run(4);
    s.finish((0, 1), None);
}

#[test]
fn s_bus() {
    let mut s = Scene::new("m4-s-bus", "voice 3 moves from bus 1 (gain 0.5) to bus 2 (gain 0.25) at sample 50");
    s.noise();
    s.send(&[config(&[ROOT, 0, 0]), gains(0, &[1.0, 0.5, 0.25]), played(V1, DC, MIXED | LOOP, 0.1), played(V2, DC, MIXED | LOOP, 0.1), play_at(V3, NOISE, 1, MIXED, 0.5, wire::ASAP)]);
    s.run(1);
    s.send(&[bus_at(V3, 2, K)]);
    s.run(3);
    let f = Q + K;
    let clip = lcg(NOISE_SEED, NOISE_AMP, NOISE_FRAMES);
    let err = max_error(&s.left, 0..s.left.len(), |t| 0.2 + if t < f { 0.25 } else { 0.125 } * clip[t] as f64);
    s.finish((0, 1), Some((err, CLOSED)));
}

#[test]
fn s_paused() {
    let mut s = three_voices("m4-s-paused", "SET_PAUSED at sample 50: voice 3 fades over the 5 ms mix fade from that sample", MIXED);
    s.send(&[paused_at(V3, true, K)]);
    s.run(4);
    let f = Q + K;
    let err = max_error(&s.left, 0..s.left.len(), |t| {
        let fade = if t < f { 1.0 } else { ramp_to(1.0, 0.0, MIX_FADE, t - f) as f64 };
        0.2 + 0.5 * noise_at(t) * fade
    });
    s.finish((0, 1), Some((err, CLOSED)));
}

#[test]
fn s_seek() {
    let mut s = three_voices("m4-s-seek", "SEEK to clip frame 1,000 at sample 50: the old audio fades over the mix fade from that sample, then the jump", MIXED);
    s.send(&[seek_at(V3, 1_000, K)]);
    s.run(5);
    let f = Q + K;
    // The closed form covers the fade-out (the jump's fade-in is the core's own).
    let err = max_error(&s.left, 0..f + MIX_FADE, |t| {
        let fade = if t < f { 1.0 } else { ramp_to(1.0, 0.0, MIX_FADE, t - f) as f64 };
        0.2 + 0.5 * noise_at(t) * fade
    });
    s.finish((0, 1), Some((err, CLOSED)));
}

#[test]
fn s_loop() {
    let mut s = three_voices("m4-s-loop", "SET_LOOP over clip frames 0..198 at sample 50 on a one-shot: it plays on to the loop end, then wraps", MIXED);
    let end = Q + K + 20;
    s.send(&[loop_at(V3, 0, end as u32, K)]);
    s.run(2);
    let clip = lcg(NOISE_SEED, NOISE_AMP, NOISE_FRAMES);
    // Skip the wrap sample itself (`class_s.rs`).
    let err = (0..s.left.len()).filter(|&t| t != end).map(|t| (s.left[t] as f64 - (0.2 + 0.5 * clip[if t < end { t } else { t - end }] as f64)).abs()).fold(0.0, f64::max);
    s.finish((0, 1), Some((err, CLOSED)));
}

/// D7: a stamped SET_VOICE_FX applies at once (at submit), so it splits nothing.
#[test]
fn s_voice_fx() {
    let mut s = three_voices("m4-s-voice-fx", "a SET_VOICE_FX (sends and a 200 Hz high-pass) stamped at sample 50 applies at once (build log D7): no split of either kind", MIXED | LOOP);
    s.send(&[sends_at(V3, K)]);
    s.run(3);
    s.finish((0, 0), None);
}

/// The reference itself: endpoints, knots on the law, the equal-power pair's power.
#[test]
fn the_reference_evaluates_the_law_at_its_knots() {
    let f = Fade::new(Law::EqualPowerIn, 0.0, 1.0, Q + K, 1_000);
    assert_eq!(f.at(Q + K - 1), 0.0);
    assert_eq!(f.at(Q + K + 999), 1.0);
    // Frame 255 is x = 256, a knot: the law there.
    let u = 1.0 - (Q + K + 1_000 - 2 * Q) as f64 / 1_000.0;
    assert!((f.at(2 * Q - 1) - libm::sin(u * core::f64::consts::FRAC_PI_2)).abs() < 1e-15);
    let g = Fade::new(Law::EqualPowerOut, 1.0, 0.0, Q + K, 1_000);
    for t in 0..1_200 {
        assert!((f.exact(t).powi(2) + g.exact(t).powi(2) - 1.0).abs() < 1e-12);
    }
}
