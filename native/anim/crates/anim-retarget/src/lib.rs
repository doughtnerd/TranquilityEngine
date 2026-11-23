//! `anim-retarget` (ADR 0370, 0371, 0372): skeleton profiles, chain mapping, rest-pose
//! compensation, runtime and offline retargeting.
//!
//! Internal to the animation core: nothing here is engine public API (ADR 0010). The graph's
//! `retarget` node family (`anim-graph::retarget`) calls it at runtime; the editor's bake and
//! bone-map tools call it through `anim-wasm`. Tested against `anim-offline::retarget`.
//!
//! - [`profile`]: the [`Profile`] model (roles, chains, joint-range defaults, mirror pairs and
//!   flips), the built-in [`Profile::humanoid`], and the per-skeleton [`BoneMap`];
//! - [`encode`]: the byte layout TypeScript passes custom profiles in, parsed with validation;
//! - [`guess`]: [`guess_bone_map`], name heuristics plus topology checks;
//! - [`map`]: the [`RetargetMap`] precomputed at load and the per-frame
//!   [`RetargetMap::retarget`] (chain transfer, root scaling, IK goals and the pinning pass),
//!   which never allocates;
//! - [`bake`]: the offline bake of a whole clip.

// `!(x > 0.0)` is deliberate: it is true for NaN as well, which `x <= 0.0` is not.
#![allow(clippy::neg_cmp_op_on_partial_ord)]
#![allow(clippy::needless_range_loop)]

pub mod bake;
pub mod encode;
pub mod guess;
pub mod map;
pub mod profile;

pub use guess::guess_bone_map;
pub use map::{
    ChainInfo, GoalInfo, MapError, MapSettings, RetargetError, RetargetMap, RetargetOptions,
    RetargetScratch, RootAxis, Side, Skeleton,
};
pub use profile::{BoneMap, Chain, ChainKind, Profile, ProfileError, Role, NO_BONE};
