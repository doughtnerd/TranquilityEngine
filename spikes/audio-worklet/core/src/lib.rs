//! Throwaway spike: a game-audio mixer shaped like the planned engine core, to measure what fits in
//! one AudioWorklet render quantum (128 frames). No wasm-bindgen: the worklet scope lacks the glue's
//! needs (TextDecoder, fetch), so the exports are plain `extern "C"` functions over linear memory.
//!
//! Per quantum it does what a real mix would:
//! - virtual voices: L logical voices, at most R mixed; the R most audible are re-chosen every 8 quanta,
//!   the rest only advance their play position;
//! - per real voice: resampled read (linear interpolation, per-voice pitch), a biquad low-pass (distance
//!   filter), gain ramped across the quantum (tween smoothing), equal-power pan to stereo, mix into its bus;
//! - 8 buses: gain ramp, a biquad high-shelf-ish EQ, and a send into the reverb;
//! - master: Freeverb-style reverb (8 combs + 4 all-passes per channel), then a peak limiter.

pub const Q: usize = 128;
const BUSES: usize = 8;
const SAMPLE_RATE_SRC: f32 = 48_000.0;

#[derive(Clone, Copy, Default)]
struct Biquad { b0: f32, b1: f32, b2: f32, a1: f32, a2: f32 }

impl Biquad {
    fn lowpass(fc: f32, q: f32, sr: f32) -> Self {
        let w = 2.0 * core::f32::consts::PI * fc / sr;
        let (s, c) = w.sin_cos();
        let alpha = s / (2.0 * q);
        let a0 = 1.0 + alpha;
        let b1 = (1.0 - c) / a0;
        Biquad { b0: b1 * 0.5, b1, b2: b1 * 0.5, a1: -2.0 * c / a0, a2: (1.0 - alpha) / a0 }
    }
    fn highpass(fc: f32, q: f32, sr: f32) -> Self {
        let w = 2.0 * core::f32::consts::PI * fc / sr;
        let (s, c) = w.sin_cos();
        let alpha = s / (2.0 * q);
        let a0 = 1.0 + alpha;
        let b0 = (1.0 + c) / (2.0 * a0);
        Biquad { b0, b1: -2.0 * b0, b2: b0, a1: -2.0 * c / a0, a2: (1.0 - alpha) / a0 }
    }
}

#[derive(Clone, Copy, Default)]
struct BiquadState { z1: f32, z2: f32 }

impl BiquadState {
    #[inline(always)]
    fn tick(&mut self, f: &Biquad, x: f32) -> f32 {
        // Transposed direct form II.
        let y = f.b0 * x + self.z1;
        self.z1 = f.b1 * x - f.a1 * y + self.z2;
        self.z2 = f.b2 * x - f.a2 * y;
        y
    }
}

#[derive(Clone, Copy, Default)]
struct Voice {
    sample: usize,
    pos: f64,
    rate: f64,
    gain: f32,
    /// Gain applied at the end of the previous quantum (the ramp starts here).
    last_gain: f32,
    pan_l: f32,
    pan_r: f32,
    bus: usize,
    filter: Biquad,
    state: BiquadState,
    audibility: f32,
}

struct Bus { gain: f32, last_gain: f32, eq: Biquad, eq_l: BiquadState, eq_r: BiquadState, send: f32, l: [f32; Q], r: [f32; Q] }

struct Comb { buf: Vec<f32>, idx: usize, store: f32, feedback: f32, damp: f32 }
impl Comb {
    fn new(len: usize) -> Self { Comb { buf: vec![0.0; len], idx: 0, store: 0.0, feedback: 0.84, damp: 0.2 } }
    #[inline(always)]
    fn tick(&mut self, x: f32) -> f32 {
        let y = self.buf[self.idx];
        self.store = y * (1.0 - self.damp) + self.store * self.damp;
        self.buf[self.idx] = x + self.store * self.feedback;
        self.idx += 1;
        if self.idx == self.buf.len() { self.idx = 0; }
        y
    }
}
struct AllPass { buf: Vec<f32>, idx: usize }
impl AllPass {
    fn new(len: usize) -> Self { AllPass { buf: vec![0.0; len], idx: 0 } }
    #[inline(always)]
    fn tick(&mut self, x: f32) -> f32 {
        let b = self.buf[self.idx];
        let y = b - x;
        self.buf[self.idx] = x + b * 0.5;
        self.idx += 1;
        if self.idx == self.buf.len() { self.idx = 0; }
        y
    }
}
struct Reverb { combs: [Vec<Comb>; 2], allpasses: [Vec<AllPass>; 2] }
impl Reverb {
    fn new(sr: f32) -> Self {
        let scale = sr / 44_100.0;
        let comb_len = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
        let ap_len = [556, 441, 341, 225];
        let make = |spread: usize| -> (Vec<Comb>, Vec<AllPass>) {
            (
                comb_len.iter().map(|&n| Comb::new(((n + spread) as f32 * scale) as usize)).collect(),
                ap_len.iter().map(|&n| AllPass::new(((n + spread) as f32 * scale) as usize)).collect(),
            )
        };
        let (cl, al) = make(0);
        let (cr, ar) = make(23);
        Reverb { combs: [cl, cr], allpasses: [al, ar] }
    }
}

pub struct Mixer {
    sr: f32,
    samples: Vec<Vec<f32>>,
    voices: Vec<Voice>,
    real: Vec<usize>,
    real_cap: usize,
    buses: Vec<Bus>,
    reverb: Reverb,
    send_l: [f32; Q],
    send_r: [f32; Q],
    limiter_env: f32,
    quantum: u64,
    rng: u32,
    pub out: [f32; Q * 2],
    pub mixed_last: u32,
}

impl Mixer {
    pub fn new(sr: f32) -> Self {
        let buses = (0..BUSES)
            .map(|i| Bus {
                gain: 0.8, last_gain: 0.8,
                eq: Biquad::highpass(40.0 + i as f32 * 20.0, 0.707, sr),
                eq_l: BiquadState::default(), eq_r: BiquadState::default(),
                send: if i % 2 == 0 { 0.3 } else { 0.1 },
                l: [0.0; Q], r: [0.0; Q],
            })
            .collect();
        let mut m = Mixer {
            sr, samples: Vec::new(), voices: Vec::new(), real: Vec::new(), real_cap: 0, buses,
            reverb: Reverb::new(sr), send_l: [0.0; Q], send_r: [0.0; Q], limiter_env: 1.0,
            quantum: 0, rng: 0x1234_5678, out: [0.0; Q * 2], mixed_last: 0,
        };
        // Four one-second test sources: harmonic tones with a little noise, so the filters have work.
        for k in 0..4 {
            let n = SAMPLE_RATE_SRC as usize;
            let f0 = 110.0 * (k + 1) as f32;
            let mut s = Vec::with_capacity(n);
            for i in 0..n {
                let t = i as f32 / SAMPLE_RATE_SRC;
                let w = 2.0 * core::f32::consts::PI * f0 * t;
                let noise = (m.next_rand() - 0.5) * 0.05;
                s.push(0.5 * w.sin() + 0.25 * (2.0 * w).sin() + 0.12 * (3.0 * w).sin() + noise);
            }
            m.samples.push(s);
        }
        m
    }

    fn next_rand(&mut self) -> f32 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 17;
        self.rng ^= self.rng << 5;
        (self.rng >> 8) as f32 / (1u32 << 24) as f32
    }

    /// Replace all voices: `logical` playing, at most `real_cap` mixed.
    pub fn set_voices(&mut self, logical: usize, real_cap: usize) {
        self.voices.clear();
        for _ in 0..logical {
            let pan = self.next_rand();
            let angle = pan * core::f32::consts::FRAC_PI_2;
            let gain = 0.02 + self.next_rand() * 0.1;
            let pitch = 0.5 + self.next_rand() * 1.5;
            let cutoff = 800.0 + self.next_rand() * 12_000.0;
            let v = Voice {
                sample: (self.next_rand() * 4.0) as usize % 4,
                pos: (self.next_rand() * SAMPLE_RATE_SRC) as f64,
                rate: pitch as f64 * (SAMPLE_RATE_SRC / self.sr) as f64,
                gain, last_gain: gain,
                pan_l: angle.cos(), pan_r: angle.sin(),
                bus: (self.next_rand() * BUSES as f32) as usize % BUSES,
                filter: Biquad::lowpass(cutoff, 0.707, self.sr),
                state: BiquadState::default(),
                audibility: gain,
            };
            self.voices.push(v);
        }
        self.real_cap = real_cap.min(logical);
        self.pick_real();
    }

    /// Choose the most audible voices to mix (partial sort, O(L)).
    fn pick_real(&mut self) {
        self.real.clear();
        self.real.extend(0..self.voices.len());
        if self.real_cap < self.real.len() {
            let voices = &self.voices;
            self.real.select_nth_unstable_by(self.real_cap, |&a, &b| voices[b].audibility.total_cmp(&voices[a].audibility));
            self.real.truncate(self.real_cap);
        }
    }

    pub fn process(&mut self) {
        self.quantum += 1;
        // Gently move gains so the ramps and the audibility ranking have real work.
        let wobble = ((self.quantum as f32) * 0.01).sin() * 0.002;
        for v in self.voices.iter_mut() {
            v.gain = (v.gain + wobble).clamp(0.0, 0.2);
            v.audibility = v.gain;
        }
        if self.quantum % 8 == 0 { self.pick_real(); }

        for b in self.buses.iter_mut() { b.l = [0.0; Q]; b.r = [0.0; Q]; }

        let inv_q = 1.0 / Q as f32;
        for &vi in self.real.iter() {
            let v = &mut self.voices[vi];
            let src = &self.samples[v.sample];
            let len = src.len() as f64;
            let bus = &mut self.buses[v.bus];
            let dg = (v.gain - v.last_gain) * inv_q;
            let mut g = v.last_gain;
            for i in 0..Q {
                let p = v.pos;
                let i0 = p as usize;
                let frac = (p - i0 as f64) as f32;
                let i1 = if i0 + 1 == src.len() { 0 } else { i0 + 1 };
                let x = src[i0] + (src[i1] - src[i0]) * frac;
                let y = v.state.tick(&v.filter, x) * g;
                bus.l[i] += y * v.pan_l;
                bus.r[i] += y * v.pan_r;
                g += dg;
                v.pos += v.rate;
                if v.pos >= len { v.pos -= len; }
            }
            v.last_gain = v.gain;
        }
        // Virtual voices only keep time.
        let mixed = self.real.len();
        if mixed < self.voices.len() {
            let mut is_real = vec![false; self.voices.len()];
            for &vi in self.real.iter() { is_real[vi] = true; }
            for (i, v) in self.voices.iter_mut().enumerate() {
                if !is_real[i] {
                    let len = self.samples[v.sample].len() as f64;
                    v.pos = (v.pos + v.rate * Q as f64) % len;
                    v.last_gain = v.gain;
                }
            }
        }
        self.mixed_last = mixed as u32;

        // Buses → master and reverb send.
        self.send_l = [0.0; Q];
        self.send_r = [0.0; Q];
        let mut ml = [0.0f32; Q];
        let mut mr = [0.0f32; Q];
        for b in self.buses.iter_mut() {
            let dg = (b.gain - b.last_gain) * inv_q;
            let mut g = b.last_gain;
            for i in 0..Q {
                let l = b.eq_l.tick(&b.eq, b.l[i]) * g;
                let r = b.eq_r.tick(&b.eq, b.r[i]) * g;
                ml[i] += l;
                mr[i] += r;
                self.send_l[i] += l * b.send;
                self.send_r[i] += r * b.send;
                g += dg;
            }
            b.last_gain = b.gain;
        }

        // Reverb.
        for ch in 0..2 {
            let send = if ch == 0 { &self.send_l } else { &self.send_r };
            let dry = if ch == 0 { &mut ml } else { &mut mr };
            let combs = &mut self.reverb.combs[ch];
            let aps = &mut self.reverb.allpasses[ch];
            for i in 0..Q {
                let x = send[i] * 0.015;
                let mut acc = 0.0;
                for c in combs.iter_mut() { acc += c.tick(x); }
                for a in aps.iter_mut() { acc = a.tick(acc); }
                dry[i] += acc;
            }
        }

        // Peak limiter: instant attack, slow release, ceiling 0.9.
        for i in 0..Q {
            let peak = ml[i].abs().max(mr[i].abs());
            let target = if peak * self.limiter_env > 0.9 { 0.9 / peak } else { 1.0 };
            self.limiter_env = if target < self.limiter_env { target } else { self.limiter_env + (target - self.limiter_env) * 0.0005 };
            self.out[i] = ml[i] * self.limiter_env;
            self.out[Q + i] = mr[i] * self.limiter_env;
        }
    }
}

// --- C ABI for the worklet and the benchmarks (one mixer per wasm instance) ---

static mut MIXER: Option<Mixer> = None;

#[allow(static_mut_refs)]
fn mixer() -> &'static mut Mixer { unsafe { MIXER.as_mut().expect("init first") } }

#[no_mangle]
pub extern "C" fn spike_init(sample_rate: f32) { unsafe { MIXER = Some(Mixer::new(sample_rate)); } }

#[no_mangle]
pub extern "C" fn spike_set_voices(logical: u32, real_cap: u32) { mixer().set_voices(logical as usize, real_cap as usize); }

/// Render one quantum; returns a pointer to 256 floats: 128 left, then 128 right.
#[no_mangle]
pub extern "C" fn spike_process() -> *const f32 { let m = mixer(); m.process(); m.out.as_ptr() }

/// Render `n` quanta back to back (for timing without per-call JS overhead).
#[no_mangle]
pub extern "C" fn spike_process_many(n: u32) { let m = mixer(); for _ in 0..n { m.process(); } }

#[no_mangle]
pub extern "C" fn spike_mixed_last() -> u32 { mixer().mixed_last }
