//! Feature `assets`: the pooled asset arena. Clips, skeletons, compiled graphs and masks are
//! copied in on load and released when the asset is released, or between editor play sessions.
//! Growth happens only in load calls, never inside `evaluate`.
//!
//! # Layout
//!
//! The arena is a table of slots; a handle is `generation << 16 | index` (`anim-wire` core's
//! `HANDLE_*`), so a released handle is stale and every call with it is a no-op. Each asset's
//! file bytes are copied once into their own 16-byte aligned block (the formats align SIMD
//! payloads to 16, and the host may read them through typed-array views), validated with the
//! `anim-format` reader, and kept with what evaluation needs precomputed:
//!
//! | Kind | Kept |
//! |---|---|
//! | skeleton (`myco.skel@1`) | parents, rest pose (AoS and packed SoA), identity pose, inverse bind matrices, the bind pose (T31: local transforms of the inverse binds' model pose, packed); (T40) a joint limit per bone from `JOINT_RANGES` against its rest rotation (free without one) and the bone of each profile role, for the rig nodes |
//! | clip (`myco.anim@1`) | a sampler over its compressed form (else its raw form) with its binding table (`anim-sample`'s `ClipBindings`: decoded channel, track and key tables, so sampling and track windows don't re-read records), duration, flags, root curve; and (T31) its sync markers keyed by name hash, its exit markers' times and its curve tracks by name hash, for the graph's markers, exit times and curve conditions; (T40) its cue markers by name hash (motion-warp windows) and its root curve's cumulative ground travel per frame (distance matching) |
//! | graph (`myco.animgraph@1`) | its [`Program`] and a binding table (an asset handle per string id: clips, masks and, for linked graphs, graphs) |
//! | mask | per-bone weights packed like a pose |
//! | retarget (T41) | a skeleton profile, or a retarget map with copies of its source skeleton and its scratch ([`crate::retarget`]) |
//! | ragdoll (T44r) | a validated ragdoll description ([`crate::physics`]) |
//! | pose database (`myco.posedb@1`, T42) | the search-ready `MatchDb`, a clip handle per database clip (`crate::matching`) |
//! | plugin module (T45) | its descriptor's node kinds and default parameter blocks (`crate::plugin`) |
//! | curve (T70) | an engine curve's baked keys (`anim_sample::curve`, the shared `myco-curve` evaluator): tween and sequence easing, `curve_sample` |
//!
//! The parsed views borrow the asset's own block for as long as the asset lives (the block never
//! moves and is freed after the views, when the slot is cleared).

use core::ptr::NonNull;
use std::alloc::{alloc, dealloc, Layout};

use anim_format::clip::{ClipView, KeyData, MarkerKind, TrackKind, CLIP_ADDITIVE, CLIP_LOOP};
use anim_format::graph::AnimGraphView;
use anim_format::skeleton::SkeletonView;
use anim_format::F32s;
use anim_graph::eval::{name_hash, Assets, ClipRef, GraphRef, Program};
use anim_graph::sources::triangulate::sort_small;
use anim_math::layout::{pack_pose, soa_len};
use anim_math::{AosMat3x4, AosTransform, AosVec3, F32x4, SoaTransform};
use anim_pose::sync::SyncMarker;
use anim_rig::JointLimit;
use anim_sample::curve::{parse_keys, CurveError, Key};
use anim_sample::{BoundClip, ClipBindings, ClipSampler, Form};
use anim_wire::core::{
    Init, HANDLE_GENERATION_SHIFT, HANDLE_INDEX_MASK, STATUS_BAD_ASSET, STATUS_FULL,
    STATUS_MISMATCH, STATUS_OK, STATUS_STALE_HANDLE, STATUS_TOO_LARGE, STATUS_UNKNOWN_NODES,
    STATUS_WRONG_KIND,
};

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]):
/// the arena's first size.
pub(crate) fn bytes_needed(init: &Init) -> u64 {
    init.arena_initial_bytes as u64
}

/// The most assets alive at once (handle indices are 16 bits).
pub const MAX_ASSETS: usize = HANDLE_INDEX_MASK as usize;

/// A copy of a file's bytes at a 16-byte aligned address.
struct AlignedBytes {
    ptr: NonNull<u8>,
    len: usize,
}

impl AlignedBytes {
    fn layout(len: usize) -> Layout {
        // 16 is a power of two and the size is at most isize::MAX for any slice we copy.
        Layout::from_size_align(len.max(1), 16).unwrap_or(Layout::new::<u128>())
    }

    fn copy(bytes: &[u8]) -> AlignedBytes {
        let layout = Self::layout(bytes.len());
        // SAFETY: the layout has a non-zero size.
        let raw = unsafe { alloc(layout) };
        let Some(ptr) = NonNull::new(raw) else {
            std::alloc::handle_alloc_error(layout);
        };
        // SAFETY: `ptr` points to at least `bytes.len()` writable bytes that don't overlap `bytes`.
        unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr.as_ptr(), bytes.len()) };
        AlignedBytes {
            ptr,
            len: bytes.len(),
        }
    }

    /// The bytes, for as long as the caller promises to keep `self` alive and unmoved in the
    /// slot (the views made from them are dropped before `self`; see [`Asset`]'s field order).
    fn as_static(&self) -> &'static [u8] {
        // SAFETY: `ptr` holds `len` initialised bytes until `drop`; callers only keep the slice in
        // views stored next to `self` and dropped before it.
        unsafe { core::slice::from_raw_parts(self.ptr.as_ptr(), self.len) }
    }

    fn addr(&self) -> usize {
        self.ptr.as_ptr() as usize
    }
}

impl Drop for AlignedBytes {
    fn drop(&mut self) {
        // SAFETY: allocated in `copy` with this layout.
        unsafe { dealloc(self.ptr.as_ptr(), Self::layout(self.len)) };
    }
}

/// A loaded skeleton.
pub struct SkeletonAsset {
    pub parents: Vec<u16>,
    pub rest: Vec<AosTransform>,
    pub rest_soa: Vec<SoaTransform>,
    pub identity: Vec<AosTransform>,
    pub inverse_bind: Vec<AosMat3x4>,
    /// The bind pose, packed (T31's `BIND_POSE`).
    pub bind_soa: Vec<SoaTransform>,
    /// T40: a joint limit per bone (`JointLimit::FREE` where `JOINT_RANGES` has none).
    pub limits: Vec<JointLimit>,
    /// T40: the bone of each profile role (`anim_graph::rig::NO_BONE` for none).
    pub roles: Vec<u16>,
}

impl ClipAsset {
    /// The sampler paired with the binding table (`load_clip` checked the pair once, and both are
    /// immutable, so it isn't checked again on every sample).
    pub fn bound(&self) -> Option<BoundClip<'_, '_>> {
        Some(self.bindings.pair_unchecked(&self.sampler))
    }
}

/// The zero-bone skeleton behind skeleton handle 0 (T17b).
static NO_SKELETON: SkeletonAsset = SkeletonAsset {
    parents: Vec::new(),
    rest: Vec::new(),
    rest_soa: Vec::new(),
    identity: Vec::new(),
    inverse_bind: Vec::new(),
    bind_soa: Vec::new(),
    limits: Vec::new(),
    roles: Vec::new(),
};

impl SkeletonAsset {
    pub fn bones(&self) -> usize {
        self.parents.len()
    }
    pub fn groups(&self) -> usize {
        soa_len(self.parents.len())
    }
}

/// A loaded clip. The sampler and root curve borrow `bytes` (declared last, so dropped last).
pub struct ClipAsset {
    sampler: ClipSampler<'static>,
    pub bindings: ClipBindings,
    root_curve: Option<F32s<'static>>,
    pub duration: f32,
    pub flags: u32,
    pub sample_rate: f32,
    pub frame_count: u32,
    pub bone_count: u32,
    pub root_bone: u32,
    /// Sync markers (ids are name hashes), exit-marker times, curve tracks (name hash, track).
    pub sync: Vec<SyncMarker>,
    pub exits: Vec<f32>,
    pub curves: Vec<(u32, u32)>,
    /// T40: cue markers (ids are name hashes), sorted by time.
    pub cues: Vec<SyncMarker>,
    /// T40: the root curve's cumulative ground travel per frame (empty without a curve).
    pub distance: Vec<f32>,
    bytes: AlignedBytes,
}

/// A loaded graph.
pub struct GraphAsset {
    pub program: Program,
    /// An asset handle per string id of the graph (0: unbound).
    pub bindings: Vec<u32>,
    bytes: AlignedBytes,
}

/// A loaded mask.
pub struct MaskAsset {
    pub bones: usize,
    pub packed: Vec<F32x4>,
}

/// What a slot holds. (A clip's binding table is inline; slots are few and long-lived.)
#[allow(clippy::large_enum_variant)]
pub enum Asset {
    Skeleton(SkeletonAsset),
    Clip(ClipAsset),
    Graph(GraphAsset),
    Mask(MaskAsset),
    /// T41: a skeleton profile or a retarget map ([`crate::retarget`]).
    Retarget(Box<crate::retarget::RetargetAsset>),
    /// T44r: a ragdoll description ([`crate::physics`]).
    Ragdoll(Box<crate::physics::RagdollAsset>),
    /// T42: a pose database (`crate::matching`).
    PoseDb(crate::matching::PoseDbAsset),
    /// T45: a registered third-party node module (`crate::plugin`).
    Plugin(crate::plugin::PluginModule),
    /// T70: an engine curve's baked keys (`anim_sample::curve`).
    Curve(Vec<Key<f32>>),
}

struct Slot {
    generation: u16,
    asset: Option<Asset>,
}

/// The arena.
#[derive(Default)]
pub struct Arena {
    slots: Vec<Slot>,
    free: Vec<u16>,
    /// Bytes of asset files held.
    held: usize,
    /// T45: the plugin host's call buffers and fault reports (`crate::plugin`).
    pub(crate) plugin_rt: crate::plugin::Runtime,
    /// T82r: bumped on every release, so a clip player's frame cache never takes a clip loaded
    /// into a released one's memory for it (`Assets::cache_epoch`).
    epoch: u32,
}

/// `generation << 16 | index`.
pub(crate) fn handle(index: usize, generation: u16) -> u32 {
    ((generation as u32) << HANDLE_GENERATION_SHIFT) | index as u32
}

/// A handle's index and generation.
pub(crate) fn split(handle: u32) -> (usize, u16) {
    (
        (handle & HANDLE_INDEX_MASK) as usize,
        (handle >> HANDLE_GENERATION_SHIFT) as u16,
    )
}

impl Arena {
    /// An arena with room reserved for `bytes` of files (`init`'s `arena_initial_bytes`).
    pub fn with_capacity(slots: usize) -> Arena {
        Arena {
            slots: Vec::with_capacity(slots),
            free: Vec::new(),
            held: 0,
            plugin_rt: crate::plugin::Runtime::new(),
            epoch: 0,
        }
    }

    /// Bytes of asset files the arena holds.
    pub fn held_bytes(&self) -> usize {
        self.held
    }

    pub(crate) fn insert(&mut self, asset: Asset) -> Result<u32, u32> {
        if let Some(index) = self.free.pop() {
            let slot = &mut self.slots[index as usize];
            slot.asset = Some(asset);
            return Ok(handle(index as usize, slot.generation));
        }
        if self.slots.len() >= MAX_ASSETS {
            return Err(STATUS_FULL);
        }
        self.slots.push(Slot {
            generation: 1,
            asset: Some(asset),
        });
        Ok(handle(self.slots.len() - 1, 1))
    }

    /// The live asset of `handle`.
    pub fn get(&self, handle: u32) -> Result<&Asset, u32> {
        let (index, generation) = split(handle);
        match self.slots.get(index) {
            Some(Slot {
                generation: g,
                asset: Some(a),
            }) if *g == generation => Ok(a),
            _ => Err(STATUS_STALE_HANDLE),
        }
    }

    pub(crate) fn get_mut(&mut self, handle: u32) -> Result<&mut Asset, u32> {
        let (index, generation) = split(handle);
        match self.slots.get_mut(index) {
            Some(Slot {
                generation: g,
                asset: Some(a),
            }) if *g == generation => Ok(a),
            _ => Err(STATUS_STALE_HANDLE),
        }
    }

    /// The skeleton of `handle`; handle 0 is the empty skeleton (no bones) of an instance
    /// without a rig (T17b).
    pub fn skeleton(&self, handle: u32) -> Result<&SkeletonAsset, u32> {
        if handle == 0 {
            return Ok(&NO_SKELETON);
        }
        match self.get(handle)? {
            Asset::Skeleton(s) => Ok(s),
            _ => Err(STATUS_WRONG_KIND),
        }
    }

    pub fn clip_asset(&self, handle: u32) -> Result<&ClipAsset, u32> {
        match self.get(handle)? {
            Asset::Clip(c) => Ok(c),
            _ => Err(STATUS_WRONG_KIND),
        }
    }

    pub fn graph(&self, handle: u32) -> Result<&GraphAsset, u32> {
        match self.get(handle)? {
            Asset::Graph(g) => Ok(g),
            _ => Err(STATUS_WRONG_KIND),
        }
    }

    pub fn mask_asset(&self, handle: u32) -> Result<&MaskAsset, u32> {
        match self.get(handle)? {
            Asset::Mask(m) => Ok(m),
            _ => Err(STATUS_WRONG_KIND),
        }
    }

    /// Releases `handle`'s asset; its handle (and every copy of it) goes stale.
    pub fn release(&mut self, handle: u32) -> u32 {
        let (index, generation) = split(handle);
        let Some(slot) = self.slots.get_mut(index) else {
            return STATUS_STALE_HANDLE;
        };
        if slot.generation != generation || slot.asset.is_none() {
            return STATUS_STALE_HANDLE;
        }
        if let Some(a) = slot.asset.take() {
            self.held -= match &a {
                Asset::Clip(c) => c.bytes.len,
                Asset::Graph(g) => g.bytes.len,
                _ => 0,
            };
        }
        // Generations skip 0, so a handle is never 0.
        slot.generation = slot.generation.wrapping_add(1).max(1);
        self.free.push(index as u16);
        self.epoch = self.epoch.wrapping_add(1);
        STATUS_OK
    }

    /// Loads a `myco.skel@1` file of at most `max_bones` bones.
    pub fn load_skeleton(&mut self, bytes: &[u8], max_bones: usize) -> Result<u32, u32> {
        let view = SkeletonView::parse(bytes).map_err(|_| STATUS_BAD_ASSET)?;
        let n = view.bone_count();
        if n > max_bones {
            return Err(STATUS_TOO_LARGE);
        }
        let mut rest = vec![AosTransform::identity(); n];
        anim_sample::rest_pose(&view, &mut rest);
        let mut rest_soa = vec![SoaTransform::identity(); soa_len(n)];
        pack_pose(&rest, &mut rest_soa);
        let mut parents = Vec::with_capacity(n);
        let mut inverse_bind = Vec::with_capacity(n);
        for i in 0..n {
            let b = view.bone(i).ok_or(STATUS_BAD_ASSET)?;
            parents.push(b.parent);
            inverse_bind.push(AosMat3x4::from_rows(b.inverse_bind));
        }
        let bind = bind_pose(&parents, &inverse_bind, &rest);
        let mut bind_soa = vec![SoaTransform::identity(); soa_len(n)];
        pack_pose(&bind, &mut bind_soa);
        let (limits, roles) = rig_tables(&view, &rest);
        self.insert(Asset::Skeleton(SkeletonAsset {
            parents,
            rest,
            rest_soa,
            identity: vec![AosTransform::identity(); n],
            inverse_bind,
            bind_soa,
            limits,
            roles,
        }))
    }

    /// Loads a `myco.anim@1` file.
    pub fn load_clip(&mut self, bytes: &[u8]) -> Result<u32, u32> {
        let asset = Self::make_clip(bytes)?;
        let held = asset.bytes.len;
        let h = self.insert(Asset::Clip(asset))?;
        self.held += held;
        Ok(h)
    }

    /// T70: replaces clip `handle`'s file with `bytes` (same handle; see `Core::replace_clip`).
    /// The epoch moves on, so no frame cache keeps samples of the old file.
    pub fn replace_clip(&mut self, handle: u32, bytes: &[u8]) -> Result<(), u32> {
        let bones = self.clip_asset(handle)?.bone_count;
        let asset = Self::make_clip(bytes)?;
        if asset.bone_count != bones {
            return Err(STATUS_MISMATCH);
        }
        let held = asset.bytes.len;
        let Asset::Clip(old) = self.get_mut(handle)? else {
            return Err(STATUS_WRONG_KIND);
        };
        let old_held = old.bytes.len;
        *old = asset;
        self.held = self.held - old_held + held;
        self.epoch = self.epoch.wrapping_add(1);
        Ok(())
    }

    fn make_clip(bytes: &[u8]) -> Result<ClipAsset, u32> {
        let block = AlignedBytes::copy(bytes);
        let data = block.as_static();
        let view = ClipView::parse(data).map_err(|_| STATUS_BAD_ASSET)?;
        let form = if view.compressed().is_some() {
            Form::Compressed
        } else {
            Form::Raw
        };
        let sampler = ClipSampler::new(view, form).map_err(|_| STATUS_BAD_ASSET)?;
        let bindings = ClipBindings::new(&sampler);
        bindings.bind(&sampler).map_err(|_| STATUS_BAD_ASSET)?;
        let (sync, exits, curves) = marker_tables(&view);
        let cues = cue_table(&view);
        let distance = travel(&view);
        Ok(ClipAsset {
            sampler,
            bindings,
            root_curve: view.root_curve(),
            duration: view.duration(),
            flags: view.flags(),
            sample_rate: view.sample_rate(),
            frame_count: view.frame_count(),
            bone_count: view.bone_count(),
            root_bone: view.root_bone(),
            sync,
            exits,
            curves,
            cues,
            distance,
            bytes: block,
        })
    }

    /// Loads a `myco.animgraph@1` file. `Ok` carries the handle and `STATUS_OK` or
    /// `STATUS_UNKNOWN_NODES`.
    pub fn load_graph(&mut self, bytes: &[u8]) -> Result<(u32, u32), u32> {
        let block = AlignedBytes::copy(bytes);
        let view = AnimGraphView::parse(block.as_static()).map_err(|_| STATUS_BAD_ASSET)?;
        let program = Program::from_view(&view).map_err(|_| STATUS_BAD_ASSET)?;
        let status = if program.unknown_nodes() > 0 {
            STATUS_UNKNOWN_NODES
        } else {
            STATUS_OK
        };
        let held = block.len;
        let asset = GraphAsset {
            bindings: vec![0; view.strings().len()],
            program,
            bytes: block,
        };
        let h = self.insert(Asset::Graph(asset))?;
        self.held += held;
        Ok((h, status))
    }

    /// Loads a mask: one weight per bone (not finite counts as 0).
    pub fn load_mask(&mut self, weights: &[f32]) -> Result<u32, u32> {
        if weights.len() > MAX_ASSETS {
            return Err(STATUS_TOO_LARGE);
        }
        let clean: Vec<f32> = weights
            .iter()
            .map(|w| if w.is_finite() { *w } else { 0.0 })
            .collect();
        let mut packed = vec![F32x4::splat(0.0); soa_len(clean.len())];
        anim_pose::blend::pack_mask(&clean, &mut packed);
        self.insert(Asset::Mask(MaskAsset {
            bones: clean.len(),
            packed,
        }))
    }

    /// T70: loads an engine curve (`anim_sample::curve`'s keys, 7 floats each).
    pub fn load_curve(&mut self, keys: &[f32]) -> Result<u32, u32> {
        match parse_keys(keys) {
            Ok(k) => self.insert(Asset::Curve(k)),
            Err(CurveError::TooLarge) => Err(STATUS_TOO_LARGE),
            Err(CurveError::Malformed) => Err(STATUS_BAD_ASSET),
        }
    }

    /// T70: the keys of curve `handle`.
    pub fn curve(&self, handle: u32) -> Result<&[Key<f32>], u32> {
        match self.get(handle)? {
            Asset::Curve(k) => Ok(k),
            _ => Err(STATUS_WRONG_KIND),
        }
    }

    /// Binds string id `id` of graph `graph` to `asset` (0 unbinds). Instances created afterwards
    /// resolve their clip and mask references through it.
    pub fn bind(&mut self, graph: u32, id: u32, asset: u32) -> u32 {
        if asset != 0 {
            match self.get(asset) {
                Ok(Asset::Clip(_)) | Ok(Asset::Mask(_)) | Ok(Asset::Graph(_)) => {}
                // T41: a retarget map, for the `retarget` node.
                Ok(Asset::Retarget(r)) if r.is_map() => {}
                // T42 pose databases, T45 plugin modules.
                Ok(Asset::PoseDb(_)) | Ok(Asset::Plugin(_)) => {}
                Ok(_) => return STATUS_WRONG_KIND,
                Err(e) => return e,
            }
        }
        match self.get_mut(graph) {
            Ok(Asset::Graph(g)) => match g.bindings.get_mut(id as usize) {
                Some(b) => {
                    *b = asset;
                    STATUS_OK
                }
                None => STATUS_MISMATCH,
            },
            Ok(_) => STATUS_WRONG_KIND,
            Err(e) => e,
        }
    }

    /// The byte address of a graph's or clip's file block (for host views), 0 for other kinds.
    pub fn bytes_addr(&self, handle: u32) -> usize {
        match self.get(handle) {
            Ok(Asset::Clip(c)) => c.bytes.addr(),
            Ok(Asset::Graph(g)) => g.bytes.addr(),
            _ => 0,
        }
    }
}

impl Assets for Arena {
    fn cache_epoch(&self) -> u32 {
        self.epoch
    }

    fn clip(&self, handle: u32) -> Option<ClipRef<'_>> {
        let c = self.clip_asset(handle).ok()?;
        Some(ClipRef {
            bound: c.bound()?,
            duration: c.duration,
            looping: c.flags & CLIP_LOOP != 0,
            additive: c.flags & CLIP_ADDITIVE != 0,
            root_curve: c.root_curve,
            sample_rate: c.sample_rate,
            frame_count: c.frame_count,
            root_bone: c.root_bone,
            sync: &c.sync,
            exits: &c.exits,
            curves: &c.curves,
            cues: &c.cues,
            distance: &c.distance,
        })
    }

    fn graph(&self, handle: u32) -> Option<GraphRef<'_>> {
        let g = self.graph(handle).ok()?;
        Some(GraphRef {
            program: &g.program,
            bindings: &g.bindings,
        })
    }

    fn mask(&self, handle: u32) -> Option<&[F32x4]> {
        self.mask_asset(handle).ok().map(|m| m.packed.as_slice())
    }

    // T41: retarget maps for the `retarget` node family.
    fn retarget(&self, handle: u32) -> Option<anim_graph::retarget::RetargetRef<'_>> {
        match self.get(handle).ok()? {
            Asset::Retarget(r) => r.node_ref(),
            _ => None,
        }
    }

    // T42: pose databases (`crate::matching`).
    fn match_db(&self, handle: u32) -> Option<anim_graph::matching::MatchRef<'_>> {
        crate::matching::match_ref(self, handle)
    }

    // T45: the plugin host (`crate::plugin`).
    fn plugins(&self) -> Option<&dyn anim_graph::plugin::PluginHost> {
        Some(self)
    }
}

/// A clip's sync markers (ids = name hashes, sorted by time), exit-marker times (sorted) and curve
/// tracks (name hash, track index), for the graph (T31).
#[allow(clippy::type_complexity)]
fn marker_tables(view: &ClipView<'_>) -> (Vec<SyncMarker>, Vec<f32>, Vec<(u32, u32)>) {
    let strings = view.strings();
    let hash = |id: u32| strings.get(id).map_or(0, name_hash);
    let mut sync = Vec::new();
    let mut exits = Vec::new();
    let mut curves = Vec::new();
    for t in 0..view.track_count() {
        let Some(info) = view.track(t) else {
            continue;
        };
        if info.kind == TrackKind::Curve {
            curves.push((hash(info.binding.field), t as u32));
        }
        for key in view.track_keys(t) {
            match key.data {
                KeyData::Marker {
                    kind: MarkerKind::Sync,
                    name,
                } => sync.push(SyncMarker {
                    id: hash(name),
                    time: key.time,
                }),
                KeyData::Marker {
                    kind: MarkerKind::Exit,
                    ..
                } => exits.push(key.time),
                _ => {}
            }
        }
    }
    sort_small(&mut sync, |a, b| a.time < b.time);
    sort_small(&mut exits, |a, b| a < b);
    (sync, exits, curves)
}

/// T40: a clip's cue markers (ids = name hashes, sorted by time), for motion-warp windows.
fn cue_table(view: &ClipView<'_>) -> Vec<SyncMarker> {
    let strings = view.strings();
    let mut cues = Vec::new();
    for t in 0..view.track_count() {
        for key in view.track_keys(t) {
            if let KeyData::Marker {
                kind: MarkerKind::Cue,
                name,
            } = key.data
            {
                cues.push(SyncMarker {
                    id: strings.get(name).map_or(0, name_hash),
                    time: key.time,
                });
            }
        }
    }
    sort_small(&mut cues, |a, b| a.time < b.time);
    cues
}

/// T40: the root curve's cumulative ground travel (up +Y) per frame, for distance matching.
fn travel(view: &ClipView<'_>) -> Vec<f32> {
    let Some(curve) = view.root_curve() else {
        return Vec::new();
    };
    let frames = view.frame_count() as usize;
    let positions: Vec<AosVec3> = (0..frames)
        .filter_map(|f| {
            Some(AosVec3::new(
                curve.get(4 * f)?,
                curve.get(4 * f + 1)?,
                curve.get(4 * f + 2)?,
            ))
        })
        .collect();
    let mut out = vec![0.0; positions.len()];
    anim_rig::warp::cumulative_distance(&positions, AosVec3::new(0.0, 1.0, 0.0), &mut out);
    out
}

/// T40: a joint limit per bone (from `JOINT_RANGES` against the rest rotation; free without a
/// range) and the bone of each profile role, for the rig nodes.
fn rig_tables(view: &SkeletonView<'_>, rest: &[AosTransform]) -> (Vec<JointLimit>, Vec<u16>) {
    let n = view.bone_count();
    let limits = (0..n)
        .map(|i| match view.joint_range(i) {
            Some(r) => JointLimit::from_range(rest[i].rotation, &r),
            None => JointLimit::FREE,
        })
        .collect();
    let mut roles = Vec::new();
    for i in 0..n {
        if let Some(r) = view.role(i) {
            let r = r as usize;
            if roles.len() <= r {
                roles.resize(r + 1, anim_graph::rig::NO_BONE);
            }
            roles[r] = i as u16;
        }
    }
    (limits, roles)
}

/// The local bind pose: each bone's model bind transform (the inverse of its inverse bind matrix,
/// decomposed into translation, rotation and per-axis scale) relative to its parent's. A bone whose
/// matrix is singular keeps its rest transform. Load time only.
fn bind_pose(
    parents: &[u16],
    inverse_bind: &[AosMat3x4],
    rest: &[AosTransform],
) -> Vec<AosTransform> {
    let model: Vec<Option<AosTransform>> = inverse_bind
        .iter()
        .map(|ib| {
            let fallback = AosMat3x4 { m: [f32::NAN; 12] };
            let m = ib.inverse_or(fallback).m;
            if m.iter().any(|v| !v.is_finite()) {
                return None;
            }
            let col = |c: usize| [m[c] as f64, m[4 + c] as f64, m[8 + c] as f64];
            let (c0, c1, c2) = (col(0), col(1), col(2));
            let len = |v: [f64; 3]| (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
            let (sx, sy, sz) = (len(c0), len(c1), len(c2));
            if sx <= 0.0 || sy <= 0.0 || sz <= 0.0 {
                return None;
            }
            let r = [
                [c0[0] / sx, c1[0] / sy, c2[0] / sz],
                [c0[1] / sx, c1[1] / sy, c2[1] / sz],
                [c0[2] / sx, c1[2] / sy, c2[2] / sz],
            ];
            // Rotation matrix to quaternion (Shepperd's method).
            let tr = r[0][0] + r[1][1] + r[2][2];
            let (x, y, z, w) = if tr > 0.0 {
                let s = (tr + 1.0).sqrt() * 2.0;
                (
                    (r[2][1] - r[1][2]) / s,
                    (r[0][2] - r[2][0]) / s,
                    (r[1][0] - r[0][1]) / s,
                    0.25 * s,
                )
            } else if r[0][0] > r[1][1] && r[0][0] > r[2][2] {
                let s = (1.0 + r[0][0] - r[1][1] - r[2][2]).sqrt() * 2.0;
                (
                    0.25 * s,
                    (r[0][1] + r[1][0]) / s,
                    (r[0][2] + r[2][0]) / s,
                    (r[2][1] - r[1][2]) / s,
                )
            } else if r[1][1] > r[2][2] {
                let s = (1.0 + r[1][1] - r[0][0] - r[2][2]).sqrt() * 2.0;
                (
                    (r[0][1] + r[1][0]) / s,
                    0.25 * s,
                    (r[1][2] + r[2][1]) / s,
                    (r[0][2] - r[2][0]) / s,
                )
            } else {
                let s = (1.0 + r[2][2] - r[0][0] - r[1][1]).sqrt() * 2.0;
                (
                    (r[0][2] + r[2][0]) / s,
                    (r[1][2] + r[2][1]) / s,
                    0.25 * s,
                    (r[1][0] - r[0][1]) / s,
                )
            };
            Some(AosTransform::new(
                anim_math::AosVec3::new(m[3], m[7], m[11]),
                anim_math::AosQuat::new(x as f32, y as f32, z as f32, w as f32)
                    .normalize_or_identity(),
                anim_math::AosVec3::new(sx as f32, sy as f32, sz as f32),
            ))
        })
        .collect();
    (0..parents.len())
        .map(|i| {
            let Some(mi) = model[i] else {
                return rest[i];
            };
            let p = parents[i];
            if p == anim_format::skeleton::NO_PARENT || p as usize >= model.len() {
                return mi;
            }
            match model[p as usize] {
                Some(mp) => mp.inverse().compose(mi),
                None => rest[i],
            }
        })
        .collect()
}
