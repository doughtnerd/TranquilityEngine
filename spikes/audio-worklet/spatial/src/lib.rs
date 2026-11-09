//! Throwaway spike: what binaural spatialisation and convolution reverb cost per 128-frame quantum.
//! The impulse responses are synthetic (decaying noise): cost doesn't depend on the data, and real
//! HRTF sets (SADIE II: 256 taps at 48 kHz) only change the numbers through their length.
//!
//! Cases, each run for `n` quanta by an exported function the benchmarks time:
//! - `fir`: per voice, two direct-form FIRs (left and right ear), `taps` long.
//! - `fft`: per voice, overlap-save through a real FFT (block 128): one forward FFT, two complex
//!   multiplies, two inverse FFTs. HRIRs longer than 128 use uniformly partitioned convolution.
//! - `moving`: `fft`, but with two HRTF filters per ear crossfaded across the quantum, which is what a
//!   moving source costs when it changes direction.
//! - `ambi`: third-order ambisonics: each voice is encoded with 16 gains into a shared 16-channel bus;
//!   one binaural decode per quantum convolves the 16 channels with left and right HRIRs (32 FFT convolutions).
//! - `reverb`: one stereo convolution reverb (L→L, R→R), IR `ir_seconds` long, uniformly partitioned (128).

use realfft::num_complex::Complex32;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use std::sync::Arc;

pub const Q: usize = 128;
const N: usize = Q * 2; // FFT size
const BINS: usize = N / 2 + 1;

struct Rng(u32);
impl Rng {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        (self.0 >> 8) as f32 / (1u32 << 24) as f32 - 0.5
    }
}

fn decaying_noise(rng: &mut Rng, len: usize) -> Vec<f32> {
    (0..len).map(|i| rng.next() * (-(i as f32) / (len as f32 * 0.25)).exp()).collect()
}

/// A uniformly partitioned convolver: IR split into 128-sample partitions, each stored as a spectrum;
/// a frequency-domain delay line of input spectra; per quantum one forward FFT, P complex MACs, one inverse.
pub struct Convolver {
    parts: Vec<Vec<Complex32>>,
    fdl: Vec<Vec<Complex32>>,
    head: usize,
    prev: [f32; Q],
    acc: Vec<Complex32>,
}

pub struct Fft {
    fwd: Arc<dyn RealToComplex<f32>>,
    inv: Arc<dyn ComplexToReal<f32>>,
    time: Vec<f32>,
    scratch_f: Vec<Complex32>,
    scratch_i: Vec<Complex32>,
}

impl Fft {
    pub fn new() -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        let fwd = planner.plan_fft_forward(N);
        let inv = planner.plan_fft_inverse(N);
        let scratch_f = fwd.make_scratch_vec();
        let scratch_i = inv.make_scratch_vec();
        Fft { fwd, inv, time: vec![0.0; N], scratch_f, scratch_i }
    }
    /// Spectrum of [prev block | this block] (overlap-save input).
    fn forward(&mut self, prev: &[f32; Q], cur: &[f32], out: &mut [Complex32]) {
        self.time[..Q].copy_from_slice(prev);
        self.time[Q..].copy_from_slice(cur);
        self.fwd.process_with_scratch(&mut self.time, out, &mut self.scratch_f).unwrap();
    }
    /// Inverse FFT, keeping the valid second half (overlap-save), added into `out` with `gain`.
    fn inverse_add(&mut self, spec: &mut [Complex32], out: &mut [f32], gain: f32) {
        spec[0].im = 0.0;
        spec[BINS - 1].im = 0.0;
        self.inv.process_with_scratch(spec, &mut self.time, &mut self.scratch_i).unwrap();
        let s = gain / N as f32;
        for i in 0..Q { out[i] += self.time[Q + i] * s; }
    }
}

impl Convolver {
    pub fn new(fft: &mut Fft, ir: &[f32]) -> Self {
        let p = ir.len().div_ceil(Q).max(1);
        let mut parts = Vec::with_capacity(p);
        for k in 0..p {
            let mut t = vec![0.0f32; N];
            for i in 0..Q {
                if let Some(&v) = ir.get(k * Q + i) { t[i] = v; }
            }
            let mut spec = vec![Complex32::new(0.0, 0.0); BINS];
            fft.fwd.process_with_scratch(&mut t, &mut spec, &mut fft.scratch_f).unwrap();
            parts.push(spec);
        }
        Convolver { fdl: vec![vec![Complex32::new(0.0, 0.0); BINS]; p], parts, head: 0, prev: [0.0; Q], acc: vec![Complex32::new(0.0, 0.0); BINS] }
    }

    /// Push one input block's spectrum into the delay line (call once per quantum per input).
    fn push(&mut self, fft: &mut Fft, input: &[f32]) {
        self.head = if self.head == 0 { self.fdl.len() - 1 } else { self.head - 1 };
        let slot = &mut self.fdl[self.head];
        fft.forward(&self.prev, input, slot);
        self.prev.copy_from_slice(input);
    }

    /// Multiply-accumulate every partition into `acc` (the hot loop).
    fn mac(&mut self) {
        for a in self.acc.iter_mut() { *a = Complex32::new(0.0, 0.0); }
        let p = self.parts.len();
        for k in 0..p {
            let x = &self.fdl[(self.head + k) % p];
            let h = &self.parts[k];
            for b in 0..BINS { self.acc[b] += x[b] * h[b]; }
        }
    }

    pub fn process(&mut self, fft: &mut Fft, input: &[f32], out: &mut [f32], gain: f32) {
        self.push(fft, input);
        self.mac();
        let mut acc = std::mem::take(&mut self.acc);
        fft.inverse_add(&mut acc, out, gain);
        self.acc = acc;
    }
}

pub struct Bench {
    rng: Rng,
    fft: Fft,
    input: Vec<[f32; Q]>,
    out_l: [f32; Q],
    out_r: [f32; Q],
    pub sink: f32,
}

impl Bench {
    pub fn new() -> Self {
        let mut rng = Rng(0x9e37_79b9);
        let input = (0..64).map(|_| { let mut b = [0.0; Q]; for s in b.iter_mut() { *s = rng.next(); } b }).collect();
        Bench { rng, fft: Fft::new(), input, out_l: [0.0; Q], out_r: [0.0; Q], sink: 0.0 }
    }

    fn finish(&mut self) {
        self.sink += self.out_l[7] + self.out_r[91];
        self.out_l = [0.0; Q];
        self.out_r = [0.0; Q];
    }

    /// Direct FIR per voice per ear, with 8 independent accumulators so the compiler can vectorize.
    pub fn fir(&mut self, voices: usize, taps: usize, n: usize) {
        let hl: Vec<Vec<f32>> = (0..voices).map(|_| decaying_noise(&mut self.rng, taps)).collect();
        let hr: Vec<Vec<f32>> = (0..voices).map(|_| decaying_noise(&mut self.rng, taps)).collect();
        // Per-voice history: taps-1 previous samples followed by the current block.
        let mut hist: Vec<Vec<f32>> = (0..voices).map(|_| vec![0.0; taps - 1 + Q]).collect();
        for q in 0..n {
            for v in 0..voices {
                let h = &mut hist[v];
                h.copy_within(Q.., 0);
                h[taps - 1..].copy_from_slice(&self.input[(q + v) % 64]);
                let (l, r) = (&hl[v], &hr[v]);
                for i in 0..Q {
                    let window = &h[i..i + taps];
                    let (mut al, mut ar) = ([0.0f32; 8], [0.0f32; 8]);
                    let chunks = taps / 8;
                    for c in 0..chunks {
                        for k in 0..8 {
                            let x = window[c * 8 + k];
                            al[k] += x * l[taps - 1 - (c * 8 + k)];
                            ar[k] += x * r[taps - 1 - (c * 8 + k)];
                        }
                    }
                    self.out_l[i] += al.iter().sum::<f32>();
                    self.out_r[i] += ar.iter().sum::<f32>();
                }
            }
            self.finish();
        }
    }

    /// Per-voice FFT convolution; `moving` adds a second filter pair per voice and a crossfade.
    pub fn fft(&mut self, voices: usize, taps: usize, n: usize, moving: bool) {
        let mut ears: Vec<[Convolver; 2]> = (0..voices)
            .map(|_| {
                let a = decaying_noise(&mut self.rng, taps);
                let b = decaying_noise(&mut self.rng, taps);
                [Convolver::new(&mut self.fft, &a), Convolver::new(&mut self.fft, &b)]
            })
            .collect();
        let mut next: Vec<[Convolver; 2]> = if moving {
            (0..voices)
                .map(|_| {
                    let a = decaying_noise(&mut self.rng, taps);
                    let b = decaying_noise(&mut self.rng, taps);
                    [Convolver::new(&mut self.fft, &a), Convolver::new(&mut self.fft, &b)]
                })
                .collect()
        } else {
            Vec::new()
        };
        let mut tmp_old = [0.0f32; Q];
        let mut tmp_new = [0.0f32; Q];
        for q in 0..n {
            for v in 0..voices {
                let input = self.input[(q + v) % 64];
                if !moving {
                    // One forward FFT shared by both ears: push into the left convolver's delay line,
                    // then reuse that spectrum for the right ear.
                    let [l, r] = &mut ears[v];
                    l.push(&mut self.fft, &input);
                    r.head = l.head;
                    let p = r.fdl.len();
                    let src = l.fdl[l.head].clone();
                    r.fdl[r.head % p].copy_from_slice(&src);
                    l.mac();
                    r.mac();
                    let mut acc = std::mem::take(&mut l.acc);
                    self.fft.inverse_add(&mut acc, &mut self.out_l, 1.0);
                    l.acc = acc;
                    let mut acc = std::mem::take(&mut r.acc);
                    self.fft.inverse_add(&mut acc, &mut self.out_r, 1.0);
                    r.acc = acc;
                } else {
                    for ear in 0..2 {
                        tmp_old = [0.0; Q];
                        tmp_new = [0.0; Q];
                        ears[v][ear].process(&mut self.fft, &input, &mut tmp_old, 1.0);
                        next[v][ear].process(&mut self.fft, &input, &mut tmp_new, 1.0);
                        let out = if ear == 0 { &mut self.out_l } else { &mut self.out_r };
                        for i in 0..Q {
                            let t = i as f32 / Q as f32;
                            out[i] += tmp_old[i] * (1.0 - t) + tmp_new[i] * t;
                        }
                    }
                }
            }
            self.finish();
        }
        self.sink += tmp_old[3] + tmp_new[5];
    }

    /// Third-order ambisonics (16 channels): per-voice encode, one binaural decode of 16 channels.
    pub fn ambi(&mut self, voices: usize, taps: usize, n: usize) {
        const CH: usize = 16;
        let gains: Vec<[f32; CH]> = (0..voices).map(|_| { let mut g = [0.0; CH]; for x in g.iter_mut() { *x = self.rng.next(); } g }).collect();
        let mut decode: Vec<[Convolver; 2]> = (0..CH)
            .map(|_| {
                let a = decaying_noise(&mut self.rng, taps);
                let b = decaying_noise(&mut self.rng, taps);
                [Convolver::new(&mut self.fft, &a), Convolver::new(&mut self.fft, &b)]
            })
            .collect();
        let mut bus = vec![[0.0f32; Q]; CH];
        for q in 0..n {
            for b in bus.iter_mut() { *b = [0.0; Q]; }
            for v in 0..voices {
                let input = &self.input[(q + v) % 64];
                let g = &gains[v];
                for c in 0..CH {
                    let gc = g[c];
                    let ch = &mut bus[c];
                    for i in 0..Q { ch[i] += input[i] * gc; }
                }
            }
            for c in 0..CH {
                let [l, r] = &mut decode[c];
                l.process(&mut self.fft, &bus[c], &mut self.out_l, 1.0);
                r.process(&mut self.fft, &bus[c], &mut self.out_r, 1.0);
            }
            self.finish();
        }
    }

    /// One stereo convolution reverb, uniformly partitioned.
    pub fn reverb(&mut self, ir_seconds: f32, n: usize) {
        let len = (ir_seconds * 48_000.0) as usize;
        let a = decaying_noise(&mut self.rng, len);
        let b = decaying_noise(&mut self.rng, len);
        let mut l = Convolver::new(&mut self.fft, &a);
        let mut r = Convolver::new(&mut self.fft, &b);
        for q in 0..n {
            let (il, ir) = (self.input[q % 64], self.input[(q + 1) % 64]);
            l.process(&mut self.fft, &il, &mut self.out_l, 1.0);
            r.process(&mut self.fft, &ir, &mut self.out_r, 1.0);
            self.finish();
        }
    }
}

/// Non-uniformly partitioned convolution with zero added latency and a flat per-quantum cost.
/// Head: the uniform 128-sample convolver over IR[0, 2B). Tail: IR[2B, end) in partitions of B = 2048
/// (FFT 4096). Input block k (16 quanta) completes at time (k+1)B; its tail output belongs at
/// [(k+2)B, (k+3)B), so the tail's multiply-accumulate is spread over the 16 quanta in between and the
/// inverse FFT lands in the last of them.
pub struct NonUniform {
    head: Convolver,
    big_fwd: Arc<dyn RealToComplex<f32>>,
    big_inv: Arc<dyn ComplexToReal<f32>>,
    scratch_f: Vec<Complex32>,
    scratch_i: Vec<Complex32>,
    time: Vec<f32>,
    parts: Vec<Vec<Complex32>>,
    fdl: Vec<Vec<Complex32>>,
    fdl_head: usize,
    in_prev: Vec<f32>,
    in_cur: Vec<f32>,
    fill: usize,
    pending: bool,
    acc: Vec<Complex32>,
    play: Vec<f32>,
    play_pos: usize,
}

pub const BIG: usize = 2048;
const SUB: usize = BIG / Q; // quanta per big block

impl NonUniform {
    pub fn new(fft: &mut Fft, ir: &[f32]) -> Self {
        let head_len = (2 * BIG).min(ir.len());
        let head = Convolver::new(fft, &ir[..head_len]);
        let mut planner = RealFftPlanner::<f32>::new();
        let big_fwd = planner.plan_fft_forward(2 * BIG);
        let big_inv = planner.plan_fft_inverse(2 * BIG);
        let mut scratch_f = big_fwd.make_scratch_vec();
        let scratch_i = big_inv.make_scratch_vec();
        let bins = BIG + 1;
        let tail = if ir.len() > head_len { &ir[head_len..] } else { &[][..] };
        let p = tail.len().div_ceil(BIG).max(1);
        let mut parts = Vec::with_capacity(p);
        for k in 0..p {
            let mut t = vec![0.0f32; 2 * BIG];
            for i in 0..BIG { if let Some(&v) = tail.get(k * BIG + i) { t[i] = v; } }
            let mut spec = vec![Complex32::new(0.0, 0.0); bins];
            big_fwd.process_with_scratch(&mut t, &mut spec, &mut scratch_f).unwrap();
            parts.push(spec);
        }
        NonUniform {
            head, big_fwd, big_inv, scratch_f, scratch_i, time: vec![0.0; 2 * BIG],
            fdl: vec![vec![Complex32::new(0.0, 0.0); bins]; p], parts, fdl_head: 0,
            in_prev: vec![0.0; BIG], in_cur: vec![0.0; BIG], fill: 0, pending: false,
            acc: vec![Complex32::new(0.0, 0.0); bins], play: vec![0.0; BIG], play_pos: 0,
        }
    }

    pub fn process(&mut self, fft: &mut Fft, input: &[f32], out: &mut [f32]) {
        self.head.process(fft, input, out, 1.0);
        // Play this quantum's share of the tail output computed earlier.
        for i in 0..Q { out[i] += self.play[self.play_pos + i]; }
        self.play_pos += Q;
        // One slice of the pending block's multiply-accumulate.
        if self.pending {
            let s = self.fill;
            let p = self.parts.len();
            let (from, to) = (s * p / SUB, (s + 1) * p / SUB);
            for j in from..to {
                let x = &self.fdl[(self.fdl_head + j) % p];
                let h = &self.parts[j];
                for b in 0..self.acc.len() { self.acc[b] += x[b] * h[b]; }
            }
            if s == SUB - 1 {
                let bins = self.acc.len();
                self.acc[0].im = 0.0;
                self.acc[bins - 1].im = 0.0;
                self.big_inv.process_with_scratch(&mut self.acc, &mut self.time, &mut self.scratch_i).unwrap();
                let scale = 1.0 / (2 * BIG) as f32;
                for i in 0..BIG { self.play[i] = self.time[BIG + i] * scale; }
                self.play_pos = 0;
            }
        }
        // Collect input; a full block goes into the frequency-domain delay line.
        self.in_cur[self.fill * Q..(self.fill + 1) * Q].copy_from_slice(input);
        self.fill += 1;
        if self.fill == SUB {
            self.fill = 0;
            let p = self.fdl.len();
            self.fdl_head = if self.fdl_head == 0 { p - 1 } else { self.fdl_head - 1 };
            self.time[..BIG].copy_from_slice(&self.in_prev);
            self.time[BIG..].copy_from_slice(&self.in_cur);
            self.big_fwd.process_with_scratch(&mut self.time, &mut self.fdl[self.fdl_head], &mut self.scratch_f).unwrap();
            std::mem::swap(&mut self.in_prev, &mut self.in_cur);
            for a in self.acc.iter_mut() { *a = Complex32::new(0.0, 0.0); }
            self.pending = true;
        }
        if self.play_pos >= BIG { self.play_pos = 0; self.play.iter_mut().for_each(|v| *v = 0.0); }
    }
}

impl Bench {
    /// One stereo non-uniform convolution reverb; `per_quantum` (if given) receives each quantum's time
    /// via the callback, for worst-case measurement natively.
    pub fn reverb_nonuniform(&mut self, ir_seconds: f32, n: usize) {
        let len = (ir_seconds * 48_000.0) as usize;
        let a = decaying_noise(&mut self.rng, len);
        let b = decaying_noise(&mut self.rng, len);
        let mut l = NonUniform::new(&mut self.fft, &a);
        let mut r = NonUniform::new(&mut self.fft, &b);
        for q in 0..n {
            let (il, ir) = (self.input[q % 64], self.input[(q + 1) % 64]);
            l.process(&mut self.fft, &il, &mut self.out_l);
            r.process(&mut self.fft, &ir, &mut self.out_r);
            self.finish();
        }
    }

    /// Max absolute difference between uniform and non-uniform output for the same IR and input.
    pub fn check_nonuniform(&mut self, ir_seconds: f32, quanta: usize) -> (f32, f32) {
        let len = (ir_seconds * 48_000.0) as usize;
        let ir = decaying_noise(&mut self.rng, len);
        let mut u = Convolver::new(&mut self.fft, &ir);
        let mut nu = NonUniform::new(&mut self.fft, &ir);
        let (mut max_diff, mut max_val) = (0.0f32, 0.0f32);
        for q in 0..quanta {
            let input = self.input[q % 64];
            let (mut a, mut b) = ([0.0f32; Q], [0.0f32; Q]);
            u.process(&mut self.fft, &input, &mut a, 1.0);
            nu.process(&mut self.fft, &input, &mut b);
            for i in 0..Q { max_diff = max_diff.max((a[i] - b[i]).abs()); max_val = max_val.max(a[i].abs()); }
        }
        (max_diff, max_val)
    }
}

/// Stateful single-quantum stepping for worst-case timing from JS.
static mut NU: Option<(Fft, NonUniform, NonUniform, [f32; Q], [f32; Q], [f32; Q])> = None;

#[allow(static_mut_refs)]
#[no_mangle]
pub extern "C" fn sp_nu_init(ir_seconds: f32) {
    let mut rng = Rng(7);
    let len = (ir_seconds * 48_000.0) as usize;
    let mut fft = Fft::new();
    let a = decaying_noise(&mut rng, len);
    let b = decaying_noise(&mut rng, len);
    let l = NonUniform::new(&mut fft, &a);
    let r = NonUniform::new(&mut fft, &b);
    let mut input = [0.0f32; Q];
    for s in input.iter_mut() { *s = rng.next(); }
    unsafe { NU = Some((fft, l, r, input, [0.0; Q], [0.0; Q])); }
}

#[allow(static_mut_refs)]
#[no_mangle]
pub extern "C" fn sp_nu_step() {
    let (fft, l, r, input, ol, or) = unsafe { NU.as_mut().expect("init") };
    *ol = [0.0; Q];
    *or = [0.0; Q];
    l.process(fft, input, ol);
    r.process(fft, input, or);
}

#[no_mangle] pub extern "C" fn sp_reverb_nu(ir_seconds: f32, n: u32) { bench().reverb_nonuniform(ir_seconds, n as usize) }

// --- C ABI for wasm benchmarks ---
static mut BENCH: Option<Bench> = None;
#[allow(static_mut_refs)]
fn bench() -> &'static mut Bench { unsafe { BENCH.get_or_insert_with(Bench::new) } }

#[no_mangle] pub extern "C" fn sp_fir(voices: u32, taps: u32, n: u32) { bench().fir(voices as usize, taps as usize, n as usize) }
#[no_mangle] pub extern "C" fn sp_fft(voices: u32, taps: u32, n: u32, moving: u32) { bench().fft(voices as usize, taps as usize, n as usize, moving != 0) }
#[no_mangle] pub extern "C" fn sp_ambi(voices: u32, taps: u32, n: u32) { bench().ambi(voices as usize, taps as usize, n as usize) }
#[no_mangle] pub extern "C" fn sp_reverb(ir_seconds: f32, n: u32) { bench().reverb(ir_seconds, n as usize) }
#[no_mangle] pub extern "C" fn sp_sink() -> f32 { bench().sink }
