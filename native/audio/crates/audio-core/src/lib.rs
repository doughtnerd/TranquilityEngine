//! The mixer of Myco's audio core (ADR 0157, api-and-models §5).
//!
//! `Core` owns every piece of mixer state: voice slots, the bus tree, the slab arena, the scheduler,
//! command and REPLAY apply, the status writer and the adaptive cap. It does no I/O and keeps no
//! globals: the wasm boundary (`audio-wasm`) hands it one block of linear memory carved by
//! [`Layout`], and calls it. Native tests build a `Core` over a heap buffer the same way.
//!
//! M1a.0 (task A0.1) is the skeleton: the init parameters, the deterministic memory layout and a
//! `process` that renders silence. Later tasks add modules beside these (A0.3 `status`/`counters`,
//! A1.2 `voices`/`scheduler`/`panner`/`clips`, A1.3b `arena`, A2.1 `bus`/`fx`), each in its own file.
//!
//! 0166 M4 (Q1's skeletons; tree A1–A5, A27): `due` (Z2a), `curves` (Z2b), `voice_split` (Z2c),
//! `groups` (C2a, C2b), `group_hold` (C2c), `group_rebase` (C2d). This module list is final for M4.
//!
//! 0171/0172 M5 (K1's skeletons; plan contract K1): `lanes` (the gain stage and BUS_MIX, moved
//! from `bus.rs`; B1a, B1b), `bus_order` (the mix order; B3), `bus_slots` (per-slot configuration;
//! B2), `duck` (the duck lane; B3, Dp1, Sc1), `loudness` (meters; Ld2, Ld7). `bus.rs` calls them as
//! stage hooks; `scheduler.rs` dispatches the M5 opcodes to them. This module list is final for M5.

pub mod arena;
pub mod automation;
pub mod bed;
pub mod bus;
pub mod bus_order;
pub mod bus_slots;
pub mod cap;
pub mod cap_controller;
pub mod chain;
pub mod clips;
pub mod core;
pub mod counters;
pub mod curves;
pub mod duck;
pub mod due;
pub mod fx;
pub mod fxpool;
pub mod group_hold;
pub mod group_rebase;
pub mod groups;
pub mod lanes;
pub mod layout;
pub mod listener;
pub mod loudness;
pub mod meters;
pub mod panner;
pub mod params;
pub mod scheduler;
pub mod sends;
pub mod status;
pub mod stream;
pub mod voice_split;
pub mod voices;
mod wire_read;
pub mod zones;

pub use crate::core::Core;
pub use crate::layout::{Layout, Region, RegionKind, REGION_ALIGN, REGION_ORDER};
pub use crate::params::{InitError, InitParams};

/// Frames per render quantum: `process` renders exactly this many (Web Audio's quantum).
pub const QUANTUM: usize = 128;

/// Output channels: `process` writes planar stereo, `[L; 128][R; 128]`.
pub const OUTPUT_CHANNELS: usize = 2;
