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

use super::kernel::Kernel;
use super::{Scratch, CYCLE};

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

/// Bytes of an instance's state for a kernel of `tail_parts` tail partitions.
pub const fn state_bytes(tail_parts: usize) -> usize {
    let _ = tail_parts;
    0 // C1: filled in with the layout
}

/// One stereo convolver over a borrowed kernel and its own state bytes.
pub struct Instance<'a> {
    kernel: Kernel<'a>,
    state: &'a mut [u8],
}

impl<'a> Instance<'a> {
    /// Starts an instance in `state` (cleared) for `kernel`, on `phase`. `None` if the state is
    /// too short or misaligned, or the phase is invalid.
    pub fn start(kernel: Kernel<'a>, state: &'a mut [u8], phase: Phase) -> Option<Self> {
        let _ = (kernel, state, phase);
        todo!("C1")
    }

    /// The instance already started in `state` for `kernel` (same tail partition count); `None`
    /// if it wasn't started, was started for another kernel size, or its header is corrupt.
    pub fn attach(kernel: Kernel<'a>, state: &'a mut [u8]) -> Option<Self> {
        let _ = (kernel, state);
        todo!("C1")
    }

    /// The instance's phase.
    pub fn phase(&self) -> Phase {
        todo!("C1")
    }

    /// Clears the histories, delay lines and accumulators and restarts the clock, keeping the
    /// phase (RESET).
    pub fn reset(&mut self) {
        todo!("C1")
    }

    /// Convolves one quantum: reads `in_l`/`in_r`, **adds** the wet signal into `out_l`/`out_r`
    /// (each [`QUANTUM`](super::QUANTUM) long, otherwise nothing happens). `scratch`'s twiddles
    /// must be filled. Allocates nothing.
    pub fn process(&mut self, scratch: &mut Scratch<'_>, in_l: &[f32], in_r: &[f32], out_l: &mut [f32], out_r: &mut [f32]) {
        let _ = (&self.kernel, &self.state, scratch, in_l, in_r, out_l, out_r);
        todo!("C1")
    }
}
