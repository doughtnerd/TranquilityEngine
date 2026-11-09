// SPDX-License-Identifier: BSD-3-Clause
// Ported from chromium/src/third_party/blink/renderer/platform/audio/hrtf_database.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/hrtf_elevation.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
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

//! The HRIR table from a `format = 2` clip (api-and-models §4.1; task H1-L2).
//!
//! Upstream (`GetConcatenatedImpulseResponsesForSubject`, `CalculateKernelsForAzimuthElevation`)
//! decodes a stereo resource of 240 concatenated 256-frame responses at 44.1 kHz, resamples each,
//! and extracts its leading delay. In Myco that work happens before upload (H2); the core receives
//! one byte blob, laid out as follows (all little-endian, no padding):
//!
//! | Offset | Contents |
//! |---|---|
//! | 0 | header: `u32 elevations; u32 azimuths; u32 irLength; f32 rate;` (16 bytes) |
//! | 16 | ear-delay table: `f32[elevations * azimuths * 2]`, entry `(d * 2 + ear)` |
//! | 16 + 8 * E * A | impulse responses: `i16[elevations * azimuths * irLength * 2]`, direction `d` occupies frames `d * irLength .. (d + 1) * irLength`, each frame interleaved (left, right) |
//!
//! where the direction index is `d = raw_azimuth * elevations + elevation_index` (azimuth-major,
//! as upstream's concatenated resource), `raw_azimuth` counts 0..=23 in 15° steps of the IRCAM
//! convention, `elevation_index` counts 0..=9 from -45° up in 15° steps (not upstream's
//! `kElevationIndexTable` order), and `ear` is 0 left, 1 right. An int16 sample `s` stands for
//! `s as f32 / 32768.0`. The responses are at the context rate (`rate`) with their leading delay
//! removed (upstream's `HRTFKernel` after `ExtractAverageGroupDelay`); the table holds those
//! delays in frames at `rate`. Entries above `MAX_ELEVATIONS` for an azimuth are present but never
//! read.
//!
//! Only Chromium's grid is accepted (10 elevations, 24 azimuths); another grid needs the panner's
//! constants to change with it. Parsing validates everything once, so the accessors can't read out
//! of bounds. Nothing here allocates or panics on bad input: errors come back as [`HrirError`].

use super::elevation_index::{NUMBER_OF_RAW_AZIMUTHS, NUMBER_OF_RAW_ELEVATIONS};
use super::Ear;

/// The clip format number for HRIR data (CLIP_BEGIN `format`).
pub const HRIR_FORMAT: u32 = 2;
/// Bytes in the header.
pub const HEADER_BYTES: usize = 16;
/// The longest accepted `irLength`, in frames (256 frames at 44.1 kHz resampled to below 176.4 kHz
/// fits; the kernel truncates to `fft_size / 2` anyway).
pub const MAX_IR_LENGTH: u32 = 1024;

/// The `format = 2` header.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HrirHeader {
    pub elevations: u32,
    pub azimuths: u32,
    /// Frames per impulse response, at `rate`.
    pub ir_length: u32,
    /// The rate the responses and delays are at (the context rate).
    pub rate: f32,
}

/// Why a blob isn't a usable HRIR table.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum HrirError {
    /// Fewer bytes than the header says the table needs (or than a header).
    Truncated { needed: usize, got: usize },
    /// Not Chromium's 10 x 24 grid.
    Grid { elevations: u32, azimuths: u32 },
    /// `irLength` is 0 or above [`MAX_IR_LENGTH`].
    IrLength(u32),
    /// `rate` isn't finite and positive.
    Rate(f32),
    /// An ear delay isn't finite and non-negative; the value is its table index `(d * 2 + ear)`.
    Delay(usize),
    /// `encode` was given a delay or response slice of the wrong length.
    Length { expected: usize, got: usize },
}

impl HrirHeader {
    /// Reads and validates a header (grid, `ir_length`, `rate`) from the first 16 bytes.
    pub fn read(bytes: &[u8]) -> Result<Self, HrirError> {
        let head: Option<[u8; HEADER_BYTES]> = bytes.get(..HEADER_BYTES).and_then(|s| <[u8; HEADER_BYTES]>::try_from(s).ok());
        let Some(head) = head else {
            return Err(HrirError::Truncated { needed: HEADER_BYTES, got: bytes.len() });
        };
        let header = Self {
            elevations: u32::from_le_bytes([head[0], head[1], head[2], head[3]]),
            azimuths: u32::from_le_bytes([head[4], head[5], head[6], head[7]]),
            ir_length: u32::from_le_bytes([head[8], head[9], head[10], head[11]]),
            rate: f32::from_le_bytes([head[12], head[13], head[14], head[15]]),
        };
        header.validate()?;
        Ok(header)
    }

    /// The grid, `ir_length` and `rate` checks shared by [`Self::read`] and [`encode`].
    fn validate(&self) -> Result<(), HrirError> {
        if self.elevations != NUMBER_OF_RAW_ELEVATIONS as u32 || self.azimuths != NUMBER_OF_RAW_AZIMUTHS as u32 {
            return Err(HrirError::Grid { elevations: self.elevations, azimuths: self.azimuths });
        }
        if self.ir_length == 0 || self.ir_length > MAX_IR_LENGTH {
            return Err(HrirError::IrLength(self.ir_length));
        }
        if !(self.rate.is_finite() && self.rate > 0.0) {
            return Err(HrirError::Rate(self.rate));
        }
        Ok(())
    }

    /// Writes the header's 16 bytes into `out[..16]` (which must be at least 16 bytes).
    pub fn write(&self, out: &mut [u8]) {
        let Some(head) = out.get_mut(..HEADER_BYTES) else {
            debug_assert!(false, "HrirHeader::write needs {HEADER_BYTES} bytes");
            return;
        };
        put(head, 0, &self.elevations.to_le_bytes());
        put(head, 4, &self.azimuths.to_le_bytes());
        put(head, 8, &self.ir_length.to_le_bytes());
        put(head, 12, &self.rate.to_le_bytes());
    }

    /// Number of directions, `elevations * azimuths`.
    pub fn directions(&self) -> usize {
        (self.elevations as usize).saturating_mul(self.azimuths as usize)
    }

    /// Byte offset of the ear-delay table (16).
    pub fn delay_table_offset(&self) -> usize {
        HEADER_BYTES
    }

    /// Byte offset of the first impulse response, `16 + 8 * directions`.
    pub fn ir_offset(&self) -> usize {
        HEADER_BYTES.saturating_add((2 * F32_BYTES).saturating_mul(self.directions()))
    }

    /// Total bytes of a table with this header, `ir_offset + 4 * directions * ir_length`.
    pub fn byte_len(&self) -> usize {
        self.ir_offset()
            .saturating_add(FRAME_BYTES.saturating_mul(self.directions()).saturating_mul(self.ir_length as usize))
    }
}

/// A validated view of a `format = 2` blob. Cheap to make (one header read and one pass over the
/// delay table), so the core can rebuild it from the arena bytes whenever it needs it.
#[derive(Clone, Copy, Debug)]
pub struct HrirDatabase<'a> {
    bytes: &'a [u8],
    header: HrirHeader,
}

impl<'a> HrirDatabase<'a> {
    /// Validates the header, the length (`bytes.len() >= byte_len()`; trailing bytes are ignored)
    /// and every ear delay.
    pub fn parse(bytes: &'a [u8]) -> Result<Self, HrirError> {
        let header = HrirHeader::read(bytes)?;
        let needed = header.byte_len();
        if bytes.len() < needed {
            return Err(HrirError::Truncated { needed, got: bytes.len() });
        }
        for index in 0..header.directions() * 2 {
            match f32_at(bytes, header.delay_table_offset() + index * F32_BYTES) {
                Some(delay) if delay.is_finite() && delay >= 0.0 => {}
                _ => return Err(HrirError::Delay(index)),
            }
        }
        Ok(Self { bytes, header })
    }

    pub fn header(&self) -> HrirHeader {
        self.header
    }

    /// The leading delay in frames removed from the response at (`elevation_index`, `raw_azimuth`,
    /// `ear`). Indices past the grid give 0.0 (and a debug assertion).
    /// The direction index `raw_azimuth * elevations + elevation_index`, or `None` past the grid.
    fn direction(&self, elevation_index: usize, raw_azimuth: usize) -> Option<usize> {
        let elevations = self.header.elevations as usize;
        let azimuths = self.header.azimuths as usize;
        (elevation_index < elevations && raw_azimuth < azimuths).then(|| raw_azimuth * elevations + elevation_index)
    }

    /// The leading delay in frames removed from the response at (`elevation_index`, `raw_azimuth`,
    /// `ear`). Indices past the grid give 0.0 (and a debug assertion).
    pub fn ear_delay(&self, elevation_index: usize, raw_azimuth: usize, ear: Ear) -> f32 {
        let Some(d) = self.direction(elevation_index, raw_azimuth) else {
            debug_assert!(false, "HRIR index past the grid: elevation {elevation_index}, azimuth {raw_azimuth}");
            return 0.0;
        };
        f32_at(self.bytes, self.header.delay_table_offset() + (d * 2 + ear as usize) * F32_BYTES).unwrap_or(0.0)
    }

    /// Copies the response at (`elevation_index`, `raw_azimuth`, `ear`) into `out` as f32
    /// (`s / 32768`): `min(out.len(), ir_length)` frames, returning that count; `out` past it is
    /// left alone. Indices past the grid write nothing and return 0 (and a debug assertion).
    pub fn read_ir(&self, elevation_index: usize, raw_azimuth: usize, ear: Ear, out: &mut [f32]) -> usize {
        let Some(d) = self.direction(elevation_index, raw_azimuth) else {
            debug_assert!(false, "HRIR index past the grid: elevation {elevation_index}, azimuth {raw_azimuth}");
            return 0;
        };
        let ir_len = self.header.ir_length as usize;
        let count = out.len().min(ir_len);
        let start = self.header.ir_offset() + d * ir_len * FRAME_BYTES + (ear as usize) * I16_BYTES;
        for (frame, slot) in out.iter_mut().take(count).enumerate() {
            *slot = i16_at(self.bytes, start + frame * FRAME_BYTES).map_or(0.0, |s| s as f32 / 32768.0);
        }
        count
    }
}

/// Writes a `format = 2` blob: the header, `delays` (`directions * 2` entries, index `d * 2 + ear`)
/// and `irs` (`directions * ir_length * 2` interleaved samples, direction-major as the layout
/// table says). Validates like [`HrirDatabase::parse`] and returns the bytes written
/// (`header.byte_len()`). For tests and H2's tooling; the core only reads.
pub fn encode(header: &HrirHeader, delays: &[f32], irs: &[i16], out: &mut [u8]) -> Result<usize, HrirError> {
    header.validate()?;
    let delay_count = header.directions() * 2;
    let sample_count = delay_count * header.ir_length as usize;
    if delays.len() != delay_count {
        return Err(HrirError::Length { expected: delay_count, got: delays.len() });
    }
    if irs.len() != sample_count {
        return Err(HrirError::Length { expected: sample_count, got: irs.len() });
    }
    let needed = header.byte_len();
    if out.len() < needed {
        return Err(HrirError::Truncated { needed, got: out.len() });
    }
    if let Some(index) = delays.iter().position(|&d| !(d.is_finite() && d >= 0.0)) {
        return Err(HrirError::Delay(index));
    }
    header.write(out);
    let delay_at = header.delay_table_offset();
    for (index, delay) in delays.iter().enumerate() {
        put(out, delay_at + index * F32_BYTES, &delay.to_le_bytes());
    }
    let ir_at = header.ir_offset();
    for (index, sample) in irs.iter().enumerate() {
        put(out, ir_at + index * I16_BYTES, &sample.to_le_bytes());
    }
    Ok(needed)
}

/// Bytes of one f32 (a delay entry) and one int16 sample.
const F32_BYTES: usize = 4;
const I16_BYTES: usize = 2;
/// Bytes of one frame: a sample for each ear.
const FRAME_BYTES: usize = 2 * I16_BYTES;

/// Little-endian f32 at `at`, or `None` if it doesn't fit in `bytes`.
fn f32_at(bytes: &[u8], at: usize) -> Option<f32> {
    let arr = <[u8; F32_BYTES]>::try_from(bytes.get(at..at.checked_add(F32_BYTES)?)?).ok()?;
    Some(f32::from_le_bytes(arr))
}

/// Little-endian i16 at `at`, or `None` if it doesn't fit in `bytes`.
fn i16_at(bytes: &[u8], at: usize) -> Option<i16> {
    let arr = <[u8; I16_BYTES]>::try_from(bytes.get(at..at.checked_add(I16_BYTES)?)?).ok()?;
    Some(i16::from_le_bytes(arr))
}

/// Copies `src` into `out` at `at`; does nothing if it doesn't fit (callers check the length first).
fn put(out: &mut [u8], at: usize, src: &[u8]) {
    if let Some(dst) = out.get_mut(at..at.saturating_add(src.len())) {
        dst.copy_from_slice(src);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const E: usize = NUMBER_OF_RAW_ELEVATIONS;
    const A: usize = NUMBER_OF_RAW_AZIMUTHS;
    const DIRS: usize = E * A;

    fn header(ir_length: u32) -> HrirHeader {
        HrirHeader { elevations: E as u32, azimuths: A as u32, ir_length, rate: 44_100.0 }
    }

    fn ear_of(ear: usize) -> Ear {
        if ear == 0 { Ear::Left } else { Ear::Right }
    }

    /// Distinct, finite, non-negative delay for table index `d * 2 + ear`.
    fn delay_for(d: usize, ear: usize) -> f32 {
        (d * 2 + ear) as f32 * 0.25 + 1.5
    }

    /// An int16 sample for (direction, ear, frame), spread across the whole range.
    fn sample_for(d: usize, ear: usize, frame: usize) -> i16 {
        (((d * 37 + ear * 1009 + frame * 7) % 65_521) as i32 - 32_760) as i16
    }

    /// A valid table with `ir_length` frames per response, built by `encode`.
    fn blob(ir_length: usize) -> Vec<u8> {
        let h = header(ir_length as u32);
        let delays: Vec<f32> = (0..DIRS * 2).map(|i| delay_for(i / 2, i % 2)).collect();
        let mut irs = Vec::with_capacity(DIRS * 2 * ir_length);
        for d in 0..DIRS {
            for frame in 0..ir_length {
                for ear in 0..2 {
                    irs.push(sample_for(d, ear, frame));
                }
            }
        }
        let mut out = vec![0u8; h.byte_len()];
        let n = encode(&h, &delays, &irs, &mut out).unwrap();
        assert_eq!(n, out.len());
        out
    }

    /// A copy of `good` with `bytes` written at `at`.
    fn patched(good: &[u8], at: usize, bytes: &[u8]) -> Vec<u8> {
        let mut b = good.to_vec();
        b[at..at + bytes.len()].copy_from_slice(bytes);
        b
    }

    #[test]
    fn header_round_trips() {
        for &rate in &[44_100.0f32, 48_000.0, 96_000.0] {
            let h = HrirHeader { elevations: 10, azimuths: 24, ir_length: 256, rate };
            let mut buf = [0u8; 32];
            h.write(&mut buf);
            assert_eq!(&buf[..4], &10u32.to_le_bytes());
            assert_eq!(&buf[4..8], &24u32.to_le_bytes());
            assert_eq!(&buf[8..12], &256u32.to_le_bytes());
            assert_eq!(&buf[12..16], &rate.to_le_bytes());
            assert_eq!(HrirHeader::read(&buf).unwrap(), h);
        }
        assert_eq!(HrirHeader::read(&[0u8; 15]).unwrap_err(), HrirError::Truncated { needed: 16, got: 15 });
    }

    #[test]
    fn offsets_and_length_follow_the_layout() {
        let h = header(256);
        assert_eq!(h.directions(), 240);
        assert_eq!(h.delay_table_offset(), 16);
        assert_eq!(h.ir_offset(), 1_936);
        assert_eq!(h.byte_len(), 247_696);
        assert_eq!(blob(256).len(), 247_696);
        assert_eq!(header(1).byte_len(), 1_936 + 4 * 240);
    }

    #[test]
    fn encode_then_parse_reads_back_every_delay_and_response() {
        let bytes = blob(256);
        let db = HrirDatabase::parse(&bytes).unwrap();
        assert_eq!(db.header(), header(256));

        // Twelve spots checked against the raw layout: delay at 16 + 4 * (d * 2 + ear), sample at
        // 1936 + 4 * (d * 256 + frame) + 2 * ear, with d = raw_azimuth * 10 + elevation_index.
        let spots: [(usize, usize, usize, usize); 12] = [
            (0, 0, 0, 0),
            (9, 0, 1, 255),
            (0, 1, 0, 1),
            (5, 2, 1, 100),
            (3, 7, 0, 17),
            (9, 23, 1, 255),
            (0, 23, 0, 0),
            (9, 12, 0, 128),
            (1, 0, 1, 2),
            (8, 5, 0, 200),
            (2, 3, 1, 3),
            (7, 19, 0, 64),
        ];
        let mut frames = vec![0.0f32; 256];
        for &(ei, az, ear, frame) in &spots {
            let d = az * E + ei;
            assert_eq!(f32_at(&bytes, 16 + 4 * (d * 2 + ear)), Some(delay_for(d, ear)));
            assert_eq!(i16_at(&bytes, 1_936 + 4 * (d * 256 + frame) + 2 * ear), Some(sample_for(d, ear, frame)));
            assert_eq!(db.ear_delay(ei, az, ear_of(ear)), delay_for(d, ear));
            assert_eq!(db.read_ir(ei, az, ear_of(ear), &mut frames), 256);
            assert_eq!(frames[frame], sample_for(d, ear, frame) as f32 / 32768.0);
        }

        // Every direction, ear and frame.
        for ei in 0..E {
            for az in 0..A {
                for ear in 0..2 {
                    let d = az * E + ei;
                    assert_eq!(db.ear_delay(ei, az, ear_of(ear)), delay_for(d, ear), "d {d} ear {ear}");
                    assert_eq!(db.read_ir(ei, az, ear_of(ear), &mut frames), 256);
                    for (frame, &v) in frames.iter().enumerate() {
                        assert_eq!(v, sample_for(d, ear, frame) as f32 / 32768.0, "d {d} ear {ear} frame {frame}");
                    }
                }
            }
        }
    }

    #[test]
    fn parse_rejects_bad_grid_ir_length_rate_delay_and_truncation() {
        let good = blob(256);
        assert!(HrirDatabase::parse(&good).is_ok());
        let mut trailing = good.clone();
        trailing.extend_from_slice(&[0xAB; 7]);
        assert!(HrirDatabase::parse(&trailing).is_ok(), "trailing bytes are ignored");

        assert_eq!(
            HrirDatabase::parse(&patched(&good, 0, &9u32.to_le_bytes())).unwrap_err(),
            HrirError::Grid { elevations: 9, azimuths: 24 }
        );
        assert_eq!(
            HrirDatabase::parse(&patched(&good, 4, &25u32.to_le_bytes())).unwrap_err(),
            HrirError::Grid { elevations: 10, azimuths: 25 }
        );
        assert_eq!(HrirDatabase::parse(&patched(&good, 8, &0u32.to_le_bytes())).unwrap_err(), HrirError::IrLength(0));
        assert_eq!(
            HrirDatabase::parse(&patched(&good, 8, &1025u32.to_le_bytes())).unwrap_err(),
            HrirError::IrLength(1025)
        );
        for rate in [0.0f32, -44_100.0, f32::NAN, f32::INFINITY] {
            let err = HrirDatabase::parse(&patched(&good, 12, &rate.to_le_bytes())).unwrap_err();
            assert!(matches!(err, HrirError::Rate(_)), "rate {rate}: {err:?}");
        }
        for (index, bad) in [(0usize, -0.5f32), (7, f32::NAN), (479, f32::INFINITY)] {
            assert_eq!(
                HrirDatabase::parse(&patched(&good, 16 + 4 * index, &bad.to_le_bytes())).unwrap_err(),
                HrirError::Delay(index)
            );
        }

        assert_eq!(HrirDatabase::parse(&[]).unwrap_err(), HrirError::Truncated { needed: 16, got: 0 });
        assert_eq!(HrirDatabase::parse(&good[..10]).unwrap_err(), HrirError::Truncated { needed: 16, got: 10 });
        assert_eq!(
            HrirDatabase::parse(&good[..good.len() - 1]).unwrap_err(),
            HrirError::Truncated { needed: 247_696, got: 247_695 }
        );
    }

    #[test]
    fn encode_checks_lengths_values_and_output_size() {
        let h = header(256);
        let delays = vec![1.0f32; 480];
        let irs = vec![0i16; 122_880];
        let mut out = vec![0u8; 247_696];
        assert_eq!(encode(&h, &delays, &irs, &mut out), Ok(247_696));
        assert_eq!(
            encode(&h, &delays[..479], &irs, &mut out),
            Err(HrirError::Length { expected: 480, got: 479 })
        );
        assert_eq!(
            encode(&h, &delays, &irs[..122_879], &mut out),
            Err(HrirError::Length { expected: 122_880, got: 122_879 })
        );
        assert_eq!(
            encode(&h, &delays, &irs, &mut out[..247_695]),
            Err(HrirError::Truncated { needed: 247_696, got: 247_695 })
        );
        let mut bad = delays.clone();
        bad[300] = -1.0;
        assert_eq!(encode(&h, &bad, &irs, &mut out), Err(HrirError::Delay(300)));
        assert_eq!(encode(&header(0), &delays, &irs, &mut out), Err(HrirError::IrLength(0)));
        let wrong_grid = HrirHeader { elevations: 9, ..h };
        assert_eq!(
            encode(&wrong_grid, &delays, &irs, &mut out),
            Err(HrirError::Grid { elevations: 9, azimuths: 24 })
        );
    }

    #[test]
    fn read_ir_clips_to_the_output_and_out_of_range_reads_nothing() {
        let bytes = blob(256);
        let db = HrirDatabase::parse(&bytes).unwrap();

        // Short output: five frames written, the rest of the buffer untouched.
        let mut short = [7.0f32; 8];
        assert_eq!(db.read_ir(2, 3, Ear::Right, &mut short[..5]), 5);
        for frame in 0..5 {
            assert_eq!(short[frame], sample_for(3 * E + 2, 1, frame) as f32 / 32768.0);
        }
        assert!(short[5..].iter().all(|&v| v == 7.0));

        // Long output: 256 frames written, the rest untouched.
        let mut long = vec![7.0f32; 300];
        assert_eq!(db.read_ir(9, 23, Ear::Left, &mut long), 256);
        assert_eq!(long[255], sample_for(239, 0, 255) as f32 / 32768.0);
        assert!(long[256..].iter().all(|&v| v == 7.0));

        // Empty output reads nothing.
        assert_eq!(db.read_ir(0, 0, Ear::Left, &mut []), 0);

        // Past the grid: nothing written, 0 returned, delay 0 (the debug build asserts instead).
        #[cfg(not(debug_assertions))]
        {
            let mut out = vec![7.0f32; 256];
            assert_eq!(db.read_ir(10, 0, Ear::Left, &mut out), 0);
            assert_eq!(db.read_ir(0, 24, Ear::Right, &mut out), 0);
            assert!(out.iter().all(|&v| v == 7.0));
            assert_eq!(db.ear_delay(10, 0, Ear::Left), 0.0);
            assert_eq!(db.ear_delay(0, 24, Ear::Right), 0.0);
        }
    }

    #[test]
    #[cfg(debug_assertions)]
    #[should_panic(expected = "past the grid")]
    fn read_ir_past_the_grid_asserts_in_debug() {
        let bytes = blob(256);
        let db = HrirDatabase::parse(&bytes).unwrap();
        let mut out = [0.0f32; 4];
        db.read_ir(10, 0, Ear::Left, &mut out);
    }
}
