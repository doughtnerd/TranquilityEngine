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

pub mod clips;
pub mod core;
pub mod counters;
pub mod layout;
pub mod panner;
pub mod params;
pub mod scheduler;
pub mod status;
pub mod voices;

pub use crate::core::Core;
pub use crate::layout::{Layout, Region, RegionKind, REGION_ALIGN, REGION_ORDER};
pub use crate::params::{InitError, InitParams};

/// Frames per render quantum: `process` renders exactly this many (Web Audio's quantum).
pub const QUANTUM: usize = 128;

/// Output channels: `process` writes planar stereo, `[L; 128][R; 128]`.
pub const OUTPUT_CHANNELS: usize = 2;
