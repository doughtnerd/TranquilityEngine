//! The offline bake (ADR 0372, 0373's "Bake retargeted clip"): retargets a whole clip to the
//! target skeleton through the same [`RetargetMap::retarget`] the runtime node calls, and writes
//! a raw `myco.anim@1` clip; with the `compress` feature, [`compress_baked`] compresses it.
//!
//! Offline: it allocates freely.

use crate::map::{RetargetError, RetargetMap, RetargetOptions};
use crate::profile::NO_BONE;
use anim_format::clip::{Binding, Clip, ClipView, Track, TrackKind};
use anim_format::skeleton::SkeletonView;
use anim_format::NONE;
use anim_math::layout::{soa_len, unpack_pose};
use anim_math::{AosQuat, AosTransform, AosVec3, SoaTransform};
use anim_sample::{ClipBindings, ClipSampler, Form, SampleError};

/// Why a bake failed.
#[derive(Clone, Debug, PartialEq)]
pub enum BakeError {
    /// The source clip can't be sampled.
    Sample(SampleError),
    /// The source clip's bone count isn't the map's source skeleton's.
    BoneCount,
    /// `source_rest` doesn't hold one transform per source bone.
    RestLength,
    /// The retarget refused a frame.
    Retarget(RetargetError),
}

impl core::fmt::Display for BakeError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "retarget bake failed: {self:?}")
    }
}

impl std::error::Error for BakeError {}

/// A baked clip.
#[derive(Clone, Debug, PartialEq)]
pub struct Baked {
    /// The target clip: raw form only, one bone track per target bone, then the source's
    /// non-bone tracks (keyed tracks always; sampled property tracks when the source has a raw
    /// form to copy them from).
    pub clip: Clip,
    /// Sampled property tracks left out because the source had no raw form.
    pub dropped_tracks: usize,
}

/// One skeleton's data read from a `myco.skel@1` view: names, parents, rest pose, roles and
/// mirror map, owned (load-time).
#[derive(Clone, Debug)]
pub struct SkeletonData {
    pub names: Vec<String>,
    pub parents: Vec<u16>,
    pub rest: Vec<AosTransform>,
    pub roles: Option<Vec<u16>>,
    pub mirror: Option<Vec<u32>>,
}

impl SkeletonData {
    /// Reads a parsed skeleton (an unnamed bone gets an empty name).
    pub fn from_view(v: &SkeletonView<'_>) -> SkeletonData {
        let strings = v.strings();
        let mut d = SkeletonData {
            names: Vec::with_capacity(v.bone_count()),
            parents: Vec::with_capacity(v.bone_count()),
            rest: Vec::with_capacity(v.bone_count()),
            roles: v
                .section(anim_format::skeleton::section::ROLES)
                .map(|_| v.roles().collect()),
            mirror: v.mirror().map(|m| m.to_vec()),
        };
        for i in 0..v.bone_count() {
            let Some(b) = v.bone(i) else { continue };
            d.names
                .push(strings.get(b.name).unwrap_or_default().to_string());
            d.parents.push(b.parent);
            let [tx, ty, tz] = b.translation;
            let [rx, ry, rz, rw] = b.rotation;
            let [sx, sy, sz] = b.scale;
            d.rest.push(AosTransform::new(
                AosVec3::new(tx, ty, tz),
                AosQuat::new(rx, ry, rz, rw),
                AosVec3::new(sx, sy, sz),
            ));
        }
        d
    }

    /// The skeleton as [`crate::map::Skeleton`].
    pub fn skeleton(&self) -> crate::map::Skeleton<'_> {
        crate::map::Skeleton {
            parents: &self.parents,
            rest: &self.rest,
        }
    }

    /// The bone names as string slices (for [`crate::guess_bone_map`]).
    pub fn name_refs(&self) -> Vec<&str> {
        self.names.iter().map(String::as_str).collect()
    }
}

/// Bakes `source` (a clip for the map's source skeleton, whose rest pose is `source_rest`)
/// onto the map's target skeleton: each frame at the clip's own rate is sampled through a
/// `BoundClip` (the compressed form when present, else the raw form), retargeted with `opts`,
/// and written as the target's raw frame. The clip keeps the source's duration, rate, frame
/// count, flags, name and strings; the root-motion bone becomes the target bone the retarget
/// root drives from it (else `NONE`).
pub fn bake(
    map: &RetargetMap,
    source: &ClipView<'_>,
    source_rest: &[AosTransform],
    opts: &RetargetOptions<'_>,
) -> Result<Baked, BakeError> {
    let form = if source.compressed().is_some() {
        Form::Compressed
    } else {
        Form::Raw
    };
    let sampler = ClipSampler::new(*source, form).map_err(BakeError::Sample)?;
    let ns = map.source_bone_count();
    let nt = map.target_bone_count();
    if sampler.bone_count() != ns {
        return Err(BakeError::BoneCount);
    }
    if source_rest.len() != ns {
        return Err(BakeError::RestLength);
    }
    let bindings = ClipBindings::new(&sampler);
    let bound = bindings.bind(&sampler).map_err(BakeError::Sample)?;
    let frames = source.frame_count().max(1) as usize;
    let rate = source.sample_rate();

    let mut scratch = map.scratch();
    let mut sample_scratch = vec![AosTransform::identity(); sampler.scratch_len()];
    let mut cache_mem = vec![0.0f32; bindings.cache_len()];
    let mut cache = anim_sample::SegmentCache::new(&mut cache_mem);
    let mut src_pose = vec![SoaTransform::identity(); soa_len(ns)];
    let mut tgt_pose = vec![SoaTransform::identity(); soa_len(nt)];
    let mut tgt_aos = vec![AosTransform::identity(); nt];
    let mut raw: Vec<Vec<f32>> = vec![Vec::with_capacity(frames * 10); nt];
    for f in 0..frames {
        let t = f as f32 / rate;
        bound
            .sample_pose(
                t,
                source_rest,
                &mut sample_scratch,
                &mut src_pose,
                Some(&mut cache),
            )
            .map_err(BakeError::Sample)?;
        map.retarget(&src_pose, opts, &mut scratch, &mut tgt_pose)
            .map_err(BakeError::Retarget)?;
        unpack_pose(&tgt_pose, &mut tgt_aos);
        for (b, x) in tgt_aos.iter().enumerate() {
            let (p, q, s) = (x.translation, x.rotation, x.scale);
            raw[b].extend_from_slice(&[p.x, p.y, p.z, q.x, q.y, q.z, q.w, s.x, s.y, s.z]);
        }
    }

    let base = source.to_clip();
    let mut tracks: Vec<Track> = raw
        .into_iter()
        .enumerate()
        .map(|(b, raw)| Track {
            kind: TrackKind::Bone,
            flags: 0,
            subtype: 0,
            binding: Binding::bone(b as u32),
            raw,
            keys: Vec::new(),
        })
        .collect();
    let mut dropped = 0;
    for t in base
        .tracks
        .into_iter()
        .filter(|t| t.kind != TrackKind::Bone)
    {
        if t.kind.is_sampled() && !base.has_raw {
            dropped += 1;
            continue;
        }
        tracks.push(t);
    }
    let root_bone = map
        .root_bones()
        .iter()
        .find(|&&(s, _)| s as u32 == base.root_bone && s != NO_BONE)
        .map_or(NONE, |&(_, t)| t as u32);
    Ok(Baked {
        clip: Clip {
            flags: base.flags,
            name: base.name,
            duration: base.duration,
            sample_rate: base.sample_rate,
            frame_count: frames as u32,
            bone_count: nt as u32,
            root_bone,
            strings: base.strings,
            tracks,
            has_raw: true,
            root_curve: None,
            compressed: None,
        },
        dropped_tracks: dropped,
    })
}

/// Compresses a baked clip for its target skeleton with `anim-compress` (offline only).
#[cfg(feature = "compress")]
pub fn compress_baked(
    baked: &Baked,
    target: &anim_format::skeleton::Skeleton,
    settings: &anim_compress::Settings,
) -> Result<anim_compress::Output, anim_compress::CompressError> {
    anim_compress::compress(&baked.clip, Some(target), settings)
}
