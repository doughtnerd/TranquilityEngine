// SPDX-License-Identifier: BSD-3-Clause
// Ported from chromium/src/third_party/blink/renderer/platform/audio/reverb_convolver.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/reverb_accumulation_buffer.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Copyright (C) 2010 Google Inc. All rights reserved. (Full notice in `convolver.rs`.)

//! One stereo convolver's mutable state (ADR 0162 C1, api-and-models §5.2): the head stage's
//! input spectra, the tail's frequency-domain delay lines and accumulators, the input history and
//! Blink's accumulation buffer, the schedule's clock and its stagger [`Phase`]. The response's
//! spectra are not here: an [`Instance`] borrows a prepared [`Kernel`] (`kernel.rs`), so several
//! instances can run over kernels held elsewhere (the shared reverb's in its region, zone kernels
//! in the arena, task C3), and one FFT [`Scratch`] serves them all.
//!
//! **State layout** (`state`, at least [`state_bytes`] bytes, 4-byte aligned; all-zero means "not
//! started": silence): a 32-byte header (`ready`, `tail_parts`, the quantum clock, the phase, the
//! delay lines' newest slots), then, packed, per channel the head input (32 spectra of 128 bins
//! and the previous quantum), the tail delay line (`tail_parts` spectra of 2,048 bins), the
//! accumulator (2,048 bins), the input ring (8,192 frames) and the accumulation buffer (4,096
//! frames). Every part's size is a multiple of 64 bytes, so the parts are 64-byte aligned when the
//! state starts 32 bytes past a 64-byte boundary, as it does after a kernel in the shared
//! reverb's region.
//!
//! **Processing** is M1's (`convolver.rs`'s doc): per channel, the head stage transforms
//! `[previous quantum, this quantum]`, multiplies the newest 32 input spectra with its partitions
//! and adds the inverse's last 128 frames at once (zero latency). The tail runs on a 16-quantum
//! schedule; block `m` (frames `[2048m, 2048m + 2048)`) completes in quantum `k_m = 16m + 15`.
//! Channel `c` on `(f, i)` runs, at slot `s = (k + 1) % 16`: the forward FFT of the block's last
//! 4,096 input frames at `s = f`; the delay line's multiply-adds, spread evenly over
//! `s = f + 1 ..= i - 1`; the inverse FFT at `s = i`, whose second half is added into the
//! accumulation buffer at frame `128 (k + 17 - i)` (= `2048 (m + 2)`, the block's output frame).
//! Last, the quantum's frames are read from the accumulation buffer and cleared (Blink's
//! `ReadAndClear`). [`SHARED_PHASE`] is M1's schedule (`f = c`, `i = 15 - c`), so the shared
//! reverb's bits are M1's; any valid phase moves only when work runs, never the block grid, the
//! transformed input or the multiply-add order, so the output is the same on every phase.

use core::mem::size_of;

use super::kernel::Kernel;
use super::{
    aligned, fft, multiply_add, part, HeadSpectrum, Scratch, TailSpectrum, CHANNELS, CYCLE, HEAD_BINS, HEAD_FFT, HEAD_PARTITIONS, INPUT_RING, OUTPUT_RING, QUANTUM,
    TAIL_BLOCK, ZERO_BIN,
};

/// A stereo instance's tail schedule: per channel `(f, i)`, the slot of the forward transform and
/// of the inverse (`f + 2 <= i <= 15`, slot `s = (k + 1) % 16`); the multiply-adds fill the slots
/// between. Moves when work runs, never the block grid, so the output is the same on every valid
/// phase.
pub type Phase = [(u8, u8); 2];

/// The shared reverb's phase (M1's: left `(0, 15)`, right `(1, 14)`, Blink's per-channel render
/// phase).
pub const SHARED_PHASE: Phase = [(0, 15), (1, 14)];

/// `f + 2 <= i <= 15` for both channels.
pub const fn phase_is_valid(p: Phase) -> bool {
    let mut c = 0;
    while c < 2 {
        let (f, i) = p[c];
        if (f as u32) + 2 > i as u32 || i as u32 >= CYCLE {
            return false;
        }
        c += 1;
    }
    true
}

/// The state's header.
#[repr(C)]
struct State {
    /// 1 once started.
    ready: u32,
    tail_parts: u32,
    /// Quanta processed since start or reset (wrapping): the schedule's clock.
    quantum: u32,
    /// `[f0, i0, f1, i1]`.
    phase: [u8; 4],
    /// Per channel, the tail delay line's slot holding the newest input spectrum.
    newest: [u32; CHANNELS],
    /// Per channel, the head delay line's slot holding the newest input spectrum.
    head_newest: [u32; CHANNELS],
}

/// One channel's head input: the previous quantum (overlap-save) and the spectra of the newest
/// 32 two-quantum frames, in a ring.
#[repr(C)]
struct HeadInput {
    spectra: [HeadSpectrum; HEAD_PARTITIONS],
    previous: [f32; QUANTUM],
}

/// Byte offsets of the state's parts for `tail` tail partitions.
#[derive(Clone, Copy)]
struct Offsets {
    head_input: usize,
    fdl: usize,
    acc: usize,
    input: usize,
    output: usize,
    total: usize,
}

const fn offsets(tail: usize) -> Offsets {
    let head_input = size_of::<State>();
    let fdl = head_input + CHANNELS * size_of::<HeadInput>();
    let acc = fdl + CHANNELS * tail * size_of::<TailSpectrum>();
    let input = acc + CHANNELS * size_of::<TailSpectrum>();
    let output = input + CHANNELS * INPUT_RING * size_of::<f32>();
    let total = output + CHANNELS * OUTPUT_RING * size_of::<f32>();
    Offsets { head_input, fdl, acc, input, output, total }
}

const _: () = assert!(size_of::<State>() == 32 && size_of::<HeadInput>() % 64 == 0);

/// Bytes of an instance's state for a kernel of `tail_parts` tail partitions.
pub const fn state_bytes(tail_parts: usize) -> usize {
    offsets(tail_parts).total
}

/// One stereo convolver over a borrowed kernel and its own state bytes.
pub struct Instance<'a> {
    kernel: Kernel<'a>,
    h: &'a mut State,
    head_input: &'a mut [HeadInput],
    fdl: &'a mut [TailSpectrum],
    acc: &'a mut [TailSpectrum],
    input: &'a mut [f32],
    output: &'a mut [f32],
}

impl<'a> Instance<'a> {
    /// The views of `state` for `kernel`, or `None` if it is too short or misaligned.
    fn view(kernel: Kernel<'a>, state: &'a mut [u8]) -> Option<Self> {
        let tail = kernel.tail_parts();
        let o = offsets(tail);
        if state.len() < o.total || !aligned(state) {
            return None;
        }
        let base = state.as_mut_ptr();
        // SAFETY: `offsets` lays the parts out in order, each starting where the previous one
        // ends (every size a multiple of 4), all before `o.total <= state.len()`; the base is
        // 4-byte aligned (checked); every part is integers and floats only.
        unsafe {
            Some(Instance {
                kernel,
                h: &mut *(base as *mut State),
                head_input: part(base, o.head_input, CHANNELS),
                fdl: part(base, o.fdl, CHANNELS * tail),
                acc: part(base, o.acc, CHANNELS),
                input: part(base, o.input, CHANNELS * INPUT_RING),
                output: part(base, o.output, CHANNELS * OUTPUT_RING),
            })
        }
    }

    /// Starts an instance in `state` (cleared) for `kernel`, on `phase`. `None` if the state is
    /// too short or misaligned, or the phase is invalid.
    pub fn start(kernel: Kernel<'a>, state: &'a mut [u8], phase: Phase) -> Option<Self> {
        if !phase_is_valid(phase) {
            return None;
        }
        let n = state_bytes(kernel.tail_parts());
        if state.len() >= n {
            state[..n].fill(0);
        }
        Self::start_cleared(kernel, state, phase)
    }

    /// [`Instance::start`] on a state whose first [`state_bytes`] bytes are already zero, without
    /// clearing them again (ADR 0162 C3b: a zone slot clears its state over several quanta while
    /// its kernel is prepared, so starting it costs no quantum a megabyte-long fill).
    pub fn start_cleared(kernel: Kernel<'a>, state: &'a mut [u8], phase: Phase) -> Option<Self> {
        if !phase_is_valid(phase) {
            return None;
        }
        let inst = Self::view(kernel, state)?;
        inst.h.tail_parts = kernel.tail_parts() as u32;
        inst.h.phase = [phase[0].0, phase[0].1, phase[1].0, phase[1].1];
        inst.h.ready = 1;
        Some(inst)
    }

    /// The instance already started in `state` for `kernel` (same tail partition count); `None`
    /// if it wasn't started, was started for another kernel size, or its header is corrupt.
    pub fn attach(kernel: Kernel<'a>, state: &'a mut [u8]) -> Option<Self> {
        let inst = Self::view(kernel, state)?;
        let tail = kernel.tail_parts();
        let h = &*inst.h;
        let sane = h.ready == 1
            && h.tail_parts as usize == tail
            && phase_is_valid(inst.phase())
            && h.newest.iter().all(|&n| (n as usize) < tail.max(1))
            && h.head_newest.iter().all(|&n| (n as usize) < HEAD_PARTITIONS);
        sane.then_some(inst)
    }

    /// Sets the schedule's clock to `k` (ADR 0162 C3: a zone slot aligns its block grid with the
    /// core's quantum count, so the stagger planner's phases hold across slots). Only while the
    /// state holds silence (just started, or idle long enough that every history is zero): the
    /// block grid moves with the clock, so audio in flight would be misplaced.
    pub fn set_clock(&mut self, k: u32) {
        self.h.quantum = k;
    }

    /// The schedule's clock: quanta processed since start or reset, or as set by
    /// [`Instance::set_clock`] (wrapping).
    pub fn clock(&self) -> u32 {
        self.h.quantum
    }

    /// The instance's phase.
    pub fn phase(&self) -> Phase {
        let p = self.h.phase;
        [(p[0], p[1]), (p[2], p[3])]
    }

    /// Clears the histories, delay lines and accumulators and restarts the clock, keeping the
    /// phase (RESET).
    pub fn reset(&mut self) {
        for x in self.head_input.iter_mut() {
            for s in x.spectra.iter_mut() {
                s.fill(ZERO_BIN);
            }
            x.previous.fill(0.0);
        }
        for x in self.fdl.iter_mut().chain(self.acc.iter_mut()) {
            x.fill(ZERO_BIN);
        }
        self.input.fill(0.0);
        self.output.fill(0.0);
        self.h.quantum = 0;
        self.h.newest = [0; CHANNELS];
        self.h.head_newest = [0; CHANNELS];
    }

    /// Convolves one quantum: reads `in_l`/`in_r`, **adds** the wet signal into `out_l`/`out_r`
    /// (each [`QUANTUM`](super::QUANTUM) long, otherwise nothing happens). `scratch`'s twiddles
    /// must be filled. Allocates nothing.
    pub fn process(&mut self, scratch: &mut Scratch<'_>, in_l: &[f32], in_r: &[f32], out_l: &mut [f32], out_r: &mut [f32]) {
        if in_l.len() != QUANTUM || in_r.len() != QUANTUM || out_l.len() != QUANTUM || out_r.len() != QUANTUM {
            return;
        }
        let phase = self.phase();
        let Instance { kernel, h, head_input, fdl, acc, input, output } = self;
        let Scratch { twiddles, time, z, work } = scratch;
        let (head, tail) = (kernel.head_parts(), kernel.tail_parts());
        let k = h.quantum;
        let at = (k as usize).wrapping_mul(QUANTUM);
        for (c, (src, dst)) in [(in_l, &mut *out_l), (in_r, &mut *out_r)].into_iter().enumerate() {
            // Head stage: push the quantum, then sum X[newest - p] * H[p] and transform back.
            let hi = &mut head_input[c];
            let block = &mut time[..HEAD_FFT];
            block[..QUANTUM].copy_from_slice(&hi.previous);
            block[QUANTUM..].copy_from_slice(src);
            hi.previous.copy_from_slice(src);
            let newest = (h.head_newest[c] as usize + 1) % HEAD_PARTITIONS;
            h.head_newest[c] = newest as u32;
            hi.spectra[newest].copy_from_slice(fft::rfft(block, &mut work[..], twiddles));
            let head_acc = &mut z[HEAD_BINS..2 * HEAD_BINS];
            head_acc.fill(ZERO_BIN);
            for (p, hk) in kernel.head[c * head..(c + 1) * head].iter().enumerate() {
                multiply_add(head_acc, &hi.spectra[(newest + HEAD_PARTITIONS - p) % HEAD_PARTITIONS], hk);
            }
            let (zl, zh) = z.split_at_mut(HEAD_BINS);
            fft::irfft(&zh[..HEAD_BINS], &mut time[..HEAD_FFT], zl, &mut work[..], twiddles);
            for (d, w) in dst.iter_mut().zip(&time[QUANTUM..HEAD_FFT]) {
                *d += *w;
            }
            // Tail stages.
            let ring = &mut input[c * INPUT_RING..(c + 1) * INPUT_RING];
            let w = at & (INPUT_RING - 1);
            ring[w..w + QUANTUM].copy_from_slice(src);
            let accumulation = &mut output[c * OUTPUT_RING..(c + 1) * OUTPUT_RING];
            if tail > 0 {
                Tail {
                    kernel: &kernel.tail[c * tail..(c + 1) * tail],
                    fdl: &mut fdl[c * tail..(c + 1) * tail],
                    acc: &mut acc[c],
                    newest: &mut h.newest[c],
                    ring,
                    accumulation: &mut *accumulation,
                    time: &mut **time,
                    z: &mut **z,
                    work: &mut **work,
                    twiddles: &**twiddles,
                }
                .step(k, phase[c].0 as u32, phase[c].1 as u32);
            }
            // ReadAndClear.
            let r = at & (OUTPUT_RING - 1);
            for (d, a) in dst.iter_mut().zip(accumulation[r..r + QUANTUM].iter_mut()) {
                *d += *a;
                *a = 0.0;
            }
        }
        h.quantum = k.wrapping_add(1);
    }
}

/// One channel's tail stages for one quantum.
struct Tail<'a> {
    kernel: &'a [TailSpectrum],
    fdl: &'a mut [TailSpectrum],
    acc: &'a mut TailSpectrum,
    newest: &'a mut u32,
    ring: &'a mut [f32],
    accumulation: &'a mut [f32],
    time: &'a mut [f32; fft::SIZE],
    z: &'a mut TailSpectrum,
    work: &'a mut TailSpectrum,
    twiddles: &'a fft::Twiddles,
}

impl Tail<'_> {
    /// Quantum `k`'s share of the channel's tail work on `(f, i)`.
    fn step(self, k: u32, f: u32, i: u32) {
        let parts = self.kernel.len();
        let s = k.wrapping_add(1) % CYCLE;
        if s == f {
            // The block completed `f` quanta ago: transform its last 4,096 input frames
            // (overlap-save) into the delay line's newest slot.
            let end = k.wrapping_sub(f).wrapping_add(1).wrapping_mul(QUANTUM as u32) as usize;
            let start = end.wrapping_sub(fft::SIZE) & (INPUT_RING - 1);
            let first = (INPUT_RING - start).min(fft::SIZE);
            self.time[..first].copy_from_slice(&self.ring[start..start + first]);
            self.time[first..].copy_from_slice(&self.ring[..fft::SIZE - first]);
            let newest = (*self.newest as usize + 1) % parts;
            *self.newest = newest as u32;
            self.fdl[newest].copy_from_slice(fft::rfft(self.time, self.work, self.twiddles));
            self.acc.fill(ZERO_BIN);
        } else if s > f && s < i {
            // This quantum's share of the stages: sum of X[m - j] * H[j].
            let slots = (i - f - 1) as usize;
            let n = (s - f - 1) as usize;
            let newest = *self.newest as usize;
            for j in n * parts / slots..(n + 1) * parts / slots {
                multiply_add(self.acc, &self.fdl[(newest + parts - j) % parts], &self.kernel[j]);
            }
        } else if s == i {
            // Inverse transform; the last half is the block's tail output, due at frame
            // 2048(m + 2) = 128(k + 17 - i). Accumulate it there.
            fft::irfft(self.acc, self.time, self.z, self.work, self.twiddles);
            let to = k.wrapping_add(CYCLE + 1 - i).wrapping_mul(QUANTUM as u32) as usize;
            for (n, y) in self.time[TAIL_BLOCK..].iter().enumerate() {
                self.accumulation[(to + n) & (OUTPUT_RING - 1)] += *y;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::kernel::{kernel_bytes, prepare_ir, IrSpec};
    use super::super::{tail_partitions, SCRATCH_BYTES};
    use super::*;

    fn bytes(r: &mut [u64]) -> &mut [u8] {
        // SAFETY: a u64 buffer viewed as its bytes.
        unsafe { core::slice::from_raw_parts_mut(r.as_mut_ptr() as *mut u8, r.len() * 8) }
    }

    fn noise(seed: u32) -> impl FnMut() -> f32 {
        let mut s = seed;
        move || {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            (s as f32 / u32::MAX as f32) * 2.0 - 1.0
        }
    }

    #[test]
    fn the_output_is_bit_identical_on_every_phase() {
        let mut sb = vec![0u64; SCRATCH_BYTES / 8];
        let mut scratch = Scratch::from_bytes(bytes(&mut sb)).unwrap();
        scratch.fill_twiddles();
        let frames = 20_000; // head 32, tail 8
        let mut kb = vec![0u64; kernel_bytes(frames).div_ceil(8)];
        let mut ir = noise(7);
        prepare_ir(bytes(&mut kb), &mut scratch, IrSpec { frames, sample_rate: 48_000.0, scale: 0.01, flags: 0 }, &mut ir).unwrap();
        let kernel = Kernel::parse(bytes(&mut kb)).unwrap();
        let phases: [Phase; 5] = [SHARED_PHASE, [(5, 11), (7, 13)], [(0, 2), (13, 15)], [(13, 15), (0, 2)], [(7, 9), (2, 10)]];
        let n = state_bytes(tail_partitions(frames));
        let mut states: Vec<Vec<u64>> = phases.iter().map(|_| vec![0u64; n.div_ceil(8)]).collect();
        for (st, &p) in states.iter_mut().zip(&phases) {
            assert_eq!(Instance::start(kernel, bytes(st), p).unwrap().phase(), p);
        }
        let mut x = noise(11);
        let mut heard = false;
        for q in 0..400 {
            let on = q % 50 < 20;
            let l: [f32; QUANTUM] = core::array::from_fn(|_| if on { x() } else { 0.0 });
            let r: [f32; QUANTUM] = core::array::from_fn(|_| if on { x() } else { 0.0 });
            let mut outs = Vec::new();
            for st in states.iter_mut() {
                let (mut ol, mut or) = ([0.0f32; QUANTUM], [0.0f32; QUANTUM]);
                let mut inst = Instance::attach(kernel, bytes(st)).unwrap();
                inst.process(&mut scratch, &l, &r, &mut ol, &mut or);
                if q == 300 {
                    inst.reset();
                }
                outs.push((ol.map(f32::to_bits), or.map(f32::to_bits)));
            }
            assert!(outs.iter().all(|o| *o == outs[0]), "quantum {q}");
            heard |= outs[0].0.iter().chain(&outs[0].1).any(|&b| b != 0);
        }
        assert!(heard, "the instances convolve");
    }

    #[test]
    fn start_and_attach_refuse() {
        let mut sb = vec![0u64; SCRATCH_BYTES / 8];
        let mut scratch = Scratch::from_bytes(bytes(&mut sb)).unwrap();
        scratch.fill_twiddles();
        let mut kb = vec![0u64; kernel_bytes(10_000).div_ceil(8)];
        prepare_ir(bytes(&mut kb), &mut scratch, IrSpec { frames: 10_000, sample_rate: 48_000.0, scale: 1.0, flags: 0 }, || 0.5).unwrap();
        let mut kb2 = vec![0u64; kernel_bytes(20_000).div_ceil(8)];
        prepare_ir(bytes(&mut kb2), &mut scratch, IrSpec { frames: 20_000, sample_rate: 48_000.0, scale: 1.0, flags: 0 }, || 0.5).unwrap();
        let (k, k2) = (Kernel::parse(bytes(&mut kb)).unwrap(), Kernel::parse(bytes(&mut kb2)).unwrap());
        let mut st = vec![0u64; state_bytes(k2.tail_parts()).div_ceil(8)];
        assert!(Instance::attach(k, bytes(&mut st)).is_none(), "not started");
        assert!(Instance::start(k, bytes(&mut st), [(3, 4), (0, 15)]).is_none(), "bad phase");
        assert!(Instance::start(k2, &mut bytes(&mut st)[..100], SHARED_PHASE).is_none(), "short");
        assert!(Instance::start(k, bytes(&mut st), SHARED_PHASE).is_some());
        assert!(Instance::attach(k, bytes(&mut st)).is_some());
        assert!(Instance::attach(k2, bytes(&mut st)).is_none(), "other kernel size");
    }
}
