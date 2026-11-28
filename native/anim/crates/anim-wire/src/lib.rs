//! `anim-wire` (ADR 0370): the animation core's boundary records, defined once.
//!
//! The record mechanism ([`record`]: fixed-stride, little-endian, versioned rows, declared with
//! [`wire_record!`]) is shared; each **family** has its own module and its own version, so the
//! task that owns a family changes only its file:
//!
//! | Family | Module | Id | Owner |
//! |---|---|---|---|
//! | init, memory and the frame calls | [`core`] | 1 | T02, T13r |
//! | track outputs | [`tracks`] | 2 | T20r |
//! | graph inputs and state | [`graph`] | 3 | T31 |
//! | rig targets, ray requests and hits | [`rig`] | 4 | T40 |
//! | motion matching | [`r#match`] | 5 | T42 |
//! | tweens | [`tween`] | 6 | T22r |
//! | timelines | [`timeline`] | 7 | T22r |
//! | physical-animation drive targets | [`physics`] | 8 | T44r |
//! | third-party nodes | [`plugin`] | 9 | T45 |
//! | debug records | [`debug`] | 10 | T31 |
//!
//! The generator ([`gen`], binary `gen_wire`) writes one TypeScript constants file per family to
//! `src/plugins/animation/runtime/wasm/wire/<family>.ts` and its byte vectors to
//! `vectors/<family>.json`; the Vitest round-trip test reads both.
//!
//! The record mechanism lives in `myco-wire` (`native/common/wire`) and the `tween` family in
//! `myco-tween` (`native/common/tween`), both re-exported here unchanged (ADR 0424 spike), so
//! `anim_wire::record`, `anim_wire::wire_record!` and `anim_wire::tween` read as before.

pub mod gen;
pub use myco_wire::{record, vector, wire_record};

pub mod core;
pub mod debug;
pub mod graph;
pub mod r#match;
pub mod physics;
pub mod plugin;
pub mod rig;
pub mod timeline;
pub mod tracks;
pub use myco_tween::wire as tween;

pub use record::{
    opcode, Const, FamilyDesc, RecordDesc, Scalar, Value, WireError, WireRecord, WireScalar,
};
pub use vector::Vector;

/// Every family, in id order. Written once (T02); a family adds records inside its own module.
pub const FAMILIES: [&FamilyDesc; 10] = [
    &core::FAMILY,
    &tracks::FAMILY,
    &graph::FAMILY,
    &rig::FAMILY,
    &r#match::FAMILY,
    &tween::FAMILY,
    &timeline::FAMILY,
    &physics::FAMILY,
    &plugin::FAMILY,
    &debug::FAMILY,
];

// The tween crate's host codes are this boundary's (`myco_tween::host`): the standalone tween
// module must answer exactly as the core does.
const _: () = {
    use myco_tween::host as h;
    assert!(h::STATUS_OK == core::STATUS_OK);
    assert!(h::STATUS_BAD_RECORD == core::STATUS_BAD_RECORD);
    assert!(h::STATUS_TOO_LARGE == core::STATUS_TOO_LARGE);
    assert!(h::STATUS_BAD_ASSET == core::STATUS_BAD_ASSET);
    assert!(h::STATUS_FULL == core::STATUS_FULL);
    assert!(h::STATUS_STALE_HANDLE == core::STATUS_STALE_HANDLE);
    assert!(h::PASS_NORMAL == core::PASS_NORMAL);
    assert!(h::PASS_FIXED == core::PASS_FIXED);
    assert!(h::HANDLE_INDEX_MASK == core::HANDLE_INDEX_MASK);
    assert!(h::HANDLE_GENERATION_SHIFT == core::HANDLE_GENERATION_SHIFT);
};
