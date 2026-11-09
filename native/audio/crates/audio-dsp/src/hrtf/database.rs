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
//! as upstream's concatenated resource), `raw_azimuth` counts 0..24 in 15° steps of the IRCAM
//! convention, `elevation_index` counts 0..10 from -45° up in 15° steps (not upstream's
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
        let _ = bytes;
        todo!("H1-L2")
    }

    /// Writes the header's 16 bytes into `out[..16]` (which must be at least 16 bytes).
    pub fn write(&self, out: &mut [u8]) {
        let _ = out;
        todo!("H1-L2")
    }

    /// Number of directions, `elevations * azimuths`.
    pub fn directions(&self) -> usize {
        todo!("H1-L2")
    }

    /// Byte offset of the ear-delay table (16).
    pub fn delay_table_offset(&self) -> usize {
        todo!("H1-L2")
    }

    /// Byte offset of the first impulse response, `16 + 8 * directions`.
    pub fn ir_offset(&self) -> usize {
        todo!("H1-L2")
    }

    /// Total bytes of a table with this header, `ir_offset + 4 * directions * ir_length`.
    pub fn byte_len(&self) -> usize {
        todo!("H1-L2")
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
        let _ = bytes;
        todo!("H1-L2")
    }

    pub fn header(&self) -> HrirHeader {
        self.header
    }

    /// The leading delay in frames removed from the response at (`elevation_index`, `raw_azimuth`,
    /// `ear`). Indices past the grid give 0.0 (and a debug assertion).
    pub fn ear_delay(&self, elevation_index: usize, raw_azimuth: usize, ear: Ear) -> f32 {
        let _ = (elevation_index, raw_azimuth, ear, self.bytes);
        todo!("H1-L2")
    }

    /// Copies the response at (`elevation_index`, `raw_azimuth`, `ear`) into `out` as f32
    /// (`s / 32768`): `min(out.len(), ir_length)` frames, returning that count; `out` past it is
    /// left alone. Indices past the grid write nothing and return 0 (and a debug assertion).
    pub fn read_ir(&self, elevation_index: usize, raw_azimuth: usize, ear: Ear, out: &mut [f32]) -> usize {
        let _ = (elevation_index, raw_azimuth, ear, out);
        todo!("H1-L2")
    }
}

/// Writes a `format = 2` blob: the header, `delays` (`directions * 2` entries, index `d * 2 + ear`)
/// and `irs` (`directions * ir_length * 2` interleaved samples, direction-major as the layout
/// table says). Validates like [`HrirDatabase::parse`] and returns the bytes written
/// (`header.byte_len()`). For tests and H2's tooling; the core only reads.
pub fn encode(header: &HrirHeader, delays: &[f32], irs: &[i16], out: &mut [u8]) -> Result<usize, HrirError> {
    let _ = (header, delays, irs, out);
    let _ = (NUMBER_OF_RAW_AZIMUTHS, NUMBER_OF_RAW_ELEVATIONS);
    todo!("H1-L2")
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "H1-L2"]
    fn header_round_trips() {}

    #[test]
    #[ignore = "H1-L2"]
    fn offsets_and_length_follow_the_layout() {}

    #[test]
    #[ignore = "H1-L2"]
    fn encode_then_parse_reads_back_every_delay_and_response() {}

    #[test]
    #[ignore = "H1-L2"]
    fn parse_rejects_bad_grid_ir_length_rate_delay_and_truncation() {}

    #[test]
    #[ignore = "H1-L2"]
    fn read_ir_clips_to_the_output_and_out_of_range_reads_nothing() {}
}
