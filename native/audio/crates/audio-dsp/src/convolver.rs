// SPDX-License-Identifier: BSD-3-Clause
// Ported from chromium/src/third_party/blink/renderer/platform/audio/reverb_convolver.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/reverb_convolver.h @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/reverb_convolver_stage.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/reverb_convolver_stage.h @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/reverb_accumulation_buffer.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/reverb_accumulation_buffer.h @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/fft_convolver.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/fft_convolver.h @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Copyright (C) 2010 Google Inc. All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions
// are met:
//
// 1.  Redistributions of source code must retain the above copyright
//     notice, this list of conditions and the following disclaimer.
// 2.  Redistributions in binary form must reproduce the above copyright
//     notice, this list of conditions and the following disclaimer in the
//     documentation and/or other materials provided with the distribution.
// 3.  Neither the name of Apple Computer, Inc. ("Apple") nor the names of
//     its contributors may be used to endorse or promote products derived
//     from this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY APPLE AND ITS CONTRIBUTORS "AS IS" AND ANY
// EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL APPLE OR ITS CONTRIBUTORS BE LIABLE FOR ANY

//! The shared reverb: Blink's staged `ReverbConvolver` on `microfft` (api-and-models §5), fed by
//! every bus effect `reverbSend` (`audio-core`'s `fx.rs`, contract K5).
//!
//! **Signal flow** (as `webAudioReference.ts`): each send adds `send * bus signal` (at the send's
//! place in the bus's chain) into one stereo input; [`process`] adds the wet output to the core's
//! output after the bus tree and before the MASTER gain. As Blink's `Reverb` with a stereo input
//! and a stereo response, the left input is convolved with the response's channel 0 and the right
//! with channel 1, each by its own convolver, with the response normalised (`ir.rs`).
//!
//! **What is ported, and what changed.** Blink's `ReverbConvolver` splits the response into stages
//! that each convolve one segment and add it into a `ReverbAccumulationBuffer` after their own
//! delay: a direct-convolution head, then `FFTConvolver` stages whose FFT size doubles from 128 up
//! to `max_fft_size`, every later stage at that size. Each stage's `render_phase` (the stage
//! index, plus one quantum per channel from `Reverb`) splits its delay into a pre- and post-delay,
//! so stages run their FFTs in different quanta. Kept here: zero latency (the output is the exact
//! linear convolution), the split into a short-partition head and long-partition tail stages, the
//! accumulation buffer the tail adds into at its delay, the per-channel render phase that keeps
//! the two channels' FFTs apart, the kernel scaling and the stereo matrixing. Changed, for the
//! budget (at most 0.1 ms average, 0.35 ms p99.9 per quantum, architecture §6.1; at the pinned
//! commit Blink runs every stage on the audio thread too) and the 150 KB wasm gate:
//! - The head is one stage of uniform 128-frame partitions over the first 4,096 frames,
//!   overlap-save on a 256-point FFT, as the HRTF panner's convolution (`hrtf::convolver`), not a
//!   direct stage plus five doubling FFT stages: the same zero-latency convolution with one FFT
//!   size and a flat cost per quantum. (It is written here rather than calling `hrtf::convolver`,
//!   whose FFT size dispatch would link 28 KB of microfft code; see `fft.rs`.)
//! - Blink's tail stages all have FFT size `max_fft_size` (4,096 here) and each transforms the
//!   same input on its own (41 stages at 48 kHz: about ten 4,096-point FFTs per quantum, forward
//!   and inverse, both channels). Here they share
//!   one transform: a frequency-domain delay line of input spectra, so a 2,048-frame block costs
//!   one forward and one inverse FFT per channel, plus one spectrum multiply-add per stage.
//! - The staggering moves from pre-delays to a fixed schedule over the 16 quanta of a tail block
//!   (see [`process`]): a quantum runs at most one 4,096-point transform.
//!
//! **Where it lives.** One convolver for the whole core, in the `Reverb` region of the core's
//! layout, sized by [`region_bytes`] (3,015,744 bytes at 48 kHz: the stages' partition spectra and the
//! delay lines). The region is zeroed at init; [`init`] runs once from `Core::new` and writes the
//! seeded response's spectra (`myco_audio_init`: may take time, never in `process`); [`process`]
//! runs once per quantum while any bus has a reverb send. Nothing allocates; transcendentals go
//! through `libm`; [`process`] and [`reset`] are safe on a zeroed region of any size (silence then).

pub mod fft;
pub mod instance;
pub mod ir;
pub mod kernel;
pub mod stagger;

use core::mem::{align_of, size_of};

use microfft::Complex32;

/// `false`: the staged convolver is in (A2.2b). It was `true` while this module was A2.1's stub.
pub const STUB: bool = false;

/// Frames per quantum: [`process`] takes exactly this many.
pub const QUANTUM: usize = 128;
/// The head stage's partitions (128 frames each, 256-point FFT).
pub const HEAD_PARTITIONS: usize = 32;
/// Frames of the response the head stage covers; the tail starts here.
pub const HEAD_FRAMES: usize = HEAD_PARTITIONS * QUANTUM;
/// Frames per tail partition (half the 4,096-point FFT): Blink's stage length at `max_fft_size`.
pub const TAIL_BLOCK: usize = fft::BINS;

const HEAD_FFT: usize = 2 * QUANTUM;
const HEAD_BINS: usize = QUANTUM;
/// Quanta per tail block: the period of the tail's schedule.
pub const CYCLE: u32 = (TAIL_BLOCK / QUANTUM) as u32;
/// Input history per channel: the tail transforms the last 4,096 frames up to one quantum late.
const INPUT_RING: usize = 2 * fft::SIZE;
/// Blink's `ReverbAccumulationBuffer`, per channel: the tail adds a block at most 2,432 frames
/// ahead of the read position.
const OUTPUT_RING: usize = fft::SIZE;
const CHANNELS: usize = ir::CHANNELS;
const ALIGN: usize = 64;
const ZERO_BIN: Complex32 = Complex32 { re: 0.0, im: 0.0 };

/// Bytes of a [`Scratch`]: the twiddle table, a 4,096-frame time buffer and two 2,048-bin spectra.
pub const SCRATCH_BYTES: usize = 4 * fft::BINS * size_of::<Complex32>();

/// The FFT buffers every kernel preparation and instance uses (one set per core: instances run
/// one after another on the audio thread). Views of [`SCRATCH_BYTES`] caller-owned bytes.
pub struct Scratch<'a> {
    twiddles: &'a mut fft::Twiddles,
    time: &'a mut [f32; fft::SIZE],
    z: &'a mut TailSpectrum,
    work: &'a mut TailSpectrum,
}

impl<'a> Scratch<'a> {
    /// Views `bytes` (at least [`SCRATCH_BYTES`], 4-byte aligned) as a scratch, or `None`. The
    /// twiddles are whatever the bytes hold: call [`Scratch::fill_twiddles`] once first.
    pub fn from_bytes(bytes: &'a mut [u8]) -> Option<Self> {
        let _ = bytes;
        todo!("C1")
    }

    /// Fills the twiddle table (`libm`; not in the process path).
    pub fn fill_twiddles(&mut self) {
        let _ = (&self.time, &self.z, &self.work);
        fft::twiddles(self.twiddles);
    }
}

type HeadSpectrum = [Complex32; HEAD_BINS];
type TailSpectrum = [Complex32; fft::BINS];

/// The region's first bytes. All-zero (`ready == 0`) means no reverb.
#[repr(C)]
struct Header {
    ready: u32,
    head_parts: u32,
    tail_parts: u32,
    /// Quanta processed since init or reset (wrapping): the schedule's clock.
    quantum: u32,
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

/// Head partitions for a response of `frames`.
pub const fn head_partitions(frames: usize) -> usize {
    let n = if frames < HEAD_FRAMES { frames } else { HEAD_FRAMES };
    n.div_ceil(QUANTUM)
}

/// Tail partitions (Blink's stages at `max_fft_size`) for a response of `frames`.
pub const fn tail_partitions(frames: usize) -> usize {
    frames.saturating_sub(HEAD_FRAMES).div_ceil(TAIL_BLOCK)
}

/// Byte offsets of the region's parts for `tail` tail partitions.
#[derive(Clone, Copy)]
struct Offsets {
    head_kernel: usize,
    head_input: usize,
    tail_kernel: usize,
    fdl: usize,
    acc: usize,
    input: usize,
    output: usize,
    twiddles: usize,
    time: usize,
    z: usize,
    work: usize,
    total: usize,
}

const fn up(n: usize) -> usize {
    n.div_ceil(ALIGN) * ALIGN
}

const fn offsets(tail: usize) -> Offsets {
    let head_kernel = up(size_of::<Header>());
    let head_input = up(head_kernel + CHANNELS * HEAD_PARTITIONS * size_of::<HeadSpectrum>());
    let tail_kernel = up(head_input + CHANNELS * size_of::<HeadInput>());
    let fdl = up(tail_kernel + CHANNELS * tail * size_of::<TailSpectrum>());
    let acc = up(fdl + CHANNELS * tail * size_of::<TailSpectrum>());
    let input = up(acc + CHANNELS * size_of::<TailSpectrum>());
    let output = up(input + CHANNELS * INPUT_RING * size_of::<f32>());
    let twiddles = up(output + CHANNELS * OUTPUT_RING * size_of::<f32>());
    let time = up(twiddles + size_of::<fft::Twiddles>());
    let z = up(time + fft::SIZE * size_of::<f32>());
    let work = up(z + size_of::<TailSpectrum>());
    let total = up(work + size_of::<TailSpectrum>());
    Offsets { head_kernel, head_input, tail_kernel, fdl, acc, input, output, twiddles, time, z, work, total }
}

/// The alignment the region's start needs (every part's offset is a multiple of 64).
const BASE_ALIGN: usize = {
    let (a, b, c) = (align_of::<Header>(), align_of::<HeadInput>(), align_of::<TailSpectrum>());
    let ab = if a > b { a } else { b };
    if ab > c {
        ab
    } else {
        c
    }
};

/// Bytes the convolver's state needs in the core's `Reverb` region at `sample_rate`: the header,
/// both channels' partition spectra (head and tail), input histories, frequency-domain delay
/// lines and accumulation buffers, and the shared FFT scratch. 0 for a rate [`ir::frames`] refuses.
pub const fn region_bytes(sample_rate: f32) -> usize {
    let frames = ir::frames(sample_rate);
    if frames == 0 {
        0
    } else {
        offsets(tail_partitions(frames)).total
    }
}

/// Typed views of the region's parts (disjoint byte ranges).
struct View<'a> {
    h: &'a mut Header,
    head_kernel: &'a mut [HeadSpectrum],
    head_input: &'a mut [HeadInput],
    tail_kernel: &'a mut [TailSpectrum],
    fdl: &'a mut [TailSpectrum],
    acc: &'a mut [TailSpectrum],
    input: &'a mut [f32],
    output: &'a mut [f32],
    scratch: RegionScratch<'a>,
}

/// The shared FFT buffers and twiddles.
struct RegionScratch<'a> {
    twiddles: &'a mut fft::Twiddles,
    time: &'a mut [f32; fft::SIZE],
    z: &'a mut TailSpectrum,
    work: &'a mut TailSpectrum,
}

fn aligned(region: &[u8]) -> bool {
    region.as_ptr() as usize % BASE_ALIGN == 0
}

fn header(region: &mut [u8]) -> Option<&mut Header> {
    if region.len() < size_of::<Header>() || !aligned(region) {
        return None;
    }
    // SAFETY: in bounds and aligned (checked above); every bit pattern is a valid `Header`.
    Some(unsafe { &mut *(region.as_mut_ptr() as *mut Header) })
}

/// The views for `tail` tail partitions, or `None` if the region is too small or misaligned.
fn view(region: &mut [u8], tail: usize) -> Option<View<'_>> {
    let o = offsets(tail);
    if region.len() < o.total || !aligned(region) {
        return None;
    }
    let base = region.as_mut_ptr();
    /// # Safety
    /// `[off, off + n * size_of::<T>())` is inside the region, aligned for `T`, disjoint from
    /// every other part, and every bit pattern is a valid `T` (floats and integers only).
    unsafe fn part<'a, T>(base: *mut u8, off: usize, n: usize) -> &'a mut [T] {
        core::slice::from_raw_parts_mut(base.add(off) as *mut T, n)
    }
    // SAFETY: `offsets` lays the parts out in order, each starting at a multiple of 64 after the
    // previous one ends, all before `o.total <= region.len()`; the base is aligned (checked).
    unsafe {
        Some(View {
            h: &mut *(base as *mut Header),
            head_kernel: part(base, o.head_kernel, CHANNELS * HEAD_PARTITIONS),
            head_input: part(base, o.head_input, CHANNELS),
            tail_kernel: part(base, o.tail_kernel, CHANNELS * tail),
            fdl: part(base, o.fdl, CHANNELS * tail),
            acc: part(base, o.acc, CHANNELS),
            input: part(base, o.input, CHANNELS * INPUT_RING),
            output: part(base, o.output, CHANNELS * OUTPUT_RING),
            scratch: RegionScratch {
                twiddles: &mut *(base.add(o.twiddles) as *mut fft::Twiddles),
                time: &mut *(base.add(o.time) as *mut [f32; fft::SIZE]),
                z: &mut *(base.add(o.z) as *mut TailSpectrum),
                work: &mut *(base.add(o.work) as *mut TailSpectrum),
            },
        })
    }
}

/// The views of an initialised region, or `None` (no reverb: silence).
fn ready_view(region: &mut [u8]) -> Option<View<'_>> {
    let h = header(region)?;
    if h.ready != 1 {
        return None;
    }
    let (head, tail) = (h.head_parts as usize, h.tail_parts as usize);
    let v = view(region, tail)?;
    let sane = head <= HEAD_PARTITIONS
        && v.h.newest.iter().all(|&n| (n as usize) < tail.max(1))
        && v.h.head_newest.iter().all(|&n| (n as usize) < HEAD_PARTITIONS);
    sane.then_some(v)
}

/// Prepares the state in `region` (at least [`region_bytes`] bytes, zeroed): generates the seeded
/// response (`ir.rs`), scales it by Blink's normalisation and stores every partition's spectrum.
/// Called once by `Core::new`. A region that is too small or misaligned is left without reverb.
pub fn init(region: &mut [u8], sample_rate: f32) {
    let Some(h) = header(region) else { return };
    h.ready = 0;
    let frames = ir::frames(sample_rate);
    if frames == 0 {
        return;
    }
    let (head, tail) = (head_partitions(frames), tail_partitions(frames));
    let Some(v) = view(region, tail) else { return };
    *v.h = Header { ready: 0, head_parts: head as u32, tail_parts: tail as u32, quantum: 0, newest: [0; CHANNELS], head_newest: [0; CHANNELS] };
    let RegionScratch { twiddles, time, work, .. } = v.scratch;
    fft::twiddles(twiddles);

    let scale = ir::normalization_scale(sample_rate);
    let mut g = ir::Generator::new(sample_rate);
    for c in 0..CHANNELS {
        // Channel c's samples come out of the generator in order, partition by partition.
        let mut drawn = 0;
        let mut next = |g: &mut ir::Generator| {
            if drawn < frames {
                drawn += 1;
                g.next_sample() * scale
            } else {
                0.0
            }
        };
        for p in 0..head {
            let block = &mut time[..HEAD_FFT];
            block.fill(0.0);
            for x in block[..QUANTUM].iter_mut() {
                *x = next(&mut g);
            }
            v.head_kernel[c * HEAD_PARTITIONS + p].copy_from_slice(fft::rfft(block, work, twiddles));
        }
        for p in 0..tail {
            time.fill(0.0);
            for x in time[..TAIL_BLOCK].iter_mut() {
                *x = next(&mut g);
            }
            v.tail_kernel[c * tail + p].copy_from_slice(fft::rfft(time, work, twiddles));
        }
    }
    v.h.ready = 1;
}

/// Adds `x * h` into `acc`, bin by bin; bin 0 packs two real values (DC in re, Nyquist in im).
#[inline]
fn multiply_add(acc: &mut [Complex32], x: &[Complex32], h: &[Complex32]) {
    acc[0].re += x[0].re * h[0].re;
    acc[0].im += x[0].im * h[0].im;
    for ((a, x), h) in acc[1..].iter_mut().zip(&x[1..]).zip(&h[1..]) {
        *a += *x * *h;
    }
}

/// Convolves one quantum: reads `in_l`/`in_r` (the summed sends) and **adds** the wet signal into
/// `out_l`/`out_r`. Every slice must be [`QUANTUM`] long (otherwise nothing happens).
///
/// Per channel: the head stage transforms `[previous quantum, this quantum]`, multiplies the
/// newest 32 input spectra with its partitions and adds the inverse's last 128 frames at once
/// (zero latency). The tail runs on a 16-quantum schedule; block `m` (frames
/// `[2048m, 2048m + 2048)`) completes in quantum `k_m = 16m + 15` and its output is due from frame
/// `2048(m + 2)`, at quantum `k_m + 17`. Channel `c` (render phase `c`, as Blink's `Reverb` offsets
/// each convolver by one quantum) runs, in quantum `k_m + s`: the forward FFT at `s = c`; the
/// multiply-adds of the delay line, spread evenly over `s = c + 1 ..= 14 - c`; the inverse FFT at
/// `s = 15 - c`, whose block is added into the accumulation buffer at its frame. So each quantum
/// runs at most one 4,096-point transform. Last, the quantum's frames are read from the
/// accumulation buffer and cleared (Blink's `ReadAndClear`).
pub fn process(region: &mut [u8], in_l: &[f32], in_r: &[f32], out_l: &mut [f32], out_r: &mut [f32]) {
    if in_l.len() != QUANTUM || in_r.len() != QUANTUM || out_l.len() != QUANTUM || out_r.len() != QUANTUM {
        return;
    }
    let Some(v) = ready_view(region) else { return };
    let View { h, head_kernel, head_input, tail_kernel, fdl, acc, input, output, scratch } = v;
    let RegionScratch { twiddles, time, z, work } = scratch;
    let (head, tail) = (h.head_parts as usize, h.tail_parts as usize);
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
        let kernel = &head_kernel[c * HEAD_PARTITIONS..(c + 1) * HEAD_PARTITIONS];
        for (p, hk) in kernel.iter().take(head).enumerate() {
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
                kernel: &tail_kernel[c * tail..(c + 1) * tail],
                fdl: &mut fdl[c * tail..(c + 1) * tail],
                acc: &mut acc[c],
                newest: &mut h.newest[c],
                ring,
                accumulation: &mut *accumulation,
                time: &mut *time,
                z: &mut *z,
                work: &mut *work,
                twiddles: &*twiddles,
            }
            .step(k, c as u32);
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
    fn step(self, k: u32, phase: u32) {
        let parts = self.kernel.len();
        let s = k.wrapping_add(1) % CYCLE;
        if s == phase {
            // The block completed `phase` quanta ago: transform its last 4,096 input frames
            // (overlap-save) into the delay line's newest slot.
            let end = k.wrapping_sub(phase).wrapping_add(1).wrapping_mul(QUANTUM as u32) as usize;
            let start = end.wrapping_sub(fft::SIZE) & (INPUT_RING - 1);
            let first = (INPUT_RING - start).min(fft::SIZE);
            self.time[..first].copy_from_slice(&self.ring[start..start + first]);
            self.time[first..].copy_from_slice(&self.ring[..fft::SIZE - first]);
            let newest = (*self.newest as usize + 1) % parts;
            *self.newest = newest as u32;
            self.fdl[newest].copy_from_slice(fft::rfft(self.time, self.work, self.twiddles));
            self.acc.fill(ZERO_BIN);
        } else if s > phase && s < CYCLE - 1 - phase {
            // This quantum's share of the stages: sum of X[m - j] * H[j].
            let slots = (CYCLE - 2 - 2 * phase) as usize;
            let i = (s - phase - 1) as usize;
            let newest = *self.newest as usize;
            for j in i * parts / slots..(i + 1) * parts / slots {
                multiply_add(self.acc, &self.fdl[(newest + parts - j) % parts], &self.kernel[j]);
            }
        } else if s == CYCLE - 1 - phase {
            // Inverse transform; the last half is the block's tail output, due at frame
            // 2048(m + 2) = 128(k + 2 + phase). Accumulate it there.
            fft::irfft(self.acc, self.time, self.z, self.work, self.twiddles);
            let to = k.wrapping_add(2 + phase).wrapping_mul(QUANTUM as u32) as usize;
            for (i, y) in self.time[TAIL_BLOCK..].iter().enumerate() {
                self.accumulation[(to + i) & (OUTPUT_RING - 1)] += *y;
            }
        }
    }
}

/// Clears the tail (input histories, delay lines, accumulation buffers), keeping the response's
/// spectra. Called by RESET.
pub fn reset(region: &mut [u8]) {
    let Some(v) = ready_view(region) else { return };
    for x in v.head_input.iter_mut() {
        for s in x.spectra.iter_mut() {
            s.fill(ZERO_BIN);
        }
        x.previous.fill(0.0);
    }
    for x in v.fdl.iter_mut().chain(v.acc.iter_mut()) {
        x.fill(ZERO_BIN);
    }
    v.input.fill(0.0);
    v.output.fill(0.0);
    v.h.quantum = 0;
    v.h.newest = [0; CHANNELS];
    v.h.head_newest = [0; CHANNELS];
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes() {
        assert_eq!(head_partitions(86_400), 32);
        assert_eq!(tail_partitions(86_400), 41);
        assert_eq!(head_partitions(100), 1);
        assert_eq!(tail_partitions(4_096), 0);
        assert_eq!(tail_partitions(4_097), 1);
        // Spectra and delay lines: 2 x 41 x 16 KB each; head 2 x 64 KB; rings, scratch, twiddles.
        assert_eq!(region_bytes(48_000.0), 3_015_744);
        assert_eq!(region_bytes(44_100.0), 2_753_600);
        assert_eq!(region_bytes(0.0), 0);
    }

    #[test]
    fn a_zeroed_or_short_region_is_silent() {
        let mut empty = [0u8; 0];
        init(&mut empty, 48_000.0);
        let input = [1.0f32; QUANTUM];
        let (mut l, mut r) = ([0.25f32; QUANTUM], [0.5f32; QUANTUM]);
        process(&mut empty, &input, &input, &mut l, &mut r);
        reset(&mut empty);
        assert_eq!((l, r), ([0.25; QUANTUM], [0.5; QUANTUM]));
        let mut zeroed = vec![0u64; region_bytes(48_000.0) / 8];
        let bytes = unsafe { core::slice::from_raw_parts_mut(zeroed.as_mut_ptr() as *mut u8, zeroed.len() * 8) };
        process(bytes, &input, &input, &mut l, &mut r);
        assert_eq!((l, r), ([0.25; QUANTUM], [0.5; QUANTUM]));
    }
}
