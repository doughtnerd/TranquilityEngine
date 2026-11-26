//! `myco-tween` (ADR 0420 spike): Myco's tweening, shared by the animation core (`anim-wasm`, which
//! links it unchanged in behaviour) and the standalone tween module (`native/tween`) that UI uses
//! without the animation plugin. Same records, same results, either way.
//!
//! | Module | What | Moved from |
//! |---|---|---|
//! | [`wire`] | the `tween` wire family (records, constants, vectors) | `anim-wire/src/tween.rs` (re-exported as `anim_wire::tween`) |
//! | [`ease`] | the Penner easings by id | `anim-math/src/ease.rs` (its `exp2` stayed in `anim_math::trig`) |
//! | [`spec`] | [`Spec`], one tween's value function, and the [`Curves`] host interface | `anim-wasm/src/tweens.rs` |
//! | [`table`] | [`Tweens`], the tween table | `anim-wasm/src/tweens.rs` |
//! | [`seq`] | sequence and parallel programs (members, evaluation, completion order) | `anim-wasm/src/timeline.rs` |
//! | [`curves`] | the curve key parser and [`curves::CurveStore`] | `anim-sample/src/curve.rs` (parser) |
//! | [`host`] | statuses, passes, the handle layout (`anim-wire` core's values) | — |
//!
//! # Host interfaces
//!
//! Generic, never dynamic: the curve lookup is the [`Curves`] type parameter of [`Spec::eval`] and
//! [`Tweens::update`], monomorphised into each module (the animation core's asset arena, the
//! standalone module's [`curves::CurveStore`]); no trait objects on the per-frame path. Memory is
//! the global allocator's, taken once when the table is sized ([`Tweens::new`]);
//! [`Tweens::bytes_for`] tells a host what that costs (the animation core adds it to `init`'s
//! `bytes_needed`).
//!
//! `no_std` with `alloc`. Dependencies: `myco-wire` (the record mechanism), `myco-curve` (the curve
//! evaluator), `anim-math` (`AosQuat` nlerp/slerp and the deterministic `sin_cos`/`exp2`).

#![no_std]

extern crate alloc;

pub mod curves;
pub mod ease;
pub mod host;
pub mod seq;
pub mod spec;
pub mod table;
pub mod wire;

pub use spec::{Curves, Eval, Spec};
pub use table::{Tweens, MAX_TWEENS};
