//! `anim-compress` (ADR 0340, 0341): the compressor. Uniform sampling, range reduction, a bit rate
//! per track chosen against an object-space error bound, as ACL does.
//!
//! Used by the editor's worker and by exports, never at runtime (it isn't linked into anim-wasm's
//! runtime module).
//!
//! Stub (T02). Filled by T11.
