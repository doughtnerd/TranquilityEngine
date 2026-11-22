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
//! | skeleton (`myco.skel@1`) | parents, rest pose (AoS and packed SoA), identity pose, inverse bind matrices |
//! | clip (`myco.anim@1`) | a sampler over its compressed form (else its raw form) with its binding table (`anim-sample`'s `ClipBindings`: decoded channel, track and key tables, so sampling and track windows don't re-read records), duration, flags, root curve |
//! | graph (`myco.animgraph@1`) | its [`Program`] and a binding table (an asset handle per string id) |
//! | mask | per-bone weights packed like a pose |
//!
//! The parsed views borrow the asset's own block for as long as the asset lives (the block never
//! moves and is freed after the views, when the slot is cleared).

use core::ptr::NonNull;
use std::alloc::{alloc, dealloc, Layout};

use anim_format::clip::{ClipView, CLIP_ADDITIVE, CLIP_LOOP};
use anim_format::graph::AnimGraphView;
use anim_format::skeleton::SkeletonView;
use anim_format::F32s;
use anim_graph::eval::{Assets, ClipRef, Program};
use anim_math::layout::{pack_pose, soa_len};
use anim_math::{AosMat3x4, AosTransform, F32x4, SoaTransform};
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
}

impl ClipAsset {
    /// The sampler paired with the binding table.
    pub fn bound(&self) -> Option<BoundClip<'_, '_>> {
        self.bindings.bind(self.sampler).ok()
    }
}

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
        }
    }

    /// Bytes of asset files the arena holds.
    pub fn held_bytes(&self) -> usize {
        self.held
    }

    fn insert(&mut self, asset: Asset) -> Result<u32, u32> {
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

    fn get_mut(&mut self, handle: u32) -> Result<&mut Asset, u32> {
        let (index, generation) = split(handle);
        match self.slots.get_mut(index) {
            Some(Slot {
                generation: g,
                asset: Some(a),
            }) if *g == generation => Ok(a),
            _ => Err(STATUS_STALE_HANDLE),
        }
    }

    pub fn skeleton(&self, handle: u32) -> Result<&SkeletonAsset, u32> {
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
        self.insert(Asset::Skeleton(SkeletonAsset {
            parents,
            rest,
            rest_soa,
            identity: vec![AosTransform::identity(); n],
            inverse_bind,
        }))
    }

    /// Loads a `myco.anim@1` file.
    pub fn load_clip(&mut self, bytes: &[u8]) -> Result<u32, u32> {
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
        bindings.bind(sampler).map_err(|_| STATUS_BAD_ASSET)?;
        let held = block.len;
        let asset = ClipAsset {
            sampler,
            bindings,
            root_curve: view.root_curve(),
            duration: view.duration(),
            flags: view.flags(),
            sample_rate: view.sample_rate(),
            frame_count: view.frame_count(),
            bone_count: view.bone_count(),
            root_bone: view.root_bone(),
            bytes: block,
        };
        let h = self.insert(Asset::Clip(asset))?;
        self.held += held;
        Ok(h)
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

    /// Binds string id `id` of graph `graph` to `asset` (0 unbinds). Instances created afterwards
    /// resolve their clip and mask references through it.
    pub fn bind(&mut self, graph: u32, id: u32, asset: u32) -> u32 {
        if asset != 0 {
            match self.get(asset) {
                Ok(Asset::Clip(_)) | Ok(Asset::Mask(_)) => {}
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
        })
    }

    fn mask(&self, handle: u32) -> Option<&[F32x4]> {
        self.mask_asset(handle).ok().map(|m| m.packed.as_slice())
    }
}
