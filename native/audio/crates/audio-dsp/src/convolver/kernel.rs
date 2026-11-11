// SPDX-License-Identifier: Apache-2.0 OR MIT
//! A prepared convolution kernel (ADR 0162 C1): an impulse response's partition spectra in
//! api-and-models §4.5's layout (clip format 3), read in place by any number of [`Instance`]s
//! (`instance.rs`). [`prepare_ir`] writes one into a caller-provided buffer: the core prepares the
//! seeded shared reverb with it at `Core::new` (so its output is bit-identical to M1's), the
//! decoder will prepare zone IRs with it (task C2a), and zone slots read those kernels from the
//! arena (task C3).
//!
//! **Layout** (little-endian; [`kernel_bytes`] bytes; 4-byte aligned):
//! a 32-byte header, `u32 magic` [`MAGIC`] ("MYIR"), `u32 version` [`VERSION`], `u32 irFrames`,
//! `f32 sampleRate`, `u32 headParts` (<= 32), `u32 tailParts`, `u32 flags` (bit 0
//! [`FLAG_SOURCE_MONO`]), `u32 reserved`; then f32 packed spectra, the head kernels
//! `[2 ch][headParts][128 bins][re, im]` (256-point transforms of 128-frame partitions), then the
//! tail `[2 ch][tailParts][2048 bins][re, im]` (4,096-point transforms of 2,048-frame partitions).
//! Bin 0 holds DC in `re` and Nyquist in `im` (`fft.rs`). The normalisation is baked in.
//!
//! [`Instance`]: super::instance::Instance

use microfft::Complex32;

use super::Scratch;

/// "MYIR".
pub const MAGIC: u32 = 0x5249_594D;
/// The layout's version.
pub const VERSION: u32 = 1;
/// The header's size.
pub const HEADER_BYTES: usize = 32;
/// `flags` bit 0: the source was mono (both channels carry the same response).
pub const FLAG_SOURCE_MONO: u32 = 1;

/// Bytes of a kernel with `head_parts` head and `tail_parts` tail partitions:
/// `32 + 8 x (headParts x 256 + tailParts x 4096)`.
pub const fn kernel_bytes_for(head_parts: usize, tail_parts: usize) -> usize {
    HEADER_BYTES + 8 * (head_parts * 2 * super::QUANTUM + tail_parts * 2 * super::TAIL_BLOCK)
}

/// Bytes of the kernel of a response of `frames` per channel (0 for no frames).
pub const fn kernel_bytes(frames: usize) -> usize {
    if frames == 0 {
        0
    } else {
        kernel_bytes_for(super::head_partitions(frames), super::tail_partitions(frames))
    }
}

/// What [`prepare_ir`] prepares.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IrSpec {
    /// Frames per channel (at least 1).
    pub frames: usize,
    /// The rate the response is at (written to the header).
    pub sample_rate: f32,
    /// Every sample is multiplied by this (an `f32` product) before its transform: the
    /// normalisation (`ir::blink_normalization_scale`).
    pub scale: f32,
    /// The header's flags.
    pub flags: u32,
}

/// A parsed kernel: the header's fields and the spectra, borrowed.
#[derive(Clone, Copy)]
pub struct Kernel<'a> {
    frames: u32,
    sample_rate: f32,
    flags: u32,
    head: &'a [[Complex32; super::QUANTUM]],
    tail: &'a [[Complex32; super::TAIL_BLOCK]],
}

impl<'a> Kernel<'a> {
    /// Parses a kernel in place: `None` if `bytes` is misaligned, shorter than its header says,
    /// or the header is wrong (magic, version, `headParts` above 32, partition counts that don't
    /// match `irFrames`).
    pub fn parse(bytes: &'a [u8]) -> Option<Self> {
        let _ = bytes;
        todo!("C1")
    }

    /// Frames per channel of the response.
    pub fn frames(&self) -> usize {
        self.frames as usize
    }
    /// The response's rate.
    pub fn sample_rate(&self) -> f32 {
        self.sample_rate
    }
    /// The header's flags.
    pub fn flags(&self) -> u32 {
        self.flags
    }
    /// Head partitions per channel.
    pub fn head_parts(&self) -> usize {
        self.head.len() / 2
    }
    /// Tail partitions per channel.
    pub fn tail_parts(&self) -> usize {
        self.tail.len() / 2
    }
}

/// Prepares the kernel of a stereo response into `out` (at least [`kernel_bytes`]`(spec.frames)`
/// bytes, 4-byte aligned) and returns the bytes written. `next` yields the response's samples in
/// order: channel 0's `spec.frames`, then channel 1's (a mono source yields its samples twice);
/// it is called exactly `2 * spec.frames` times. Each sample is scaled by `spec.scale`, then each
/// partition is transformed (`scratch`'s `time` and `work`; its twiddles must be filled). The
/// header is written last, so a kernel cut short never parses. `None`, writing nothing, if `out`
/// is too short or misaligned or `spec.frames` is 0. Allocates nothing.
pub fn prepare_ir(out: &mut [u8], scratch: &mut Scratch<'_>, spec: IrSpec, next: impl FnMut() -> f32) -> Option<usize> {
    let _ = (out, scratch, spec, next, MAGIC, VERSION);
    todo!("C1")
}
