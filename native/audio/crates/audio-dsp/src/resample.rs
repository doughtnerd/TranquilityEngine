//! The voice resampler (api-and-models §5: "`resample` (linear, then the M1a.3 choice)"; A3.6).
//!
//! A voice reads its clip at a fractional position that advances by `pitch * clipRate /
//! contextRate` per output frame. [`lagrange`] renders a block of frames by 4-point, 3rd-order
//! Lagrange interpolation over the neighbouring clip frames; it is what voices use. [`linear`]
//! (A1.2's kernel) stays as the reference the quality tests compare against. [`advance`] moves the
//! position the same way without reading (virtual voices keep time, architecture §2.2). All three
//! use exactly the same position arithmetic, so a voice that goes virtual and comes back lands on
//! the same frame it would have played.
//!
//! **Why Lagrange** (measured with `tests/quality_thdn.rs`' rows): of the 4-point kernels that pass
//! through the samples (so whole-frame positions stay bit-exact), it ties Catmull-Rom (cubic
//! Hermite) where every fraction is 0 or 1/2 (pitch 1.5 and 0.5, where the two kernels coincide)
//! and beats it on every other THD+N and spur row, by up to 20 dB at 1 kHz (−112.5 against −93.2 dB
//! a semitone up; 10 kHz a semitone up −35.6 against −30.7 dB), for about the same arithmetic. The
//! "optimal" 4-point polynomials for oversampled input (Niemitalo) do not pass through the samples,
//! so they would change every voice, whole pitch ratios included.
//!
//! **Aliasing.** No kernel here band-limits: content that pitching up pushes past the output's
//! Nyquist folds back. A kernel that passes through the samples cannot reject it at whole ratios (at
//! pitch 2 it reads every other frame, whatever its taps), and elsewhere a flatter kernel passes a
//! little more of the top octave than linear does. Rejecting folds needs band-limited copies of the
//! clip (an octave mipmap built by a half-band filter at load) or a pre-filter scaled with pitch.
//!
//! Clips are interleaved, f32 or int16 (architecture §5.2), with 1 or 2 channels, or 4, 9 or 16
//! for an ambisonic clip of order 1-3 (ADR 0162, api-and-models §5.2 "Arena to 16 channels").
//! [`lagrange`] and [`lagrange_region`] render a stereo pair; [`lagrange_n`] and
//! [`lagrange_region_n`] render up to [`MAX_CHANNELS`] channels planar into one shared scratch of
//! [`PLANAR_SCRATCH_FLOATS`] (8 KB), with the same filters, bit-identical for 1 and 2 channels.
//! Nothing allocates.

/// Most channels a clip has: an ambisonic clip of order 3 (ADR 0162).
pub const MAX_CHANNELS: usize = 16;

/// Floats in the shared planar scratch an N-channel render fills: [`MAX_CHANNELS`] channels of one
/// 128-frame quantum, 8 KB (api-and-models §5.2).
pub const PLANAR_SCRATCH_FLOATS: usize = MAX_CHANNELS * 128;

/// A clip's samples, interleaved (`frames * channels` values).
#[derive(Clone, Copy, Debug)]
pub enum Samples<'a> {
    F32(&'a [f32]),
    /// Converted as `s as f32 / 32768.0`.
    I16(&'a [i16]),
}

/// What the resampler reads: a clip's samples and shape.
#[derive(Clone, Copy, Debug)]
pub struct Source<'a> {
    pub samples: Samples<'a>,
    /// 1, 2, 4, 9 or 16 (at most [`MAX_CHANNELS`]).
    pub channels: u32,
    /// Frames in the clip; `samples` holds at least `frames * channels` values.
    pub frames: u32,
}

#[inline]
fn sample(samples: &Samples<'_>, index: usize) -> f32 {
    match *samples {
        Samples::F32(s) => s[index],
        Samples::I16(s) => s[index] as f32 / 32768.0,
    }
}

/// Renders `out_l.len()` frames (`out_l`, `out_r` and `steps` have the same length) from `src`,
/// starting at `*pos` (in clip frames), by linear interpolation. Returns the frames written.
///
/// For each output frame `i`, in order:
/// 1. If `!looping` and `*pos >= frames as f64`: zero-fill `out_l[i..]` and `out_r[i..]` and return `i`.
/// 2. `idx = *pos as usize` (truncation; `*pos` is never negative), `t = (*pos - idx as f64) as f32`.
///    The next frame is `idx + 1` if `idx + 1 < frames`; else `0` when `looping`; else `idx` (the
///    last frame holds, as Chromium's `AudioBufferSourceNode` does).
/// 3. Per channel, `y = a + (b - a) * t` with `a` the sample at `idx`, `b` at the next frame.
///    `out_l[i]` is channel 0; `out_r[i]` is channel 1, or a copy of channel 0 for a mono clip.
/// 4. `*pos += steps[i] as f64`; then, if `looping`, `while *pos >= frames as f64 { *pos -= frames as f64 }`.
///
/// Returns `out_l.len()` when the block was filled. A clip with `frames == 0` writes zeros and
/// returns 0.
pub fn linear(src: &Source<'_>, pos: &mut f64, steps: &[f32], looping: bool, out_l: &mut [f32], out_r: &mut [f32]) -> usize {
    let len = out_l.len();
    debug_assert!(out_r.len() == len && steps.len() == len);
    let frames = src.frames as usize;
    if frames == 0 {
        out_l.fill(0.0);
        out_r.fill(0.0);
        return 0;
    }
    let frames_f = frames as f64;
    let stereo = src.channels == 2;
    if looping {
        // A position handed in past the end wraps first, the same way step 4 keeps it.
        while *pos >= frames_f {
            *pos -= frames_f;
        }
    }
    for i in 0..len {
        if !looping && *pos >= frames_f {
            out_l[i..].fill(0.0);
            out_r[i..].fill(0.0);
            return i;
        }
        let idx = *pos as usize;
        let t = (*pos - idx as f64) as f32;
        let next = if idx + 1 < frames {
            idx + 1
        } else if looping {
            0
        } else {
            idx
        };
        if stereo {
            let l0 = sample(&src.samples, 2 * idx);
            let l1 = sample(&src.samples, 2 * next);
            let r0 = sample(&src.samples, 2 * idx + 1);
            let r1 = sample(&src.samples, 2 * next + 1);
            out_l[i] = l0 + (l1 - l0) * t;
            out_r[i] = r0 + (r1 - r0) * t;
        } else {
            let a = sample(&src.samples, idx);
            let b = sample(&src.samples, next);
            let y = a + (b - a) * t;
            out_l[i] = y;
            out_r[i] = y;
        }
        *pos += steps[i] as f64;
        if looping {
            while *pos >= frames_f {
                *pos -= frames_f;
            }
        }
    }
    len
}

/// One interleaved sample type: f32 as is, int16 scaled by 1/32768.
trait Sample: Copy {
    fn get(self) -> f32;
}

impl Sample for f32 {
    #[inline(always)]
    fn get(self) -> f32 {
        self
    }
}

impl Sample for i16 {
    #[inline(always)]
    fn get(self) -> f32 {
        self as f32 / 32768.0
    }
}

/// Renders `out_l.len()` frames (`out_l`, `out_r` and `steps` have the same length) from `src`,
/// starting at `*pos` (in clip frames), by 4-point, 3rd-order Lagrange interpolation. Returns the
/// frames written. This is the voices' resampler (A3.6, the "M1a.3 choice" of api-and-models §5).
///
/// The position arithmetic is [`linear`]'s exactly (its steps 1, 2 and 4, so [`advance`] keeps
/// time for both); only step 3 differs. Per channel, with `t` the fraction and `x[j]` the sample of
/// clip frame `j`:
///
/// `y = w0 x[idx-1] + w1 x[idx] + w2 x[idx+1] + w3 x[idx+2]`, where
/// `w0 = -t (t-1) (t-2) / 6`, `w1 = (t+1) (t-1) (t-2) / 2`, `w2 = -(t+1) t (t-2) / 2`,
/// `w3 = (t+1) t (t-1) / 6` (the cubic through the four neighbours, evaluated at `t`).
/// (A mono clip evaluates the same cubic in Horner form; a stereo clip shares the four weights
/// between its channels. The two forms agree to f32 rounding.)
///
/// At `t = 0` the weights are exactly `(0, 1, 0, 0)`, so a voice whose position lands on whole
/// frames (pitch 1 or 2 at the clip's rate, from a whole start offset) reads the clip bit for bit,
/// as [`linear`] does.
///
/// **Edges.** A neighbour outside `0..frames` is the clip **wrapped** when `looping` (the kernel
/// reads across the loop seam in both directions), else the clip **held**: frames before 0 read
/// frame 0 and frames past the end read the last frame (the clip extended by its edge frames, as
/// [`linear`]'s last-frame hold is). Nothing is read outside `samples`, whatever `frames` claims
/// (the frame count used is at most `samples.len() / channels`).
///
/// Mono clips are copied to both outputs; stereo clips keep their channels. A clip of more than 2
/// channels (ambisonic, ADR 0162) renders its channel 0 (W, the omnidirectional component) to both
/// outputs through [`lagrange_n`], until task B3's ambisonic voice decodes it. A clip with
/// `frames == 0` writes zeros and returns 0. Nothing allocates and nothing panics.
pub fn lagrange(src: &Source<'_>, pos: &mut f64, steps: &[f32], looping: bool, out_l: &mut [f32], out_r: &mut [f32]) -> usize {
    if src.channels > 2 {
        let n = lagrange_n(src, pos, steps, looping, 1, out_l);
        out_r.copy_from_slice(out_l);
        return n;
    }
    match (src.samples, src.channels == 2) {
        (Samples::F32(d), false) => render4::<f32, false>(d, src.frames, pos, steps, looping, out_l, out_r),
        (Samples::F32(d), true) => render4::<f32, true>(d, src.frames, pos, steps, looping, out_l, out_r),
        (Samples::I16(d), false) => render4::<i16, false>(d, src.frames, pos, steps, looping, out_l, out_r),
        (Samples::I16(d), true) => render4::<i16, true>(d, src.frames, pos, steps, looping, out_l, out_r),
    }
}

/// The Lagrange weights for neighbours `idx - 1 ..= idx + 2` at fraction `t` (see [`lagrange`]).
/// Public for readers that fetch their own neighbours (B3's stream rings); `t = 0` gives exactly
/// `(0, 1, 0, 0)`.
#[inline(always)]
pub fn weights(t: f32) -> [f32; 4] {
    let (a, b, c) = (t + 1.0, t - 1.0, t - 2.0);
    [-(t * b * c) * (1.0 / 6.0), 0.5 * (a * b * c), -0.5 * (a * t * c), (a * t * b) * (1.0 / 6.0)]
}

/// The cubic of [`lagrange`] through `x[0..4]` (frames `idx - 1 ..= idx + 2`) at `t`, in Horner form:
/// `((c3 t + c2) t + c1) t + x[1]`, so `t = 0` gives `x[1]` exactly.
#[inline(always)]
fn horner(x: [f32; 4], t: f32) -> f32 {
    let c1 = x[2] - (1.0 / 3.0) * x[0] - 0.5 * x[1] - (1.0 / 6.0) * x[3];
    let c2 = 0.5 * (x[0] + x[2]) - x[1];
    let c3 = (1.0 / 6.0) * (x[3] - x[0]) + 0.5 * (x[1] - x[2]);
    ((c3 * t + c2) * t + c1) * t + x[1]
}

/// `j.clamp(0, last) as usize`, the edge neighbour of a non-looping read. Not `isize::clamp`: its min > max
/// assert formats both values, and that panic path was inlined into every copy of the four kernels (about
/// 2.9 KB of the wasm). The plain assert keeps what it tells the optimiser (`last >= 0`, without which the
/// metered count rises up to 0.9%) and panics on the same condition, which can't happen: `last` is
/// `frames - 1` with `1 <= frames <= data.len() <= isize::MAX`.
#[inline(always)]
fn clamp_edge(j: isize, last: isize) -> usize {
    assert!(last >= 0);
    (if j < 0 {
        0
    } else if j > last {
        last
    } else {
        j
    }) as usize
}

#[inline(always)]
fn render4<S: Sample, const STEREO: bool>(data: &[S], frames: u32, pos: &mut f64, steps: &[f32], looping: bool, out_l: &mut [f32], out_r: &mut [f32]) -> usize {
    let len = out_l.len();
    debug_assert!(out_r.len() == len && steps.len() == len);
    let ch = if STEREO { 2 } else { 1 };
    // Never read past the samples, whatever `frames` claims.
    let frames = (frames as usize).min(data.len() / ch);
    if frames == 0 {
        out_l.fill(0.0);
        out_r.fill(0.0);
        return 0;
    }
    let frames_f = frames as f64;
    if looping {
        while *pos >= frames_f {
            *pos -= frames_f;
        }
    }
    let last = frames - 1;
    // The neighbour `idx + d` (d in -1..=2) at the clip's edges: wrapped when looping, else clamped.
    let edge = |idx: usize, d: isize| -> usize {
        let j = idx as isize + d;
        if looping {
            j.rem_euclid(frames as isize) as usize
        } else {
            clamp_edge(j, last as isize)
        }
    };
    for i in 0..len {
        if !looping && *pos >= frames_f {
            out_l[i..].fill(0.0);
            out_r[i..].fill(0.0);
            return i;
        }
        let idx = (*pos as usize).min(last);
        let t = (*pos - idx as f64) as f32;
        // The four neighbours: one contiguous window inside the clip (the usual case), else frame by
        // frame through `edge`.
        let start = idx.wrapping_sub(1).wrapping_mul(ch);
        let inside = idx >= 1 && idx + 2 < frames;
        if STEREO {
            let window: Option<&[S; 8]> = if inside { data.get(start..start + 8).and_then(|s| s.try_into().ok()) } else { None };
            let (xl, xr) = match window {
                Some(x) => ([x[0].get(), x[2].get(), x[4].get(), x[6].get()], [x[1].get(), x[3].get(), x[5].get(), x[7].get()]),
                None => {
                    let j = [edge(idx, -1), idx, edge(idx, 1), edge(idx, 2)];
                    (j.map(|j| data[2 * j].get()), j.map(|j| data[2 * j + 1].get()))
                }
            };
            // Stereo shares the weights between channels.
            let w = weights(t);
            out_l[i] = w[0] * xl[0] + w[1] * xl[1] + w[2] * xl[2] + w[3] * xl[3];
            out_r[i] = w[0] * xr[0] + w[1] * xr[1] + w[2] * xr[2] + w[3] * xr[3];
        } else {
            let window: Option<&[S; 4]> = if inside { data.get(start..start + 4).and_then(|s| s.try_into().ok()) } else { None };
            let x = match window {
                Some(x) => [x[0].get(), x[1].get(), x[2].get(), x[3].get()],
                None => [edge(idx, -1), idx, edge(idx, 1), edge(idx, 2)].map(|j| data[j].get()),
            };
            // Mono: the same cubic in Horner form (fewer operations for one channel).
            let y = horner(x, t);
            out_l[i] = y;
            out_r[i] = y;
        }
        *pos += steps[i] as f64;
        if looping {
            while *pos >= frames_f {
                *pos -= frames_f;
            }
        }
    }
    len
}

/// Moves `*pos` through `steps.len()` frames of a clip of `frames` frames without reading samples:
/// the position arithmetic of [`linear`] (steps 1 and 4) exactly. Returns the frames consumed:
/// `i` when a non-looping position reached `frames` before frame `i`, else `steps.len()`.
/// `frames == 0` returns 0.
pub fn advance(pos: &mut f64, steps: &[f32], frames: u32, looping: bool) -> usize {
    if frames == 0 {
        return 0;
    }
    let frames_f = frames as f64;
    if looping {
        while *pos >= frames_f {
            *pos -= frames_f;
        }
    }
    for (i, &step) in steps.iter().enumerate() {
        if !looping && *pos >= frames_f {
            return i;
        }
        *pos += step as f64;
        if looping {
            while *pos >= frames_f {
                *pos -= frames_f;
            }
        }
    }
    steps.len()
}

/// [`lagrange`] over a **loop region** (ADR 0158 §4, SET_LOOP): frames `start..end` of the clip
/// repeat. The caller resolves `0 <= start < end <= frames`; an empty region writes zeros.
///
/// While the position is before `end`, a neighbour at or past `end` reads the region wrapped
/// (`start + (j - end)`), so the kernel reads across the seam forward as a whole-clip loop does;
/// other neighbours are the clip's own frames, held at its edges. A step that crosses `end` from
/// below wraps the position back by the region's length. A position already at or past `end`
/// (a voice started there) plays on, unwrapped, to the clip's end and stops there, as a
/// non-looping clip does. Returns the frames written (fewer only when the clip ran out). A clip of
/// more than 2 channels renders its channel 0 to both outputs, as [`lagrange`] does.
pub fn lagrange_region(src: &Source<'_>, pos: &mut f64, steps: &[f32], start: u32, end: u32, out_l: &mut [f32], out_r: &mut [f32]) -> usize {
    if src.channels > 2 {
        let n = lagrange_region_n(src, pos, steps, start, end, 1, out_l);
        out_r.copy_from_slice(out_l);
        return n;
    }
    match (src.samples, src.channels == 2) {
        (Samples::F32(d), false) => region4::<f32, false>(d, src.frames, pos, steps, start, end, out_l, out_r),
        (Samples::F32(d), true) => region4::<f32, true>(d, src.frames, pos, steps, start, end, out_l, out_r),
        (Samples::I16(d), false) => region4::<i16, false>(d, src.frames, pos, steps, start, end, out_l, out_r),
        (Samples::I16(d), true) => region4::<i16, true>(d, src.frames, pos, steps, start, end, out_l, out_r),
    }
}

#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn region4<S: Sample, const STEREO: bool>(data: &[S], frames: u32, pos: &mut f64, steps: &[f32], start: u32, end: u32, out_l: &mut [f32], out_r: &mut [f32]) -> usize {
    let len = out_l.len();
    debug_assert!(out_r.len() == len && steps.len() == len);
    let ch = if STEREO { 2 } else { 1 };
    let frames = (frames as usize).min(data.len() / ch);
    let end = (end as usize).min(frames);
    let start = (start as usize).min(end);
    if frames == 0 || end <= start {
        out_l.fill(0.0);
        out_r.fill(0.0);
        return 0;
    }
    let (frames_f, end_f, span) = (frames as f64, end as f64, (end - start) as f64);
    let last = frames - 1;
    for i in 0..len {
        if *pos >= frames_f {
            out_l[i..].fill(0.0);
            out_r[i..].fill(0.0);
            return i;
        }
        let idx = (*pos as usize).min(last);
        let t = (*pos - idx as f64) as f32;
        let before = idx < end;
        let at = |d: isize| -> usize {
            let j = idx as isize + d;
            if before && j >= end as isize {
                start + (j as usize - end) % (end - start)
            } else {
                clamp_edge(j, last as isize)
            }
        };
        let j = [at(-1), idx, at(1), at(2)];
        if STEREO {
            let w = weights(t);
            let xl = j.map(|j| data[2 * j].get());
            let xr = j.map(|j| data[2 * j + 1].get());
            out_l[i] = w[0] * xl[0] + w[1] * xl[1] + w[2] * xl[2] + w[3] * xl[3];
            out_r[i] = w[0] * xr[0] + w[1] * xr[1] + w[2] * xr[2] + w[3] * xr[3];
        } else {
            let y = horner(j.map(|j| data[j].get()), t);
            out_l[i] = y;
            out_r[i] = y;
        }
        let was = *pos;
        *pos += steps[i] as f64;
        if was < end_f {
            while *pos >= end_f {
                *pos -= span;
            }
        }
    }
    len
}

/// [`lagrange`] for a clip of any channel count up to [`MAX_CHANNELS`] (ADR 0162 task B2): renders
/// the clip's first `channels` channels (`1 ..= src.channels`) of `steps.len()` frames **planar**
/// into `out`: channel `c`'s frame `i` at `out[c * steps.len() + i]` (`out` holds at least
/// `channels * steps.len()` floats; the shared scratch is [`PLANAR_SCRATCH_FLOATS`]). Returns the
/// frames written; the rest of each channel's row is zero-filled when a non-looping clip ends.
///
/// The position arithmetic, the edges (wrapped when `looping`, else held) and the filter are
/// [`lagrange`]'s exactly. The kernel is the Horner form when the clip has **one** channel, else
/// the shared [`weights`] (so channels 0 and 1 of a stereo clip are bit-identical to `lagrange`'s
/// `out_l` and `out_r`, and a mono clip's channel 0 to its `out_l`). Interleaved frame `j`'s channel
/// `c` is `samples[j * src.channels + c]`. `channels` of 0, above `src.channels` or above
/// [`MAX_CHANNELS`], or a short `out`, writes nothing and returns 0. Nothing allocates or panics.
pub fn lagrange_n(src: &Source<'_>, pos: &mut f64, steps: &[f32], looping: bool, channels: usize, out: &mut [f32]) -> usize {
    if !planar_ok(src, channels, steps.len(), out) {
        return 0;
    }
    let out = &mut out[..channels * steps.len()];
    let stride = src.channels as usize;
    match (src.samples, stride == 1) {
        (Samples::F32(d), false) => render_n::<f32, false>(d, stride, src.frames, pos, steps, looping, channels, out),
        (Samples::F32(d), true) => render_n::<f32, true>(d, stride, src.frames, pos, steps, looping, channels, out),
        (Samples::I16(d), false) => render_n::<i16, false>(d, stride, src.frames, pos, steps, looping, channels, out),
        (Samples::I16(d), true) => render_n::<i16, true>(d, stride, src.frames, pos, steps, looping, channels, out),
    }
}

/// The refusals of the N-channel entry points: `channels` in `1 ..= min(src.channels, MAX_CHANNELS)`
/// and `out` holding `channels` rows of `len`. When false, nothing is written.
#[inline(always)]
fn planar_ok(src: &Source<'_>, channels: usize, len: usize, out: &[f32]) -> bool {
    (1..=(src.channels as usize).min(MAX_CHANNELS)).contains(&channels) && out.len() >= channels * len
}

/// Zero-fills frames `from..len` of every planar row (`out` holds `channels` rows of `len`).
#[inline(always)]
fn zero_rows_from(out: &mut [f32], len: usize, channels: usize, from: usize) {
    for c in 0..channels {
        out[c * len + from..(c + 1) * len].fill(0.0);
    }
}

/// [`render4`] for `channels` planar rows: the same position arithmetic and edges, with the kernel
/// of [`lagrange_n`] (Horner for a mono clip, else the shared weights). `stride` is the clip's
/// channel count (the interleave), `out` is exactly `channels * steps.len()` long.
#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn render_n<S: Sample, const MONO: bool>(data: &[S], stride: usize, frames: u32, pos: &mut f64, steps: &[f32], looping: bool, channels: usize, out: &mut [f32]) -> usize {
    let len = steps.len();
    debug_assert!(out.len() == channels * len);
    // Never read past the samples, whatever `frames` claims.
    let frames = (frames as usize).min(data.len() / stride);
    if frames == 0 {
        out.fill(0.0);
        return 0;
    }
    let frames_f = frames as f64;
    if looping {
        while *pos >= frames_f {
            *pos -= frames_f;
        }
    }
    let last = frames - 1;
    // The neighbour `idx + d` (d in -1..=2) at the clip's edges: wrapped when looping, else clamped.
    let edge = |idx: usize, d: isize| -> usize {
        let j = idx as isize + d;
        if looping {
            j.rem_euclid(frames as isize) as usize
        } else {
            clamp_edge(j, last as isize)
        }
    };
    for i in 0..len {
        if !looping && *pos >= frames_f {
            zero_rows_from(out, len, channels, i);
            return i;
        }
        let idx = (*pos as usize).min(last);
        let t = (*pos - idx as f64) as f32;
        let j = [edge(idx, -1), idx, edge(idx, 1), edge(idx, 2)];
        if MONO {
            out[i] = horner(j.map(|j| data[j].get()), t);
        } else {
            // Every channel shares the four weights, as render4's stereo path does.
            let w = weights(t);
            for c in 0..channels {
                let x = j.map(|j| data[j * stride + c].get());
                out[c * len + i] = w[0] * x[0] + w[1] * x[1] + w[2] * x[2] + w[3] * x[3];
            }
        }
        *pos += steps[i] as f64;
        if looping {
            while *pos >= frames_f {
                *pos -= frames_f;
            }
        }
    }
    len
}

/// [`lagrange_region`] for a clip of any channel count up to [`MAX_CHANNELS`]: the loop region's
/// position arithmetic and seam reads of [`lagrange_region`], the kernel choice and planar output
/// of [`lagrange_n`] (bit-identical to `lagrange_region` for 1 and 2 channels). The same refusals
/// as [`lagrange_n`] (nothing written, 0), and an empty region zero-fills the rows and returns 0.
#[allow(clippy::too_many_arguments)]
pub fn lagrange_region_n(src: &Source<'_>, pos: &mut f64, steps: &[f32], start: u32, end: u32, channels: usize, out: &mut [f32]) -> usize {
    if !planar_ok(src, channels, steps.len(), out) {
        return 0;
    }
    let out = &mut out[..channels * steps.len()];
    let stride = src.channels as usize;
    match (src.samples, stride == 1) {
        (Samples::F32(d), false) => region_n::<f32, false>(d, stride, src.frames, pos, steps, start, end, channels, out),
        (Samples::F32(d), true) => region_n::<f32, true>(d, stride, src.frames, pos, steps, start, end, channels, out),
        (Samples::I16(d), false) => region_n::<i16, false>(d, stride, src.frames, pos, steps, start, end, channels, out),
        (Samples::I16(d), true) => region_n::<i16, true>(d, stride, src.frames, pos, steps, start, end, channels, out),
    }
}

/// [`region4`] for `channels` planar rows (see [`render_n`] for the layout and the kernel).
#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn region_n<S: Sample, const MONO: bool>(data: &[S], stride: usize, frames: u32, pos: &mut f64, steps: &[f32], start: u32, end: u32, channels: usize, out: &mut [f32]) -> usize {
    let len = steps.len();
    debug_assert!(out.len() == channels * len);
    let frames = (frames as usize).min(data.len() / stride);
    let end = (end as usize).min(frames);
    let start = (start as usize).min(end);
    if frames == 0 || end <= start {
        out.fill(0.0);
        return 0;
    }
    let (frames_f, end_f, span) = (frames as f64, end as f64, (end - start) as f64);
    let last = frames - 1;
    for i in 0..len {
        if *pos >= frames_f {
            zero_rows_from(out, len, channels, i);
            return i;
        }
        let idx = (*pos as usize).min(last);
        let t = (*pos - idx as f64) as f32;
        let before = idx < end;
        let at = |d: isize| -> usize {
            let j = idx as isize + d;
            if before && j >= end as isize {
                start + (j as usize - end) % (end - start)
            } else {
                clamp_edge(j, last as isize)
            }
        };
        let j = [at(-1), idx, at(1), at(2)];
        if MONO {
            out[i] = horner(j.map(|j| data[j].get()), t);
        } else {
            let w = weights(t);
            for c in 0..channels {
                let x = j.map(|j| data[j * stride + c].get());
                out[c * len + i] = w[0] * x[0] + w[1] * x[1] + w[2] * x[2] + w[3] * x[3];
            }
        }
        let was = *pos;
        *pos += steps[i] as f64;
        if was < end_f {
            while *pos >= end_f {
                *pos -= span;
            }
        }
    }
    len
}

/// [`advance`] over a loop region, with [`lagrange_region`]'s position arithmetic (virtual voices).
/// Returns the steps taken (fewer only when a position past the region ran out of clip).
pub fn advance_region(pos: &mut f64, steps: &[f32], start: u32, end: u32, frames: u32) -> usize {
    let end = end.min(frames);
    let start = start.min(end);
    if frames == 0 || end <= start {
        return 0;
    }
    let (frames_f, end_f, span) = (frames as f64, end as f64, (end - start) as f64);
    for (i, &step) in steps.iter().enumerate() {
        if *pos >= frames_f {
            return i;
        }
        let was = *pos;
        *pos += step as f64;
        if was < end_f {
            while *pos >= end_f {
                *pos -= span;
            }
        }
    }
    steps.len()
}

/// The exponent of the lowest set bit of a finite, non-zero `x` (`x` is an odd multiple of
/// `2^result`).
fn lowest_bit_exponent(x: f64) -> i32 {
    let bits = x.to_bits();
    let biased = ((bits >> 52) & 0x7FF) as i32;
    let mantissa = bits & ((1u64 << 52) - 1);
    let (m, e) = if biased == 0 { (mantissa, -1074) } else { (mantissa | (1u64 << 52), biased - 1075) };
    e + m.trailing_zeros() as i32
}

/// [`advance`] with every step equal to `step` (a settled pitch: virtual voices keep time), in
/// O(1) when that is exact, else through [`advance`]'s loop. Same result bit for bit. `n` is at
/// most a quantum (128).
///
/// Why it is exact: `step`, `*pos` and `frames` are all multiples of `2^g` (`g` the lowest set bit
/// of either, at most 0 since `frames` is whole). While every value stays below `2^(52 + g)` in
/// magnitude, each of the loop's additions and subtractions is exact, so the loop's result is the
/// exact `(pos + n·step)` reduced into `[0, frames)` (looping) — which is what this computes, with
/// exact integer multiples. Otherwise (a huge position, a step with far finer bits than the
/// position, a non-looping voice reaching its end, a negative or non-finite value) it loops.
#[inline(never)]
pub fn advance_constant(pos: &mut f64, step: f32, n: usize, frames: u32, looping: bool) -> usize {
    let n = n.min(128);
    let frames_f = frames as f64;
    let s = step as f64;
    let p = *pos;
    let exact = frames > 0 && s.is_finite() && s >= 0.0 && p.is_finite() && p >= 0.0;
    if exact {
        let mut g = 0i32;
        if s != 0.0 {
            g = g.min(lowest_bit_exponent(s));
        }
        if p != 0.0 {
            g = g.min(lowest_bit_exponent(p));
        }
        // Everything the loop computes stays below p + n·step + frames.
        let bound = p + n as f64 * s + frames_f;
        // 2^(52 + g), built from its exponent bits (52 + g ≥ -948: a normal number).
        if g > -1000 && bound < f64::from_bits(((1023 + 52 + g) as u64) << 52) {
            if looping {
                let mut t = p;
                // The loop first wraps `*pos` into the clip, then adds and wraps each step.
                if t >= frames_f {
                    t -= ((t / frames_f) as u64) as f64 * frames_f;
                }
                t += n as f64 * s;
                if t >= frames_f {
                    t -= ((t / frames_f) as u64) as f64 * frames_f;
                }
                // The truncated quotient (t ≥ 0, so a floor) of a rounded division can be one off
                // either way: settle exactly.
                while t >= frames_f {
                    t -= frames_f;
                }
                while t < 0.0 {
                    t += frames_f;
                }
                *pos = t;
                return n;
            }
            let t = p + n as f64 * s;
            // The non-looping loop stops before a frame once `pos >= frames`.
            if p + (n as f64 - 1.0).max(0.0) * s < frames_f {
                *pos = t;
                return n;
            }
        }
    }
    // The general case: the loop itself.
    let steps = [step; 128];
    advance(pos, &steps[..n], frames, looping)
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    /// `advance_constant` lands exactly where `advance` does, over random positions, steps,
    /// lengths and loop modes, including huge positions and fine steps (the loop fallback).
    fn ramp_clip(frames: usize) -> Vec<f32> {
        (0..frames).map(|i| i as f32).collect()
    }

    #[test]
    fn a_region_loop_wraps_at_its_end_and_reads_across_the_seam() {
        let data = ramp_clip(16);
        let src = Source { samples: Samples::F32(&data), channels: 1, frames: 16 };
        let mut pos = 2.0;
        let (mut l, mut r) = ([0.0f32; 12], [0.0f32; 12]);
        assert_eq!(lagrange_region(&src, &mut pos, &[1.0; 12], 4, 8, &mut l, &mut r), 12);
        // 2, 3 (the intro), then 4..8 repeating.
        assert_eq!(l, [2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 4.0, 5.0, 6.0, 7.0, 4.0, 5.0]);
        assert_eq!(pos, 6.0);
        // Half a frame after the region's last frame: 6, 7, then the wrapped 4, 5.
        let mut pos = 7.5;
        let (mut l, mut r) = ([0.0f32; 1], [0.0f32; 1]);
        lagrange_region(&src, &mut pos, &[1.0], 4, 8, &mut l, &mut r);
        assert_eq!(l[0], horner([6.0, 7.0, 4.0, 5.0], 0.5));
        assert_eq!(pos, 4.5);
    }

    #[test]
    fn a_region_position_past_its_end_plays_on_to_the_clip_end() {
        let data = ramp_clip(10);
        let src = Source { samples: Samples::F32(&data), channels: 1, frames: 10 };
        let mut pos = 8.0;
        let (mut l, mut r) = ([9.0f32; 4], [9.0f32; 4]);
        assert_eq!(lagrange_region(&src, &mut pos, &[1.0; 4], 2, 6, &mut l, &mut r), 2);
        assert_eq!(l, [8.0, 9.0, 0.0, 0.0]);
        let mut p = 8.0;
        assert_eq!(advance_region(&mut p, &[1.0; 4], 2, 6, 10), 2);
        assert_eq!(p, 10.0);
    }

    #[test]
    fn advance_region_keeps_time_with_lagrange_region() {
        let data = ramp_clip(64);
        let src = Source { samples: Samples::F32(&data), channels: 1, frames: 64 };
        let steps: Vec<f32> = (0..128).map(|i| 0.7 + (i % 5) as f32 * 0.3).collect();
        let (mut a, mut b) = (1.25, 1.25);
        let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
        lagrange_region(&src, &mut a, &steps, 10, 40, &mut l, &mut r);
        advance_region(&mut b, &steps, 10, 40, 64);
        assert_eq!(a, b);
        assert!((10.0..40.0).contains(&a));
    }

    #[test]
    fn advance_constant_matches_the_loop_bit_for_bit() {
        let mut seed = 0x1234_5678u32;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed
        };
        for case in 0..200_000 {
            let frames = 1 + rnd() % match case % 4 {
                0 => 8,
                1 => 1_000,
                2 => 200_000,
                _ => 20_000_000,
            };
            let step = match case % 5 {
                0 => 1.0,
                1 => (rnd() % 1_000) as f32 / 997.0 * 2.0,
                2 => f32::from_bits(0x3C00_0000 + rnd() % 0x0400_0000), // 2^-7 .. 2^1 any mantissa
                3 => (rnd() % 17) as f32,
                _ => f32::from_bits(0x3000_0000 + rnd() % 0x1000_0000), // tiny steps
            };
            let start = match case % 3 {
                0 => (rnd() % frames) as f64,
                1 => (rnd() % frames) as f64 + (rnd() % 4096) as f64 / 4096.0,
                _ => (rnd() % (2 * frames)) as f64 * 0.731_f32 as f64,
            };
            let n = (rnd() % 129) as usize;
            for looping in [false, true] {
                let mut a = start;
                let used_a = advance(&mut a, &vec![step; n], frames, looping);
                let mut b = start;
                let used_b = advance_constant(&mut b, step, n, frames, looping);
                assert_eq!((a.to_bits(), used_a), (b.to_bits(), used_b), "case {case}: start {start} step {step} n {n} frames {frames} looping {looping}: {a} vs {b}");
            }
        }
    }

    /// Frame `i` holds `i / 256`, so interpolated values are exact in f32.
    fn ramp(n: usize) -> Vec<f32> {
        (0..n).map(|i| i as f32 / 256.0).collect()
    }

    fn mono(data: &[f32]) -> Source<'_> {
        Source { samples: Samples::F32(data), channels: 1, frames: data.len() as u32 }
    }

    fn stereo(data: &[f32]) -> Source<'_> {
        Source { samples: Samples::F32(data), channels: 2, frames: (data.len() / 2) as u32 }
    }

    fn close(a: &[f32], b: &[f32]) {
        assert_eq!(a.len(), b.len());
        for (i, (x, y)) in a.iter().zip(b).enumerate() {
            assert!((x - y).abs() < 1e-6, "index {i}: {x} != {y}");
        }
    }

    #[test]
    fn unit_steps_read_the_clip_exactly() {
        let x = ramp(8);
        let src = mono(&x);
        let mut pos = 0.0;
        let (mut l, mut r) = ([0.0f32; 8], [0.0f32; 8]);
        let n = linear(&src, &mut pos, &[1.0f32; 8], false, &mut l, &mut r);
        assert_eq!(n, 8);
        assert_eq!(&l[..], &x[..]);
        assert_eq!(&r[..], &x[..]);
        assert_eq!(pos, 8.0);
    }

    #[test]
    fn half_steps_interpolate_between_frames() {
        let x = ramp(8);
        let src = mono(&x);
        let mut pos = 0.0;
        let (mut l, mut r) = ([0.0f32; 8], [0.0f32; 8]);
        linear(&src, &mut pos, &[0.5f32; 8], false, &mut l, &mut r);
        // Even outputs land on a frame; odd outputs sit halfway between a pair of frames.
        let expected: Vec<f32> = (0..8usize)
            .map(|i| {
                let k = (i / 2) as f32;
                if i % 2 == 0 { k / 256.0 } else { (k + 0.5) / 256.0 }
            })
            .collect();
        close(&l, &expected);
        assert_eq!(pos, 4.0);
    }

    #[test]
    fn double_steps_skip_frames() {
        let x = ramp(8);
        let src = mono(&x);
        let mut pos = 0.0;
        let (mut l, mut r) = ([0.0f32; 4], [0.0f32; 4]);
        let n = linear(&src, &mut pos, &[2.0f32; 4], false, &mut l, &mut r);
        assert_eq!(n, 4);
        assert_eq!(l, [x[0], x[2], x[4], x[6]]);
        assert_eq!(pos, 8.0);
    }

    #[test]
    fn a_mono_clip_is_copied_to_both_outputs() {
        let x = [0.25f32, -0.5, 0.75, 1.0];
        let src = mono(&x);
        let mut pos = 0.0;
        let (mut l, mut r) = ([0.0f32; 4], [0.0f32; 4]);
        linear(&src, &mut pos, &[0.5f32; 4], false, &mut l, &mut r);
        assert_eq!(l, r);
        // Positions 0, 0.5, 1.0, 1.5: a frame, then midpoints and frames again.
        close(&l, &[0.25, -0.125, -0.5, 0.125]);
    }

    #[test]
    fn a_stereo_clip_keeps_its_channels() {
        // Interleaved pairs: left = f / 16, right = 1 - f / 16.
        let mut data: Vec<f32> = Vec::new();
        for f in 0..4 {
            data.push(f as f32 / 16.0);
            data.push(1.0 - f as f32 / 16.0);
        }
        let src = stereo(&data);
        let mut pos = 0.0;
        let (mut l, mut r) = ([0.0f32; 4], [0.0f32; 4]);
        linear(&src, &mut pos, &[1.0f32; 4], false, &mut l, &mut r);
        assert_eq!(l, [0.0, 1.0 / 16.0, 2.0 / 16.0, 3.0 / 16.0]);
        assert_eq!(r, [1.0, 15.0 / 16.0, 14.0 / 16.0, 13.0 / 16.0]);
    }

    #[test]
    fn int16_samples_are_scaled_by_1_over_32768() {
        let x: [i16; 4] = [16384, -16384, 0, 32767];
        let src = Source { samples: Samples::I16(&x[..]), channels: 1, frames: 4 };
        let mut pos = 0.0;
        let (mut l, mut r) = ([0.0f32; 4], [0.0f32; 4]);
        linear(&src, &mut pos, &[1.0f32; 4], false, &mut l, &mut r);
        assert_eq!(l, [0.5, -0.5, 0.0, 32767.0 / 32768.0]);
        assert_eq!(r, l);
    }

    #[test]
    fn a_non_looping_clip_stops_and_zero_fills_at_its_end() {
        let x = ramp(5);
        let src = mono(&x);
        let mut pos = 0.0;
        let (mut l, mut r) = ([1.0f32; 8], [1.0f32; 8]);
        let n = linear(&src, &mut pos, &[1.0f32; 8], false, &mut l, &mut r);
        assert_eq!(n, 5);
        assert_eq!(&l[..5], &x[..]);
        assert!(l[5..].iter().all(|&v| v == 0.0));
        assert!(r[5..].iter().all(|&v| v == 0.0));
        assert_eq!(pos, 5.0);
    }

    #[test]
    fn the_last_frame_holds_when_not_looping() {
        let x = ramp(4);
        let src = mono(&x);
        let mut pos = 3.5;
        let (mut l, mut r) = ([0.0f32; 1], [0.0f32; 1]);
        let n = linear(&src, &mut pos, &[1.0f32], false, &mut l, &mut r);
        assert_eq!(n, 1);
        assert_eq!(l[0], x[3]);
        assert_eq!(pos, 4.5);
        // Past the end now: nothing more is written.
        let n = linear(&src, &mut pos, &[1.0f32], false, &mut l, &mut r);
        assert_eq!(n, 0);
        assert_eq!(l[0], 0.0);
    }

    #[test]
    fn a_looping_clip_wraps_and_interpolates_across_the_seam() {
        let x = ramp(4);
        let src = mono(&x);
        let mut pos = 3.5;
        let (mut l, mut r) = ([0.0f32; 2], [0.0f32; 2]);
        let n = linear(&src, &mut pos, &[0.5f32, 0.5], true, &mut l, &mut r);
        assert_eq!(n, 2);
        // Frame 3 mixed with frame 0 across the seam, then frame 0 after the wrap.
        assert_eq!(l[0], 0.5 * x[3]);
        assert_eq!(l[1], 0.0);
        assert_eq!(pos, 0.5);
    }

    #[test]
    fn per_frame_steps_follow_a_changing_pitch() {
        let x = ramp(8);
        let src = mono(&x);
        let steps: [f32; 5] = [1.0, 2.0, 0.5, 0.5, 1.0];
        let mut pos = 0.0;
        let (mut l, mut r) = ([0.0f32; 5], [0.0f32; 5]);
        let n = linear(&src, &mut pos, &steps, false, &mut l, &mut r);
        assert_eq!(n, 5);
        // Read positions: 0, 1, 3, 3.5, 4.
        let expected = [0.0f32, 1.0, 3.0, 3.5, 4.0].map(|p| p / 256.0);
        close(&l, &expected);
        assert_eq!(pos, 5.0);
    }

    #[test]
    fn advance_matches_the_position_linear_reaches() {
        let x = ramp(5);
        let src = mono(&x);
        let steps: [f32; 8] = [1.0, 1.5, 0.7, 1.0, 1.0, 2.0, 1.0, 1.0];
        for &looping in &[false, true] {
            let mut lin_pos = 0.25;
            let mut adv_pos = 0.25;
            let (mut l, mut r) = ([0.0f32; 8], [0.0f32; 8]);
            let n_lin = linear(&src, &mut lin_pos, &steps, looping, &mut l, &mut r);
            let n_adv = advance(&mut adv_pos, &steps, 5, looping);
            // Non-looping stops at frame 5 (the clip has 5 frames); looping fills all 8.
            let expected = if looping { 8 } else { 5 };
            assert_eq!(n_lin, expected);
            assert_eq!(n_adv, expected);
            assert_eq!(lin_pos, adv_pos);
        }
    }

    #[test]
    fn an_empty_clip_renders_nothing() {
        let empty: &[f32] = &[];
        let src = Source { samples: Samples::F32(empty), channels: 1, frames: 0 };
        for &looping in &[false, true] {
            let mut pos = 1.5;
            let (mut l, mut r) = ([1.0f32; 3], [1.0f32; 3]);
            let n = linear(&src, &mut pos, &[1.0f32; 3], looping, &mut l, &mut r);
            assert_eq!(n, 0);
            assert_eq!(l, [0.0; 3]);
            assert_eq!(r, [0.0; 3]);
            assert_eq!(pos, 1.5);
            assert_eq!(advance(&mut pos, &[1.0f32; 3], 0, looping), 0);
            assert_eq!(pos, 1.5);
        }
    }

    // ---- lagrange (A3.6) ----

    /// A cubic in the frame index: Lagrange interpolation reproduces it exactly (up to rounding).
    fn cubic_clip(n: usize) -> Vec<f32> {
        (0..n).map(|i| cubic_at(i as f64) as f32).collect()
    }

    fn cubic_at(x: f64) -> f64 {
        0.001 * x * x * x - 0.02 * x * x + 0.1 * x - 0.3
    }

    /// Deterministic noise in [-1, 1).
    fn noise(n: usize, seed: u32) -> Vec<f32> {
        let mut s = seed;
        (0..n)
            .map(|_| {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (s >> 8) as f32 / (1u32 << 23) as f32 - 1.0
            })
            .collect()
    }

    #[test]
    fn lagrange_is_bit_exact_to_linear_on_whole_frames() {
        let x = noise(64, 7);
        let xi: Vec<i16> = x.iter().map(|&v| (v * 32767.0) as i16).collect();
        let sources = [
            Source { samples: Samples::F32(&x), channels: 1, frames: 64 },
            Source { samples: Samples::F32(&x), channels: 2, frames: 32 },
            Source { samples: Samples::I16(&xi), channels: 1, frames: 64 },
            Source { samples: Samples::I16(&xi), channels: 2, frames: 32 },
        ];
        for src in &sources {
            for &step in &[1.0f32, 2.0, 3.0] {
                for &looping in &[false, true] {
                    for &start in &[0.0f64, 5.0, 31.0] {
                        let (mut pl, mut pg) = (start, start);
                        let (mut l1, mut r1) = ([9.0f32; 40], [9.0f32; 40]);
                        let (mut l2, mut r2) = ([7.0f32; 40], [7.0f32; 40]);
                        let steps = [step; 40];
                        let a = linear(src, &mut pl, &steps, looping, &mut l1, &mut r1);
                        let b = lagrange(src, &mut pg, &steps, looping, &mut l2, &mut r2);
                        assert_eq!(a, b);
                        assert_eq!(pl, pg);
                        for k in 0..40 {
                            assert_eq!(l1[k].to_bits(), l2[k].to_bits(), "step {step} loop {looping} start {start} frame {k}");
                            assert_eq!(r1[k].to_bits(), r2[k].to_bits(), "step {step} loop {looping} start {start} frame {k}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn lagrange_reproduces_a_cubic_between_frames() {
        let x = cubic_clip(32);
        let src = mono(&x);
        let mut pos = 1.0;
        let (mut l, mut r) = ([0.0f32; 64], [0.0f32; 64]);
        // Interior positions 1 .. 28.69 (neighbours stay inside the clip).
        let steps = [0.43f32; 64];
        assert_eq!(lagrange(&src, &mut pos, &steps, false, &mut l, &mut r), 64);
        let mut p = 1.0f64;
        for k in 0..64 {
            assert!((l[k] as f64 - cubic_at(p)).abs() < 2e-6, "frame {k} at {p}: {} != {}", l[k], cubic_at(p));
            assert_eq!(l[k], r[k]);
            p += 0.43f32 as f64;
        }
    }

    #[test]
    fn lagrange_half_steps_use_the_four_point_midpoint() {
        let x = noise(16, 3);
        let src = mono(&x);
        let mut pos = 4.5;
        let (mut l, mut r) = ([0.0f32; 1], [0.0f32; 1]);
        lagrange(&src, &mut pos, &[1.0], false, &mut l, &mut r);
        // At t = 1/2 the weights are (-1, 9, 9, -1) / 16.
        let expected = (-x[3] + 9.0 * x[4] + 9.0 * x[5] - x[6]) / 16.0;
        assert!((l[0] - expected).abs() < 1e-6);
    }

    #[test]
    fn lagrange_keeps_stereo_channels_and_scales_int16() {
        // Left a cubic, right its negation, as int16.
        let c = cubic_clip(16);
        let mut data: Vec<i16> = Vec::new();
        for &v in &c {
            data.push((v * 32768.0).round() as i16);
            data.push((-v * 32768.0).round() as i16);
        }
        let src = Source { samples: Samples::I16(&data), channels: 2, frames: 16 };
        let mut pos = 2.25;
        let (mut l, mut r) = ([0.0f32; 8], [0.0f32; 8]);
        lagrange(&src, &mut pos, &[1.0f32; 8], false, &mut l, &mut r);
        for k in 0..8 {
            let want = cubic_at(2.25 + k as f64);
            assert!((l[k] as f64 - want).abs() < 1e-4, "left {k}");
            assert!((r[k] as f64 + want).abs() < 1e-4, "right {k}");
        }
    }

    #[test]
    fn lagrange_reads_across_the_loop_seam() {
        let x = noise(8, 11);
        let src = mono(&x);
        // Frame 7.5 needs frames 6, 7, 0, 1; frame 0.5 (after the wrap) needs 7, 0, 1, 2.
        let mut pos = 7.5;
        let (mut l, mut r) = ([0.0f32; 2], [0.0f32; 2]);
        assert_eq!(lagrange(&src, &mut pos, &[1.0, 1.0], true, &mut l, &mut r), 2);
        let mid = |a: f32, b: f32, c: f32, d: f32| (-a + 9.0 * b + 9.0 * c - d) / 16.0;
        assert!((l[0] - mid(x[6], x[7], x[0], x[1])).abs() < 1e-6);
        assert!((l[1] - mid(x[7], x[0], x[1], x[2])).abs() < 1e-6);
        assert_eq!(pos, 1.5);
    }

    #[test]
    fn lagrange_holds_the_edge_frames_when_not_looping() {
        let x = noise(8, 5);
        let src = mono(&x);
        let mid = |a: f32, b: f32, c: f32, d: f32| (-a + 9.0 * b + 9.0 * c - d) / 16.0;
        // Before the start: frame -1 reads frame 0.
        let (mut l, mut r) = ([0.0f32; 1], [0.0f32; 1]);
        let mut pos = 0.5;
        lagrange(&src, &mut pos, &[1.0], false, &mut l, &mut r);
        assert!((l[0] - mid(x[0], x[0], x[1], x[2])).abs() < 1e-6);
        // Near the end: frames 8 and 9 read frame 7.
        let mut pos = 6.5;
        lagrange(&src, &mut pos, &[1.0], false, &mut l, &mut r);
        assert!((l[0] - mid(x[5], x[6], x[7], x[7])).abs() < 1e-6);
        let mut pos = 7.5;
        lagrange(&src, &mut pos, &[1.0], false, &mut l, &mut r);
        assert!((l[0] - mid(x[6], x[7], x[7], x[7])).abs() < 1e-6);
        // Then past the end: nothing more, as linear.
        assert_eq!(lagrange(&src, &mut pos, &[1.0], false, &mut l, &mut r), 0);
        assert_eq!(l[0], 0.0);
    }

    #[test]
    fn lagrange_handles_clips_of_one_to_three_frames() {
        for n in 1..=3usize {
            let x = noise(2 * n, n as u32);
            for &channels in &[1u32, 2] {
                let frames = if channels == 2 { n } else { 2 * n };
                let src = Source { samples: Samples::F32(&x), channels, frames: frames as u32 };
                for &looping in &[false, true] {
                    let mut pos = 0.0;
                    let (mut l, mut r) = ([0.0f32; 32], [0.0f32; 32]);
                    let got = lagrange(&src, &mut pos, &[0.37f32; 32], looping, &mut l, &mut r);
                    let mut adv = 0.0;
                    assert_eq!(advance(&mut adv, &[0.37f32; 32], frames as u32, looping), got);
                    assert_eq!(adv, pos);
                    assert!(l.iter().chain(r.iter()).all(|v| v.is_finite() && v.abs() < 2.0));
                    // A constant clip stays constant at every fraction and edge.
                    let k = [0.25f32; 6];
                    let src_k = Source { samples: Samples::F32(&k), channels, frames: frames as u32 };
                    let mut pos = 0.1;
                    let got = lagrange(&src_k, &mut pos, &[0.37f32; 32], looping, &mut l, &mut r);
                    assert!(l[..got].iter().all(|&v| (v - 0.25).abs() < 1e-6), "n {n} ch {channels} loop {looping}");
                }
            }
        }
    }

    #[test]
    fn lagrange_lands_where_advance_does() {
        let x = noise(10, 2);
        let src = mono(&x);
        let steps: [f32; 12] = [1.0, 1.5, 0.7, 1.0, 1.25, 2.0, 0.3, 1.0, 3.3, 1.0, 0.9, 1.1];
        for &looping in &[false, true] {
            let (mut a, mut b, mut c) = (0.25, 0.25, 0.25);
            let (mut l, mut r) = ([0.0f32; 12], [0.0f32; 12]);
            let n1 = lagrange(&src, &mut a, &steps, looping, &mut l, &mut r);
            let n2 = linear(&src, &mut b, &steps, looping, &mut l, &mut r);
            let n3 = advance(&mut c, &steps, 10, looping);
            assert_eq!((n1, a), (n2, b));
            assert_eq!((n1, a), (n3, c));
        }
    }

    #[test]
    fn lagrange_never_reads_past_the_samples() {
        // `frames` claims more than the slice holds: only the 4 frames there are read.
        let x = [0.5f32; 4];
        let src = Source { samples: Samples::F32(&x), channels: 1, frames: 100 };
        for &looping in &[false, true] {
            let mut pos = 2.5;
            let (mut l, mut r) = ([0.0f32; 16], [0.0f32; 16]);
            let n = lagrange(&src, &mut pos, &[0.5f32; 16], looping, &mut l, &mut r);
            assert!(l[..n].iter().all(|&v| (v - 0.5).abs() < 1e-6));
        }
        let empty: &[f32] = &[];
        let src = Source { samples: Samples::F32(empty), channels: 2, frames: 0 };
        let mut pos = 1.5;
        let (mut l, mut r) = ([1.0f32; 3], [1.0f32; 3]);
        assert_eq!(lagrange(&src, &mut pos, &[1.0f32; 3], true, &mut l, &mut r), 0);
        assert_eq!((l, r, pos), ([0.0; 3], [0.0; 3], 1.5));
    }

    // ---- lagrange_n, lagrange_region_n (ADR 0162 B2, leaf L-B2a) ----

    /// Mono and stereo, f32 and int16, looping or not, unit / fractional / per-frame steps, starts
    /// at the edges and past the end: `lagrange_n` equals `lagrange` bit for bit (`to_bits`), the
    /// final positions and the returned counts too.
    #[test]
    fn lagrange_n_is_bit_identical_to_lagrange_for_mono_and_stereo() {
        let x = noise(64, 21);
        let xi: Vec<i16> = x.iter().map(|&v| (v * 32767.0) as i16).collect();
        let sources = [
            Source { samples: Samples::F32(&x), channels: 1, frames: 64 },
            Source { samples: Samples::F32(&x), channels: 2, frames: 32 },
            Source { samples: Samples::I16(&xi), channels: 1, frames: 64 },
            Source { samples: Samples::I16(&xi), channels: 2, frames: 32 },
        ];
        let unit = [1.0f32; 40];
        let fractional = [0.43f32; 40];
        let per_frame: Vec<f32> = (0..40).map(|i| 0.3 + (i % 7) as f32 * 0.35).collect();
        let step_sets: [&[f32]; 3] = [&unit, &fractional, &per_frame];
        for src in &sources {
            let ch = src.channels as usize;
            for steps in step_sets {
                let n = steps.len();
                for &looping in &[false, true] {
                    // Inside the clip, on its edges, and past its end (wrapped when looping).
                    for &start in &[0.0f64, 0.5, 5.0, 31.0, 31.9, 63.5, 70.0] {
                        let (mut pl, mut pn) = (start, start);
                        let (mut l, mut r) = ([9.0f32; 40], [9.0f32; 40]);
                        let mut planar = [5.0f32; PLANAR_SCRATCH_FLOATS];
                        let a = lagrange(src, &mut pl, steps, looping, &mut l, &mut r);
                        let b = lagrange_n(src, &mut pn, steps, looping, ch, &mut planar);
                        assert_eq!((a, pl.to_bits()), (b, pn.to_bits()), "ch {ch} loop {looping} start {start}");
                        for c in 0..ch {
                            let want = if c == 0 { &l } else { &r };
                            for k in 0..n {
                                assert_eq!(planar[c * n + k].to_bits(), want[k].to_bits(), "ch {ch} row {c} loop {looping} start {start} frame {k}");
                            }
                        }
                        // Channel 0 alone is `out_l` too.
                        let mut p1 = start;
                        let mut one = [0.0f32; 40];
                        assert_eq!(lagrange_n(src, &mut p1, steps, looping, 1, &mut one), a);
                        assert!(one[..a].iter().zip(&l[..a]).all(|(x, y)| x.to_bits() == y.to_bits()));
                    }
                }
            }
        }
    }

    /// The same for `lagrange_region_n` against `lagrange_region` (regions inside the clip, at its
    /// edges, a position past the region's end, an empty region).
    #[test]
    fn lagrange_region_n_is_bit_identical_to_lagrange_region_for_mono_and_stereo() {
        let x = noise(64, 22);
        let xi: Vec<i16> = x.iter().map(|&v| (v * 32767.0) as i16).collect();
        let sources = [
            Source { samples: Samples::F32(&x), channels: 1, frames: 64 },
            Source { samples: Samples::F32(&x), channels: 2, frames: 32 },
            Source { samples: Samples::I16(&xi), channels: 1, frames: 64 },
            Source { samples: Samples::I16(&xi), channels: 2, frames: 32 },
        ];
        let unit = [1.0f32; 40];
        let fractional = [0.43f32; 40];
        let per_frame: Vec<f32> = (0..40).map(|i| 0.3 + (i % 7) as f32 * 0.35).collect();
        let step_sets: [&[f32]; 3] = [&unit, &fractional, &per_frame];
        // Whole clip, inside, at both edges, a region that ends at the clip's end, empty, and
        // inverted (empty after the clamp).
        let regions = [(0u32, u32::MAX), (4, 20), (0, 3), (25, 31), (30, 30), (20, 100), (40, 10)];
        for src in &sources {
            let ch = src.channels as usize;
            for steps in step_sets {
                let n = steps.len();
                for &(s, e) in &regions {
                    for &start in &[0.0f64, 0.5, 2.25, 19.5, 31.0, 40.0, 63.5, 70.0] {
                        let (mut pl, mut pn) = (start, start);
                        let (mut l, mut r) = ([9.0f32; 40], [9.0f32; 40]);
                        let mut planar = [5.0f32; PLANAR_SCRATCH_FLOATS];
                        let a = lagrange_region(src, &mut pl, steps, s, e, &mut l, &mut r);
                        let b = lagrange_region_n(src, &mut pn, steps, s, e, ch, &mut planar);
                        assert_eq!((a, pl.to_bits()), (b, pn.to_bits()), "ch {ch} region {s}..{e} start {start}");
                        for c in 0..ch {
                            let want = if c == 0 { &l } else { &r };
                            for k in 0..n {
                                assert_eq!(planar[c * n + k].to_bits(), want[k].to_bits(), "ch {ch} row {c} region {s}..{e} start {start} frame {k}");
                            }
                        }
                    }
                }
            }
        }
    }

    /// A 16-channel clip (channel `c` a distinct signal): channels `c` and `c + 1` of the planar
    /// output equal `lagrange` on a stereo clip of those two channels, bit for bit, for every even
    /// `c`; the same for 4 and 9 channels (the odd last channel paired with a copy of itself).
    #[test]
    fn every_channel_of_a_16_channel_clip_matches_the_stereo_kernel() {
        const FRAMES: usize = 24;
        const N: usize = 40;
        let steps: Vec<f32> = (0..N).map(|i| 0.4 + (i % 5) as f32 * 0.35).collect();
        for &ch in &[4usize, 9, 16] {
            let data = noise(FRAMES * ch, 40 + ch as u32);
            let clip = Source { samples: Samples::F32(&data), channels: ch as u32, frames: FRAMES as u32 };
            for &looping in &[false, true] {
                // Starts inside, and near the end, so the non-looping clip runs out mid-block.
                for &start in &[0.0f64, 3.7, 23.5] {
                    let mut planar = [0.0f32; PLANAR_SCRATCH_FLOATS];
                    let mut p = start;
                    let got = lagrange_n(&clip, &mut p, &steps, looping, ch, &mut planar);
                    for c in (0..ch).step_by(2) {
                        // The odd last channel of an odd clip pairs with a copy of itself.
                        let c2 = (c + 1).min(ch - 1);
                        let mut pair = Vec::with_capacity(2 * FRAMES);
                        for j in 0..FRAMES {
                            pair.push(data[j * ch + c]);
                            pair.push(data[j * ch + c2]);
                        }
                        let pair_src = Source { samples: Samples::F32(&pair), channels: 2, frames: FRAMES as u32 };
                        let mut pp = start;
                        let (mut l, mut r) = ([0.0f32; N], [0.0f32; N]);
                        assert_eq!(lagrange(&pair_src, &mut pp, &steps, looping, &mut l, &mut r), got, "ch {ch} pair {c}");
                        assert_eq!(pp.to_bits(), p.to_bits());
                        for k in 0..got {
                            assert_eq!(planar[c * N + k].to_bits(), l[k].to_bits(), "ch {ch} channel {c} loop {looping} start {start} frame {k}");
                            assert_eq!(planar[c2 * N + k].to_bits(), r[k].to_bits(), "ch {ch} channel {c2} loop {looping} start {start} frame {k}");
                        }
                    }
                }
            }
        }
    }

    /// `channels` below the clip's renders only those rows (the rest of `out` untouched);
    /// `channels` 0, above the clip's, above 16, or a short `out` returns 0 and writes nothing.
    #[test]
    fn lagrange_n_renders_the_channels_asked_and_refuses_bad_arguments() {
        const N: usize = 8;
        let data = noise(16 * 9, 9);
        let nine = Source { samples: Samples::F32(&data), channels: 9, frames: 16 };
        let steps = [0.6f32, 1.0, 1.3, 0.8, 1.0, 0.5, 1.1, 0.9];
        let mut full = [0.0f32; PLANAR_SCRATCH_FLOATS];
        let mut p_full = 2.5;
        assert_eq!(lagrange_n(&nine, &mut p_full, &steps, true, 9, &mut full), N);

        // Three channels of nine: rows 0..3 match the full render; the rest of `out` is untouched.
        let mut out = [7.0f32; PLANAR_SCRATCH_FLOATS];
        let mut p = 2.5;
        assert_eq!(lagrange_n(&nine, &mut p, &steps, true, 3, &mut out), N);
        assert_eq!(p.to_bits(), p_full.to_bits());
        assert!(out[..3 * N].iter().zip(&full[..3 * N]).all(|(a, b)| a.to_bits() == b.to_bits()));
        assert!(out[3 * N..].iter().all(|&v| v == 7.0));

        // Refused: nothing written, position kept, 0 returned.
        let refused = |f: &mut dyn FnMut(&mut f64, &mut [f32]) -> usize| {
            let mut out = [7.0f32; PLANAR_SCRATCH_FLOATS];
            let mut p = 2.5;
            assert_eq!(f(&mut p, &mut out), 0);
            assert_eq!(p, 2.5);
            assert!(out.iter().all(|&v| v == 7.0));
        };
        refused(&mut |p, out| lagrange_n(&nine, p, &steps, true, 0, out));
        refused(&mut |p, out| lagrange_n(&nine, p, &steps, true, 10, out));
        refused(&mut |p, out| lagrange_region_n(&nine, p, &steps, 2, 12, 0, out));
        refused(&mut |p, out| lagrange_region_n(&nine, p, &steps, 2, 12, 10, out));
        refused(&mut |p, out| lagrange_n(&nine, p, &steps, true, 4, &mut out[..4 * N - 1]));
        refused(&mut |p, out| lagrange_region_n(&nine, p, &steps, 2, 12, 4, &mut out[..4 * N - 1]));
        // A 17-channel clip is above MAX_CHANNELS.
        let big = noise(4 * 17, 17);
        let seventeen = Source { samples: Samples::F32(&big), channels: 17, frames: 4 };
        refused(&mut |p, out| lagrange_n(&seventeen, p, &steps, true, 17, out));
        refused(&mut |p, out| lagrange_region_n(&seventeen, p, &steps, 0, 4, 17, out));
        // Exactly `channels * len` is enough.
        let mut exact = [0.0f32; 4 * N];
        let mut p = 2.5;
        assert_eq!(lagrange_n(&nine, &mut p, &steps, true, 4, &mut exact), N);
    }

    /// A non-looping 9-channel clip ending mid-block zero-fills every row past the end and returns
    /// the frames written; the position matches `advance` (and `advance_region` for the region form).
    #[test]
    fn an_n_channel_clip_ends_like_a_stereo_one_and_keeps_time_with_advance() {
        const N: usize = 16;
        const FRAMES: usize = 10;
        let data = noise(FRAMES * 9, 31);
        let nine = Source { samples: Samples::F32(&data), channels: 9, frames: FRAMES as u32 };
        // Channels 0 and 1 as a stereo clip.
        let pair: Vec<f32> = (0..FRAMES).flat_map(|j| [data[j * 9], data[j * 9 + 1]]).collect();
        let stereo = Source { samples: Samples::F32(&pair), channels: 2, frames: FRAMES as u32 };
        let steps = [0.8f32, 0.9, 1.1, 0.6, 0.7, 1.3, 1.0, 0.9, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0];

        // Non-looping, starting at 6.5: the reads at 6.5, 7.3, 8.2, 9.3 and 9.9 are inside; the next
        // position (10.6) is past the end, so the block stops after 5 frames.
        let mut p = 6.5;
        let mut planar = [7.0f32; PLANAR_SCRATCH_FLOATS];
        let got = lagrange_n(&nine, &mut p, &steps, false, 9, &mut planar);
        let mut ps = 6.5;
        let (mut l, mut r) = ([0.0f32; N], [0.0f32; N]);
        let got_stereo = lagrange(&stereo, &mut ps, &steps, false, &mut l, &mut r);
        let mut pa = 6.5;
        assert_eq!(advance(&mut pa, &steps, FRAMES as u32, false), got);
        assert_eq!((got, got_stereo), (5, 5));
        assert!(p > FRAMES as f64 && p == ps && p.to_bits() == pa.to_bits());
        for c in 0..9 {
            assert!(planar[c * N + got..(c + 1) * N].iter().all(|&v| v == 0.0), "row {c} not zero-filled");
        }
        for k in 0..got {
            assert_eq!(planar[k].to_bits(), l[k].to_bits(), "frame {k}");
            assert_eq!(planar[N + k].to_bits(), r[k].to_bits(), "frame {k}");
        }

        // A block that ends mid-clip keeps every row's tail at zero and stops at the clip's end.
        let mut p = 8.0;
        let mut planar = [7.0f32; PLANAR_SCRATCH_FLOATS];
        assert_eq!(lagrange_n(&nine, &mut p, &[1.0; N], false, 9, &mut planar), 2);
        assert_eq!(p, 10.0);
        assert!((0..9).all(|c| planar[c * N + 2..(c + 1) * N].iter().all(|&v| v == 0.0)));

        // The region form: a region 2..6 and a position already past it (6.5) plays on to the end.
        let mut p = 6.5;
        let mut planar = [7.0f32; PLANAR_SCRATCH_FLOATS];
        let got = lagrange_region_n(&nine, &mut p, &steps, 2, 6, 9, &mut planar);
        let mut pa = 6.5;
        assert_eq!(advance_region(&mut pa, &steps, 2, 6, FRAMES as u32), got);
        assert_eq!(got, 5);
        assert_eq!((p.to_bits(), pa.to_bits()), (pa.to_bits(), pa.to_bits()));
        for c in 0..9 {
            assert!(planar[c * N + got..(c + 1) * N].iter().all(|&v| v == 0.0), "region row {c} not zero-filled");
        }
    }

    /// `lagrange` and `lagrange_region` on a 4-, 9- and 16-channel clip give channel 0 (W) on both
    /// outputs, equal to `lagrange_n` with `channels` 1.
    #[test]
    fn the_stereo_entry_points_render_w_for_an_ambisonic_clip() {
        const N: usize = 30;
        let steps: Vec<f32> = (0..N).map(|i| 0.45 + (i % 4) as f32 * 0.3).collect();
        for &ch in &[4usize, 9, 16] {
            let data = noise(20 * ch, 50 + ch as u32);
            let clip = Source { samples: Samples::F32(&data), channels: ch as u32, frames: 20 };
            for &looping in &[false, true] {
                let (mut pa, mut pb) = (1.2, 1.2);
                let (mut l, mut r) = ([0.0f32; N], [0.0f32; N]);
                let mut w = [0.0f32; N];
                let n = lagrange(&clip, &mut pa, &steps, looping, &mut l, &mut r);
                assert_eq!(n, lagrange_n(&clip, &mut pb, &steps, looping, 1, &mut w));
                assert_eq!(pa.to_bits(), pb.to_bits());
                assert!(l[..n].iter().zip(&w[..n]).all(|(a, b)| a.to_bits() == b.to_bits()), "ch {ch} out_l is not W");
                assert!(r[..n].iter().zip(&w[..n]).all(|(a, b)| a.to_bits() == b.to_bits()), "ch {ch} out_r is not W");

                let (mut pa, mut pb) = (1.2, 1.2);
                let n = lagrange_region(&clip, &mut pa, &steps, 3, 15, &mut l, &mut r);
                assert_eq!(n, lagrange_region_n(&clip, &mut pb, &steps, 3, 15, 1, &mut w));
                assert_eq!(pa.to_bits(), pb.to_bits());
                assert!(l[..n].iter().zip(&w[..n]).all(|(a, b)| a.to_bits() == b.to_bits()), "ch {ch} region out_l is not W");
                assert!(r[..n].iter().zip(&w[..n]).all(|(a, b)| a.to_bits() == b.to_bits()), "ch {ch} region out_r is not W");
            }
        }
    }
}
