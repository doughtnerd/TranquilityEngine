//! The bed probe's scene (ADR 0162 A2, #120), shared by the `bed_probe` example (native binary and
//! wasm module) and `tests/bed_identity.rs`: N mono voices moving on the sphere encoded into one
//! order-3 bed (the bed spike's `bed256` case: every voice's direction and gain change every
//! quantum, so every coefficient ramp is live), optionally a 3rd-order clip rotated into the bed
//! by a turning listener, then one MagLS-style decode. Everything is generated from integer seeds
//! (no platform maths: `libm` only), so native and wasm runs are comparable bit for bit.

use audio_dsp::ambisonic::{self, ShRotation, CHANNELS, QUANTUM};
use audio_dsp::bed_decoder::{BedDecoder, MaglsFilters, EARS};
use audio_dsp::hrtf::HrtfScratch;

/// Taps of the synthetic filters (format 4 at 48 kHz).
pub const TAPS: usize = 256;
/// Frames of each voice's looping content (as the spike).
const CONTENT_FRAMES: usize = 8_192;

/// xorshift32, never 0.
#[derive(Clone, Copy)]
pub struct Rng(pub u32);

impl Rng {
    pub fn next(&mut self) -> u32 {
        let mut s = self.0;
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        self.0 = s;
        s
    }
    /// Uniform in [0, 1), exact in f32 (24 bits).
    pub fn unit(&mut self) -> f32 {
        (self.next() >> 8) as f32 * (1.0 / 16_777_216.0)
    }
    /// Uniform in [-1, 1).
    pub fn sym(&mut self) -> f32 {
        self.unit() * 2.0 - 1.0
    }
}

/// Synthetic decode filters with the format 4 layout `[16][2][TAPS]`: decaying noise per channel
/// and ear, louder for the low orders (a stand-in for `magls-o3.bin`, which A3 bakes).
pub fn synthetic_time_responses() -> Vec<f32> {
    let mut r = Rng(0x00C0_FFEE);
    let mut t = vec![0.0f32; CHANNELS * EARS * TAPS];
    for c in 0..CHANNELS {
        let level = 1.0 / (1 + ambisonic::order_of(c)) as f32;
        for e in 0..EARS {
            let mut env = level;
            for k in 0..TAPS {
                t[(c * EARS + e) * TAPS + k] = r.sym() * env * 0.25;
                env *= 0.985;
            }
        }
    }
    t
}

/// The scene's state.
pub struct Scene {
    voices: usize,
    content: Vec<f32>,
    dirs: Vec<[f32; 3]>,
    spin: Vec<ambisonic::Mat3>,
    gains: Vec<f32>,
    coefs: Vec<[f32; CHANNELS]>,
    rng: Vec<Rng>,
    step: usize,
    clip: bool,
    clip_rot: ShRotation,
    bed: Box<[[f32; QUANTUM]; CHANNELS]>,
    clip_in: Box<[[f32; QUANTUM]; CHANNELS]>,
    filters: Box<MaglsFilters<2>>,
    decoder: Box<BedDecoder>,
    scratch: Box<HrtfScratch>,
}

fn unit_vector(r: &mut Rng) -> [f32; 3] {
    loop {
        let v = [r.sym(), r.sym(), r.sym()];
        let l = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
        if l > 0.01 && l <= 1.0 {
            let i = 1.0 / libm::sqrtf(l);
            return [v[0] * i, v[1] * i, v[2] * i];
        }
    }
}

/// Rotation by `t` radians about the unit axis `a` (Rodrigues).
fn axis_angle(a: [f32; 3], t: f32) -> ambisonic::Mat3 {
    let (c, s) = (libm::cosf(t), libm::sinf(t));
    let k = 1.0 - c;
    [
        [c + a[0] * a[0] * k, a[0] * a[1] * k - a[2] * s, a[0] * a[2] * k + a[1] * s],
        [a[1] * a[0] * k + a[2] * s, c + a[1] * a[1] * k, a[1] * a[2] * k - a[0] * s],
        [a[2] * a[0] * k - a[1] * s, a[2] * a[1] * k + a[0] * s, c + a[2] * a[2] * k],
    ]
}

impl Scene {
    /// `voices` moving voices; `clip` adds a 3rd-order clip rotated by a turning listener.
    pub fn new(voices: usize, clip: bool) -> Scene {
        let mut r = Rng(0x9E37_79B9);
        let mut content = vec![0.0f32; voices * CONTENT_FRAMES];
        for v in 0..voices {
            // A decaying two-partial note plus a little noise: values only, the cost is in the encode.
            let p1 = 0.01 + 0.05 * r.unit();
            let p2 = p1 * (1.5 + r.unit());
            for (i, x) in content[v * CONTENT_FRAMES..(v + 1) * CONTENT_FRAMES].iter_mut().enumerate() {
                let n = i as f32;
                *x = 0.4 * libm::sinf(p1 * n) + 0.2 * libm::sinf(p2 * n) + 0.05 * r.sym();
            }
        }
        let mut dirs = Vec::with_capacity(voices);
        let mut spin = Vec::with_capacity(voices);
        let mut gains = Vec::with_capacity(voices);
        let mut coefs = Vec::with_capacity(voices);
        let mut rng = Vec::with_capacity(voices);
        for _ in 0..voices {
            let d = unit_vector(&mut r);
            let axis = unit_vector(&mut r);
            // 10 to 90 degrees per second at 48 kHz.
            let rate = (10.0 + 80.0 * r.unit()) * (core::f32::consts::PI / 180.0) * QUANTUM as f32 / 48_000.0;
            let g = 0.3 + 0.7 * r.unit();
            dirs.push(d);
            spin.push(axis_angle(axis, rate));
            gains.push(g);
            coefs.push(ambisonic::encode_gains(d, 3).map(|c| c * g));
            rng.push(Rng(r.next() | 1));
        }
        let mut scratch = Box::new(HrtfScratch::new());
        let mut filters = Box::new(MaglsFilters::<2>::ZERO);
        filters.load(&synthetic_time_responses(), TAPS, &mut scratch).expect("synthetic filters load");
        Scene {
            voices,
            content,
            dirs,
            spin,
            gains,
            coefs,
            rng,
            step: 0,
            clip,
            clip_rot: ShRotation::IDENTITY,
            bed: Box::new([[0.0; QUANTUM]; CHANNELS]),
            clip_in: Box::new([[0.0; QUANTUM]; CHANNELS]),
            filters,
            decoder: Box::new(BedDecoder::ZERO),
            scratch,
        }
    }

    /// One quantum: encode every voice (and the clip), decode, write the binaural result.
    pub fn quantum(&mut self, out_l: &mut [f32; QUANTUM], out_r: &mut [f32; QUANTUM]) {
        for ch in self.bed.iter_mut() {
            ch.fill(0.0);
        }
        let off = (self.step * QUANTUM) % CONTENT_FRAMES;
        for v in 0..self.voices {
            let m = &self.spin[v];
            let d = self.dirs[v];
            let mut n = [
                m[0][0] * d[0] + m[0][1] * d[1] + m[0][2] * d[2],
                m[1][0] * d[0] + m[1][1] * d[1] + m[1][2] * d[2],
                m[2][0] * d[0] + m[2][1] * d[1] + m[2][2] * d[2],
            ];
            let inv = 1.0 / libm::sqrtf(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
            n = [n[0] * inv, n[1] * inv, n[2] * inv];
            self.dirs[v] = n;
            let g = (self.gains[v] + (self.rng[v].unit() - 0.5) * 0.1).clamp(0.2, 1.0);
            self.gains[v] = g;
            let c1 = ambisonic::encode_gains(n, 3).map(|c| c * g);
            let x: &[f32; QUANTUM] = self.content[v * CONTENT_FRAMES + off..][..QUANTUM].try_into().unwrap();
            ambisonic::encode_ramp_add(&mut self.bed, x, &self.coefs[v], &c1, CHANNELS);
            self.coefs[v] = c1;
        }
        if self.clip {
            // The clip's channels: voice 0's content scaled per channel (distinct, deterministic).
            for (c, ch) in self.clip_in.iter_mut().enumerate() {
                let src = &self.content[off..off + QUANTUM];
                let k = 1.0 / (1 + c) as f32;
                for (o, x) in ch.iter_mut().zip(src) {
                    *o = x * k;
                }
            }
            // A listener turning about up, tilted, plus the clip's yaw.
            let a = self.step as f32 * 0.01;
            let q = [0.1 * libm::sinf(a), libm::sinf(0.5 * a), 0.05, libm::cosf(0.5 * a)];
            let listener = ambisonic::quat_to_ambix(q).unwrap_or(ambisonic::MAT3_IDENTITY);
            let r = ambisonic::mat3_mul(&listener, &ambisonic::yaw_ambix(0.25));
            let next = ShRotation::from_mat3(&r).scaled(0.5);
            ambisonic::rotate_ramp_add(&self.clip_in, &mut self.bed, CHANNELS, &self.clip_rot, &next);
            self.clip_rot = next;
        }
        out_l.fill(0.0);
        out_r.fill(0.0);
        self.decoder.process(&self.bed, CHANNELS, &self.filters, &mut self.scratch, out_l, out_r);
        self.step += 1;
    }
}

/// FNV-1a 64 over the little-endian bits of every output sample (left then right per quantum).
pub fn fnv1a(state: &mut u64, samples: &[f32]) {
    for s in samples {
        for b in s.to_bits().to_le_bytes() {
            *state ^= b as u64;
            *state = state.wrapping_mul(0x0000_0100_0000_01B3);
        }
    }
}

/// The identity digest: 32 voices and the rotated clip for 64 quanta.
pub fn digest() -> u64 {
    let mut s = Scene::new(32, true);
    let mut h = 0xCBF2_9CE4_8422_2325u64;
    let (mut l, mut r) = ([0.0f32; QUANTUM], [0.0f32; QUANTUM]);
    for _ in 0..64 {
        s.quantum(&mut l, &mut r);
        fnv1a(&mut h, &l);
        fnv1a(&mut h, &r);
    }
    h
}
