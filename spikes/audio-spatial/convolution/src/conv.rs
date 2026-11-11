//! M1's staged convolver (`audio_dsp::convolver`), copied out of its byte region into owned
//! buffers so the spike can (a) give it IRs of any length, (b) run several instances, (c) move each
//! channel's tail transforms to other quanta, and (d) build the partition spectra incrementally.
//! The head stage, the tail stage, the schedule arithmetic and the kernel scaling are M1's
//! (`convolver.rs`), line for line; the FFTs are M1's own (`audio_dsp::convolver::fft`).
//! `checks::m1_parity` shows the output is bit-identical to M1's `process` for M1's 1.8 s IR.
//!
//! **What changes.** M1 runs channel c's tail as: forward FFT at schedule slot `f = c`, spectrum
//! multiply-adds over slots `f+1 .. i-1`, inverse FFT at slot `i = 15 - c`, slot = `(k + 1) % 16`.
//! Here a channel's `(f, i)` is any pair with `0 <= f` and `f + 2 <= i <= 15`. The block grid
//! (block m ends at input frame 2048 m), the input transformed, the multiply-add order and the
//! frame the block is accumulated at are all unchanged, so the output is **bit-identical** for
//! every `(f, i)`: only the quantum that does the work moves. (A forward at slot f reads the input
//! ending f quanta ago; an inverse at slot i adds at frame `128 (k + 17 - i)`, still ahead of the
//! read position for `i <= 15`.)

use audio_dsp::convolver::{fft, head_partitions, tail_partitions, HEAD_FRAMES, HEAD_PARTITIONS, QUANTUM, TAIL_BLOCK};
use microfft::Complex32;

pub type Sched = [(u32, u32); 2];
/// M1's schedule: left forward at slot 0, inverse at 15; right 1 and 14.
pub const M1_SCHED: Sched = [(0, 15), (1, 14)];

const CH: usize = 2;
const CYCLE: u32 = (TAIL_BLOCK / QUANTUM) as u32; // 16
const HP: usize = HEAD_PARTITIONS;
const HB: usize = QUANTUM; // head bins
const HEAD_FFT: usize = 2 * QUANTUM;
const INPUT_RING: usize = 2 * fft::SIZE;
const OUTPUT_RING: usize = fft::SIZE;
const ZERO: Complex32 = Complex32 { re: 0.0, im: 0.0 };

/// FFT scratch and twiddles, shared by every zone on the audio thread (one set per core).
pub struct Scratch {
    tw: Box<fft::Twiddles>,
    time: Vec<f32>,
    z: Vec<Complex32>,
    work: Vec<Complex32>,
}
impl Scratch {
    pub fn new() -> Self {
        let mut tw = Box::new([Complex32::default(); fft::BINS]);
        fft::twiddles(&mut tw);
        Scratch { tw, time: vec![0.0; fft::SIZE], z: vec![ZERO; fft::BINS], work: vec![ZERO; fft::BINS] }
    }
    pub const fn bytes() -> usize {
        fft::BINS * 8 + fft::SIZE * 4 + 2 * fft::BINS * 8
    }
}

#[inline]
fn multiply_add(acc: &mut [Complex32], x: &[Complex32], h: &[Complex32]) {
    acc[0].re += x[0].re * h[0].re;
    acc[0].im += x[0].im * h[0].im;
    for ((a, x), h) in acc[1..].iter_mut().zip(&x[1..]).zip(&h[1..]) {
        *a += *x * *h;
    }
}

/// One reverb zone: a stereo staged convolver with its own partition spectra and histories.
pub struct Zone {
    pub frames: usize,
    /// The normalisation scale baked into the spectra (set when the IR's rms pass completes).
    pub scale: f32,
    pub head: usize,
    pub tail: usize,
    head_kernel: Vec<Complex32>,
    head_spectra: Vec<Complex32>,
    head_prev: [[f32; QUANTUM]; CH],
    head_newest: [usize; CH],
    tail_kernel: Vec<Complex32>,
    fdl: Vec<Complex32>,
    acc: Vec<Complex32>,
    ring_in: Vec<f32>,
    ring_out: Vec<f32>,
    newest: [usize; CH],
    pub k: u32,
    pub sched: Sched,
    /// Tail transforms (forward + inverse, both channels) run by the last `process`.
    pub last_tail_ffts: u32,
}

impl Zone {
    /// Allocates the buffers for an IR of `frames` (all zero: silent until `Prep` fills them).
    pub fn alloc(frames: usize, sched: Sched) -> Self {
        let (head, tail) = (head_partitions(frames), tail_partitions(frames));
        Zone {
            frames,
            scale: 1.0,
            head,
            tail,
            head_kernel: vec![ZERO; CH * HP * HB],
            head_spectra: vec![ZERO; CH * HP * HB],
            head_prev: [[0.0; QUANTUM]; CH],
            head_newest: [0; CH],
            tail_kernel: vec![ZERO; CH * tail * fft::BINS],
            fdl: vec![ZERO; CH * tail * fft::BINS],
            acc: vec![ZERO; CH * fft::BINS],
            ring_in: vec![0.0; CH * INPUT_RING],
            ring_out: vec![0.0; CH * OUTPUT_RING],
            newest: [0; CH],
            k: 0,
            sched,
            last_tail_ffts: 0,
        }
    }

    /// Partition spectra of the response: the part that depends on the IR (and is rebuilt on a
    /// zone switch).
    pub fn kernel_bytes(&self) -> usize {
        (self.head_kernel.len() + self.tail_kernel.len()) * 8
    }
    /// Everything the zone owns (kernels, input spectra delay lines, rings, accumulators).
    pub fn bytes(&self) -> usize {
        (self.head_kernel.len() + self.head_spectra.len() + self.tail_kernel.len() + self.fdl.len() + self.acc.len()) * 8
            + (self.ring_in.len() + self.ring_out.len()) * 4
            + CH * QUANTUM * 4
    }
    pub fn kernels_equal(&self, o: &Zone) -> bool {
        self.head_kernel == o.head_kernel && self.tail_kernel == o.tail_kernel
    }

    /// Convolves one quantum: reads `in_*`, **adds** the wet signal to `out_*` (each 128 long).
    pub fn process(&mut self, sc: &mut Scratch, in_l: &[f32], in_r: &[f32], out_l: &mut [f32], out_r: &mut [f32]) {
        let (head, tail) = (self.head, self.tail);
        let k = self.k;
        let at = (k as usize).wrapping_mul(QUANTUM);
        let Scratch { tw, time, z, work } = sc;
        let mut tail_ffts = 0;
        for (c, (src, dst)) in [(in_l, &mut *out_l), (in_r, &mut *out_r)].into_iter().enumerate() {
            // Head stage (uniform 128-frame partitions on a 256-point FFT).
            let spectra = &mut self.head_spectra[c * HP * HB..(c + 1) * HP * HB];
            let block = &mut time[..HEAD_FFT];
            block[..QUANTUM].copy_from_slice(&self.head_prev[c]);
            block[QUANTUM..].copy_from_slice(src);
            self.head_prev[c].copy_from_slice(src);
            let newest = (self.head_newest[c] + 1) % HP;
            self.head_newest[c] = newest;
            spectra[newest * HB..(newest + 1) * HB].copy_from_slice(fft::rfft(block, &mut work[..], tw));
            let head_acc = &mut z[HB..2 * HB];
            head_acc.fill(ZERO);
            let kernel = &self.head_kernel[c * HP * HB..(c + 1) * HP * HB];
            for p in 0..head {
                let s = (newest + HP - p) % HP;
                multiply_add(head_acc, &spectra[s * HB..(s + 1) * HB], &kernel[p * HB..(p + 1) * HB]);
            }
            let (zl, zh) = z.split_at_mut(HB);
            fft::irfft(&zh[..HB], &mut time[..HEAD_FFT], zl, &mut work[..], tw);
            for (d, w) in dst.iter_mut().zip(&time[QUANTUM..HEAD_FFT]) {
                *d += *w;
            }
            // Tail stage.
            let ring = &mut self.ring_in[c * INPUT_RING..(c + 1) * INPUT_RING];
            let w = at & (INPUT_RING - 1);
            ring[w..w + QUANTUM].copy_from_slice(src);
            let accumulation = &mut self.ring_out[c * OUTPUT_RING..(c + 1) * OUTPUT_RING];
            if tail > 0 {
                let (f, i) = self.sched[c];
                let s = k.wrapping_add(1) % CYCLE;
                let kernel = &self.tail_kernel[c * tail * fft::BINS..(c + 1) * tail * fft::BINS];
                let fdl = &mut self.fdl[c * tail * fft::BINS..(c + 1) * tail * fft::BINS];
                let acc = &mut self.acc[c * fft::BINS..(c + 1) * fft::BINS];
                if s == f {
                    let end = k.wrapping_sub(f).wrapping_add(1).wrapping_mul(QUANTUM as u32) as usize;
                    let start = end.wrapping_sub(fft::SIZE) & (INPUT_RING - 1);
                    let first = (INPUT_RING - start).min(fft::SIZE);
                    time[..first].copy_from_slice(&ring[start..start + first]);
                    time[first..].copy_from_slice(&ring[..fft::SIZE - first]);
                    let n = (self.newest[c] + 1) % tail;
                    self.newest[c] = n;
                    fdl[n * fft::BINS..(n + 1) * fft::BINS].copy_from_slice(fft::rfft(time, work, tw));
                    acc.fill(ZERO);
                    tail_ffts += 1;
                } else if s > f && s < i {
                    let slots = (i - f - 1) as usize;
                    let idx = (s - f - 1) as usize;
                    let newest = self.newest[c];
                    for j in idx * tail / slots..(idx + 1) * tail / slots {
                        let sl = (newest + tail - j) % tail;
                        multiply_add(acc, &fdl[sl * fft::BINS..(sl + 1) * fft::BINS], &kernel[j * fft::BINS..(j + 1) * fft::BINS]);
                    }
                } else if s == i {
                    fft::irfft(acc, time, z, work, tw);
                    let to = k.wrapping_add(17 - i).wrapping_mul(QUANTUM as u32) as usize;
                    for (n, y) in time[TAIL_BLOCK..].iter().enumerate() {
                        accumulation[(to + n) & (OUTPUT_RING - 1)] += *y;
                    }
                    tail_ffts += 1;
                }
            }
            let r = at & (OUTPUT_RING - 1);
            for (d, a) in dst.iter_mut().zip(accumulation[r..r + QUANTUM].iter_mut()) {
                *d += *a;
                *a = 0.0;
            }
        }
        self.last_tail_ffts = tail_ffts;
        self.k = k.wrapping_add(1);
    }
}

const GAIN_CALIBRATION: f32 = -58.0;
const MIN_POWER: f32 = 0.000125;
const RMS_CHUNK: usize = 8192;

/// Builds a zone's partition spectra from an IR in bounded steps ("units"): the normalisation
/// pass (`ir.rs`'s `normalization_scale`, 8,192 samples per unit) then one forward FFT per
/// (channel, partition): head partitions (256-point) first, then tail partitions (4,096-point).
/// `tick(.., usize::MAX)` is the at-once preparation M1 does in `init`.
pub struct Prep {
    ir: [Vec<f32>; 2],
    pub zone: Zone,
    scale: f32,
    sum: f64,
    rms_pos: usize,
    c: usize,
    part: usize,
    pub done: bool,
    pub units_done: usize,
}

impl Prep {
    /// Takes the IR (the engine would read it from the decoded clip) and allocates the zone.
    pub fn new(ir: [Vec<f32>; 2], sched: Sched) -> Self {
        let frames = ir[0].len();
        Prep { zone: Zone::alloc(frames, sched), ir, scale: 1.0, sum: 0.0, rms_pos: 0, c: 0, part: 0, done: false, units_done: 0 }
    }

    pub fn total_units(&self) -> usize {
        let n = self.ir[0].len();
        (CH * n).div_ceil(RMS_CHUNK) + CH * (self.zone.head + self.zone.tail)
    }

    /// Does up to `units` units of work; returns true once the zone is ready.
    pub fn tick(&mut self, sc: &mut Scratch, units: usize) -> bool {
        let mut left = units;
        while left > 0 && !self.done {
            self.unit(sc);
            self.units_done += 1;
            left -= 1;
        }
        self.done
    }

    fn unit(&mut self, sc: &mut Scratch) {
        let n = self.ir[0].len();
        if self.rms_pos < CH * n {
            let end = (self.rms_pos + RMS_CHUNK).min(CH * n);
            for i in self.rms_pos..end {
                let x = self.ir[i / n][i % n] as f64;
                self.sum += x * x;
            }
            self.rms_pos = end;
            if end == CH * n {
                let mut power = libm::sqrt(self.sum / (CH * n) as f64) as f32;
                if !power.is_finite() || power < MIN_POWER {
                    power = MIN_POWER;
                }
                let mut scale = 1.0 / power;
                scale *= libm::powf(10.0, GAIN_CALIBRATION * 0.05);
                scale *= 44_100.0 / 48_000.0;
                self.scale = scale;
                self.zone.scale = scale;
            }
            return;
        }
        let Scratch { tw, time, work, .. } = sc;
        let (head, tail) = (self.zone.head, self.zone.tail);
        let (c, p) = (self.c, self.part);
        let (ir, scale) = (&self.ir[c], self.scale);
        let at = |i: usize| if i < n { ir[i] * scale } else { 0.0 };
        if p < head {
            let block = &mut time[..HEAD_FFT];
            block.fill(0.0);
            for (i, x) in block[..QUANTUM].iter_mut().enumerate() {
                *x = at(p * QUANTUM + i);
            }
            let o = (c * HP + p) * HB;
            self.zone.head_kernel[o..o + HB].copy_from_slice(fft::rfft(block, work, tw));
        } else {
            let q = p - head;
            time.fill(0.0);
            for (i, x) in time[..TAIL_BLOCK].iter_mut().enumerate() {
                *x = at(HEAD_FRAMES + q * TAIL_BLOCK + i);
            }
            let o = (c * tail + q) * fft::BINS;
            self.zone.tail_kernel[o..o + fft::BINS].copy_from_slice(fft::rfft(time, work, tw));
        }
        self.part += 1;
        if self.part == head + tail {
            self.part = 0;
            self.c += 1;
            if self.c == CH {
                self.done = true;
            }
        }
    }

    /// Runs to completion and returns the ready zone.
    pub fn finish(mut self, sc: &mut Scratch) -> Zone {
        self.tick(sc, usize::MAX);
        self.zone
    }
}

/// Cost model for the planner (native measurements, `examples/micro.rs`): a 4,096-point
/// transform 1.0, one partition's multiply-add 0.055.
const MAC_WEIGHT: f64 = 0.055;

fn add_channel(load: &mut [f64; 16], count: &mut [u32; 16], f: u32, i: u32, parts: usize, sign: f64) {
    load[f as usize] += sign;
    load[i as usize] += sign;
    if sign > 0.0 {
        count[f as usize] += 1;
        count[i as usize] += 1;
    } else {
        count[f as usize] -= 1;
        count[i as usize] -= 1;
    }
    let slots = (i - f - 1) as f64;
    for s in f + 1..i {
        load[s as usize] += sign * MAC_WEIGHT * parts as f64 / slots;
    }
}

/// Spreads the tail work of zones over the 16-quantum cycle. `tail_parts[z]` is zone z's tail
/// partition count (for the multiply-add load). Each channel needs a forward slot f and an
/// inverse slot i (`f + 2 <= i <= 15`); the multiply-adds fill the slots between. Finds the
/// smallest cap (in steps of 0.05 transform-equivalents) on any quantum's modelled load for which
/// a depth-first search over the channels, in zone order, finds an assignment (each channel's
/// pairs tried lowest resulting peak first; a node budget bounds each attempt). For one or two
/// zones the result need not be M1's own schedule (the cap search only looks at the peak).
pub fn plan_stagger(tail_parts: &[usize]) -> Vec<Sched> {
    plan(tail_parts, false)
}

/// As [`plan_stagger`], but first priority is that no quantum carries more than the floor
/// `ceil(4 N / 16)` of transforms (zones never share a tail quantum while `N <= 4`); the peak load
/// comes second.
pub fn plan_unique(tail_parts: &[usize]) -> Vec<Sched> {
    plan(tail_parts, true)
}

fn plan(tail_parts: &[usize], unique: bool) -> Vec<Sched> {
    let channels = tail_parts.len() * 2;
    struct Search<'a> {
        parts: &'a [usize],
        channels: usize,
        cap: f64,
        count_cap: u32,
        budget: u32,
        out: Vec<(u32, u32)>,
    }
    fn dfs(s: &mut Search, ch: usize, load: &mut [f64; 16], count: &mut [u32; 16]) -> bool {
        if ch == s.channels {
            return true;
        }
        if s.budget == 0 {
            return false;
        }
        s.budget -= 1;
        let p = s.parts[ch / 2];
        let mut cands: Vec<(f64, f64, u32, u32)> = Vec::new();
        for f in 0..14u32 {
            for i in f + 2..16 {
                let mut l = *load;
                let mut c = *count;
                add_channel(&mut l, &mut c, f, i, p, 1.0);
                let peak = l.iter().cloned().fold(0.0, f64::max);
                if peak > s.cap + 1e-9 || c.iter().any(|&n| n > s.count_cap) {
                    continue;
                }
                let sq: f64 = l.iter().map(|x| x * x).sum();
                cands.push((peak, sq, f, i));
            }
        }
        cands.sort_by(|a, b| a.partial_cmp(b).unwrap());
        for (_, _, f, i) in cands {
            add_channel(load, count, f, i, p, 1.0);
            s.out.push((f, i));
            if dfs(s, ch + 1, load, count) {
                return true;
            }
            s.out.pop();
            add_channel(load, count, f, i, p, -1.0);
        }
        false
    }
    let total: f64 = tail_parts.iter().map(|&p| 4.0 + 2.0 * MAC_WEIGHT * p as f64).sum();
    let mut cap = (total / 16.0 * 20.0).floor() / 20.0;
    loop {
        let count_cap = if unique { (channels * 2).div_ceil(16) as u32 } else { u32::MAX };
        let mut s = Search { parts: tail_parts, channels, cap, count_cap, budget: 20_000, out: Vec::new() };
        if dfs(&mut s, 0, &mut [0.0; 16], &mut [0; 16]) {
            return s.out.chunks(2).map(|c| [c[0], c[1]]).collect();
        }
        cap += 0.05;
    }
}

/// Transforms per quantum slot `s = (k+1) % 16` implied by schedules (deterministic accounting).
pub fn transforms_per_slot(scheds: &[Sched]) -> [u32; 16] {
    let mut n = [0u32; 16];
    for s in scheds {
        for &(f, i) in s {
            n[f as usize] += 1;
            n[i as usize] += 1;
        }
    }
    n
}

/// Modelled tail load per slot, in 4,096-point-transform equivalents (`MAC_WEIGHT` per partition
/// multiply-add), for zones with `parts` tail partitions on `scheds`.
pub fn modelled_slot_load(scheds: &[Sched], parts: &[usize]) -> [f64; 16] {
    let (mut load, mut count) = ([0.0f64; 16], [0u32; 16]);
    for (s, &p) in scheds.iter().zip(parts) {
        for &(f, i) in s {
            add_channel(&mut load, &mut count, f, i, p, 1.0);
        }
    }
    load
}
