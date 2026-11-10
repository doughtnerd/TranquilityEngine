// SPDX-License-Identifier: BSD-3-Clause
// Ported from chromium/src/third_party/blink/renderer/platform/audio/biquad.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
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

//! Blink's direct-form processing (`Biquad::Process`, the non-Mac path with constant
//! coefficients): history in `f64`, each output computed in `f64` and rounded to `f32`, and the
//! history flushed of denormals at the end of a block (`DenormalDisabler::FlushDenormalFloatToZero`).

use super::coeffs::Coefficients;

/// `DenormalDisabler::FlushDenormalFloatToZero` on a double: zero below `FLT_MIN`.
#[inline]
fn flush(x: f64) -> f64 {
    if x.abs() < f32::MIN_POSITIVE as f64 {
        0.0
    } else {
        x
    }
}

/// Filters `samples` in place with `c`, carrying `history` (`x1, x2, y1, y2`).
#[inline]
pub fn process(c: &Coefficients, history: &mut [f64; 4], samples: &mut [f32]) {
    let [b0, b1, b2, a1, a2] = *c;
    let [mut x1, mut x2, mut y1, mut y2] = *history;
    for s in samples.iter_mut() {
        let x = *s;
        let y = (b0 * x as f64 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) as f32;
        *s = y;
        x2 = x1;
        x1 = x as f64;
        y2 = y1;
        y1 = y as f64;
    }
    *history = [flush(x1), flush(x2), flush(y1), flush(y2)];
}

/// [`process`] on two channels at once (equal lengths), each with its own history. The same
/// arithmetic per channel, so the same samples; interleaving the two recursions lets them overlap.
#[inline]
pub fn process_stereo(c: &Coefficients, history: &mut [[f64; 4]; 2], left: &mut [f32], right: &mut [f32]) {
    let [b0, b1, b2, a1, a2] = *c;
    let [mut lx1, mut lx2, mut ly1, mut ly2] = history[0];
    let [mut rx1, mut rx2, mut ry1, mut ry2] = history[1];
    for (l, r) in left.iter_mut().zip(right.iter_mut()) {
        let (xl, xr) = (*l, *r);
        let yl = (b0 * xl as f64 + b1 * lx1 + b2 * lx2 - a1 * ly1 - a2 * ly2) as f32;
        let yr = (b0 * xr as f64 + b1 * rx1 + b2 * rx2 - a1 * ry1 - a2 * ry2) as f32;
        *l = yl;
        *r = yr;
        lx2 = lx1;
        lx1 = xl as f64;
        ly2 = ly1;
        ly1 = yl as f64;
        rx2 = rx1;
        rx1 = xr as f64;
        ry2 = ry1;
        ry1 = yr as f64;
    }
    history[0] = [flush(lx1), flush(lx2), flush(ly1), flush(ly2)];
    history[1] = [flush(rx1), flush(rx2), flush(ry1), flush(ry2)];
}

#[cfg(test)]
mod tests {
    use super::super::coeffs::IDENTITY;
    use super::*;

    #[test]
    fn identity_passes_and_denormals_flush() {
        let mut h = [0.0; 4];
        let mut x = [0.5f32, -1.0, 1e-40];
        process(&IDENTITY, &mut h, &mut x);
        assert_eq!(x, [0.5, -1.0, 1e-40]);
        assert_eq!(h, [0.0, -1.0, 0.0, -1.0], "x1 and y1 (a denormal) flush to zero");
    }

    #[test]
    fn stereo_equals_two_mono_passes() {
        let c = super::super::coeffs::lowpass(0.05, 6.0);
        let l: Vec<f32> = (0..300).map(|n| ((n * 37) % 101) as f32 / 50.0 - 1.0).collect();
        let r: Vec<f32> = (0..300).map(|n| ((n * 53) % 97) as f32 / 48.0 - 1.0).collect();
        let (mut ml, mut mr, mut sl, mut sr) = (l.clone(), r.clone(), l, r);
        let (mut h0, mut h1, mut hs) = ([0.0; 4], [0.0; 4], [[0.0; 4]; 2]);
        process(&c, &mut h0, &mut ml);
        process(&c, &mut h1, &mut mr);
        process_stereo(&c, &mut hs, &mut sl, &mut sr);
        assert_eq!((sl, sr, hs), (ml, mr, [h0, h1]));
    }
}
