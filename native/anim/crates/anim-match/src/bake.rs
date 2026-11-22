//! The database bake (offline: allocates; deterministic: the same inputs give the same bytes).
//!
//! # Frames
//!
//! Each clip is sampled on the grid `t = i / sample_rate` (f32): `t ≤ duration` for a one-shot
//! clip, `t < duration` for a looping one (its last frame repeats the first). A grid frame is
//! baked when it lies in one of the clip's tagged ranges (`start ≤ t ≤ end`; a clip with no
//! ranges is baked whole, untagged); its tags are the union of the ranges holding it. Frames go
//! into the database clip by clip, in time order, so a clip's frames form runs that the runtime
//! follows while it plays ([`crate::db::MatchDb`]).
//!
//! **Clip ends.** In a one-shot clip, a frame whose furthest *future* trajectory sample runs
//! past the clip's end (`t + offset > duration + 1e-4`) is **excluded**: its future is unknown,
//! and the search should never pick a pose with nothing to play after it. A *past* sample before
//! the start is clamped to the first frame. A looping clip wraps both ways: time past the end
//! continues from the start, carried by the clip's per-loop root displacement
//! (`C(duration) ∘ C(0)⁻¹`, the character frame at the end composed with the inverse of the one
//! at the start), so trajectories and velocities run smoothly over the seam.
//!
//! # Features
//!
//! Measured in character space (`crate::character`) at time `t`, the character frame `C(t)` being
//! the ground projection of the root-motion bone (`BakeSettings::root_bone`, else the clip's
//! root bone, else bone 0):
//!
//! - bone position: `C(t)⁻¹ · P(t)` (`P` the bone's model-space position, unwrapped over loops);
//! - bone velocity: `C(t)⁻¹ · (P(t) − P(t − h)) / h` with `h = 1 / sample_rate` (backward
//!   difference, as the runtime measures it over two frames); a one-shot clip's first frame uses
//!   the forward difference `(P(h) − P(0)) / h`;
//! - trajectory position: `(x, z)` of `C(t)⁻¹ · C(t + offset)`'s origin;
//! - trajectory direction: `(x, z)` of its forward.
//!
//! Poses come from `anim-sample` (the runtime's own sampling) and `anim-math`, in f32.
//!
//! # Normalisation
//!
//! Means and standard deviations are accumulated in f64 over every baked frame (population
//! deviation), then rounded to f32; each deviation is floored at `std_floor`. With
//! [`Normalization::PerFeature`] every dim of a feature shares the mean of its dims' deviations
//! (Holden's choice: it keeps a feature's geometry) before the floor. The matrix stores
//! `(value − mean) / std` computed in f32, exactly as the runtime normalises a query, so a query
//! equal to a frame's features costs 0 against it. Weights are stored in the schema, not in the
//! matrix (`myco.posedb@1`'s contract); the runtime folds `√weight` into its copy of the rows.

use crate::character::CharacterFrame;
use crate::kdtree;
use crate::schema::FeatureSpec;
use crate::MAX_TAGS;
use anim_format::clip::{ClipView, CLIP_LOOP};
use anim_format::posedb::{words_per_frame, Feature, FeatureKind, FrameRef, PoseDb};
use anim_format::skeleton::SkeletonView;
use anim_format::{FormatError, StringInterner, NONE};
use anim_math::layout::{local_to_model, soa_len, NO_PARENT};
use anim_math::{AosTransform, AosVec3, SoaTransform};
use anim_sample::{ClipSampler, Form, SampleError};

/// A time range of a clip and its tags.
#[derive(Clone, Copy, Debug)]
pub struct TaggedRange<'a> {
    /// Seconds (inclusive).
    pub start: f32,
    /// Seconds (inclusive).
    pub end: f32,
    /// Tag names.
    pub tags: &'a [&'a str],
}

/// One clip to bake.
#[derive(Clone, Copy)]
pub struct BakeClip<'a> {
    /// The parsed clip.
    pub view: ClipView<'a>,
    /// Which stored form to sample.
    pub form: Form,
    /// The clip's asset reference, stored in the database's clip list.
    pub asset: &'a str,
    /// Tagged ranges; empty bakes the whole clip, untagged.
    pub ranges: &'a [TaggedRange<'a>],
}

/// How standard deviations are shared between a feature's dims.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Normalization {
    /// Each dim has its own deviation.
    #[default]
    PerDimension,
    /// Every dim of a feature uses the mean of its dims' deviations.
    PerFeature,
}

/// Bake options.
#[derive(Clone, Copy, Debug)]
pub struct BakeSettings<'a> {
    /// Frames per second of the database (finite, > 0). Default 30.
    pub sample_rate: f32,
    /// The smallest standard deviation (finite, > 0). Default 0.01.
    pub std_floor: f32,
    /// Default [`Normalization::PerDimension`].
    pub normalization: Normalization,
    /// Bake a KD-tree. Default true.
    pub kd_tree: bool,
    /// KD-tree leaf size. Default 16.
    pub leaf_size: usize,
    /// The root-motion bone the character frame follows; `None` uses each clip's root bone, or
    /// bone 0 when it has none.
    pub root_bone: Option<u32>,
    /// The skeleton's asset reference, stored in the database.
    pub skeleton: Option<&'a str>,
}

impl Default for BakeSettings<'_> {
    fn default() -> Self {
        Self {
            sample_rate: 30.0,
            std_floor: 0.01,
            normalization: Normalization::PerDimension,
            kd_tree: true,
            leaf_size: 16,
            root_bone: None,
            skeleton: None,
        }
    }
}

/// Why a bake was refused.
#[derive(Clone, Debug, PartialEq)]
pub enum BakeError {
    /// Bad settings (the field named).
    Settings(&'static str),
    /// The schema is empty, has a custom feature, a bad weight or offset, or a bone out of range
    /// (the feature's index).
    Feature(usize),
    /// A clip's bone count isn't the skeleton's, or it can't be sampled in the requested form.
    Clip {
        clip: usize,
        error: Option<SampleError>,
    },
    /// A range is reversed or not finite (clip, range).
    Range { clip: usize, range: usize },
    /// More than [`MAX_TAGS`] distinct tags.
    TooManyTags,
    /// No frame survived.
    NoFrames,
    /// A feature value isn't finite (a degenerate clip).
    NotFinite,
    /// The writer refused the database.
    Format(FormatError),
}

/// A baked database.
#[derive(Clone, Debug)]
pub struct Baked {
    /// The owned model.
    pub db: PoseDb,
    /// The `myco.posedb@1` file.
    pub bytes: Vec<u8>,
    /// Grid frames inside a tagged range left out because their future ran past a one-shot clip's
    /// end.
    pub excluded: usize,
}

/// Bakes `clips` (all made for `skel`) with `schema`.
pub fn bake(
    skel: &SkeletonView<'_>,
    clips: &[BakeClip<'_>],
    schema: &[FeatureSpec],
    settings: &BakeSettings<'_>,
) -> Result<Baked, BakeError> {
    let rate = settings.sample_rate;
    if !(rate.is_finite() && rate > 0.0) {
        return Err(BakeError::Settings("sample_rate"));
    }
    if !(settings.std_floor.is_finite() && settings.std_floor > 0.0) {
        return Err(BakeError::Settings("std_floor"));
    }
    let bones = skel.bone_count();
    if schema.is_empty() {
        return Err(BakeError::Feature(0));
    }
    let mut features = Vec::with_capacity(schema.len());
    let mut dims = 0u32;
    let mut max_future = 0.0f32;
    for (i, f) in schema.iter().enumerate() {
        let d = f.kind.dims().ok_or(BakeError::Feature(i))?;
        let bad_bone = f.kind.has_bone() && f.bone as usize >= bones;
        if bad_bone || !(f.weight.is_finite() && f.weight >= 0.0) || !f.time_offset.is_finite() {
            return Err(BakeError::Feature(i));
        }
        let traj = !f.kind.has_bone();
        if traj {
            max_future = max_future.max(f.time_offset);
        }
        features.push(Feature {
            kind: f.kind,
            dims: d,
            bone: if f.kind.has_bone() { f.bone } else { NONE },
            first_dim: dims,
            weight: f.weight,
            time_offset: if traj { f.time_offset } else { 0.0 },
            name: NONE,
        });
        dims += d as u32;
    }
    let dims_us = dims as usize;

    let mut strings = StringInterner::new();
    let skeleton = settings.skeleton.map_or(NONE, |s| strings.intern(s));
    let mut tag_names: Vec<&str> = Vec::new();
    let mut raw: Vec<f32> = Vec::new();
    let mut frames: Vec<FrameRef> = Vec::new();
    let mut frame_tags: Vec<u128> = Vec::new();
    let mut clip_ids = Vec::with_capacity(clips.len());
    let mut excluded = 0usize;
    let mut row = vec![0.0f32; dims_us];

    for (ci, clip) in clips.iter().enumerate() {
        clip_ids.push(strings.intern(clip.asset));
        for (ri, r) in clip.ranges.iter().enumerate() {
            if !(r.start.is_finite() && r.end.is_finite() && r.start <= r.end) {
                return Err(BakeError::Range {
                    clip: ci,
                    range: ri,
                });
            }
            for t in r.tags {
                if !tag_names.contains(t) {
                    if tag_names.len() == MAX_TAGS {
                        return Err(BakeError::TooManyTags);
                    }
                    tag_names.push(t);
                }
            }
        }
        let mut eval = ClipEval::new(skel, clip, settings.root_bone)
            .map_err(|e| BakeError::Clip { clip: ci, error: e })?;
        let duration = eval.duration;
        let h = 1.0 / rate;
        let mut i = 0u32;
        loop {
            let t = i as f32 / rate;
            let in_clip = if eval.looping && duration > 0.0 {
                t < duration
            } else {
                t <= duration
            };
            if !in_clip {
                break;
            }
            i += 1;
            let mut tags = 0u128;
            let mut inside = clip.ranges.is_empty();
            for r in clip.ranges {
                if r.start <= t && t <= r.end {
                    inside = true;
                    for name in r.tags {
                        let k = tag_names.iter().position(|n| n == name).unwrap_or(0);
                        tags |= 1u128 << k;
                    }
                }
            }
            if !inside {
                continue;
            }
            if !eval.looping && t + max_future > duration + 1e-4 {
                excluded += 1;
                continue;
            }
            eval.features(&features, t, h, &mut row);
            if row.iter().any(|v| !v.is_finite()) {
                return Err(BakeError::NotFinite);
            }
            raw.extend_from_slice(&row);
            frames.push(FrameRef {
                clip: ci as u32,
                time: t,
            });
            frame_tags.push(tags);
        }
    }
    let n = frames.len();
    if n == 0 {
        return Err(BakeError::NoFrames);
    }

    // Statistics in f64, frame order.
    let mut mean64 = vec![0.0f64; dims_us];
    for r in raw.chunks_exact(dims_us) {
        for (m, &v) in mean64.iter_mut().zip(r) {
            *m += v as f64;
        }
    }
    for m in &mut mean64 {
        *m /= n as f64;
    }
    let mut var64 = vec![0.0f64; dims_us];
    for r in raw.chunks_exact(dims_us) {
        for ((s, &v), m) in var64.iter_mut().zip(r).zip(&mean64) {
            let d = v as f64 - m;
            *s += d * d;
        }
    }
    let mut std64: Vec<f64> = var64.iter().map(|s| (s / n as f64).sqrt()).collect();
    if settings.normalization == Normalization::PerFeature {
        for f in &features {
            let r = f.first_dim as usize..(f.first_dim as usize + f.dims as usize);
            let avg = std64[r.clone()].iter().sum::<f64>() / f.dims as f64;
            std64[r].fill(avg);
        }
    }
    let mean: Vec<f32> = mean64.iter().map(|&m| m as f32).collect();
    let std: Vec<f32> = std64
        .iter()
        .map(|&s| (s as f32).max(settings.std_floor))
        .collect();
    let mut matrix = raw;
    for r in matrix.chunks_exact_mut(dims_us) {
        for ((v, m), s) in r.iter_mut().zip(&mean).zip(&std) {
            *v = (*v - m) / s;
        }
    }

    let kd_tree = settings.kd_tree.then(|| {
        let mut scale = vec![0.0f32; dims_us];
        for f in &features {
            let w = f.weight.sqrt();
            scale[f.first_dim as usize..][..f.dims as usize].fill(w);
        }
        kdtree::build(&matrix, dims_us, &scale, settings.leaf_size)
    });

    let tag_ids: Vec<u32> = tag_names.iter().map(|t| strings.intern(t)).collect();
    let wpf = words_per_frame(tag_ids.len());
    let mut tags = Vec::with_capacity(n * wpf);
    for t in &frame_tags {
        for w in 0..wpf {
            tags.push((t >> (32 * w)) as u32);
        }
    }
    let db = PoseDb {
        sample_rate: rate,
        skeleton,
        strings: strings.into_strings(),
        dims,
        features,
        mean,
        std,
        matrix,
        frames,
        clips: clip_ids,
        tag_names: tag_ids,
        tags,
        kd_tree,
    };
    let bytes = db.write().map_err(BakeError::Format)?;
    Ok(Baked {
        db,
        bytes,
        excluded,
    })
}

/// One clip's sampling state.
struct ClipEval<'a> {
    sampler: ClipSampler<'a>,
    parents: Vec<u16>,
    rest: Vec<AosTransform>,
    scratch: Vec<AosTransform>,
    soa: Vec<SoaTransform>,
    model: Vec<AosTransform>,
    /// Unwrapped model positions at the frame's time and at the velocity's other end.
    now: Vec<AosVec3>,
    other: Vec<AosVec3>,
    root: usize,
    rest_root: anim_math::AosQuat,
    duration: f32,
    looping: bool,
    /// The per-loop displacement `C(duration) ∘ C(0)⁻¹`, and its inverse.
    lap: CharacterFrame,
    lap_inv: CharacterFrame,
}

impl<'a> ClipEval<'a> {
    fn new(
        skel: &SkeletonView<'_>,
        clip: &BakeClip<'a>,
        root_bone: Option<u32>,
    ) -> Result<Self, Option<SampleError>> {
        let n = skel.bone_count();
        if clip.view.bone_count() as usize != n || n == 0 {
            return Err(None);
        }
        let sampler = ClipSampler::new(clip.view, clip.form).map_err(Some)?;
        let mut rest = vec![AosTransform::identity(); n];
        anim_sample::rest_pose(skel, &mut rest);
        let parents: Vec<u16> = (0..n)
            .map(|i| skel.parent(i).map_or(NO_PARENT, |p| p as u16))
            .collect();
        let clip_root = clip.view.root_bone();
        let root = root_bone
            .or((clip_root != NONE).then_some(clip_root))
            .unwrap_or(0) as usize;
        if root >= n {
            return Err(None);
        }
        // The root's rest model-space rotation.
        let mut chain = rest[root];
        let mut p = parents[root];
        while p != NO_PARENT {
            chain = rest[p as usize].compose(chain);
            p = parents[p as usize];
        }
        let mut e = ClipEval {
            sampler,
            parents,
            scratch: vec![AosTransform::identity(); sampler.scratch_len()],
            soa: vec![SoaTransform::identity(); soa_len(n)],
            model: vec![AosTransform::identity(); n],
            now: vec![AosVec3::zero(); n],
            other: vec![AosVec3::zero(); n],
            rest,
            root,
            rest_root: chain.rotation,
            duration: clip.view.duration(),
            looping: clip.view.flags() & CLIP_LOOP != 0,
            lap: CharacterFrame::IDENTITY,
            lap_inv: CharacterFrame::IDENTITY,
        };
        if e.looping && e.duration > 0.0 {
            let c0 = e.sample_frame(0.0);
            let c1 = e.sample_frame(e.duration);
            e.lap = c1.compose(&c0.inverse());
            e.lap_inv = e.lap.inverse();
        }
        Ok(e)
    }

    /// Samples the clip at clip time `t` into `model` and returns its character frame.
    fn sample_frame(&mut self, t: f32) -> CharacterFrame {
        // Errors were ruled out at construction (lengths fixed, form present).
        let _ = self
            .sampler
            .sample_pose(t, &self.rest, &mut self.scratch, &mut self.soa, None);
        local_to_model(&self.parents, &self.soa, &mut self.model);
        CharacterFrame::from_root(self.model[self.root], self.rest_root)
    }

    /// Samples at `t` (any time: wrapped for a looping clip, clamped for a one-shot) into `model`
    /// and returns the lap transform that unwraps it and the unwrapped character frame.
    fn at(&mut self, t: f32) -> (CharacterFrame, CharacterFrame) {
        let (local_t, laps) = if self.looping && self.duration > 0.0 {
            let k = (t / self.duration).floor();
            let mut lt = t - k * self.duration;
            let mut k = k as i32;
            if lt >= self.duration {
                lt -= self.duration;
                k += 1;
            }
            (lt.max(0.0), k)
        } else {
            (t.clamp(0.0, self.duration), 0)
        };
        let c = self.sample_frame(local_t);
        let mut lap = CharacterFrame::IDENTITY;
        let step = if laps >= 0 { self.lap } else { self.lap_inv };
        for _ in 0..laps.unsigned_abs() {
            lap = step.compose(&lap);
        }
        (lap, lap.compose(&c))
    }

    /// Writes the features at `t` into `row`.
    fn features(&mut self, features: &[Feature], t: f32, h: f32, row: &mut [f32]) {
        let (lap, c) = self.at(t);
        let n = self.model.len();
        for b in 0..n {
            self.now[b] = lap.point3_to_world(self.model[b].translation);
        }
        let has_velocity = features.iter().any(|f| f.kind == FeatureKind::BoneVelocity);
        // Velocities: one more sample, backward (forward at a one-shot clip's first frame).
        let forward = !self.looping && t - h < 0.0;
        let still = forward && t + h > self.duration;
        if has_velocity && !still {
            let (lap_o, _) = self.at(if forward { t + h } else { t - h });
            for b in 0..n {
                self.other[b] = lap_o.point3_to_world(self.model[b].translation);
            }
        }
        let c_inv = c.inverse();
        let inv_h = 1.0 / h;
        for f in features {
            let o = f.first_dim as usize;
            let b = f.bone as usize;
            match f.kind {
                FeatureKind::BonePosition => {
                    let p = c.point3_to_local(self.now[b]);
                    row[o..o + 3].copy_from_slice(&[p.x, p.y, p.z]);
                }
                FeatureKind::BoneVelocity => {
                    let d = if still {
                        AosVec3::zero()
                    } else if forward {
                        self.other[b] - self.now[b]
                    } else {
                        self.now[b] - self.other[b]
                    };
                    let v = c.vector3_to_local(d.scale(inv_h));
                    row[o..o + 3].copy_from_slice(&[v.x, v.y, v.z]);
                }
                FeatureKind::TrajectoryPosition | FeatureKind::TrajectoryDirection => {
                    let (_, there) = self.at(t + f.time_offset);
                    let rel = c_inv.compose(&there);
                    let v = if f.kind == FeatureKind::TrajectoryPosition {
                        rel.position
                    } else {
                        rel.forward
                    };
                    row[o..o + 2].copy_from_slice(&v);
                }
                FeatureKind::Custom => {}
            }
        }
    }
}
