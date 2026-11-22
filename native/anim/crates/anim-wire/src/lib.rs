//! `anim-wire` (ADR 0340): the animation core's boundary records, defined once.
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
//! Std only, no dependencies.

pub mod gen;
pub mod record;
pub mod vector;

pub mod core;
pub mod debug;
pub mod graph;
pub mod r#match;
pub mod physics;
pub mod plugin;
pub mod rig;
pub mod timeline;
pub mod tracks;
pub mod tween;

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
