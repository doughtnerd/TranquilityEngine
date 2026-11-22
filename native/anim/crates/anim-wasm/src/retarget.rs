//! Feature `retarget` (T41): skeleton profiles, `guess_bone_map`, retarget maps (arena assets the
//! graph's `RETARGET` node binds), the profile's mirror table for the `MIRROR` node, and the bake.
//!
//! Setup calls only (wasm-bindgen exports below, thin wrappers over [`Core`] methods); nothing here
//! runs per frame except the node itself (`anim-graph::retarget`), which reads the map through
//! [`Assets::retarget`](anim_graph::eval::Assets::retarget).
//!
//! | Call | Does |
//! |---|---|
//! | `profile_decode(bytes)` | a custom profile (`anim-retarget`'s `encode` layout) as an asset; handle 0 means the built-in Humanoid profile everywhere a profile is taken |
//! | `guess_bone_map(skeleton_bytes, profile, bones, confidence)` | the guess per role: bone (`u16`, `0xFFFF` none) and confidence; returns the role count |
//! | `retarget_map_create(src_skel, src_profile, src_map, tgt_skel, tgt_profile, tgt_map, flags)` | a retarget map asset ([`MAP_ALIGN`]); bone maps are one `u16` per role |
//! | `retarget_goal_count(map)` | the map's IK goals (the node's goal words follow their order) |
//! | `retarget_mirror_table(skeleton_bytes, profile, map, out)` | the `MIRROR` node's bone words (partner and flip, `anim_graph::mixing::mirror_word`) |
//! | `retarget_bake(map, clip_bytes, root_axes, ik_weights)` | the source clip retargeted to a raw `myco.anim@1` clip (empty on failure) |
//! | `retarget_bake_compressed(…, target_skeleton_bytes)` | the same, compressed: only with the crate's `editor` feature |
//!
//! `guess_bone_map` and `retarget_mirror_table` take the skeleton's **file** bytes: the runtime
//! skeleton asset keeps no bone names, roles or mirror section (they are editor data).
//!
//! # Bake and module size
//!
//! The raw bake is in the runtime module (it reuses the sampler, the retarget and the clip writer
//! the module already has, so it costs little). Compression links `anim-compress` and the f64
//! reference, so it is behind the `editor` feature (`anim-retarget/compress`), which `build.mjs`
//! doesn't enable: Phase B's editor worker builds its own module with `--features editor`, or
//! compresses the raw bake in its importer.

use core::cell::RefCell;
use std::sync::OnceLock;

use anim_format::clip::ClipView;
use anim_format::skeleton::SkeletonView;
use anim_graph::eval::SkeletonPose;
use anim_graph::retarget::RetargetRef;
use anim_math::layout::{pack_pose, soa_len};
use anim_math::{AosTransform, SoaTransform};
use anim_pose::Axis;
use anim_retarget::bake::{bake, SkeletonData};
use anim_retarget::{
    guess_bone_map as guess, BoneMap, MapSettings, Profile, RetargetMap, RetargetOptions, RetargetScratch,
    RootAxis, Side, Skeleton,
};
use anim_wire::core::{
    Init, STATUS_BAD_ASSET, STATUS_MISMATCH, STATUS_NOT_INITIALIZED, STATUS_OK,
    STATUS_WRONG_KIND,
};
use wasm_bindgen::prelude::wasm_bindgen;

use crate::assets::Asset;
use crate::init::{with, Core};

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]):
/// none up front (profiles and maps live in the arena, which grows in load calls).
pub(crate) fn bytes_needed(_init: &Init) -> u64 {
    0
}

/// `retarget_map_create` flag: align each chain's rest direction with the source's (decision
/// D47; `MapSettings::align_chains`).
pub const MAP_ALIGN: u32 = 1;

fn humanoid() -> &'static Profile {
    static HUMANOID: OnceLock<Profile> = OnceLock::new();
    HUMANOID.get_or_init(Profile::humanoid)
}

/// A retarget map with what the node needs besides it.
pub struct MapAsset {
    map: RetargetMap,
    scratch: RefCell<RetargetScratch>,
    parents: Vec<u16>,
    rest: Vec<AosTransform>,
    rest_soa: Vec<SoaTransform>,
    identity: Vec<AosTransform>,
}

/// What a `retarget` arena slot holds.
pub enum RetargetAsset {
    Profile(Profile),
    Map(MapAsset),
}

impl RetargetAsset {
    pub(crate) fn is_map(&self) -> bool {
        matches!(self, RetargetAsset::Map(_))
    }

    /// The node's view of a map.
    pub(crate) fn node_ref(&self) -> Option<RetargetRef<'_>> {
        match self {
            RetargetAsset::Map(m) => Some(RetargetRef {
                map: &m.map,
                scratch: &m.scratch,
                source: SkeletonPose {
                    parents: &m.parents,
                    rest: &m.rest,
                    rest_soa: &m.rest_soa,
                    identity: &m.identity,
                    bind_soa: &[],
                },
            }),
            RetargetAsset::Profile(_) => None,
        }
    }
}

fn root_axis(bits: u32) -> RootAxis {
    match bits & 3 {
        1 => RootAxis::Unscaled,
        2 => RootAxis::Locked,
        _ => RootAxis::Scaled,
    }
}

/// `root_axes` packs the three axes two bits each (x in bits 0–1): 0 scaled, 1 unscaled, 2 locked.
fn root_axes(packed: u32) -> [RootAxis; 3] {
    [
        root_axis(packed),
        root_axis(packed >> 2),
        root_axis(packed >> 4),
    ]
}

impl Core {
    pub(crate) fn retarget_profile(&self, handle: u32) -> Result<&Profile, u32> {
        if handle == 0 {
            return Ok(humanoid());
        }
        match self.arena.get(handle)? {
            Asset::Retarget(r) => match &**r {
                RetargetAsset::Profile(p) => Ok(p),
                RetargetAsset::Map(_) => Err(STATUS_WRONG_KIND),
            },
            _ => Err(STATUS_WRONG_KIND),
        }
    }

    fn map_asset(&self, handle: u32) -> Result<&MapAsset, u32> {
        match self.arena.get(handle)? {
            Asset::Retarget(r) => match &**r {
                RetargetAsset::Map(m) => Ok(m),
                RetargetAsset::Profile(_) => Err(STATUS_WRONG_KIND),
            },
            _ => Err(STATUS_WRONG_KIND),
        }
    }

    /// Decodes a custom profile into an asset; 0 on failure (`STATUS_BAD_ASSET`).
    pub fn profile_decode(&mut self, bytes: &[u8]) -> u32 {
        if !self.started {
            return self.handle(Err(STATUS_NOT_INITIALIZED));
        }
        let r = match anim_retarget::encode::decode(bytes) {
            Ok(p) => self
                .arena
                .insert(Asset::Retarget(Box::new(RetargetAsset::Profile(p)))),
            Err(_) => Err(STATUS_BAD_ASSET),
        };
        self.handle(r)
    }

    /// Guesses `profile`'s bone map for a skeleton file: per role, the bone into `bones` and the
    /// confidence into `confidence` (as many roles as both hold). Returns the profile's role
    /// count, or 0 on failure (`last_status`).
    pub fn guess_bone_map(
        &mut self,
        skeleton: &[u8],
        profile: u32,
        bones: &mut [u16],
        confidence: &mut [f32],
    ) -> u32 {
        if !self.started {
            self.last_status = STATUS_NOT_INITIALIZED;
            return 0;
        }
        let r = (|| {
            let view = SkeletonView::parse(skeleton).map_err(|_| STATUS_BAD_ASSET)?;
            let data = SkeletonData::from_view(&view);
            let p = self.retarget_profile(profile)?;
            Ok(guess(&data.name_refs(), &data.parents, p))
        })();
        match r {
            Ok(map) => {
                for (o, b) in bones.iter_mut().zip(&map.bones) {
                    *o = *b;
                }
                for (o, c) in confidence.iter_mut().zip(&map.confidence) {
                    *o = *c;
                }
                self.last_status = STATUS_OK;
                map.bones.len() as u32
            }
            Err(e) => {
                self.last_status = e;
                0
            }
        }
    }

    /// Creates a retarget map from the source skeleton (asset), profile and bone map (one `u16`
    /// per role, `0xFFFF` unmapped) to the target's; `flags` [`MAP_ALIGN`]. 0 on failure.
    #[allow(clippy::too_many_arguments)]
    pub fn retarget_map_create(
        &mut self,
        src_skeleton: u32,
        src_profile: u32,
        src_map: &[u16],
        tgt_skeleton: u32,
        tgt_profile: u32,
        tgt_map: &[u16],
        flags: u32,
    ) -> u32 {
        if !self.started {
            return self.handle(Err(STATUS_NOT_INITIALIZED));
        }
        let r = self.create_map(
            src_skeleton,
            src_profile,
            src_map,
            tgt_skeleton,
            tgt_profile,
            tgt_map,
            flags,
        );
        let r = r.and_then(|m| {
            self.arena
                .insert(Asset::Retarget(Box::new(RetargetAsset::Map(m))))
        });
        self.handle(r)
    }

    #[allow(clippy::too_many_arguments)]
    fn create_map(
        &self,
        src_skeleton: u32,
        src_profile: u32,
        src_map: &[u16],
        tgt_skeleton: u32,
        tgt_profile: u32,
        tgt_map: &[u16],
        flags: u32,
    ) -> Result<MapAsset, u32> {
        let ss = self.arena.skeleton(src_skeleton)?;
        let ts = self.arena.skeleton(tgt_skeleton)?;
        let (sp, tp) = (self.retarget_profile(src_profile)?, self.retarget_profile(tgt_profile)?);
        let bone_map = |m: &[u16], p: &Profile| -> Result<BoneMap, u32> {
            if m.len() != p.roles.len() {
                return Err(STATUS_MISMATCH);
            }
            let mut b = BoneMap::new(m.len());
            for (r, &bone) in m.iter().enumerate() {
                b.set(r as u16, bone);
            }
            Ok(b)
        };
        let (sm, tm) = (bone_map(src_map, sp)?, bone_map(tgt_map, tp)?);
        fn side(s: &crate::assets::SkeletonAsset) -> Skeleton<'_> {
            Skeleton {
                parents: &s.parents,
                rest: &s.rest,
            }
        }
        let map = RetargetMap::new(
            Side {
                skeleton: side(ss),
                profile: sp,
                map: &sm,
            },
            Side {
                skeleton: side(ts),
                profile: tp,
                map: &tm,
            },
            &MapSettings {
                align_chains: flags & MAP_ALIGN != 0,
            },
        )
        .map_err(|_| STATUS_BAD_ASSET)?;
        let scratch = RefCell::new(map.scratch());
        let mut rest_soa = vec![SoaTransform::identity(); soa_len(ss.bones())];
        pack_pose(&ss.rest, &mut rest_soa);
        Ok(MapAsset {
            map,
            scratch,
            parents: ss.parents.clone(),
            rest: ss.rest.clone(),
            rest_soa,
            identity: vec![AosTransform::identity(); ss.bones()],
        })
    }

    /// The IK goals of a map (0 for a stale handle).
    pub fn retarget_goal_count(&self, map: u32) -> u32 {
        self.map_asset(map).map_or(0, |m| m.map.goals().len() as u32)
    }

    /// The `MIRROR` node's bone words for a skeleton file, its profile and bone map: per bone its
    /// partner and flip (`anim_graph::mixing::mirror_word`), from the profile's mirror roles and
    /// flips (the skeleton's `MIRROR` section where a role is unmapped; flips derived from the rest
    /// pose unless the profile sets them), across the skeleton's mirror axis. Returns the bone
    /// count, or 0 on failure.
    pub fn retarget_mirror_table(
        &mut self,
        skeleton: &[u8],
        profile: u32,
        map: &[u16],
        out: &mut [u32],
    ) -> u32 {
        if !self.started {
            self.last_status = STATUS_NOT_INITIALIZED;
            return 0;
        }
        let r = (|| {
            let view = SkeletonView::parse(skeleton).map_err(|_| STATUS_BAD_ASSET)?;
            let data = SkeletonData::from_view(&view);
            let p = self.retarget_profile(profile)?;
            if map.len() != p.roles.len() {
                return Err(STATUS_MISMATCH);
            }
            let mut b = BoneMap::new(map.len());
            for (r, &bone) in map.iter().enumerate() {
                b.set(r as u16, bone);
            }
            let n = data.parents.len();
            let mut rest_soa = vec![SoaTransform::identity(); soa_len(n)];
            pack_pose(&data.rest, &mut rest_soa);
            let mut model = vec![AosTransform::identity(); n];
            anim_math::layout::local_to_model(&data.parents, &rest_soa, &mut model);
            let axis = match view.mirror_axis() {
                1 => Axis::Y,
                2 => Axis::Z,
                _ => Axis::X,
            };
            Ok(p.mirror_table(&b, &model, data.mirror.as_deref(), axis))
        })();
        match r {
            Ok((partner, flips)) => {
                for ((o, &p), &f) in out.iter_mut().zip(&partner).zip(&flips) {
                    *o = anim_graph::mixing::mirror_word(p, f as u8);
                }
                self.last_status = STATUS_OK;
                partner.len() as u32
            }
            Err(e) => {
                self.last_status = e;
                0
            }
        }
    }

    fn baked(
        &self,
        map: u32,
        clip: &[u8],
        axes: u32,
        ik_weights: &[f32],
    ) -> Result<anim_retarget::bake::Baked, u32> {
        let m = self.map_asset(map)?;
        let view = ClipView::parse(clip).map_err(|_| STATUS_BAD_ASSET)?;
        let opts = RetargetOptions {
            root_axes: root_axes(axes),
            ik_weights,
        };
        bake(&m.map, &view, &m.rest, &opts).map_err(|_| STATUS_MISMATCH)
    }

    /// Bakes a source clip through a map into a raw `myco.anim@1` clip (`root_axes` packed two bits
    /// per axis, x first: 0 scaled, 1 unscaled, 2 locked; `ik_weights` per goal). Empty on failure.
    pub fn retarget_bake(
        &mut self,
        map: u32,
        clip: &[u8],
        root_axes: u32,
        ik_weights: &[f32],
    ) -> Vec<u8> {
        if !self.started {
            self.last_status = STATUS_NOT_INITIALIZED;
            return Vec::new();
        }
        let r = self
            .baked(map, clip, root_axes, ik_weights)
            .and_then(|b| b.clip.write().map_err(|_| STATUS_BAD_ASSET));
        match r {
            Ok(bytes) => {
                self.last_status = STATUS_OK;
                bytes
            }
            Err(e) => {
                self.last_status = e;
                Vec::new()
            }
        }
    }

    /// [`Core::retarget_bake`], compressed for the target skeleton (its file bytes) with the
    /// default settings. Editor builds only (`editor` feature).
    #[cfg(feature = "editor")]
    pub fn retarget_bake_compressed(
        &mut self,
        map: u32,
        clip: &[u8],
        target_skeleton: &[u8],
        root_axes: u32,
        ik_weights: &[f32],
    ) -> Vec<u8> {
        if !self.started {
            self.last_status = STATUS_NOT_INITIALIZED;
            return Vec::new();
        }
        let r = (|| {
            let target = SkeletonView::parse(target_skeleton)
                .map_err(|_| STATUS_BAD_ASSET)?
                .to_skeleton();
            let b = self.baked(map, clip, root_axes, ik_weights)?;
            anim_retarget::bake::compress_baked(&b, &target, &anim_compress::Settings::default())
                .map(|o| o.bytes)
                .map_err(|_| STATUS_BAD_ASSET)
        })();
        match r {
            Ok(bytes) => {
                self.last_status = STATUS_OK;
                bytes
            }
            Err(e) => {
                self.last_status = e;
                Vec::new()
            }
        }
    }
}

/// Decodes a custom skeleton profile; returns its handle, or 0 (see `last_status`).
#[wasm_bindgen]
pub fn profile_decode(bytes: &[u8]) -> u32 {
    with(|c| c.profile_decode(bytes))
}

/// Guesses a profile's bone map for a skeleton file; returns the role count (0: see `last_status`).
#[wasm_bindgen]
pub fn guess_bone_map(skeleton: &[u8], profile: u32, bones: &mut [u16], confidence: &mut [f32]) -> u32 {
    with(|c| c.guess_bone_map(skeleton, profile, bones, confidence))
}

/// Creates a retarget map asset; returns its handle, or 0 (see `last_status`).
#[wasm_bindgen]
pub fn retarget_map_create(
    src_skeleton: u32,
    src_profile: u32,
    src_map: &[u16],
    tgt_skeleton: u32,
    tgt_profile: u32,
    tgt_map: &[u16],
    flags: u32,
) -> u32 {
    with(|c| {
        c.retarget_map_create(
            src_skeleton,
            src_profile,
            src_map,
            tgt_skeleton,
            tgt_profile,
            tgt_map,
            flags,
        )
    })
}

/// The IK goals of a retarget map.
#[wasm_bindgen]
pub fn retarget_goal_count(map: u32) -> u32 {
    with(|c| c.retarget_goal_count(map))
}

/// Writes the `MIRROR` node's bone words for a skeleton file; returns the bone count (0: failure).
#[wasm_bindgen]
pub fn retarget_mirror_table(skeleton: &[u8], profile: u32, map: &[u16], out: &mut [u32]) -> u32 {
    with(|c| c.retarget_mirror_table(skeleton, profile, map, out))
}

/// Bakes a clip through a retarget map into a raw clip (empty: see `last_status`).
#[wasm_bindgen]
pub fn retarget_bake(map: u32, clip: &[u8], root_axes: u32, ik_weights: &[f32]) -> Vec<u8> {
    with(|c| c.retarget_bake(map, clip, root_axes, ik_weights))
}

/// Bakes and compresses a clip through a retarget map (editor builds only).
#[cfg(feature = "editor")]
#[wasm_bindgen]
pub fn retarget_bake_compressed(
    map: u32,
    clip: &[u8],
    target_skeleton: &[u8],
    root_axes: u32,
    ik_weights: &[f32],
) -> Vec<u8> {
    with(|c| c.retarget_bake_compressed(map, clip, target_skeleton, root_axes, ik_weights))
}
