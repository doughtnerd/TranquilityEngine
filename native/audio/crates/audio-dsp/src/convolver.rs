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
// DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
// (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
// ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
// THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

//! The shared reverb: Blink's staged `ReverbConvolver` on `microfft` (api-and-models §5), fed by
//! every bus effect `reverbSend` (`audio-core`'s `fx.rs`, contract K5).
//!
//! **A stub until A2.2b.** A2.1 fixed the signatures `audio-core` calls; A2.2b ports the staged
//! convolver, generates the seeded impulse response in [`init`], and sizes its state with
//! [`region_bytes`], all in this module only. The stub has no impulse response, so its wet output
//! is silence; the sends themselves pass the bus signal through unchanged (a send is a tap).
//!
//! **Where it lives.** One convolver for the whole core, in the `Reverb` region of the core's
//! layout. `audio-core`'s `layout.rs` sizes that region with [`region_bytes`] (0 in the stub), so
//! A2.2b changes the size here without touching the layout. The region is 64-byte aligned and
//! zeroed at init. [`init`] runs once from `Core::new` (`myco_audio_init`: may take time, never in
//! `process`); [`process`] runs once per quantum while any bus has a reverb send.
//!
//! **Signal flow** (as `webAudioReference.ts`): each send adds `send * bus signal` (at the send's
//! place in the bus's chain) into one stereo input; the wet output is added to the core's output
//! after the bus tree and before the MASTER gain.
//!
//! Contract for the port: nothing allocates; transcendentals through `libm`; `process` must be
//! safe on a zeroed region of [`region_bytes`] bytes even if `init` failed (silence then).

/// `true` while this module is the A2.1 stub (wet output silent). A2.2b sets it to `false`.
pub const STUB: bool = true;

/// Bytes the convolver's state needs in the core's `Reverb` region at `sample_rate` (impulse
/// response spectra, the staged FFT buffers, the accumulation buffer). The stub needs none.
pub const fn region_bytes(sample_rate: f32) -> usize {
    let _ = sample_rate;
    0
}

/// Prepares the state in `region` (exactly [`region_bytes`] bytes, zeroed, 64-byte aligned): the
/// seeded impulse response and its partition spectra. Called once by `Core::new`.
pub fn init(region: &mut [u8], sample_rate: f32) {
    let _ = (region, sample_rate);
}

/// Convolves one quantum: reads `in_l`/`in_r` (the summed sends) and **adds** the wet signal into
/// `out_l`/`out_r` (equal lengths: one quantum). Stub: adds nothing.
pub fn process(region: &mut [u8], in_l: &[f32], in_r: &[f32], out_l: &mut [f32], out_r: &mut [f32]) {
    let _ = (region, in_l, in_r, out_l, out_r);
}

/// Clears the tail (input history and accumulation buffers), keeping the impulse response. Called
/// by RESET.
pub fn reset(region: &mut [u8]) {
    let _ = region;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stub_adds_no_wet_signal() {
        let mut region = [0u8; 0];
        init(&mut region, 48_000.0);
        let input = [1.0f32; 4];
        let mut l = [0.25f32; 4];
        let mut r = [0.5f32; 4];
        process(&mut region, &input, &input, &mut l, &mut r);
        assert_eq!((l, r), ([0.25; 4], [0.5; 4]));
        assert_eq!(region_bytes(48_000.0), 0);
    }
}
