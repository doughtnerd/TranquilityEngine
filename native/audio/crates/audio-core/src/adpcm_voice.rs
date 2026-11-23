//! The ADPCM voice reader (ADR 0351 §3 as 0359 §5 settles it; ABI 4.12): a mixed voice on a format 6 clip decodes its
//! IMA ADPCM blocks **incrementally, a little each quantum**, into a small window of int16 frames, and reads them with
//! the voices' 4-point Lagrange kernel. No quantum decodes a whole block: the A0 spike measured that design's 9.4×
//! worst quantum when voices cross a block together, against a flat +23k wasm instructions per voice here.
//!
//! **Bit for bit.** For the same clip decoded whole (`audio_adpcm::decode`) and played as an int16 clip,
//! `resample::lagrange` (whole-clip loop or one-shot) and `resample::lagrange_region` (a SET_LOOP region) give exactly
//! what [`render`] gives: the same position arithmetic, the same neighbours at the edges (held at a one-shot's ends,
//! wrapped round a loop's seam), the same filter (`resample::weights` for stereo, `resample::horner` for mono).
//!
//! **The cursor.** Each mixed-voice pool entry (`fxpool.rs`, the `Fx` region) has a [`Cursor`] at the same index in
//! the `AdpcmCursors` region (`max_mixed` of them, [`CURSOR_BYTES`] each), so a voice holds one exactly while it holds
//! a pool entry ("virtual voices hold nothing"). It follows one voice id and clip id; another one resets it. It keeps:
//! - a window of clip frames `ws..we` (at most [`WINDOW_FRAMES`]) and the IMA state before `we`, per channel;
//! - for a loop (whole clip or region), the **seam**: the IMA state before the loop's first frame, its first three
//!   frames (which the kernel reads ahead across the seam) and the frame before it (`F - 1` for a whole-clip loop,
//!   `start - 1` for a region, which the kernel reads behind the first frame after a wrap). They are decoded once when
//!   the loop is set (up to a block's worth, as a seek), so a wrap restarts the window from the cached state.
//!
//! **Each quantum** the reader works out the frames the quantum will read (its position plus the sum of its steps,
//! capped at the loop's end), decodes up to there in one run (sliding the window when it fills), then renders frame by
//! frame from the window. A frame outside it (a wrap, a step larger than the estimate) refills it on the spot. A jump
//! (a voice promoted after keeping time virtually, a seek, a start offset) decodes from the block's start up to the
//! frame once, at most 1,023 frames per channel.
//!
//! Clips of 1 or 2 channels only (the store refuses more). A voice with a loop program (ADR 0342) or flagged
//! ambisonic plays an ADPCM clip straight (as an ambisonic voice plays a program straight): `voices.rs` decides.

use audio_adpcm::{block_bytes, skip_run, State, BLOCK_FRAMES};
use audio_dsp::resample::{horner, weights};

use crate::clips::AdpcmClip;
use crate::layout::REGION_ALIGN;
use crate::params::InitParams;

/// Frames per channel the window holds: a quantum's read at up to ≈ 3.9× (pitch × rate ratio) in one decode; larger
/// steps refill it within the quantum.
pub const WINDOW_FRAMES: usize = 512;
/// Frames decoded past a refill's need, so a quantum that outruns its estimate refills a few times, not every frame.
const AHEAD: usize = 64;
/// The seam's head: the loop's first frames the kernel reads ahead across the seam.
const HEAD: usize = 3;

/// How the voice moves through the clip: the three readers of `resample`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Plays to the end (`lagrange` with `looping` false): neighbours held at the clip's edges.
    Once,
    /// The whole clip loops (`lagrange` with `looping` true): neighbours wrapped.
    Loop,
    /// Frames `start..end` repeat (`lagrange_region`).
    Region { start: u32, end: u32 },
}

/// No seam cached.
const SEAM_NONE: u32 = 0;
const SEAM_LOOP: u32 = 1;
const SEAM_REGION: u32 = 2;

/// One voice's decode state (module comment). All-zero is an empty cursor (`voice` 0 follows no voice).
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Cursor {
    /// The voice id followed, and its clip id.
    voice: u32,
    clip: u32,
    /// The window holds clip frames `ws..we`; `we - ws <= WINDOW_FRAMES`.
    ws: u32,
    we: u32,
    /// The IMA state before frame `we`, per channel.
    st: [State; 2],
    /// The seam's key (`SEAM_*`, the loop's first frame and its end) and what it holds.
    seam: u32,
    seam_start: u32,
    seam_end: u32,
    /// The state before frame `seam_start`, per channel.
    lt_state: [State; 2],
    /// Frames `seam_start..seam_start + head_n`, interleaved.
    head: [i16; HEAD * 2],
    head_n: u32,
    /// The frame before the loop's first (`prev_frame`), when `has_prev`.
    prev_frame: u32,
    has_prev: u32,
    prev: [i16; 2],
    /// Frames `ws..we`, interleaved by the clip's channel count.
    window: [i16; WINDOW_FRAMES * 2],
}

/// Bytes of one cursor in the region (a whole number of region alignments).
pub const CURSOR_BYTES: usize = core::mem::size_of::<Cursor>().div_ceil(REGION_ALIGN) * REGION_ALIGN;

const _: () = assert!(core::mem::align_of::<Cursor>() <= REGION_ALIGN);

/// The `AdpcmCursors` region: one cursor per mixed-voice pool entry (`max_mixed`).
pub const fn region_bytes(p: &InitParams) -> usize {
    p.max_mixed as usize * CURSOR_BYTES
}

/// The cursors, viewed over the `AdpcmCursors` region.
pub fn cursors(region: &mut [u8]) -> &mut [Cursor] {
    // SAFETY: the region is REGION_ALIGN-aligned (Layout) and zeroed at init; all-zero bytes are a valid Cursor
    // (integers and arrays of them; `State` is two i32s), and every bit pattern is too (the reader clamps what it
    // reads: positions against `ws..we`, step indices in `State`). Only `voices.rs` views it, through this.
    unsafe { core::slice::from_raw_parts_mut(region.as_mut_ptr() as *mut Cursor, region.len() / CURSOR_BYTES) }
}

/// The cursor of pool entry `fx` (a slot's `fx`: the entry's index plus 1), or `None` for 0 or past the region.
pub fn cursor(cursors: &mut [Cursor], fx: u16) -> Option<&mut Cursor> {
    cursors.get_mut((fx as usize).checked_sub(1)?)
}

/// Renders `out_l.len()` frames (`out_r` and `steps` have the same length) of voice `voice` on ADPCM clip `clip_id`
/// from `*pos`, as [`Mode`]'s reader of `resample` would render the clip decoded whole. Returns the frames written:
/// fewer only when a one-shot (or a region voice past its end) ran out, the rest zero-filled.
#[allow(clippy::too_many_arguments)]
pub fn render(cur: &mut Cursor, voice: u32, clip_id: u32, clip: &AdpcmClip<'_>, pos: &mut f64, steps: &[f32], mode: Mode, out_l: &mut [f32], out_r: &mut [f32]) -> usize {
    match (clip.channels == 1, mode) {
        (true, Mode::Once) => render_ch::<1, ONCE>(cur, voice, clip_id, clip, pos, steps, mode, out_l, out_r),
        (true, Mode::Loop) => render_ch::<1, LOOP>(cur, voice, clip_id, clip, pos, steps, mode, out_l, out_r),
        (true, Mode::Region { .. }) => render_ch::<1, REGION>(cur, voice, clip_id, clip, pos, steps, mode, out_l, out_r),
        (false, Mode::Once) => render_ch::<2, ONCE>(cur, voice, clip_id, clip, pos, steps, mode, out_l, out_r),
        (false, Mode::Loop) => render_ch::<2, LOOP>(cur, voice, clip_id, clip, pos, steps, mode, out_l, out_r),
        (false, Mode::Region { .. }) => render_ch::<2, REGION>(cur, voice, clip_id, clip, pos, steps, mode, out_l, out_r),
    }
}

/// [`Mode`] as a const parameter, so each reader's loop carries only its own position arithmetic.
const ONCE: u8 = 0;
const LOOP: u8 = 1;
const REGION: u8 = 2;

/// `*pos` after one step of `step`, as `M`'s reader of `resample` moves it.
#[inline(always)]
fn advance<const M: u8>(pos: &mut f64, step: f32, frames_f: f64, end_f: f64, span: f64) {
    if M == REGION {
        let was = *pos;
        *pos += step as f64;
        if was < end_f {
            while *pos >= end_f {
                *pos -= span;
            }
        }
    } else {
        *pos += step as f64;
        if M == LOOP {
            while *pos >= frames_f {
                *pos -= frames_f;
            }
        }
    }
}

/// The clip as the reader sees it: its blocks and its frame count, checked once per quantum.
struct Blocks<'a, const CH: usize> {
    data: &'a [u8],
    frames: usize,
}

impl<const CH: usize> Blocks<'_, CH> {
    #[inline(always)]
    fn block(&self, b: usize) -> &[u8] {
        let bb = block_bytes(CH);
        &self.data[b * bb..(b + 1) * bb]
    }

    /// The state before frame `f` of every channel, decoding from `from` (with `states` before it) when `from` is in
    /// `f`'s block and not past it, else from the block's header.
    fn state_at(&self, f: usize, from: Option<(usize, [State; 2])>) -> [State; 2] {
        let b0 = f / BLOCK_FRAMES * BLOCK_FRAMES;
        let block = self.block(f / BLOCK_FRAMES);
        let (start, mut st) = match from {
            Some((g, st)) if g >= b0 && g <= f => (g, st),
            _ => {
                let mut st = [State::default(); 2];
                for (c, s) in st.iter_mut().enumerate().take(CH) {
                    *s = State::from_header(block, c);
                }
                (b0, st)
            }
        };
        for (c, s) in st.iter_mut().enumerate().take(CH) {
            skip_run(block, CH, c, start - b0, f - b0, s);
        }
        st
    }

    /// Decodes frames `f..f + out.len() / CH` (inside the clip) from `st` (the state before `f`) into `out`,
    /// across blocks; leaves `st` the state after them.
    fn decode(&self, mut f: usize, st: &mut [State; 2], out: &mut [i16]) {
        let mut at = 0usize;
        let end = f + out.len() / CH;
        while f < end {
            let (b, i) = (f / BLOCK_FRAMES, f % BLOCK_FRAMES);
            let n = (BLOCK_FRAMES - i).min(end - f);
            let block = self.block(b);
            for (c, s) in st.iter_mut().enumerate().take(CH) {
                if i == 0 {
                    *s = State::from_header(block, c);
                }
                audio_adpcm::decode_run(block, CH, c, i, i + n, s, &mut out[at * CH + c..], CH);
            }
            f += n;
            at += n;
        }
    }

    /// One frame, decoded from its block's start (only for a neighbour neither the window nor the seam holds).
    fn frame(&self, f: usize) -> [i16; 2] {
        let mut st = self.state_at(f, None);
        let mut out = [0i16; 2];
        self.decode(f, &mut st, &mut out[..CH]);
        out
    }
}

impl Cursor {
    /// Follow voice `voice` on clip `clip` from scratch.
    fn reset(&mut self, voice: u32, clip: u32) {
        self.voice = voice;
        self.clip = clip;
        self.ws = 0;
        self.we = 0;
        self.seam = SEAM_NONE;
    }

    /// Caches the seam of a loop whose first frame is `start` and whose wrap point is `end` (the clip's frames for a
    /// whole-clip loop), unless it holds it already.
    fn set_seam<const CH: usize>(&mut self, clip: &Blocks<'_, CH>, kind: u32, start: usize, end: usize) {
        if self.seam == kind && self.seam_start as usize == start && self.seam_end as usize == end {
            return;
        }
        self.seam = kind;
        self.seam_start = start as u32;
        self.seam_end = end as u32;
        self.lt_state = clip.state_at(start, None);
        let n = HEAD.min(end - start);
        let mut st = self.lt_state;
        let mut head = [0i16; HEAD * 2];
        clip.decode(start, &mut st, &mut head[..n * CH]);
        self.head = head;
        self.head_n = n as u32;
        // The neighbour behind the first frame after a wrap: the clip's last frame (whole-clip loop), the frame before
        // the region (a region starting at 0 reads frame 0 there, held, which the window holds).
        let prev = if kind == SEAM_LOOP { Some(clip.frames - 1) } else { start.checked_sub(1) };
        self.has_prev = prev.is_some() as u32;
        if let Some(p) = prev {
            self.prev_frame = p as u32;
            self.prev = clip.frame(p);
        }
    }

    /// Restarts the window at frame `lo` (empty), from the cheapest known state.
    fn reseat<const CH: usize>(&mut self, clip: &Blocks<'_, CH>, lo: usize) {
        let from = if (self.ws as usize) <= lo && self.we as usize <= lo && self.we > 0 {
            Some((self.we as usize, self.st))
        } else if self.seam != SEAM_NONE && (self.seam_start as usize) <= lo {
            Some((self.seam_start as usize, self.lt_state))
        } else {
            None
        };
        self.st = clip.state_at(lo, from);
        self.ws = lo as u32;
        self.we = lo as u32;
    }

    /// Makes the window hold frames `lo..hi` (`lo < hi <= cap <= frames`), decoding on to `target` (at most `cap`)
    /// when it decodes at all.
    fn ensure<const CH: usize>(&mut self, clip: &Blocks<'_, CH>, lo: usize, hi: usize, target: usize) {
        let (ws, we) = (self.ws as usize, self.we as usize);
        if lo < ws || lo > we || (ws == we && ws != lo) {
            self.reseat(clip, lo);
        }
        if hi <= self.we as usize {
            return;
        }
        let mut target = target.max(hi);
        if target - self.ws as usize > WINDOW_FRAMES {
            // Slide: keep frames `lo..we`.
            let shift = lo - self.ws as usize;
            let keep = self.we as usize - lo;
            self.window.copy_within(shift * CH..(shift + keep) * CH, 0);
            self.ws = lo as u32;
        }
        target = target.min(self.ws as usize + WINDOW_FRAMES);
        let (ws, we) = (self.ws as usize, self.we as usize);
        let mut st = self.st;
        clip.decode(we, &mut st, &mut self.window[(we - ws) * CH..(target - ws) * CH]);
        self.st = st;
        self.we = target as u32;
    }

    /// Neighbour frame `j` (a clip frame), from the window, the seam, or decoded on its own.
    #[inline]
    fn get<const CH: usize>(&self, clip: &Blocks<'_, CH>, j: usize) -> [i16; 2] {
        let (ws, we) = (self.ws as usize, self.we as usize);
        if j >= ws && j < we {
            let at = (j - ws) * CH;
            return [self.window[at], self.window[at + CH - 1]];
        }
        if self.seam != SEAM_NONE {
            let k = j.wrapping_sub(self.seam_start as usize);
            if k < self.head_n as usize {
                return [self.head[k * CH], self.head[k * CH + CH - 1]];
            }
            if self.has_prev != 0 && j == self.prev_frame as usize {
                return self.prev;
            }
        }
        clip.frame(j)
    }
}

#[inline(always)]
fn to_f32(s: i16) -> f32 {
    s as f32 / 32768.0
}

/// Frames `i..` while each one's four neighbours are consecutive window frames: `ws < idx` and `idx + 2 < hi` (`hi` at
/// most the window's end and the seam). Returns the first frame it didn't render (a one-shot's end is the caller's).
#[allow(clippy::too_many_arguments)]
#[inline(always)]
fn fast_run<const CH: usize, const M: u8>(window: &[i16; WINDOW_FRAMES * 2], ws: usize, hi: usize, pos: &mut f64, steps: &[f32], mut i: usize, out_l: &mut [f32], out_r: &mut [f32], last: usize, frames_f: f64, end_f: f64, span: f64) -> usize {
    debug_assert!(hi.saturating_sub(ws) <= WINDOW_FRAMES);
    while i < steps.len() {
        let p = *pos;
        if M != LOOP && p >= frames_f {
            break;
        }
        let idx = (p as usize).min(last);
        if idx <= ws || idx + 2 >= hi {
            break;
        }
        let t = (p - idx as f64) as f32;
        let at = (idx - 1 - ws) * CH;
        // SAFETY: frames `idx - 1 ..= idx + 2` are window frames `idx - 1 - ws .. hi - ws`, and `hi - ws <= WINDOW_FRAMES`.
        let s = |k: usize| to_f32(unsafe { *window.get_unchecked(at + k) });
        if CH == 2 {
            let w = weights(t);
            out_l[i] = w[0] * s(0) + w[1] * s(2) + w[2] * s(4) + w[3] * s(6);
            out_r[i] = w[0] * s(1) + w[1] * s(3) + w[2] * s(5) + w[3] * s(7);
        } else {
            let y = horner([s(0), s(1), s(2), s(3)], t);
            out_l[i] = y;
            out_r[i] = y;
        }
        advance::<M>(pos, steps[i], frames_f, end_f, span);
        i += 1;
    }
    i
}

#[allow(clippy::too_many_arguments)]
fn render_ch<const CH: usize, const M: u8>(cur: &mut Cursor, voice: u32, clip_id: u32, adpcm: &AdpcmClip<'_>, pos: &mut f64, steps: &[f32], mode: Mode, out_l: &mut [f32], out_r: &mut [f32]) -> usize {
    let len = out_l.len();
    debug_assert!(out_r.len() == len && steps.len() == len);
    let frames = adpcm.frames as usize;
    if frames == 0 || adpcm.blocks.len() < audio_adpcm::encoded_bytes(frames, CH) {
        out_l.fill(0.0);
        out_r.fill(0.0);
        return 0;
    }
    let clip = Blocks::<CH> { data: adpcm.blocks, frames };
    if cur.voice != voice || cur.clip != clip_id {
        cur.reset(voice, clip_id);
    }
    let frames_f = frames as f64;
    let last = frames - 1;
    // The mode as `resample`'s readers resolve it: `lt` is the loop's first frame, `end` where it wraps.
    let (looping, region) = (M == LOOP, M == REGION);
    let (start, end) = match mode {
        Mode::Once | Mode::Loop => (0, frames),
        Mode::Region { start, end } => {
            let end = (end as usize).min(frames);
            let start = (start as usize).min(end);
            if end <= start {
                out_l.fill(0.0);
                out_r.fill(0.0);
                return 0;
            }
            (start, end)
        }
    };

    if looping {
        while *pos >= frames_f {
            *pos -= frames_f;
        }
        cur.set_seam(&clip, SEAM_LOOP, 0, frames);
    } else if region {
        cur.set_seam(&clip, SEAM_REGION, start, end);
    }
    let seamed = looping || region;
    let (end_f, span) = (end as f64, (end - start) as f64);
    // How far ahead frame `idx` reads before the seam (its neighbours past it wrap), and the first neighbour it needs
    // from the window (the one behind the loop's first frame comes from the seam).
    let limit_of = |idx: usize| -> usize { if region && idx >= end { frames } else { end } };
    let lo_of = |idx: usize| -> usize { if seamed && idx == start { idx } else { idx.saturating_sub(1) } };

    // This quantum's read, decoded in one run: up to its position plus its steps (capped at the seam). The estimate takes
    // the larger of the first and last steps (a pitch ramp is monotonic within a quantum); a frame past it refills.
    if len > 0 && (*pos < frames_f) {
        let idx = (*pos as usize).min(last);
        let limit = limit_of(idx);
        let step = steps[0].max(steps[len - 1]) as f64;
        let est = ((*pos + step * len as f64) as usize).saturating_add(3).min(limit);
        let hi = (idx + 3).min(limit);
        cur.ensure(&clip, lo_of(idx), hi, est);
    }

    let mut i = 0;
    while i < len {
        if !looping && *pos >= frames_f {
            out_l[i..].fill(0.0);
            out_r[i..].fill(0.0);
            return i;
        }
        // The usual case: a run of frames whose four neighbours are consecutive window frames.
        let hi = (cur.we as usize).min(limit_of((*pos as usize).min(last)));
        i = fast_run::<CH, M>(&cur.window, cur.ws as usize, hi, pos, steps, i, out_l, out_r, last, frames_f, end_f, span);
        if i == len {
            break;
        }
        if !looping && *pos >= frames_f {
            out_l[i..].fill(0.0);
            out_r[i..].fill(0.0);
            return i;
        }
        let idx = (*pos as usize).min(last);
        let t = (*pos - idx as f64) as f32;
        let limit = limit_of(idx);
        let mut xl = [0.0f32; 4];
        let mut xr = [0.0f32; 4];
        {
            // Near an edge, a seam or the window's end: refill if the window can serve, then each neighbour as the
            // reader picks it.
            let hi = (idx + 3).min(limit);
            let lo = lo_of(idx);
            if lo < hi {
                cur.ensure(&clip, lo, hi, (hi + AHEAD).min(limit));
            }
            let before = idx < end;
            let at = |d: isize| -> usize {
                let j = idx as isize + d;
                if looping {
                    j.rem_euclid(frames as isize) as usize
                } else if region && before && j >= end as isize {
                    start + (j as usize - end) % (end - start)
                } else {
                    j.clamp(0, last as isize) as usize
                }
            };
            let j = [at(-1), idx, at(1), at(2)];
            for k in 0..4 {
                let f = cur.get(&clip, j[k]);
                xl[k] = to_f32(f[0]);
                xr[k] = to_f32(f[1]);
            }
        }
        if CH == 2 {
            let w = weights(t);
            out_l[i] = w[0] * xl[0] + w[1] * xl[1] + w[2] * xl[2] + w[3] * xl[3];
            out_r[i] = w[0] * xr[0] + w[1] * xr[1] + w[2] * xr[2] + w[3] * xr[3];
        } else {
            let y = horner(xl, t);
            out_l[i] = y;
            out_r[i] = y;
        }
        advance::<M>(pos, steps[i], frames_f, end_f, span);
        i += 1;
    }
    len
}

#[cfg(test)]
mod tests {
    use super::*;
    use audio_dsp::resample::{lagrange, lagrange_region, Samples, Source};
    use std::vec;
    use std::vec::Vec;

    fn signal(frames: usize, ch: usize) -> Vec<i16> {
        let mut seed = 0x1357_9bdfu32;
        (0..frames * ch)
            .map(|i| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                let f = (i / ch) as f32;
                ((f * 0.023 * (1 + i % ch) as f32).sin() * 14_000.0 + (seed as f32 / u32::MAX as f32 - 0.5) * 4_000.0) as i16
            })
            .collect()
    }

    struct Case {
        ch: usize,
        frames: usize,
        pcm: Vec<i16>,
        blocks: Vec<u8>,
    }

    fn case(ch: usize, frames: usize) -> Case {
        let blocks = myco_audio_encode::adpcm::encode(&signal(frames, ch), ch);
        let mut pcm = vec![0i16; frames * ch];
        audio_adpcm::decode(&blocks, ch, frames, &mut pcm).unwrap();
        Case { ch, frames, pcm, blocks }
    }

    /// Plays `quanta` quanta of 128 frames at `steps(q, i)` through the reader and through `resample` on the whole
    /// decode, from `pos`, and asserts they agree bit for bit (output and position). `jump(q)` moves both positions
    /// before quantum `q` (a seek, a promote after keeping time).
    fn compare(c: &Case, mode: Mode, mut pos: f64, quanta: usize, step: impl Fn(usize, usize) -> f32, jump: impl Fn(usize) -> Option<f64>) -> usize {
        let clip = AdpcmClip { blocks: &c.blocks, channels: c.ch as u32, frames: c.frames as u32, sample_rate: 48_000.0 };
        let src = Source { samples: Samples::I16(&c.pcm), channels: c.ch as u32, frames: c.frames as u32 };
        let mut cur: Cursor = unsafe { core::mem::zeroed() };
        let mut ref_pos = pos;
        let mut rendered = 0;
        for q in 0..quanta {
            if let Some(p) = jump(q) {
                pos = p;
                ref_pos = p;
            }
            let steps: Vec<f32> = (0..128).map(|i| step(q, i)).collect();
            let (mut al, mut ar, mut bl, mut br) = (vec![0.0f32; 128], vec![0.0f32; 128], vec![0.0f32; 128], vec![0.0f32; 128]);
            let n = render(&mut cur, 7, 3, &clip, &mut pos, &steps, mode, &mut al, &mut ar);
            let m = match mode {
                Mode::Once => lagrange(&src, &mut ref_pos, &steps, false, &mut bl, &mut br),
                Mode::Loop => lagrange(&src, &mut ref_pos, &steps, true, &mut bl, &mut br),
                Mode::Region { start, end } => lagrange_region(&src, &mut ref_pos, &steps, start, end, &mut bl, &mut br),
            };
            assert_eq!(n, m, "quantum {q}: frames written");
            for i in 0..128 {
                assert!(al[i].to_bits() == bl[i].to_bits() && ar[i].to_bits() == br[i].to_bits(), "quantum {q} frame {i}: {} {} vs {} {}", al[i], ar[i], bl[i], br[i]);
            }
            assert_eq!(pos.to_bits(), ref_pos.to_bits(), "quantum {q}: position");
            rendered += n;
            if n < 128 {
                break;
            }
        }
        rendered
    }

    #[test]
    fn a_one_shot_matches_the_whole_decode_across_blocks_at_any_pitch() {
        for ch in [1, 2] {
            let c = case(ch, 5 * BLOCK_FRAMES + 377);
            for pitch in [1.0f32, 1.37, 0.61, 2.0, 3.3, 5.7, 9.1] {
                let n = compare(&c, Mode::Once, 0.0, 400, |_, _| pitch, |_| None);
                assert!(n > 0 && n < 400 * 128, "{ch} ch at {pitch}: ran out after {n}");
            }
            // A pitch that moves every frame (a vibrato), from a start offset mid-block.
            compare(&c, Mode::Once, 1_500.25, 300, |q, i| 1.0 + 0.5 * (((q * 128 + i) as f32) * 0.01).sin(), |_| None);
        }
    }

    #[test]
    fn a_whole_clip_loop_matches_across_its_seam_and_blocks() {
        for ch in [1, 2] {
            for frames in [3 * BLOCK_FRAMES, 2 * BLOCK_FRAMES + 513, 700, 5] {
                let c = case(ch, frames);
                for pitch in [1.0f32, 1.5, 0.73, 4.25] {
                    compare(&c, Mode::Loop, 0.0, 120, |_, _| pitch, |_| None);
                }
            }
        }
    }

    #[test]
    fn a_looping_region_crossing_blocks_matches_at_any_pitch() {
        for ch in [1, 2] {
            let c = case(ch, 6 * BLOCK_FRAMES + 99);
            for (start, end) in [(1_000u32, 3_100u32), (0, 2_048), (1_023, 1_025), (2_500, 2_503), (4_000, 6_243), (777, 778)] {
                for pitch in [1.0f32, 1.21, 0.5, 3.75] {
                    compare(&c, Mode::Region { start, end }, 100.0, 150, |_, _| pitch, |_| None);
                }
            }
            // A voice already past the region's end plays on to the clip's end.
            compare(&c, Mode::Region { start: 100, end: 400 }, 5_000.0, 100, |_, _| 1.3, |_| None);
        }
    }

    #[test]
    fn jumps_and_mode_changes_restart_the_window_from_the_right_state() {
        let c = case(2, 8 * BLOCK_FRAMES);
        // Seeks forward, backward, into the same block, to the very end.
        compare(&c, Mode::Once, 0.0, 60, |_, _| 1.1, |q| match q {
            10 => Some(5_000.5),
            20 => Some(300.0),
            30 => Some(330.75),
            40 => Some(8.0 * 1024.0 - 50.0),
            _ => None,
        });
        compare(&c, Mode::Loop, 0.0, 80, |_, _| 2.2, |q| (q % 13 == 5).then_some((q * 911) as f64 % 8192.0));
        // The same cursor through a loop, then a region, then a one-shot (SET_LOOP changes).
        let clip = AdpcmClip { blocks: &c.blocks, channels: 2, frames: c.frames as u32, sample_rate: 48_000.0 };
        let src = Source { samples: Samples::I16(&c.pcm), channels: 2, frames: c.frames as u32 };
        let mut cur: Cursor = unsafe { core::mem::zeroed() };
        let (mut p, mut rp) = (6_000.0f64, 6_000.0f64);
        let steps = [1.17f32; 128];
        for q in 0..90 {
            let mode = match q / 30 {
                0 => Mode::Loop,
                1 => Mode::Region { start: 2_000, end: 4_500 },
                _ => Mode::Once,
            };
            let (mut al, mut ar, mut bl, mut br) = ([0.0f32; 128], [0.0f32; 128], [0.0f32; 128], [0.0f32; 128]);
            render(&mut cur, 9, 4, &clip, &mut p, &steps, mode, &mut al, &mut ar);
            match mode {
                Mode::Loop => lagrange(&src, &mut rp, &steps, true, &mut bl, &mut br),
                Mode::Region { start, end } => lagrange_region(&src, &mut rp, &steps, start, end, &mut bl, &mut br),
                Mode::Once => lagrange(&src, &mut rp, &steps, false, &mut bl, &mut br),
            };
            assert!(al.iter().zip(&bl).all(|(a, b)| a.to_bits() == b.to_bits()) && ar.iter().zip(&br).all(|(a, b)| a.to_bits() == b.to_bits()), "quantum {q}");
        }
        // Another voice on the cursor starts again from nothing.
        let (mut al, mut ar) = ([0.0f32; 128], [0.0f32; 128]);
        let mut p = 0.0;
        render(&mut cur, 10, 4, &clip, &mut p, &steps, Mode::Once, &mut al, &mut ar);
        assert_eq!(al[0], c.pcm[0] as f32 / 32768.0);
    }

    #[test]
    fn a_short_or_missing_clip_reads_silence() {
        let mut cur: Cursor = unsafe { core::mem::zeroed() };
        let clip = AdpcmClip { blocks: &[0u8; 100], channels: 2, frames: 2048, sample_rate: 48_000.0 };
        let (mut l, mut r) = ([1.0f32; 128], [1.0f32; 128]);
        let mut p = 0.0;
        assert_eq!(render(&mut cur, 1, 1, &clip, &mut p, &[1.0; 128], Mode::Once, &mut l, &mut r), 0);
        assert!(l.iter().chain(&r).all(|s| *s == 0.0));
    }

    #[test]
    fn the_cursor_fits_its_layout_size() {
        assert!(core::mem::size_of::<Cursor>() <= CURSOR_BYTES);
        assert_eq!(CURSOR_BYTES % REGION_ALIGN, 0);
    }
}
