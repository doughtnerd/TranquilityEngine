//! `anim-plugin-sdk` (ADR 0340, "Third-party graph and rig nodes"): the small C ABI a plugin's node
//! module implements (pose in, parameters in, pose out) and the Rust SDK for writing one.
//!
//! A node is a wasm module with its own memory and no imports, declared in the plugin's
//! `plugin.json`. The core calls it inside graph evaluation (`anim-graph::plugin`); faults pass the
//! input pose through and report once (audio 0338's model).
//!
//! `no_std`, so plugin modules stay small. Stub (T02). Filled by T45.
#![no_std]
