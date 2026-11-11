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
//!   (`instance.rs`): a quantum runs at most one 4,096-point transform per instance, and several
//!   instances are spread over the cycle by modelled load (`stagger.rs`, ADR 0162).
//!
//! **Where it lives.** One shared reverb for the whole core, in the `Reverb` region of the core's
//! layout, sized by [`region_bytes`] (3,015,744 bytes at 48 kHz). Since ADR 0162's split (task C1)
//! the region holds three parts, back to back: the seeded response's prepared kernel
//! (`kernel.rs`, api-and-models §4.5's layout, clip format 3), one instance's state on
//! [`SHARED_PHASE`](instance::SHARED_PHASE) (`instance.rs`), and the FFT [`Scratch`] (which zone
//! slots share, [`shared_scratch`]). The region is zeroed at init; [`init`] runs once from
//! `Core::new`, preparing the kernel with [`kernel::prepare_ir`] (`myco_audio_init`: may take
//! time, never in `process`); [`process`] runs once per quantum while any bus has a reverb send.
//! The output is bit-identical to the convolver before the split (`tests/convolver_digest.rs`).
//! Nothing allocates; transcendentals go through `libm`; [`process`] and [`reset`] are safe on a
//! zeroed region of any size (silence then).
//!
//! **Several convolvers** (zone slots, task C3) use the parts directly: a [`kernel::Kernel`]
//! parsed in place, an [`instance::Instance`] over it with a phase from [`stagger::plan_stagger`],
//! and one [`Scratch`].

pub mod fft;
pub mod instance;
pub mod ir;
pub mod kernel;
pub mod stagger;

use core::mem::size_of;

use microfft::Complex32;

use instance::{Instance, SHARED_PHASE};
use kernel::{IrSpec, Kernel};

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
/// Quanta per tail block: the period of the tail's schedule.
pub const CYCLE: u32 = (TAIL_BLOCK / QUANTUM) as u32;

pub(crate) const HEAD_FFT: usize = 2 * QUANTUM;
pub(crate) const HEAD_BINS: usize = QUANTUM;
/// Input history per channel: the tail transforms the last 4,096 frames up to one quantum late.
pub(crate) const INPUT_RING: usize = 2 * fft::SIZE;
/// Blink's `ReverbAccumulationBuffer`, per channel: the tail adds a block at most 2,432 frames
/// ahead of the read position.
pub(crate) const OUTPUT_RING: usize = fft::SIZE;
pub(crate) const CHANNELS: usize = ir::CHANNELS;
pub(crate) const ZERO_BIN: Complex32 = Complex32 { re: 0.0, im: 0.0 };

pub(crate) type HeadSpectrum = [Complex32; HEAD_BINS];
pub(crate) type TailSpectrum = [Complex32; fft::BINS];

/// Head partitions for a response of `frames`.
pub const fn head_partitions(frames: usize) -> usize {
    let n = if frames < HEAD_FRAMES { frames } else { HEAD_FRAMES };
    n.div_ceil(QUANTUM)
}

/// Tail partitions (Blink's stages at `max_fft_size`) for a response of `frames`.
pub const fn tail_partitions(frames: usize) -> usize {
    frames.saturating_sub(HEAD_FRAMES).div_ceil(TAIL_BLOCK)
}

/// The alignment every part needs (`u32`, `f32` and `Complex32` fields only).
pub(crate) const ALIGN: usize = 4;

pub(crate) fn aligned(bytes: &[u8]) -> bool {
    bytes.as_ptr() as usize % ALIGN == 0
}

/// # Safety
/// `[off, off + n * size_of::<T>())` is inside the allocation `base` points into, aligned for
/// `T`, not aliased by any other live reference, and every bit pattern is a valid `T` (floats and
/// integers only).
pub(crate) unsafe fn part<'a, T>(base: *mut u8, off: usize, n: usize) -> &'a mut [T] {
    core::slice::from_raw_parts_mut(base.add(off) as *mut T, n)
}

/// Adds `x * h` into `acc`, bin by bin; bin 0 packs two real values (DC in re, Nyquist in im).
#[inline]
pub(crate) fn multiply_add(acc: &mut [Complex32], x: &[Complex32], h: &[Complex32]) {
    acc[0].re += x[0].re * h[0].re;
    acc[0].im += x[0].im * h[0].im;
    for ((a, x), h) in acc[1..].iter_mut().zip(&x[1..]).zip(&h[1..]) {
        *a += *x * *h;
    }
}

/// Bytes of a [`Scratch`]: the twiddle table, a 4,096-frame time buffer and two 2,048-bin spectra.
pub const SCRATCH_BYTES: usize = 4 * fft::BINS * size_of::<Complex32>();

/// The FFT buffers every kernel preparation and instance uses (one set per core: instances run
/// one after another on the audio thread). Views of [`SCRATCH_BYTES`] caller-owned bytes.
pub struct Scratch<'a> {
    pub(crate) twiddles: &'a mut fft::Twiddles,
    pub(crate) time: &'a mut [f32; fft::SIZE],
    pub(crate) z: &'a mut TailSpectrum,
    pub(crate) work: &'a mut TailSpectrum,
}

impl<'a> Scratch<'a> {
    /// Views `bytes` (at least [`SCRATCH_BYTES`], 4-byte aligned) as a scratch, or `None`. The
    /// twiddles are whatever the bytes hold: call [`Scratch::fill_twiddles`] once first.
    pub fn from_bytes(bytes: &'a mut [u8]) -> Option<Self> {
        if bytes.len() < SCRATCH_BYTES || !aligned(bytes) {
            return None;
        }
        const Q: usize = SCRATCH_BYTES / 4;
        let base = bytes.as_mut_ptr();
        // SAFETY: four disjoint quarters of `bytes` (checked long enough and aligned), each the
        // size of its type; floats only.
        unsafe {
            Some(Scratch {
                twiddles: &mut *(base as *mut fft::Twiddles),
                time: &mut *(base.add(Q) as *mut [f32; fft::SIZE]),
                z: &mut *(base.add(2 * Q) as *mut TailSpectrum),
                work: &mut *(base.add(3 * Q) as *mut TailSpectrum),
            })
        }
    }

    /// Fills the twiddle table (`libm`; not in the process path).
    pub fn fill_twiddles(&mut self) {
        fft::twiddles(self.twiddles);
    }
}

/// Bytes the shared reverb needs in the core's `Reverb` region at `sample_rate`: the seeded
/// response's kernel, one instance's state and the scratch. 0 for a rate [`ir::frames`] refuses.
pub const fn region_bytes(sample_rate: f32) -> usize {
    let frames = ir::frames(sample_rate);
    if frames == 0 {
        0
    } else {
        kernel::kernel_bytes(frames) + instance::state_bytes(tail_partitions(frames)) + SCRATCH_BYTES
    }
}

/// The region's parts: its kernel (parsed), the instance's state bytes and the scratch; `None`
/// when no kernel was prepared (a zeroed, short or misaligned region).
fn split(region: &mut [u8]) -> Option<(Kernel<'_>, &mut [u8], Scratch<'_>)> {
    let (kb, tail) = {
        let k = Kernel::parse(region)?;
        (k.byte_len(), k.tail_parts())
    };
    let (k, rest) = region.split_at_mut(kb);
    let sb = instance::state_bytes(tail);
    if rest.len() < sb + SCRATCH_BYTES {
        return None;
    }
    let (state, scratch) = rest.split_at_mut(sb);
    Some((Kernel::parse(k)?, state, Scratch::from_bytes(scratch)?))
}

/// Prepares the shared reverb in `region` (at least [`region_bytes`] bytes, zeroed): fills the
/// scratch's twiddles, prepares the seeded response (`ir.rs`), scaled by Blink's normalisation,
/// with [`kernel::prepare_ir`], and starts the instance on
/// [`SHARED_PHASE`](instance::SHARED_PHASE). Called once by `Core::new`. A region that is too
/// small or misaligned is left without reverb.
pub fn init(region: &mut [u8], sample_rate: f32) {
    if region.len() >= kernel::HEADER_BYTES && aligned(region) {
        region[..4].fill(0); // no kernel until this one is prepared
    }
    let frames = ir::frames(sample_rate);
    if frames == 0 || region.len() < region_bytes(sample_rate) || !aligned(region) {
        return;
    }
    let (kb, sb) = (kernel::kernel_bytes(frames), instance::state_bytes(tail_partitions(frames)));
    let (k, rest) = region.split_at_mut(kb);
    let (state, scratch) = rest.split_at_mut(sb);
    let Some(mut scratch) = Scratch::from_bytes(scratch) else { return };
    scratch.fill_twiddles();
    let spec = IrSpec { frames, sample_rate, scale: ir::normalization_scale(sample_rate), flags: 0 };
    let mut g = ir::Generator::new(sample_rate);
    if kernel::prepare_ir(k, &mut scratch, spec, || g.next_sample()).is_none() {
        return;
    }
    if let Some(kernel) = Kernel::parse(k) {
        let _ = Instance::start(kernel, state, SHARED_PHASE);
    }
}

/// Convolves one quantum: reads `in_l`/`in_r` (the summed sends) and **adds** the wet signal into
/// `out_l`/`out_r`. Every slice must be [`QUANTUM`] long (otherwise nothing happens). The work is
/// [`Instance::process`]'s on [`SHARED_PHASE`](instance::SHARED_PHASE).
pub fn process(region: &mut [u8], in_l: &[f32], in_r: &[f32], out_l: &mut [f32], out_r: &mut [f32]) {
    let Some((kernel, state, mut scratch)) = split(region) else { return };
    if let Some(mut inst) = Instance::attach(kernel, state) {
        inst.process(&mut scratch, in_l, in_r, out_l, out_r);
    }
}

/// Clears the tail (input histories, delay lines, accumulation buffers), keeping the response's
/// spectra. Called by RESET.
pub fn reset(region: &mut [u8]) {
    let Some((kernel, state, _)) = split(region) else { return };
    if let Some(mut inst) = Instance::attach(kernel, state) {
        inst.reset();
    }
}

/// The region's FFT scratch (twiddles filled), for zone slots to share with the shared reverb
/// (they run one after another on the audio thread). `None` when [`init`] prepared no reverb.
pub fn shared_scratch(region: &mut [u8]) -> Option<Scratch<'_>> {
    split(region).map(|(_, _, s)| s)
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
        assert!(shared_scratch(bytes).is_none());
    }

    #[test]
    fn the_region_is_kernel_then_state_then_scratch() {
        let sr = 48_000.0;
        let mut r = vec![0u64; region_bytes(sr) / 8];
        let bytes = unsafe { core::slice::from_raw_parts_mut(r.as_mut_ptr() as *mut u8, r.len() * 8) };
        init(bytes, sr);
        let (kb, tail) = {
            let k = Kernel::parse(bytes).unwrap();
            assert_eq!((k.frames(), k.head_parts(), k.tail_parts(), k.sample_rate(), k.flags()), (86_400, 32, 41, sr, 0));
            (k.byte_len(), k.tail_parts())
        };
        // The state starts 32 bytes past a 64-byte boundary, so its parts after the 32-byte header
        // are 64-byte aligned, as the old layout's.
        assert_eq!(kb % 64, 32);
        assert_eq!(kb + instance::state_bytes(tail) + SCRATCH_BYTES, region_bytes(sr));
        let (k, rest) = bytes.split_at_mut(kb);
        let inst = Instance::attach(Kernel::parse(k).unwrap(), rest).unwrap();
        assert_eq!(inst.phase(), SHARED_PHASE);
        let s = shared_scratch(bytes).unwrap();
        assert_eq!(s.twiddles[1].re, libm::cos(-2.0 * core::f64::consts::PI / 4096.0) as f32);
    }
}
