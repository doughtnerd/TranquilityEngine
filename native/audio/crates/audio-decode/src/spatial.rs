// SPDX-License-Identifier: BSD-3-Clause
// Ported from chromium/src/third_party/blink/renderer/platform/audio/hrtf_elevation.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/hrtf_kernel.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/fft_frame.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/audio_bus.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/media/base/sinc_resampler.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
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
//
// media/base/sinc_resampler.cc: Copyright 2012 The Chromium Authors. Use of this source code is
// governed by a BSD-style license that can be found in Chromium's LICENSE file
// (native/audio/third_party/blink/CHROMIUM-LICENSE).

//! The spatial assets' preparation for a context rate (ADR 0331; ADR 0157 H5, ADR 0162 A3):
//! `myco_hrir_prepare` turns the HRIR asset into the wire's clip format 2 and `myco_magls_prepare`
//! the MagLS asset into format 4, beside the zone IR preparation ([`crate::ir`]). Pure: an asset in,
//! a new blob out. Main sends the blob to the core through its clip registry.
//!
//! Chromium's pipeline, as `CalculateKernelsForAzimuthElevation` (hrtf_elevation.cc) and the
//! `HRTFKernel` constructor run it: each response resampled on its own by
//! `AudioBus::TryCreateBySampleRateConverting` (media's `SincResampler`: 32-tap Blackman sinc, 33
//! kernel offsets, cutoff 0.9, 64-frame requests, in f32, [`sinc_kernels`] and [`sinc_resample`]),
//! zero-padded to `fft_size / 2` when shorter, and its average group delay extracted at the context
//! rate ([`extract_average_group_delay`]). The FFT size is audio-dsp's
//! [`fft_size_for_sample_rate`], the core's own rule.
//!
//! **Bit-exact with the TypeScript it replaces** (ADR 0331): the group delay runs on a radix-2 f64
//! FFT ([`fft`]) whose spectrum is rounded to f32 between steps, as `FFTFrame` keeps it, not on
//! audio-dsp's f32 real FFT (`hrtf::fft`, the core's per-quantum transform), and every operation
//! keeps the f32/f64 split of the TypeScript port, so the blobs, and the HRTF golden digests that
//! render them (ADR 0157 H5, 0162 A3), are unchanged. `libm` gives the transcendentals on every
//! target; the tests pin the blobs' SHA-256 at twelve rates.

use audio_dsp::hrtf::elevation_index::fft_size_for_sample_rate;
use audio_wire::generated::{MaglsHeader, MAGLS_MAGIC, MAGLS_ORDER, MAGLS_VERSION};
use core::f64::consts::PI;

use crate::ir::IrError;
use crate::{ERR_ARG, ERR_FORMAT};

/// Bytes of the HRIR header, in the asset and the format 2 blob: `u32 elevations; u32 azimuths;
/// u32 irLength; f32 rate` (little-endian). The asset follows it with `i16[directions * irLength *
/// 2]` (direction `d = azimuth * elevations + elevation`, frames interleaved left, right; delays
/// in); the blob puts the `f32[directions * 2]` delay table between the two.
pub const HRIR_HEADER_BYTES: usize = 16;
/// Responses in the MagLS asset and blob: `[16 channels][2 ears]`.
const MAGLS_RESPONSES: usize = 16 * 2;

/// `request_frames` = 64, which selects the 32-tap kernel (`KernelSizeFromRequestFrames`).
const SINC_REQUEST_FRAMES: usize = 64;
const SINC_KERNEL_SIZE: usize = 32;
const SINC_KERNEL_OFFSETS: usize = 32;

/// `InitializeKernel`: the 33 Blackman-windowed sinc kernels (sub-sample offsets 0..1), kept in
/// f32 as upstream keeps them. `io_ratio` is the source rate over the destination rate.
pub fn sinc_kernels(io_ratio: f64) -> Vec<f32> {
    const K: usize = SINC_KERNEL_SIZE;
    // `SincScaleFactor`: the normalised cutoff, lowered by 0.90 for the 32-tap kernel.
    let scale = (if io_ratio > 1.0 { 1.0 / io_ratio } else { 1.0 }) * 0.9;
    let a0 = 0.5 * (1.0 - 0.16);
    let a1 = 0.5;
    let a2 = 0.5 * 0.16;
    let pi_f = core::f32::consts::PI;
    let mut kernels = vec![0.0f32; K * (SINC_KERNEL_OFFSETS + 1)];
    for o in 0..=SINC_KERNEL_OFFSETS {
        let sub = (o as f64 / SINC_KERNEL_OFFSETS as f64) as f32 as f64;
        for i in 0..K {
            let pre_sinc = (pi_f * ((i as f64 - (K / 2) as f64 - sub) as f32)) as f64;
            let x = (((i as f64 - sub) as f32) as f64 / K as f64) as f32 as f64;
            let window = (a0 - a1 * libm::cos(2.0 * PI * x) + a2 * libm::cos(4.0 * PI * x)) as f32 as f64;
            let sinc = if pre_sinc != 0.0 { libm::sin(scale * pre_sinc) / pre_sinc } else { scale };
            kernels[o * K + i] = (window * sinc) as f32;
        }
    }
    kernels
}

/// `AudioBus::TryCreateBySampleRateConverting` for one channel: `trunc(len / io_ratio)` frames
/// from a `SincResampler(io_ratio, 64, read)` whose read callback copies the source and then zeros.
/// The region bookkeeping is upstream's (`UpdateRegions`, `Resample`), so the input lines up with
/// the kernel exactly as there; the convolution is `Convolve_C`'s.
pub fn sinc_resample(source: &[f32], io_ratio: f64, kernels: &[f32]) -> Vec<f32> {
    const K: usize = SINC_KERNEL_SIZE;
    let mut out = vec![0.0f32; (source.len() as f64 / io_ratio) as usize];
    let mut input = [0.0f32; SINC_REQUEST_FRAMES + K];
    let mut consumed = 0usize;
    let mut read = |input: &mut [f32], at: usize| {
        for slot in &mut input[at..at + SINC_REQUEST_FRAMES] {
            *slot = if consumed < source.len() {
                consumed += 1;
                source[consumed - 1]
            } else {
                0.0
            };
        }
    };
    // r1 is input[0], r2 input[K / 2]; r0 moves right by K / 2 after the first load.
    let r2 = K / 2;
    let regions = |second_load: bool| {
        let r0 = if second_load { K } else { K / 2 };
        (r0, r0 + SINC_REQUEST_FRAMES - K, r0 + SINC_REQUEST_FRAMES - K / 2 - r2)
    };
    let (mut r0, mut r3, mut block_size) = regions(false);
    let mut virtual_source_idx = 0.0f64;
    let mut remaining = out.len();
    let mut j = 0;
    if remaining > 0 {
        read(&mut input, r0);
    }
    while remaining > 0 {
        while virtual_source_idx < block_size as f64 {
            let source_idx = virtual_source_idx as usize;
            let virtual_offset_idx = (virtual_source_idx - source_idx as f64) * SINC_KERNEL_OFFSETS as f64;
            let offset_idx = virtual_offset_idx as usize;
            let k1 = &kernels[offset_idx * K..][..K];
            let k2 = &kernels[(offset_idx + 1) * K..][..K];
            let (mut sum1, mut sum2) = (0.0f32, 0.0f32);
            for (i, &s) in input[source_idx..source_idx + K].iter().enumerate() {
                sum1 += s * k1[i];
                sum2 += s * k2[i];
            }
            let blend = virtual_offset_idx - offset_idx as f64;
            out[j] = ((1.0 - blend) * sum1 as f64 + blend * sum2 as f64) as f32;
            j += 1;
            virtual_source_idx += io_ratio;
            remaining -= 1;
            if remaining == 0 {
                return out;
            }
        }
        virtual_source_idx -= block_size as f64;
        input.copy_within(r3..r3 + K, 0);
        if r0 == r2 {
            (r0, r3, block_size) = regions(true);
        }
        read(&mut input, r0);
    }
    out
}

/// cos and sin of `2πk / n` for `k < n / 2`, for [`fft`] at size `n`.
pub struct Twiddles {
    n: usize,
    cos: Vec<f64>,
    sin: Vec<f64>,
}

impl Twiddles {
    pub fn new(n: usize) -> Self {
        let (cos, sin) = (0..n / 2)
            .map(|k| {
                let a = (2.0 * PI * k as f64) / n as f64;
                (libm::cos(a), libm::sin(a))
            })
            .unzip();
        Self { n, cos, sin }
    }
}

/// Radix-2 complex FFT of `re`, `im` (length `w.n`, a power of two) in place, unnormalised; `sign`
/// -1 forward, +1 inverse.
pub fn fft(re: &mut [f64], im: &mut [f64], sign: f64, w: &Twiddles) {
    let n = w.n;
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let half = len >> 1;
        let stride = n / len;
        for i in (0..n).step_by(len) {
            for k in 0..half {
                let wr = w.cos[k * stride];
                let wi = sign * w.sin[k * stride];
                let (a, b) = (i + k, i + k + half);
                let tr = re[b] * wr - im[b] * wi;
                let ti = re[b] * wi + im[b] * wr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
            }
        }
        len <<= 1;
    }
}

/// `ExtractAverageGroupDelay(channel, n)` at `n = w.n`: the magnitude-weighted average group delay
/// of `ir[..n]` from its packed spectrum (bin 0 read as the complex (DC, Nyquist)), less 20 frames
/// of headroom when above 20, removed as a linear phase from bins 1..n/2-1 with the DC term zeroed;
/// `ir[..n]` becomes the inverse transform. The spectrum is kept in f32 between steps, as `FFTFrame`
/// keeps it. Returns the delay in frames; 0, leaving `ir` alone, for a silent response (upstream
/// would divide by zero; the table has none).
pub fn extract_average_group_delay(ir: &mut [f32], w: &Twiddles) -> f32 {
    let n = w.n;
    let half = n / 2;
    let mut re: Vec<f64> = ir[..n].iter().map(|&x| x as f64).collect();
    let mut im = vec![0.0f64; n];
    fft(&mut re, &mut im, -1.0, w);
    let mut spec_re = vec![0.0f32; half];
    let mut spec_im = vec![0.0f32; half];
    spec_re[0] = re[0] as f32;
    spec_im[0] = re[half] as f32;
    for k in 1..half {
        spec_re[k] = re[k] as f32;
        spec_im[k] = im[k] as f32;
    }
    let two_pi = 2.0 * PI;
    let sample_phase_delay = two_pi / n as f64;
    let magnitude = |r: f32, i: f32| ((r as f64) * (r as f64) + (i as f64) * (i as f64)).sqrt();
    let (mut ave_sum, mut weight_sum, mut last_phase) = (0.0f64, 0.0f64, 0.0f64);
    for k in 0..half {
        let mag = magnitude(spec_re[k], spec_im[k]);
        let phase = libm::atan2(spec_im[k] as f64, spec_re[k] as f64);
        let mut d = phase - last_phase;
        last_phase = phase;
        if d < -PI {
            d += two_pi;
        }
        if d > PI {
            d -= two_pi;
        }
        ave_sum += mag * d;
        weight_sum += mag;
    }
    if weight_sum == 0.0 {
        return 0.0;
    }
    let mut delay = -(ave_sum / weight_sum) / sample_phase_delay;
    // Leave 20 sample headroom (for leading edge of impulse).
    if delay > 20.0 {
        delay -= 20.0;
    }
    // AddConstantGroupDelay(-delay), then remove the DC offset.
    let phase_adj = delay * sample_phase_delay;
    for k in 1..half {
        let mag = magnitude(spec_re[k], spec_im[k]);
        let phase = libm::atan2(spec_im[k] as f64, spec_re[k] as f64) + k as f64 * phase_adj;
        spec_re[k] = (mag * libm::cos(phase)) as f32;
        spec_im[k] = (mag * libm::sin(phase)) as f32;
    }
    spec_re[0] = 0.0;
    re.fill(0.0);
    im.fill(0.0);
    re[0] = spec_re[0] as f64;
    re[half] = spec_im[0] as f64;
    for k in 1..half {
        re[k] = spec_re[k] as f64;
        im[k] = spec_im[k] as f64;
        re[n - k] = spec_re[k] as f64;
        im[n - k] = -(spec_im[k] as f64);
    }
    fft(&mut re, &mut im, 1.0, w);
    for (out, &x) in ir[..n].iter_mut().zip(&re) {
        *out = (x / n as f64) as f32;
    }
    delay as f32
}

/// The wire's int16: `round(x * 32768)`, half away from zero, clamped.
fn quantise(x: f32) -> i16 {
    let round = |v: f64| {
        let f = v.floor();
        if v - f >= 0.5 {
            f + 1.0
        } else {
            f
        }
    };
    let v = x as f64 * 32768.0;
    let r = if v < 0.0 { -round(-v) } else { round(v) };
    r.clamp(-32768.0, 32767.0) as i16
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn f32_at(b: &[u8], at: usize) -> f32 {
    f32::from_bits(u32_at(b, at))
}

fn check_rate(rate: f64, what: &str) -> Result<(), IrError> {
    if rate > 0.0 && rate.is_finite() {
        Ok(())
    } else {
        Err(IrError { code: ERR_ARG, message: format!("audio: bad {what} target rate {rate}") })
    }
}

/// `myco_hrir_prepare`: the HRIR asset (responses at its own rate, delays in) as the wire's format
/// 2 blob for a context at `rate`: `fft_size / 2` frames per response (all the kernel reads), the
/// delays at `f32(rate)`. `ERR_ARG` for a rate that isn't finite and positive, `ERR_FORMAT` for an
/// asset that isn't the documented layout.
pub fn prepare_hrir(asset: &[u8], rate: f64) -> Result<Vec<u8>, IrError> {
    check_rate(rate, "HRIR")?;
    let bad = || IrError {
        code: ERR_FORMAT,
        message: "audio: the HRIR asset is not the documented layout (a header, then 16-bit responses with their delays in)".into(),
    };
    if asset.len() < HRIR_HEADER_BYTES {
        return Err(bad());
    }
    let (elevations, azimuths, in_len) = (u32_at(asset, 0) as u64, u32_at(asset, 4) as u64, u32_at(asset, 8) as u64);
    let asset_rate = f32_at(asset, 12);
    let directions = elevations * azimuths;
    if directions == 0 || in_len == 0 || !(asset_rate > 0.0 && asset_rate.is_finite()) || asset.len() as u64 != HRIR_HEADER_BYTES as u64 + 4 * directions * in_len {
        return Err(bad());
    }
    let (directions, in_len) = (directions as usize, in_len as usize);
    // The context rate is a float upstream; `sample_rate_ratio` is computed in double.
    let context_rate = rate as f32;
    let io_ratio = asset_rate as f64 / context_rate as f64;
    let kernels = (asset_rate != context_rate).then(|| sinc_kernels(io_ratio));
    let taps = fft_size_for_sample_rate(context_rate) / 2;
    let twiddles = Twiddles::new(taps);
    let table_end = HRIR_HEADER_BYTES + 8 * directions;
    let mut out = vec![0u8; table_end + 4 * directions * taps];
    out[0..8].copy_from_slice(&asset[0..8]);
    out[8..12].copy_from_slice(&(taps as u32).to_le_bytes());
    out[12..16].copy_from_slice(&context_rate.to_le_bytes());
    let mut source = vec![0.0f32; in_len];
    for d in 0..directions {
        for ear in 0..2 {
            let in_base = HRIR_HEADER_BYTES + d * in_len * 4 + ear * 2;
            for (i, s) in source.iter_mut().enumerate() {
                let at = in_base + i * 4;
                *s = i16::from_le_bytes([asset[at], asset[at + 1]]) as f32 / 32768.0;
            }
            let converted = match &kernels {
                Some(k) => sinc_resample(&source, io_ratio, k),
                None => source.clone(),
            };
            // Zero-padded to fft_size / 2 when shorter (`CalculateKernelsForAzimuthElevation`).
            let mut response = vec![0.0f32; taps.max(converted.len())];
            response[..converted.len()].copy_from_slice(&converted);
            let delay = extract_average_group_delay(&mut response, &twiddles);
            let at = HRIR_HEADER_BYTES + (d * 2 + ear) * 4;
            out[at..at + 4].copy_from_slice(&delay.to_le_bytes());
            let out_base = table_end + d * taps * 4 + ear * 2;
            for (j, &x) in response[..taps].iter().enumerate() {
                out[out_base + j * 4..][..2].copy_from_slice(&quantise(x).to_le_bytes());
            }
        }
    }
    Ok(out)
}

/// `myco_magls_prepare`: the MagLS asset (the `MaglsHeader`, then f32 `[16][2][taps]` at its own
/// rate) as the format 4 blob for a context at `rate`: the header with `taps = fft_size / 2` and
/// `sample_rate = f32(rate)`, then every response resampled with [`sinc_resample`] (skipped when
/// the rates are equal, so the blob then equals the asset), zero-padded or cut to `taps`; a cut
/// response fades linearly over its last `trunc(rate / 4410)` frames (as the HRTF kernel,
/// hrtf_kernel.cc). `ERR_ARG` for a bad rate, `ERR_FORMAT` for an asset that isn't the documented
/// layout (magic, version 1, order 3, taps > 0, a finite positive rate, `32 + 32 * taps * 4` bytes).
pub fn prepare_magls(asset: &[u8], rate: f64) -> Result<Vec<u8>, IrError> {
    check_rate(rate, "MagLS")?;
    let bad = |why: &str| IrError { code: ERR_FORMAT, message: format!("audio: the MagLS asset is not the documented layout ({why})") };
    let Ok((head, _)) = MaglsHeader::read(asset, 0) else { return Err(bad("shorter than its header")) };
    if head.magic != MAGLS_MAGIC || head.version != MAGLS_VERSION || head.order != MAGLS_ORDER {
        return Err(bad("magic, version or order"));
    }
    if head.taps == 0 {
        return Err(bad("no taps"));
    }
    let asset_rate = head.sample_rate;
    if !(asset_rate > 0.0 && asset_rate.is_finite()) {
        return Err(bad("rate"));
    }
    let in_taps = head.taps as usize;
    if asset.len() as u64 != MaglsHeader::FIXED_END as u64 + (MAGLS_RESPONSES * 4) as u64 * head.taps as u64 {
        return Err(bad("byte length"));
    }
    let context_rate = rate as f32;
    let taps = fft_size_for_sample_rate(context_rate) / 2;
    let mut out = vec![0u8; MaglsHeader::FIXED_END + MAGLS_RESPONSES * taps * 4];
    let header = MaglsHeader { magic: MAGLS_MAGIC, version: MAGLS_VERSION, order: MAGLS_ORDER, taps: taps as u32, sample_rate: context_rate, reserved: [0; 3] };
    header.write(&mut out, 0).map_err(|_| bad("header"))?;
    let io_ratio = asset_rate as f64 / context_rate as f64;
    let kernels = (asset_rate != context_rate).then(|| sinc_kernels(io_ratio));
    // The fade of the cut: the last trunc(rate / 4410) frames, as the HRTF kernel's raw response.
    let fade = (rate / 4410.0) as usize;
    let mut source = vec![0.0f32; in_taps];
    for r in 0..MAGLS_RESPONSES {
        for (i, s) in source.iter_mut().enumerate() {
            *s = f32_at(asset, MaglsHeader::FIXED_END + (r * in_taps + i) * 4);
        }
        let converted = match &kernels {
            Some(k) => sinc_resample(&source, io_ratio, k),
            None => source.clone(),
        };
        let length = converted.len();
        for j in 0..taps {
            let mut v = if j < length { converted[j] as f64 } else { 0.0 };
            if length > taps && j + fade >= taps {
                v *= 1.0 - (j + fade - taps) as f64 / fade as f64;
            }
            let at = MaglsHeader::FIXED_END + (r * taps + j) * 4;
            out[at..at + 4].copy_from_slice(&(v as f32).to_le_bytes());
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantise_rounds_half_away_from_zero_and_clamps() {
        assert_eq!(quantise(0.5 / 32768.0), 1);
        assert_eq!(quantise(-0.5 / 32768.0), -1);
        assert_eq!(quantise(1.0), 32767);
        assert_eq!(quantise(-1.0), -32768);
        assert_eq!(quantise(-2.0), -32768);
    }

    #[test]
    fn sinc_resample_lengths_follow_try_create_by_sample_rate_converting() {
        let k = |r: f64| sinc_kernels(r);
        assert_eq!(sinc_resample(&[0.0; 256], 44100.0 / 48000.0, &k(44100.0 / 48000.0)).len(), 278);
        assert_eq!(sinc_resample(&[0.0; 256], 44100.0 / 96000.0, &k(44100.0 / 96000.0)).len(), 557);
        assert_eq!(sinc_resample(&[0.0; 256], 2.0, &k(2.0)).len(), 128);
    }

    fn peak_at(x: &[f32]) -> usize {
        (0..x.len()).fold(0, |best, i| if x[i].abs() > x[best].abs() { i } else { best })
    }

    #[test]
    fn sinc_resample_passes_dc_and_a_sine_with_no_delay() {
        let ratio = 44100.0 / 48000.0;
        let k = sinc_kernels(ratio);
        let dc = sinc_resample(&[0.5; 2048], ratio, &k);
        assert!(dc[100..2000].iter().all(|&x| (x - 0.5).abs() < 2e-3));
        let sine: Vec<f32> = (0..2048).map(|i| (2.0 * PI * 1000.0 * i as f64 / 44100.0).sin() as f32).collect();
        let out = sinc_resample(&sine, ratio, &k);
        for (j, &x) in out.iter().enumerate().take(2000).skip(100) {
            assert!((x as f64 - (2.0 * PI * 1000.0 * j as f64 / 48000.0).sin()).abs() < 3e-3, "frame {j}");
        }
    }

    #[test]
    fn sinc_resample_puts_an_impulse_at_its_position_times_the_ratio_across_request_boundaries() {
        let ratio = 44100.0 / 48000.0;
        let k = sinc_kernels(ratio);
        for at in [3usize, 50, 63, 64, 100, 200] {
            let mut x = [0.0f32; 256];
            x[at] = 1.0;
            assert_eq!(peak_at(&sinc_resample(&x, ratio, &k)), (at as f64 * 48000.0 / 44100.0).round() as usize, "impulse at {at}");
        }
    }

    #[test]
    fn group_delay_of_an_impulse_at_50_is_about_29_34_and_moves_the_peak_to_20() {
        let mut ir = vec![0.0f32; 256];
        ir[50] = 1.0;
        let delay = extract_average_group_delay(&mut ir, &Twiddles::new(256));
        assert!((delay - 29.34).abs() < 0.1, "{delay}");
        assert!([20, 21].contains(&peak_at(&ir)));
    }

    #[test]
    fn silent_response_has_no_delay_and_is_left_alone() {
        let mut ir = vec![0.0f32; 256];
        assert_eq!(extract_average_group_delay(&mut ir, &Twiddles::new(256)), 0.0);
        assert!(ir.iter().all(|&x| x == 0.0));
    }

    #[test]
    fn bad_rates_and_layouts_are_refused() {
        for rate in [0.0, -48000.0, f64::NAN, f64::INFINITY] {
            assert_eq!(prepare_hrir(&[0; 16], rate).unwrap_err().code, ERR_ARG);
            assert_eq!(prepare_magls(&[0; 32], rate).unwrap_err().code, ERR_ARG);
        }
        assert_eq!(prepare_hrir(&[0; 8], 48000.0).unwrap_err().code, ERR_FORMAT);
        assert_eq!(prepare_magls(&[0; 16], 48000.0).unwrap_err().code, ERR_FORMAT);
    }
}
