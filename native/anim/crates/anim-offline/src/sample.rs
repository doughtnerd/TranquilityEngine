//! Reference area `sample`: f64 clip sampling (bone and property tracks) from raw and compressed
//! clips, the reference for `anim-sample` and `anim-compress`'s error report.
//!
//! Written for clarity: every value is read straight from the file through `anim-format`'s views,
//! bits are read one at a time, and all arithmetic is f64. It follows the compressed-form contract
//! that `anim-compress` documents (its crate docs, "The bitstream"):
//!
//! - **Time to frames:** frame `i` sits at `min(i / rate, duration)` (`anim_format::frames`), so
//!   the last frame of a clip whose duration isn't a whole number of frames sits at the duration.
//!   `f0 = floor(t · rate)`, `f1 = f0 + 1`, `alpha` the fraction of the way from `f0`'s time to
//!   `f1`'s; frame 0 before 0, the last frame from its time on.
//! - **Segment ranges:** a segment's range in value space is
//!   `min = clip_min + (q_min / 255) · clip_extent`, `extent = (q_extent / 255) · clip_extent`.
//! - **Samples:** bit rate 0 is the segment minimum; 3..=23 bits is
//!   `seg_min + code / (2^bits − 1) · seg_extent`; 32 is the f32 stored raw.
//! - **Bitstream:** per segment, frame-major: for each frame, each animated channel (in animated
//!   order), each component, `bits` bits, least significant bit first.
//! - **Drop-w rotations:** `w = sqrt(max(0, 1 − (x² + y² + z²)))`.
//!
//! Track windows (crossed keys, activation levels, discrete payloads) are at the end of the file,
//! with their rules.
//!
//! Interpolation: linear for translation, scale and value channels; normalised lerp for rotations
//! (slerp when the clip sets `CLIP_SLERP`, or a `quat` track's subtype is slerp).

use crate::math::{Quat, Transform, Vec3};
use anim_format::clip::{
    ChannelKind, ChannelMode, ClipView, CompressedView, QuatInterp, RotationFormat, TrackKind,
    CLIP_SLERP,
};
use anim_format::skeleton::SkeletonView;

/// Where time `t` falls between two frames.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FramePos {
    /// The earlier frame.
    pub f0: u32,
    /// The later frame (= `f0` at the end).
    pub f1: u32,
    /// Blend weight of `f1`, in [0, 1).
    pub alpha: f64,
}

/// The two frames around `t` (seconds) at `rate` Hz over `frames` samples of a clip of
/// `duration` seconds (frame `i` at `min(i / rate, duration)`).
pub fn frame_pos(t: f64, rate: f64, frames: u32, duration: f64) -> FramePos {
    let last = frames.saturating_sub(1);
    let time = |i: u32| (i as f64 / rate).min(duration);
    let t = t.max(0.0);
    if t >= time(last) {
        return FramePos {
            f0: last,
            f1: last,
            alpha: 0.0,
        };
    }
    let f0 = ((t * rate).floor() as u32).min(last.saturating_sub(1));
    let f1 = f0 + 1;
    let (t0, t1) = (time(f0), time(f1));
    FramePos {
        f0,
        f1,
        alpha: if t1 > t0 { (t - t0) / (t1 - t0) } else { 1.0 },
    }
}

/// [`frame_pos`] for the clip `view`.
pub fn clip_frame_pos(view: &ClipView<'_>, t: f64) -> FramePos {
    frame_pos(
        t,
        view.sample_rate() as f64,
        view.frame_count(),
        view.duration() as f64,
    )
}

/// The skeleton's rest pose.
pub fn rest_pose(skel: &SkeletonView<'_>) -> Vec<Transform> {
    (0..skel.bone_count())
        .map(|i| {
            let b = skel.bone(i).expect("bone in range");
            transform_from(&[
                b.translation[0],
                b.translation[1],
                b.translation[2],
                b.rotation[0],
                b.rotation[1],
                b.rotation[2],
                b.rotation[3],
                b.scale[0],
                b.scale[1],
                b.scale[2],
            ])
        })
        .collect()
}

/// The skeleton's parent array.
pub fn parents(skel: &SkeletonView<'_>) -> Vec<u16> {
    (0..skel.bone_count())
        .map(|i| skel.bone(i).expect("bone in range").parent)
        .collect()
}

/// A transform from a raw bone frame (translation xyz, rotation xyzw, scale xyz); the rotation is
/// normalised.
pub fn transform_from(v: &[f32]) -> Transform {
    let f = |i: usize| v[i] as f64;
    Transform {
        translation: Vec3::new(f(0), f(1), f(2)),
        rotation: Quat::new(f(3), f(4), f(5), f(6)).normalize_or_identity(),
        scale: Vec3::new(f(7), f(8), f(9)),
    }
}

fn blend_transform(a: Transform, b: Transform, alpha: f64, slerp: bool) -> Transform {
    Transform {
        translation: a.translation.lerp(b.translation, alpha),
        rotation: blend_quat(a.rotation, b.rotation, alpha, slerp),
        scale: a.scale.lerp(b.scale, alpha),
    }
}

fn blend_quat(a: Quat, b: Quat, alpha: f64, slerp: bool) -> Quat {
    if slerp {
        a.slerp(b, alpha).normalize_or_identity()
    } else {
        a.nlerp(b, alpha)
    }
}

fn blend_values(a: &[f64], b: &[f64], alpha: f64, kind: TrackKind, subtype: u8) -> Vec<f64> {
    if kind == TrackKind::Quat {
        let qa = Quat::new(a[0], a[1], a[2], a[3]).normalize_or_identity();
        let qb = Quat::new(b[0], b[1], b[2], b[3]).normalize_or_identity();
        let slerp = QuatInterp::from_u8(subtype) == Some(QuatInterp::Slerp);
        let q = blend_quat(qa, qb, alpha, slerp);
        return vec![q.x, q.y, q.z, q.w];
    }
    a.iter().zip(b).map(|(x, y)| x + (y - x) * alpha).collect()
}

fn slerp_flag(view: &ClipView<'_>) -> bool {
    view.flags() & CLIP_SLERP != 0
}

// -------------------------------------------------------------------------------------------------
// Raw form
// -------------------------------------------------------------------------------------------------

/// Track `track`'s raw frame `frame` (width floats), if the raw form is present.
pub fn raw_frame(view: &ClipView<'_>, track: usize, frame: u32) -> Option<Vec<f32>> {
    let t = view.track(track)?;
    let raw = view.track_raw(track)?;
    let w = t.width as usize;
    let s = raw.slice(frame as usize * w, w)?;
    Some(s.to_vec())
}

/// The local pose at raw frame `frame`: the rest pose with every bone track's frame applied.
pub fn raw_pose_at_frame(view: &ClipView<'_>, rest: &[Transform], frame: u32) -> Vec<Transform> {
    let mut pose = rest.to_vec();
    for i in 0..view.track_count() {
        let Some(t) = view.track(i) else { continue };
        if t.kind != TrackKind::Bone {
            continue;
        }
        if let Some(v) = raw_frame(view, i, frame) {
            pose[t.binding.bone as usize] = transform_from(&v);
        }
    }
    pose
}

/// The local pose at time `t` from the raw form.
pub fn sample_raw_pose(view: &ClipView<'_>, rest: &[Transform], t: f64) -> Vec<Transform> {
    let p = clip_frame_pos(view, t);
    let a = raw_pose_at_frame(view, rest, p.f0);
    let b = raw_pose_at_frame(view, rest, p.f1);
    let slerp = slerp_flag(view);
    a.iter()
        .zip(&b)
        .map(|(x, y)| blend_transform(*x, *y, p.alpha, slerp))
        .collect()
}

/// A non-bone sampled track's value at time `t` from the raw form.
pub fn sample_raw_track(view: &ClipView<'_>, track: usize, t: f64) -> Option<Vec<f64>> {
    let info = view.track(track)?;
    let p = clip_frame_pos(view, t);
    let a: Vec<f64> = raw_frame(view, track, p.f0)?
        .iter()
        .map(|&x| x as f64)
        .collect();
    let b: Vec<f64> = raw_frame(view, track, p.f1)?
        .iter()
        .map(|&x| x as f64)
        .collect();
    Some(blend_values(&a, &b, p.alpha, info.kind, info.subtype))
}

// -------------------------------------------------------------------------------------------------
// Compressed form (reference decode)
// -------------------------------------------------------------------------------------------------

/// Reads `bits` bits at bit `pos` of `data`, least significant first, one bit at a time.
fn read_bits(data: &[u8], pos: u64, bits: u32) -> u32 {
    let mut v = 0u32;
    for i in 0..bits as u64 {
        let p = pos + i;
        let bit = (data[(p / 8) as usize] >> (p % 8)) & 1;
        v |= (bit as u32) << i;
    }
    v
}

/// Decodes compressed channel `channel` at frame `frame` into its components (rotation
/// channels: xyz or xyzw as stored, before drop-w reconstruction).
pub fn decode_channel(view: &ClipView<'_>, channel: usize, frame: u32) -> Option<Vec<f64>> {
    let c = view.compressed()?;
    let ch = c.channel(channel)?;
    let w = ch.width as usize;
    match ch.mode {
        ChannelMode::Default => None,
        ChannelMode::Constant => {
            let k = c.constants();
            Some(
                (0..w)
                    .map(|i| k.get(ch.data_offset as usize + i).unwrap() as f64)
                    .collect(),
            )
        }
        ChannelMode::Animated => Some(decode_animated(&c, &ch, frame)),
    }
}

fn decode_animated(
    c: &CompressedView<'_>,
    ch: &anim_format::clip::Channel,
    frame: u32,
) -> Vec<f64> {
    let sf = c.segment_frames();
    let s = (frame / sf) as usize;
    let seg = c.segment(s).unwrap();
    let in_seg = (frame - seg.start_frame) as u64;
    let rates = c.bit_rates(s).unwrap();
    let data = c.segment_data(s).unwrap();
    let ranges = c.clip_ranges();
    let seg_ranges = c.segment_ranges();
    // Bits per frame and this channel's offsets within the frame and the segment ranges.
    let mut frame_bits = 0u64;
    let mut before_bits = 0u64;
    let mut range_base = 0usize; // components of earlier animated channels in this segment
    let mut width_sum = 0usize;
    for i in 0..c.channel_count() {
        let o = c.channel(i).unwrap();
        if o.mode != ChannelMode::Animated {
            continue;
        }
        let b = rates[o.animated_index as usize] as u64 * o.width as u64;
        if o.animated_index < ch.animated_index {
            before_bits += b;
            range_base += o.width as usize;
        }
        frame_bits += b;
        width_sum += o.width as usize;
    }
    let bits = rates[ch.animated_index as usize] as u32;
    let w = ch.width as usize;
    let mut pos = in_seg * frame_bits + before_bits;
    (0..w)
        .map(|k| {
            let cmin = ranges.get(ch.data_offset as usize + k).unwrap() as f64;
            let cext = ranges.get(ch.data_offset as usize + w + k).unwrap() as f64;
            let r = (s * width_sum + range_base + k) * 2;
            let smin = cmin + seg_ranges[r] as f64 / 255.0 * cext;
            let sext = seg_ranges[r + 1] as f64 / 255.0 * cext;
            let v = match bits {
                0 => smin,
                32 => f32::from_bits(read_bits(data, pos, 32)) as f64,
                b => {
                    let code = read_bits(data, pos, b);
                    smin + code as f64 / ((1u64 << b) - 1) as f64 * sext
                }
            };
            pos += bits as u64;
            v
        })
        .collect()
}

/// A rotation from stored components (drop-w: w reconstructed), normalised.
pub fn rotation_from(v: &[f64], format: RotationFormat) -> Quat {
    let q = match format {
        RotationFormat::QuatDropW => {
            let w = (1.0 - (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]))
                .max(0.0)
                .sqrt();
            Quat::new(v[0], v[1], v[2], w)
        }
        RotationFormat::QuatFull => Quat::new(v[0], v[1], v[2], v[3]),
    };
    q.normalize_or_identity()
}

/// The local pose at compressed frame `frame`: the rest pose, with each bone track's channels
/// applied (default channels keep the rest value).
pub fn compressed_pose_at_frame(
    view: &ClipView<'_>,
    rest: &[Transform],
    frame: u32,
) -> Option<Vec<Transform>> {
    let c = view.compressed()?;
    let format = c.rotation_format();
    let mut pose = rest.to_vec();
    for i in 0..c.channel_count() {
        let ch = c.channel(i)?;
        let t = view.track(ch.track as usize)?;
        if t.kind != TrackKind::Bone {
            continue;
        }
        let Some(v) = decode_channel(view, i, frame) else {
            continue;
        };
        let bone = &mut pose[t.binding.bone as usize];
        match ch.kind {
            ChannelKind::Rotation => bone.rotation = rotation_from(&v, format),
            ChannelKind::Translation => bone.translation = Vec3::new(v[0], v[1], v[2]),
            ChannelKind::Scale => bone.scale = Vec3::new(v[0], v[1], v[2]),
            ChannelKind::Value => {}
        }
    }
    Some(pose)
}

/// The local pose at time `t` from the compressed form.
pub fn sample_compressed_pose(
    view: &ClipView<'_>,
    rest: &[Transform],
    t: f64,
) -> Option<Vec<Transform>> {
    let p = clip_frame_pos(view, t);
    let a = compressed_pose_at_frame(view, rest, p.f0)?;
    let b = compressed_pose_at_frame(view, rest, p.f1)?;
    let slerp = slerp_flag(view);
    Some(
        a.iter()
            .zip(&b)
            .map(|(x, y)| blend_transform(*x, *y, p.alpha, slerp))
            .collect(),
    )
}

/// A non-bone track's value at compressed frame `frame`; `None` for a default channel (the
/// field keeps its default) or a track without a value channel.
pub fn compressed_track_at_frame(
    view: &ClipView<'_>,
    track: usize,
    frame: u32,
) -> Option<Vec<f64>> {
    let c = view.compressed()?;
    let i = (0..c.channel_count()).find(|&i| {
        c.channel(i)
            .is_some_and(|ch| ch.track as usize == track && ch.kind == ChannelKind::Value)
    })?;
    decode_channel(view, i, frame)
}

/// A non-bone track's value at time `t` from the compressed form (`None` for a default channel).
pub fn sample_compressed_track(view: &ClipView<'_>, track: usize, t: f64) -> Option<Vec<f64>> {
    let info = view.track(track)?;
    let p = clip_frame_pos(view, t);
    let a = compressed_track_at_frame(view, track, p.f0)?;
    let b = compressed_track_at_frame(view, track, p.f1)?;
    Some(blend_values(&a, &b, p.alpha, info.kind, info.subtype))
}

/// The virtual-vertex distance between two model-space transforms: the largest distance between
/// the images of `(d, 0, 0)`, `(0, d, 0)` and `(0, 0, d)` (ACL's error metric).
pub fn vertex_error(a: Transform, b: Transform, shell: f64) -> f64 {
    [
        Vec3::new(shell, 0.0, 0.0),
        Vec3::new(0.0, shell, 0.0),
        Vec3::new(0.0, 0.0, shell),
    ]
    .iter()
    .map(|&p| (a.transform_point(p) - b.transform_point(p)).length())
    .fold(0.0, f64::max)
}

// -------------------------------------------------------------------------------------------------
// Track windows (the reference for `anim-sample`'s window sampling)
// -------------------------------------------------------------------------------------------------
//
// The rules, spelled out and applied by brute force in f64:
//
// - A looping window starts at `from` wrapped into `[0, d)` and ends at `a + delta`, unwrapped,
//   with `|delta| ≤ 4·d`; a non-looping one clamps both ends to `[0, d]`. No duration: no loop.
// - Forward, an instant at `u` (a key time plus any multiple of `d` when looping) is crossed
//   when `a < u ≤ b`; in reverse when `b ≤ u < a`. `start` makes `a` inclusive.
// - Crossed keys come in travel order: by `u`, ties by loop cycle (the end of one cycle before the
//   start of the next), then (track, key); all reversed in reverse.
// - Notifies fire when `always` or `weight > threshold`; audio and control keys when
//   `weight > 0`; markers always. A seek crosses nothing.
// - Ranges cover `[time, end)`; activation ranges ending at `d` also cover `d` in a
//   non-looping play.

/// A playhead move, as `anim-sample`'s `Window`.
#[derive(Clone, Copy, Debug)]
pub struct WindowRef {
    pub from: f64,
    pub delta: f64,
    pub looping: bool,
    /// The first window of a play: the start point is included.
    pub start: bool,
    /// A jump: nothing is crossed.
    pub seek: bool,
}

/// One crossed instant key.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Crossed {
    pub track: usize,
    /// The key's index in the `KEYS` section.
    pub key: usize,
    /// The key's time.
    pub time: f64,
}

/// The window's resolved start and end (unwrapped when looping) and whether it loops.
pub fn window_span(w: &WindowRef, duration: f64) -> (f64, f64, bool) {
    let d = duration.max(0.0);
    let looping = w.looping && d > 0.0;
    if looping {
        let a = w.from.rem_euclid(d);
        let a = if a >= d { 0.0 } else { a };
        (a, a + w.delta.clamp(-4.0 * d, 4.0 * d), true)
    } else {
        (
            w.from.clamp(0.0, d),
            (w.from + w.delta).clamp(0.0, d),
            false,
        )
    }
}

/// Every instant key (notify, marker, audio, control) the window crosses and that passes the
/// weight gate, in travel order.
pub fn crossed_keys(view: &ClipView<'_>, w: &WindowRef, weight: f64) -> Vec<Crossed> {
    use anim_format::clip::KeyData;
    if w.seek {
        return Vec::new();
    }
    let d = view.duration() as f64;
    let (a, b, looping) = window_span(w, d);
    let forward = b >= a;
    let cycles: Vec<i64> = if looping {
        (-12..=12).collect()
    } else {
        vec![0]
    };
    let mut hits: Vec<(f64, i64, usize, usize, f64)> = Vec::new();
    for track in 0..view.track_count() {
        let info = view.track(track).expect("track");
        for (j, key) in view.track_keys(track).enumerate() {
            let fires = match key.data {
                KeyData::Event {
                    threshold, always, ..
                } => key.end == key.time && (always || weight > threshold as f64),
                KeyData::Marker { .. } => true,
                KeyData::Audio { .. } | KeyData::Control { .. } => weight > 0.0,
                _ => false,
            };
            if !fires {
                continue;
            }
            for &k in &cycles {
                let u = key.time as f64 + k as f64 * d;
                let crossed = if forward {
                    (a < u || (w.start && a == u)) && u <= b
                } else {
                    b <= u && (u < a || (w.start && u == a))
                };
                if crossed {
                    hits.push((u, k, track, info.first_key as usize + j, key.time as f64));
                }
            }
        }
    }
    hits.sort_by(|x, y| {
        x.0.total_cmp(&y.0)
            .then(x.1.cmp(&y.1))
            .then(x.2.cmp(&y.2))
            .then(x.3.cmp(&y.3))
    });
    if !forward {
        hits.reverse();
    }
    hits.into_iter()
        .map(|(_, _, track, key, time)| Crossed { track, key, time })
        .collect()
}

/// Whether `activation` track `track` is active at `t`: some range has `time ≤ t < end`, or
/// (`hold`, a non-looping play) `t = end = duration`.
pub fn active_at(view: &ClipView<'_>, track: usize, t: f64, hold: bool) -> bool {
    let d = view.duration() as f64;
    view.track_keys(track).any(|k| {
        let (s, e) = (k.time as f64, k.end as f64);
        (s <= t && t < e) || (hold && t == e && e == d)
    })
}

/// `discrete` track `track`'s payload at `t`: the last key with `time ≤ t`, else the first key.
pub fn discrete_at(view: &ClipView<'_>, track: usize, t: f64) -> Option<u32> {
    use anim_format::clip::KeyData;
    let mut value = None;
    for (i, k) in view.track_keys(track).enumerate() {
        if let KeyData::Discrete { value: v } = k.data {
            if i == 0 || k.time as f64 <= t {
                value = Some(v);
            }
        }
    }
    value
}
