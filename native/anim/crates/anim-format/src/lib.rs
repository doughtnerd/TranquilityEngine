//! `anim-format` (ADR 0340, 0341): binary layouts for `myco.anim@1` clips, `myco.skel@1`
//! skeletons, `myco.animgraph@1` compiled graphs and `myco.posedb@1` pose databases.
//!
//! Flat, little-endian, `repr(C)`, 4-byte aligned, so TypeScript reads them as typed-array views
//! without copying.
//!
//! Stub (T02). Filled by T03r.
