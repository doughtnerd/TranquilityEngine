//! Channel extraction: resampling, splitting bone tracks, rotation signs, default and constant
//! detection, clip ranges, and the per-segment quantisation of one channel.

use anim_format::clip::{ChannelKind, ChannelMode, Clip, RotationFormat, TrackKind, CLIP_ADDITIVE};
use anim_format::frames::{frame_count, frame_time};
use anim_offline::math::{Quat, Transform, Vec3};
use anim_offline::sample::{frame_pos, rotation_from, vertex_error};

/// One channel to compress, with its reference samples.
#[derive(Clone, Debug)]
pub(crate) struct Chan {
    pub track: u32,
    pub kind: ChannelKind,
    /// Stored components.
    pub width: usize,
    /// Bone channels: the bone.
    pub bone: Option<usize>,
    /// Reference samples as stored (rotations normalised, sign-fixed): `frames * width`.
    pub values: Vec<f64>,
    pub mode: ChannelMode,
    /// Constant channels: the stored value (f32).
    pub constant: Vec<f32>,
    /// Animated channels: clip minimums and extents (f32).
    pub clip_min: Vec<f32>,
    pub clip_ext: Vec<f32>,
    /// Property channels: the absolute bound.
    pub bound: f64,
    /// How far a default or constant channel strays from its stored value (bone channels: at the
    /// shell distance), so the worst can be made animated when the bound isn't met.
    pub deviation: f64,
}

/// The clip's sampled tracks resampled to `rate` (or as they are): per track, `frames * width`.
pub(crate) fn resample(clip: &Clip, rate: f32) -> (u32, Vec<Vec<f32>>) {
    if rate == clip.sample_rate {
        let raws = clip.tracks.iter().map(|t| t.raw.clone()).collect();
        return (clip.frame_count, raws);
    }
    let src_rate = clip.sample_rate as f64;
    let duration = clip.duration as f64;
    let frames = frame_count(duration, rate as f64);
    let raws = clip
        .tracks
        .iter()
        .map(|t| {
            if !t.kind.is_sampled() {
                return Vec::new();
            }
            let w = t.kind.width() as usize;
            let mut out = Vec::with_capacity(frames as usize * w);
            for f in 0..frames {
                let time = frame_time(f, rate as f64, duration);
                let p = frame_pos(time, src_rate, clip.frame_count, duration);
                let a = &t.raw[p.f0 as usize * w..][..w];
                let b = &t.raw[p.f1 as usize * w..][..w];
                let lerp = |i: usize| a[i] as f64 + (b[i] as f64 - a[i] as f64) * p.alpha;
                let quat_at = |o: usize| {
                    let qa = Quat::new(
                        a[o] as f64,
                        a[o + 1] as f64,
                        a[o + 2] as f64,
                        a[o + 3] as f64,
                    );
                    let qb = Quat::new(
                        b[o] as f64,
                        b[o + 1] as f64,
                        b[o + 2] as f64,
                        b[o + 3] as f64,
                    );
                    qa.normalize_or_identity()
                        .nlerp(qb.normalize_or_identity(), p.alpha)
                };
                let mut v: Vec<f64> = (0..w).map(lerp).collect();
                let q_off = match t.kind {
                    TrackKind::Bone => Some(3),
                    TrackKind::Quat => Some(0),
                    _ => None,
                };
                if let Some(o) = q_off {
                    let q = quat_at(o);
                    v[o..o + 4].copy_from_slice(&[q.x, q.y, q.z, q.w]);
                }
                out.extend(v.iter().map(|&x| x as f32));
            }
            out
        })
        .collect();
    (frames, raws)
}

fn quat_at(v: &[f32], o: usize) -> Quat {
    Quat::new(
        v[o] as f64,
        v[o + 1] as f64,
        v[o + 2] as f64,
        v[o + 3] as f64,
    )
    .normalize_or_identity()
}

/// Rotation samples as stored: drop-w on `w ≥ 0`, full with sign continuity (first `w ≥ 0`).
fn rotation_values(qs: &[Quat], format: RotationFormat) -> Vec<f64> {
    let mut out = Vec::new();
    let mut prev: Option<Quat> = None;
    for &q in qs {
        let q = match format {
            RotationFormat::QuatDropW => {
                if q.w < 0.0 {
                    -q
                } else {
                    q
                }
            }
            RotationFormat::QuatFull => match prev {
                Some(p) if p.dot(q) < 0.0 => -q,
                None if q.w < 0.0 => -q,
                _ => q,
            },
        };
        prev = Some(q);
        out.extend_from_slice(&[q.x, q.y, q.z]);
        if format == RotationFormat::QuatFull {
            out.push(q.w);
        }
    }
    out
}

/// A constant candidate: the per-component mid-range.
fn mid_range(values: &[f64], width: usize) -> Vec<f64> {
    (0..width)
        .map(|k| {
            let (lo, hi) = values
                .iter()
                .skip(k)
                .step_by(width)
                .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), &v| {
                    (lo.min(v), hi.max(v))
                });
            lo + (hi - lo) * 0.5
        })
        .collect()
}

/// A bone channel's value as the decoder sees it (rotations rebuilt and normalised).
pub(crate) fn apply_bone_value(
    t: &mut Transform,
    kind: ChannelKind,
    v: &[f64],
    format: RotationFormat,
) {
    match kind {
        ChannelKind::Rotation => t.rotation = rotation_from(v, format),
        ChannelKind::Translation => t.translation = Vec3::new(v[0], v[1], v[2]),
        ChannelKind::Scale => t.scale = Vec3::new(v[0], v[1], v[2]),
        ChannelKind::Value => {}
    }
}

/// The error a bone channel's value `lossy` makes against `reference` on its own, in the parent's
/// space, at shell distance `shell`.
pub(crate) fn local_error(
    kind: ChannelKind,
    reference: &[f64],
    lossy: &[f64],
    format: RotationFormat,
    shell: f64,
) -> f64 {
    let mut a = Transform::IDENTITY;
    let mut b = Transform::IDENTITY;
    apply_bone_value(&mut a, kind, reference, format);
    apply_bone_value(&mut b, kind, lossy, format);
    vertex_error(a, b, shell)
}

/// Builds every channel of `clip` (with `raws` at `frames`) for `format`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build(
    clip: &Clip,
    raws: &[Vec<f32>],
    frames: u32,
    rest: &[Transform],
    shells: &[f64],
    format: RotationFormat,
    bone_bound: f64,
    property_bound: impl Fn(u32) -> f64,
    property_default: impl Fn(u32) -> Option<Vec<f32>>,
) -> Vec<Chan> {
    let additive = clip.flags & CLIP_ADDITIVE != 0;
    let threshold = bone_bound * 0.1;
    let mut out = Vec::new();
    for (ti, t) in clip.tracks.iter().enumerate() {
        if !t.kind.is_sampled() {
            continue;
        }
        let raw = &raws[ti];
        let w = t.kind.width() as usize;
        let track = ti as u32;
        if t.kind == TrackKind::Bone {
            let bone = t.binding.bone as usize;
            let shell = shells[bone];
            let frame = |f: usize| &raw[f * w..(f + 1) * w];
            let qs: Vec<Quat> = (0..frames as usize).map(|f| quat_at(frame(f), 3)).collect();
            let rot = rotation_values(&qs, format);
            let tr: Vec<f64> = (0..frames as usize)
                .flat_map(|f| frame(f)[0..3].iter().map(|&x| x as f64).collect::<Vec<_>>())
                .collect();
            let sc: Vec<f64> = (0..frames as usize)
                .flat_map(|f| {
                    frame(f)[7..10]
                        .iter()
                        .map(|&x| x as f64)
                        .collect::<Vec<_>>()
                })
                .collect();
            let r = rest[bone];
            let rest_rot = rotation_values(&[r.rotation], format);
            let rest_tr = vec![r.translation.x, r.translation.y, r.translation.z];
            let rest_sc = vec![r.scale.x, r.scale.y, r.scale.z];
            for (kind, values, rest_v) in [
                (ChannelKind::Rotation, rot, rest_rot),
                (ChannelKind::Translation, tr, rest_tr),
                (ChannelKind::Scale, sc, rest_sc),
            ] {
                let cw = if kind == ChannelKind::Rotation {
                    if format == RotationFormat::QuatDropW {
                        3
                    } else {
                        4
                    }
                } else {
                    3
                };
                let dev = |stored: &[f64]| {
                    values
                        .chunks(cw)
                        .map(|v| local_error(kind, v, stored, format, shell))
                        .fold(0.0, f64::max)
                };
                let mut c = Chan::new(track, kind, cw, Some(bone), values.clone());
                let default_dev = if additive {
                    f64::INFINITY
                } else {
                    dev(&rest_v)
                };
                let mid: Vec<f32> = mid_range(&values, cw).iter().map(|&x| x as f32).collect();
                let mid64: Vec<f64> = mid.iter().map(|&x| x as f64).collect();
                let const_dev = dev(&mid64);
                if default_dev <= threshold {
                    c.mode = ChannelMode::Default;
                    c.deviation = default_dev;
                } else if const_dev <= threshold {
                    c.mode = ChannelMode::Constant;
                    c.constant = mid;
                    c.deviation = const_dev;
                }
                out.push(c);
            }
        } else {
            let mut values: Vec<f64> = raw.iter().map(|&x| x as f64).collect();
            if t.kind == TrackKind::Quat {
                let qs: Vec<Quat> = (0..frames as usize).map(|f| quat_at(raw, f * 4)).collect();
                values = rotation_values(&qs, RotationFormat::QuatFull);
            }
            let bound = property_bound(track);
            let mut c = Chan::new(track, ChannelKind::Value, w, None, values.clone());
            c.bound = bound;
            let dev = |stored: &[f64]| {
                values
                    .chunks(w)
                    .flat_map(|v| v.iter().zip(stored).map(|(a, b)| (a - b).abs()))
                    .fold(0.0, f64::max)
            };
            let default_dev = property_default(track)
                .filter(|d| d.len() == w)
                .map(|d| dev(&d.iter().map(|&x| x as f64).collect::<Vec<_>>()))
                .unwrap_or(f64::INFINITY);
            let mid: Vec<f32> = mid_range(&values, w).iter().map(|&x| x as f32).collect();
            let const_dev = dev(&mid.iter().map(|&x| x as f64).collect::<Vec<_>>());
            if default_dev <= bound {
                c.mode = ChannelMode::Default;
                c.deviation = default_dev;
            } else if const_dev <= bound {
                c.mode = ChannelMode::Constant;
                c.constant = mid;
                c.deviation = const_dev;
            }
            out.push(c);
        }
    }
    for c in &mut out {
        if c.mode == ChannelMode::Animated {
            c.set_clip_range();
        }
    }
    out
}

impl Chan {
    fn new(
        track: u32,
        kind: ChannelKind,
        width: usize,
        bone: Option<usize>,
        values: Vec<f64>,
    ) -> Self {
        Chan {
            track,
            kind,
            width,
            bone,
            values,
            mode: ChannelMode::Animated,
            constant: Vec::new(),
            clip_min: Vec::new(),
            clip_ext: Vec::new(),
            bound: 0.0,
            deviation: 0.0,
        }
    }

    /// Makes the channel animated (after a default or constant one broke the bound).
    pub(crate) fn make_animated(&mut self) {
        self.mode = ChannelMode::Animated;
        self.constant.clear();
        self.set_clip_range();
    }

    /// The f32 clip range covering every sample.
    fn set_clip_range(&mut self) {
        let w = self.width;
        self.clip_min.clear();
        self.clip_ext.clear();
        for k in 0..w {
            let (lo, hi) = self
                .values
                .iter()
                .skip(k)
                .step_by(w)
                .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), &v| {
                    (lo.min(v), hi.max(v))
                });
            // Round the minimum down and the extent up so the f32 range covers [lo, hi].
            let mut min = lo as f32;
            if min as f64 > lo {
                min = min.next_down();
            }
            let mut ext = (hi - min as f64) as f32;
            while (min as f64 + ext as f64) < hi {
                ext = ext.next_up();
            }
            self.clip_min.push(min);
            self.clip_ext.push(ext.max(0.0));
        }
    }

    /// Frame `f`'s reference value.
    pub(crate) fn value(&self, f: usize) -> &[f64] {
        &self.values[f * self.width..(f + 1) * self.width]
    }
}

/// One channel quantised over one segment at one rate.
#[derive(Clone, Debug)]
pub(crate) struct Quantized {
    /// `(min, extent)` bytes per component.
    pub ranges: Vec<[u8; 2]>,
    /// Codes, frame-major (`frames * width`).
    pub codes: Vec<u32>,
    /// The decoded values (f64, as `anim-offline` decodes them), frame-major.
    pub decoded: Vec<f64>,
}

/// Quantises `c`'s frames `[start, start + count)` at `bits`.
pub(crate) fn quantize(c: &Chan, start: usize, count: usize, bits: u8) -> Quantized {
    let w = c.width;
    let mut ranges = Vec::with_capacity(w);
    let mut seg_min = Vec::with_capacity(w);
    let mut seg_ext = Vec::with_capacity(w);
    for k in 0..w {
        let cmin = c.clip_min[k] as f64;
        let cext = c.clip_ext[k] as f64;
        let (lo, hi) = (start..start + count)
            .map(|f| c.value(f)[k])
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| {
                (lo.min(v), hi.max(v))
            });
        let norm = |v: f64| {
            if cext > 0.0 {
                ((v - cmin) / cext).clamp(0.0, 1.0)
            } else {
                0.0
            }
        };
        let (q_min, q_ext) = if bits == 0 {
            let mid = norm(lo + (hi - lo) * 0.5);
            ((mid * 255.0 + 0.5).floor().min(255.0) as u8, 0u8)
        } else {
            let q_lo = (norm(lo) * 255.0).floor().clamp(0.0, 255.0) as u32;
            let q_hi = (norm(hi) * 255.0).ceil().clamp(0.0, 255.0) as u32;
            (q_lo as u8, (q_hi - q_lo) as u8)
        };
        ranges.push([q_min, q_ext]);
        seg_min.push(cmin + q_min as f64 / 255.0 * cext);
        seg_ext.push(q_ext as f64 / 255.0 * cext);
    }
    let mut codes = Vec::with_capacity(count * w);
    let mut decoded = Vec::with_capacity(count * w);
    for f in start..start + count {
        for k in 0..w {
            let v = c.value(f)[k];
            let (code, d) = match bits {
                0 => (0, seg_min[k]),
                32 => {
                    let x = v as f32;
                    (x.to_bits(), x as f64)
                }
                b => {
                    let max = ((1u64 << b) - 1) as f64;
                    let code = if seg_ext[k] > 0.0 {
                        let n = ((v - seg_min[k]) / seg_ext[k]).clamp(0.0, 1.0);
                        (n * max + 0.5).floor() as u32
                    } else {
                        0
                    };
                    (code, seg_min[k] + code as f64 / max * seg_ext[k])
                }
            };
            codes.push(code);
            decoded.push(d);
        }
    }
    Quantized {
        ranges,
        codes,
        decoded,
    }
}
