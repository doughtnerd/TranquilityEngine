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

use super::{aligned, fft, head_partitions, part, tail_partitions, HeadSpectrum, Scratch, TailSpectrum, CHANNELS, HEAD_FRAMES, HEAD_PARTITIONS, QUANTUM, TAIL_BLOCK};

/// "MYIR".
pub const MAGIC: u32 = 0x5249_594D;
/// The layout's version.
pub const VERSION: u32 = 1;
/// The header's size.
pub const HEADER_BYTES: usize = 32;
/// `flags` bit 0: the source was mono (both channels carry the same response).
pub const FLAG_SOURCE_MONO: u32 = 1;

const HEAD_PART_BYTES: usize = core::mem::size_of::<HeadSpectrum>();

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
    pub(crate) head: &'a [HeadSpectrum],
    pub(crate) tail: &'a [TailSpectrum],
}

fn word(bytes: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([bytes[4 * i], bytes[4 * i + 1], bytes[4 * i + 2], bytes[4 * i + 3]])
}

impl<'a> Kernel<'a> {
    /// Parses a kernel in place: `None` if `bytes` is misaligned, shorter than its header says,
    /// or the header is wrong (magic, version, `headParts` above 32, partition counts that don't
    /// match `irFrames`).
    pub fn parse(bytes: &'a [u8]) -> Option<Self> {
        if bytes.len() < HEADER_BYTES || !aligned(bytes) || word(bytes, 0) != MAGIC || word(bytes, 1) != VERSION {
            return None;
        }
        let frames = word(bytes, 2);
        let (head, tail) = (word(bytes, 4) as usize, word(bytes, 5) as usize);
        let ok = frames > 0
            && head <= HEAD_PARTITIONS
            && head == head_partitions(frames as usize)
            && tail == tail_partitions(frames as usize)
            && bytes.len() >= kernel_bytes_for(head, tail);
        if !ok {
            return None;
        }
        let base = bytes.as_ptr() as *mut u8;
        // SAFETY: the head and tail spectra lie inside `bytes` (length checked against the header's
        // counts), start 4-byte aligned (the base is aligned, the header and every spectrum are
        // multiples of 4 bytes), are only read (shared references), and are plain floats.
        let (head_spectra, tail_spectra) = unsafe {
            (
                &*part::<HeadSpectrum>(base, HEADER_BYTES, CHANNELS * head),
                &*part::<TailSpectrum>(base, HEADER_BYTES + CHANNELS * head * HEAD_PART_BYTES, CHANNELS * tail),
            )
        };
        Some(Kernel { frames, sample_rate: f32::from_bits(word(bytes, 3)), flags: word(bytes, 6), head: head_spectra, tail: tail_spectra })
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
        self.head.len() / CHANNELS
    }
    /// Tail partitions per channel.
    pub fn tail_parts(&self) -> usize {
        self.tail.len() / CHANNELS
    }
    /// The kernel's size in bytes ([`kernel_bytes_for`] its partition counts).
    pub fn byte_len(&self) -> usize {
        kernel_bytes_for(self.head_parts(), self.tail_parts())
    }
}

/// Prepares the kernel of a stereo response into `out` (at least [`kernel_bytes`]`(spec.frames)`
/// bytes, 4-byte aligned) and returns the bytes written. `next` yields the response's samples in
/// order: channel 0's `spec.frames`, then channel 1's (a mono source yields its samples twice);
/// it is called exactly `2 * spec.frames` times. Each sample is scaled by `spec.scale`, then each
/// partition is transformed (`scratch`'s `time` and `work`; its twiddles must be filled), one
/// [`prepare_unit`] each. The header is written last, so a kernel cut short never parses. `None`,
/// writing nothing, if `out` is too short or misaligned or `spec.frames` is 0 or above
/// `u32::MAX`. Allocates nothing.
pub fn prepare_ir(out: &mut [u8], scratch: &mut Scratch<'_>, spec: IrSpec, mut next: impl FnMut() -> f32) -> Option<usize> {
    let frames = spec.frames;
    if frames == 0 || frames > u32::MAX as usize || out.len() < kernel_bytes(frames) || !aligned(out) {
        return None;
    }
    let (head, tail) = (head_partitions(frames), tail_partitions(frames));
    out[..HEADER_BYTES].fill(0);
    for c in 0..CHANNELS {
        // Channel c's samples come out of `next` in order, partition by partition.
        let mut drawn = 0;
        for p in 0..head + tail {
            let unit = if p < head { c * head + p } else { CHANNELS * head + c * tail + p - head };
            prepare_unit(out, scratch, spec, unit, &mut |_, _, _, block| {
                for x in block.iter_mut() {
                    *x = if drawn < frames {
                        drawn += 1;
                        next()
                    } else {
                        0.0
                    };
                }
            })?;
        }
    }
    write_header(out, spec)
}

/// Units of a preparation of `frames` frames per channel ([`prepare_unit`]): one per partition
/// per channel, `2 x (headParts + tailParts)`.
pub const fn units(frames: usize) -> usize {
    CHANNELS * (head_partitions(frames) + tail_partitions(frames))
}

/// Where interleaved stereo f32 PCM of `frames` frames (clip format 5) starts in a buffer of
/// [`kernel_bytes`]`(frames)` bytes so that [`prepare_unit_in_place`] can turn it into the kernel
/// in the same buffer: `32 + 1,024 x headParts + 16,384 x tailParts`, so the PCM, padded to whole
/// partitions, ends where the kernel does (ADR 0162 C3b).
///
/// Why that is safe, in unit order (channel 0's head partitions, channel 1's, channel 0's tail
/// partitions, channel 1's): each unit reads its partition's samples before writing its spectrum,
/// and every spectrum lands on bytes that are either before the PCM or hold frames every later
/// unit is done with. Channel 0's head spectra end before the PCM starts; channel 1's head
/// partition `p` lands before the PCM or on head frames of partitions before `p`; channel 0's
/// tail partition `p` before the PCM or on head frames (both channels' head units ran first);
/// channel 1's tail partition `p` exactly on its own partition's frames, whose channel 0 half was
/// transformed in channel 0's pass. `in_place_matches_prepare_ir` checks it.
pub const fn pcm_offset(frames: usize) -> usize {
    HEADER_BYTES + head_partitions(frames) * QUANTUM * 8 + tail_partitions(frames) * TAIL_BLOCK * 8
}

/// Reads channel `c`'s frames from `first` of the interleaved stereo PCM of `frames` frames held
/// at [`pcm_offset`] in `buf` into `block` (as many as fit before the end; the rest of `block` is
/// left alone).
#[inline(never)]
pub fn pcm_read(buf: &[u8], frames: usize, c: usize, first: usize, block: &mut [f32]) {
    let n = frames.saturating_sub(first).min(block.len());
    let at = pcm_offset(frames) + 4 * (2 * first + c);
    if n > 0 && at + 8 * n - 4 <= buf.len() {
        for (j, x) in block[..n].iter_mut().enumerate() {
            // SAFETY: `at + 8 j + 4 <= at + 8 (n - 1) + 4 <= buf.len()` (checked above).
            *x = f32::from_le_bytes(unsafe { buf.as_ptr().add(at + 8 * j).cast::<[u8; 4]>().read() });
        }
    }
}

/// Transforms unit `unit` (of [`units`]`(spec.frames)`: channel 0's head partitions, channel 1's,
/// then channel 0's tail partitions, channel 1's) into its place in `out`: `fill(out, channel,
/// first frame, block)` writes the partition's unscaled samples into `block` (128 or 2,048 of
/// them; 0 past the response's end), each is multiplied by `spec.scale` (an `f32` product, as
/// [`prepare_ir`] always did), and the zero-padded block is transformed (`scratch`'s twiddles
/// must be filled). The order of units changes nothing in the result. `None` if `out` is too
/// short or misaligned or `unit` is out of range. Allocates nothing.
#[inline(never)]
pub fn prepare_unit(out: &mut [u8], scratch: &mut Scratch<'_>, spec: IrSpec, unit: usize, fill: &mut dyn FnMut(&[u8], usize, usize, &mut [f32])) -> Option<()> {
    let frames = spec.frames;
    let (head, tail) = (head_partitions(frames), tail_partitions(frames));
    if out.len() < kernel_bytes(frames) || !aligned(out) || unit >= units(frames) {
        return None;
    }
    let (c, n, first, at) = if unit < CHANNELS * head {
        (unit / head, QUANTUM, unit % head * QUANTUM, HEADER_BYTES + unit * HEAD_PART_BYTES)
    } else {
        let u = unit - CHANNELS * head;
        (u / tail, TAIL_BLOCK, HEAD_FRAMES + u % tail * TAIL_BLOCK, HEADER_BYTES + CHANNELS * head * HEAD_PART_BYTES + u * 8 * TAIL_BLOCK)
    };
    let Scratch { twiddles, time, work, .. } = scratch;
    let block = &mut time[..2 * n];
    block.fill(0.0);
    fill(out, c, first, &mut block[..n]);
    for x in block[..n].iter_mut() {
        *x *= spec.scale;
    }
    let bins = fft::rfft(block, &mut work[..], twiddles);
    // SAFETY: `n` bins at `at` lie inside `out` (its length is checked against the kernel's),
    // 4-byte aligned (checked; `at` is a multiple of 4), floats only; `bins` is in the scratch.
    unsafe { part::<Complex32>(out.as_mut_ptr(), at, n) }.copy_from_slice(bins);
    Some(())
}

/// [`prepare_unit`] on interleaved stereo PCM held in `buf` itself at [`pcm_offset`] (see there):
/// running every unit in order, then [`write_header`], turns the PCM into its kernel,
/// bit-identical to [`prepare_ir`] on the same samples (ADR 0162 C3b).
pub fn prepare_unit_in_place(buf: &mut [u8], scratch: &mut Scratch<'_>, spec: IrSpec, unit: usize) -> Option<()> {
    let frames = spec.frames;
    prepare_unit(buf, scratch, spec, unit, &mut |pcm, c, first, block| pcm_read(pcm, frames, c, first, block))
}

/// Writes the header of `spec`'s kernel into `out` (after every unit) and returns the kernel's
/// bytes; `None` if `out` is too short or misaligned or `spec.frames` is 0 or above `u32::MAX`.
/// The magic goes last, so a kernel cut short never parses.
#[inline(never)]
pub fn write_header(out: &mut [u8], spec: IrSpec) -> Option<usize> {
    let frames = spec.frames;
    let n = kernel_bytes(frames);
    if frames == 0 || frames > u32::MAX as usize || out.len() < n || !aligned(out) {
        return None;
    }
    let header = [MAGIC, VERSION, frames as u32, spec.sample_rate.to_bits(), head_partitions(frames) as u32, tail_partitions(frames) as u32, spec.flags, 0];
    for (i, w) in header.iter().enumerate().rev() {
        out[4 * i..4 * i + 4].copy_from_slice(&w.to_le_bytes());
    }
    Some(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_follow_the_format() {
        // api-and-models §4.5: 1.5 MB at 2 s, 3.0 MB at 4 s (48 kHz).
        assert_eq!(kernel_bytes(96_000), 32 + 8 * (32 * 256 + 45 * 4096));
        assert_eq!(kernel_bytes(192_000), 32 + 8 * (32 * 256 + 92 * 4096));
        assert_eq!(kernel_bytes(86_400), 1_409_056);
        assert_eq!(kernel_bytes(0), 0);
        assert_eq!(kernel_bytes(100), 32 + 8 * 256);
    }

    fn scratch_bytes() -> Vec<u64> {
        vec![0u64; crate::convolver::SCRATCH_BYTES / 8]
    }

    fn bytes(r: &mut [u64]) -> &mut [u8] {
        // SAFETY: a u64 buffer viewed as its bytes.
        unsafe { core::slice::from_raw_parts_mut(r.as_mut_ptr() as *mut u8, r.len() * 8) }
    }

    #[test]
    fn prepares_parses_and_refuses() {
        let mut sb = scratch_bytes();
        let mut sc = Scratch::from_bytes(bytes(&mut sb)).unwrap();
        sc.fill_twiddles();
        let frames = 9_000; // head 32, tail 3
        let spec = IrSpec { frames, sample_rate: 8_000.0, scale: 0.5, flags: FLAG_SOURCE_MONO };
        let mut out = vec![0u64; kernel_bytes(frames).div_ceil(8)];
        let mut calls = 0;
        let written = prepare_ir(bytes(&mut out), &mut sc, spec, || {
            calls += 1;
            if calls % frames == 1 {
                1.0
            } else {
                0.0
            }
        });
        assert_eq!(written, Some(kernel_bytes(frames)));
        assert_eq!(calls, 2 * frames);
        let k = Kernel::parse(bytes(&mut out)).unwrap();
        assert_eq!((k.frames(), k.sample_rate(), k.flags(), k.head_parts(), k.tail_parts()), (frames, 8_000.0, 1, 32, 3));
        assert_eq!(k.byte_len(), kernel_bytes(frames));
        // An impulse of 0.5 at frame 0: the first head partition is flat 0.5, everything else 0.
        assert!(k.head[0].iter().all(|b| b.re == 0.5 && (b.im == 0.0 || b.im == 0.5)));
        assert!(k.head[32].iter().all(|b| b.re == 0.5));
        assert!(k.head[1].iter().chain(k.tail[0].iter()).all(|b| b.re == 0.0 && b.im == 0.0));
        let len = kernel_bytes(frames);
        let b = bytes(&mut out);
        assert!(Kernel::parse(&b[..len - 4]).is_none(), "short");
        assert!(Kernel::parse(&b[1..]).is_none(), "misaligned");
        b[0] ^= 1;
        assert!(Kernel::parse(b).is_none(), "magic");
        b[0] ^= 1;
        b[16] = 33;
        assert!(Kernel::parse(b).is_none(), "head parts");
        assert_eq!(prepare_unit(bytes(&mut out), &mut sc, spec, units(frames), &mut |_, _, _, _| {}), None, "unit out of range");
        let mut short = vec![0u64; 4];
        assert_eq!(prepare_ir(bytes(&mut short), &mut sc, spec, || 0.0), None);
        assert_eq!(prepare_ir(bytes(&mut out), &mut sc, IrSpec { frames: 0, ..spec }, || 0.0), None);
    }

    #[test]
    fn in_place_matches_prepare_ir() {
        // ADR 0162 C3b: interleaved PCM at `pcm_offset`, unit by unit in order, becomes exactly the
        // kernel `prepare_ir` makes from the same samples (head only, one tail partition, a partial
        // last partition, 2 s at 48 kHz).
        let mut sb = scratch_bytes();
        let mut sc = Scratch::from_bytes(bytes(&mut sb)).unwrap();
        sc.fill_twiddles();
        for frames in [1usize, 100, 4_096, 4_097, 6_144, 9_000, 96_000] {
            let mut s = 0x1234_5678u32;
            let pcm: Vec<f32> = (0..2 * frames)
                .map(|_| {
                    s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    (s >> 8) as f32 / (1u32 << 23) as f32 - 1.0
                })
                .collect();
            let spec = IrSpec { frames, sample_rate: 48_000.0, scale: 0.37, flags: 0 };
            let n = kernel_bytes(frames);
            let mut want = vec![0u64; n.div_ceil(8)];
            let mut it = (0..2).flat_map(|c| pcm.iter().skip(c).step_by(2)).copied();
            assert_eq!(prepare_ir(bytes(&mut want), &mut sc, spec, || it.next().unwrap()), Some(n));
            let mut got = vec![0u64; n.div_ceil(8)];
            let at = pcm_offset(frames);
            assert!(at + 8 * frames <= n, "the PCM fits");
            for (i, x) in pcm.iter().enumerate() {
                bytes(&mut got)[at + 4 * i..at + 4 * i + 4].copy_from_slice(&x.to_le_bytes());
            }
            let mut last = [0.0f32; 2];
            pcm_read(bytes(&mut got), frames, 1, frames - 1, &mut last);
            assert_eq!(last, [pcm[2 * frames - 1], 0.0], "the last frame, and nothing past the end");
            for u in 0..units(frames) {
                assert_eq!(prepare_unit_in_place(bytes(&mut got), &mut sc, spec, u), Some(()));
            }
            assert_eq!(write_header(bytes(&mut got), spec), Some(n));
            assert!(bytes(&mut got)[..n] == bytes(&mut want)[..n], "{frames} frames: bit-identical");
        }
    }
}
