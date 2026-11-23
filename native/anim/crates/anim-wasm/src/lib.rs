//! `anim-wasm` (ADR 0350): the animation core's WebAssembly boundary. One module instance per page,
//! shared by every World; TypeScript makes a fixed number of calls per frame, never one per
//! character. wasm-bindgen glue is for setup calls only; per-frame data moves through views on
//! wasm memory laid out by `anim-wire`.
//!
//! One module per feature, so the task that owns a feature changes only its file. Each feature
//! reports the memory it needs for the init parameters (`bytes_needed`), summed by [`init`].
//!
//! | Module | Feature | Owner |
//! |---|---|---|
//! | [`init`] | `init` (init record → memory needed) and `source_hash` | T02, T13r |
//! | [`assets`] | the pooled asset arena: load and release | T13r |
//! | [`instances`] | the instance table (index plus generation), snapshot and restore, LOD fields | T13r |
//! | [`evaluate`] | `write_inputs`, `evaluate`, output views | T13r |
//! | [`tracks`] | property and event track outputs | T20r |
//! | [`graph`] | graph assets, parameters, requests, slots | T31 |
//! | [`rig`] | rig targets, grounder rays and hits | T40 |
//! | [`retarget`] | retarget maps, `guess_bone_map` | T41 |
//! | [`matching`] | pose databases and matching (`match` is a Rust keyword) | T42 |
//! | [`tweens`] | the tween table | T22r |
//! | [`timeline`] | timeline programs | T22r |
//! | [`physics`] | drive-target outputs | T44r |
//! | [`plugin`] | third-party node modules | T45 |
//! | [`debug`] | graph debug records | T31 |

pub mod init;

pub mod assets;
pub mod debug;
pub mod evaluate;
pub mod graph;
pub mod instances;
pub mod matching;
pub mod physics;
pub mod plugin;
pub mod retarget;
pub mod rig;
pub mod timeline;
pub mod tracks;
pub mod tweens;
