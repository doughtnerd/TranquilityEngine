//! `anim-meter` (ADR 0340, "Third-party graph and rig nodes"; audio 0338): the instruction-budget
//! (fuel) pass. It checks a third-party node module against the node ABI
//! (`anim_plugin_sdk::abi`) and rewrites it at load so that it counts the work it does and stops at
//! its budget.
//!
//! Compiled into the editor's loader wasm in Phase B, not into the runtime module: `no_std` with
//! `alloc`, on `wasmparser` and `wasm-encoder`.
//!
//! # Validation ([`validate`])
//!
//! A module is refused unless:
//!
//! - it is at most [`Limits::max_module_bytes`] long and **valid** under the allowed proposal set
//!   [`ALLOWED_FEATURES`]: Wasm 2.0 (mutable globals, sign extension, saturating float-to-int,
//!   multi-value, bulk memory, reference types, **simd128**) plus `extended-const`. Everything
//!   else is refused, notably threads and shared memory, relaxed SIMD (its results differ between
//!   machines, so it breaks the deterministic-maths rule), multi-memory, memory64, exception
//!   handling, tail calls, typed function references, GC, custom page sizes, wide arithmetic,
//!   stack switching and the component model;
//! - it has **no imports** and **no start function** (a start function would run at
//!   instantiation, outside any budget);
//! - it defines exactly **one memory**, exported as `memory`, whose initial size is at most
//!   [`Limits::max_memory_pages`] and whose maximum, if declared, is too (one without a maximum
//!   gets the limit as its maximum when metered);
//! - its exports are exactly the ABI's four functions with their signatures, the memory, and
//!   any number of **immutable** globals (tables, mutable globals and other functions are refused);
//! - it isn't metered already: a `myco_fuel*` export or a [`MARKER_SECTION`] means
//!   [`MeterError::AlreadyMetered`], so metering twice is refused, never double-counted.
//!
//! # Metering ([`meter`])
//!
//! The pass appends a mutable `i64` global, the fuel counter (0 at instantiation, so nothing runs
//! until the host sets a budget), and two exports:
//!
//! - [`FUEL_SET`] `(i64) -> ()` sets the counter (the budget for the next call);
//! - [`FUEL_GET`] `() -> i64` reads it: budget minus consumption after a call, negative after
//!   the module trapped for running out.
//!
//! Every function body is split into **metered blocks**: straight-line runs that end at a branch
//! or at a place a branch can land just after ([`cost::ends_block`]). At the start of each block
//! with a non-zero cost, the pass inserts `fuel -= cost; if fuel < 0 { unreachable }`, where the
//! cost is the sum of the block's static weights ([`cost`]). A loop's body is a block that starts
//! at its header, so every iteration pays for itself. Bulk memory and table instructions, and
//! `memory.grow`, also pay a dynamic charge from their length operand just before they run. A
//! budget of exactly a call's consumption succeeds; one unit less traps.
//!
//! Appending (globals, types, functions, exports) shifts no existing index, so the rest of the
//! module is copied unchanged except the memory's maximum. Custom sections other than `name` are
//! dropped, and a [`MARKER_SECTION`] holding [`METER_VERSION`] is added at the end. The output is
//! validated again and is **deterministic**: the same input and limits give the same bytes.
#![no_std]

extern crate alloc;

pub mod cost;
mod rewrite;

use alloc::string::String;
use anim_plugin_sdk::abi;
use wasmparser::{ExternalKind, Payload, ValType, WasmFeatures};

/// The pass's version: its weights, its inserted code and its marker. Stored in the marker.
pub const METER_VERSION: u32 = 1;
/// The export that sets the fuel counter: `(i64) -> ()`.
pub const FUEL_SET: &str = "myco_fuel_set";
/// The export that reads the fuel counter: `() -> i64`.
pub const FUEL_GET: &str = "myco_fuel_get";
/// The custom section a metered module carries: [`METER_VERSION`], `u32` little-endian.
pub const MARKER_SECTION: &str = "myco.metered";

/// The proposals a node module may use: Wasm 2.0 (with simd128) plus `extended-const`.
pub const ALLOWED_FEATURES: WasmFeatures = WasmFeatures::WASM2.union(WasmFeatures::EXTENDED_CONST);

/// Load limits. Tripwires against runaway modules, not design limits: raise them with a reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    /// The memory's largest size in 64 KiB pages (initial, declared maximum, and the maximum given
    /// to a module that declares none). Default 256 (16 MiB).
    pub max_memory_pages: u32,
    /// The module's largest size in bytes. Default 8 MiB.
    pub max_module_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self { max_memory_pages: 256, max_module_bytes: 8 << 20 }
    }
}

/// Why a module was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MeterError {
    /// Longer than [`Limits::max_module_bytes`].
    TooLarge { bytes: usize, limit: usize },
    /// Malformed, invalid, or using a proposal outside [`ALLOWED_FEATURES`] (the validator's
    /// message).
    Invalid(String),
    /// The module imports something (the first import's `module.name`).
    Import(String),
    /// The module has a start function.
    StartFunction,
    /// The module defines no memory or more than one.
    MemoryCount(u32),
    /// The memory isn't exported as `memory`.
    MemoryNotExported,
    /// The memory's initial size or declared maximum is over the limit (pages).
    MemoryTooLarge { pages: u64, limit: u32 },
    /// An export the ABI doesn't allow (its name).
    Export(String),
    /// A required ABI function isn't exported.
    MissingExport(&'static str),
    /// A required ABI function has the wrong signature.
    Signature(&'static str),
    /// The module is metered already.
    AlreadyMetered,
    /// The rewritten module failed validation: a bug in the pass.
    Internal(String),
}

impl core::fmt::Display for MeterError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            MeterError::TooLarge { bytes, limit } => write!(f, "module is {bytes} bytes, over the {limit}-byte limit"),
            MeterError::Invalid(m) => write!(f, "invalid or unsupported module: {m}"),
            MeterError::Import(n) => write!(f, "node modules have no imports, found {n}"),
            MeterError::StartFunction => f.write_str("node modules have no start function"),
            MeterError::MemoryCount(n) => write!(f, "node modules define exactly one memory, found {n}"),
            MeterError::MemoryNotExported => f.write_str("the memory must be exported as \"memory\""),
            MeterError::MemoryTooLarge { pages, limit } => write!(f, "memory of {pages} pages is over the {limit}-page limit"),
            MeterError::Export(n) => write!(f, "export \"{n}\" isn't part of the node ABI"),
            MeterError::MissingExport(n) => write!(f, "missing export \"{n}\""),
            MeterError::Signature(n) => write!(f, "export \"{n}\" has the wrong signature"),
            MeterError::AlreadyMetered => f.write_str("module is metered already"),
            MeterError::Internal(m) => write!(f, "metering produced an invalid module (a bug): {m}"),
        }
    }
}

/// What [`validate`] learned about an accepted module.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModuleInfo {
    /// Functions the module defines.
    pub functions: u32,
    /// The memory's initial pages.
    pub memory_initial: u32,
    /// The memory's maximum pages once metered (declared, or the limit).
    pub memory_maximum: u32,
}

fn invalid(e: wasmparser::BinaryReaderError) -> MeterError {
    use alloc::string::ToString;
    MeterError::Invalid(e.to_string())
}

/// Whether `bytes` carries the marker section or a reserved (`myco_fuel*`) export. Unparseable
/// input is not metered.
pub fn is_metered(bytes: &[u8]) -> bool {
    for payload in wasmparser::Parser::new(0).parse_all(bytes) {
        match payload {
            Ok(Payload::CustomSection(c)) if c.name() == MARKER_SECTION => return true,
            Ok(Payload::ExportSection(exports)) => {
                for e in exports.into_iter().flatten() {
                    if e.name.starts_with(abi::RESERVED_PREFIX) {
                        return true;
                    }
                }
            }
            Ok(_) => {}
            Err(_) => return false,
        }
    }
    false
}

/// The ABI functions' signatures: (params, results).
fn expected_signature(name: &str) -> (&'static [ValType], &'static [ValType]) {
    use ValType::{F32, I32};
    match name {
        abi::ABI_VERSION_FN | abi::DESCRIBE => (&[], &[I32]),
        abi::ALLOC => (&[I32], &[I32]),
        _ => (&[I32, I32, I32, I32, I32, I32, I32, I32, F32], &[I32]),
    }
}

/// Checks `bytes` against the node ABI and the allowed features (see the crate docs).
pub fn validate(bytes: &[u8], limits: &Limits) -> Result<ModuleInfo, MeterError> {
    if bytes.len() > limits.max_module_bytes {
        return Err(MeterError::TooLarge { bytes: bytes.len(), limit: limits.max_module_bytes });
    }
    if is_metered(bytes) {
        return Err(MeterError::AlreadyMetered);
    }
    wasmparser::Validator::new_with_features(ALLOWED_FEATURES).validate_all(bytes).map_err(invalid)?;

    let mut types = alloc::vec::Vec::new();
    let mut func_types = alloc::vec::Vec::new();
    let mut global_mutable = alloc::vec::Vec::new();
    let mut memories = alloc::vec::Vec::new();
    let mut found = [false; 4];
    let mut memory_exported = false;
    for payload in wasmparser::Parser::new(0).parse_all(bytes) {
        match payload.map_err(invalid)? {
            Payload::TypeSection(r) => {
                for t in r.into_iter_err_on_gc_types() {
                    types.push(t.map_err(invalid)?);
                }
            }
            Payload::ImportSection(r) => {
                use alloc::format;
                if let Some(first) = r.into_imports().next() {
                    let i = first.map_err(invalid)?;
                    return Err(MeterError::Import(format!("{}.{}", i.module, i.name)));
                }
            }
            Payload::FunctionSection(r) => {
                for t in r {
                    func_types.push(t.map_err(invalid)?);
                }
            }
            Payload::MemorySection(r) => {
                for m in r {
                    memories.push(m.map_err(invalid)?);
                }
            }
            Payload::GlobalSection(r) => {
                for g in r {
                    global_mutable.push(g.map_err(invalid)?.ty.mutable);
                }
            }
            Payload::StartSection { .. } => return Err(MeterError::StartFunction),
            Payload::ExportSection(r) => {
                for e in r {
                    let e = e.map_err(invalid)?;
                    let refuse = || MeterError::Export(String::from(e.name));
                    match e.kind {
                        ExternalKind::Func => {
                            let slot = abi::REQUIRED_EXPORTS.iter().position(|n| *n == e.name).ok_or_else(refuse)?;
                            let name = abi::REQUIRED_EXPORTS[slot];
                            let ty = func_types.get(e.index as usize).and_then(|t| types.get(*t as usize));
                            let (params, results) = expected_signature(name);
                            match ty {
                                Some(ty) if ty.params() == params && ty.results() == results => found[slot] = true,
                                _ => return Err(MeterError::Signature(name)),
                            }
                        }
                        ExternalKind::Memory if e.name == abi::MEMORY => memory_exported = true,
                        ExternalKind::Global if !global_mutable.get(e.index as usize).copied().unwrap_or(true) => {}
                        _ => return Err(refuse()),
                    }
                }
            }
            _ => {}
        }
    }
    if memories.len() != 1 {
        return Err(MeterError::MemoryCount(memories.len() as u32));
    }
    if !memory_exported {
        return Err(MeterError::MemoryNotExported);
    }
    if let Some(slot) = found.iter().position(|f| !f) {
        return Err(MeterError::MissingExport(abi::REQUIRED_EXPORTS[slot]));
    }
    let mem = memories[0];
    let limit = limits.max_memory_pages;
    for pages in [Some(mem.initial), mem.maximum].into_iter().flatten() {
        if pages > u64::from(limit) {
            return Err(MeterError::MemoryTooLarge { pages, limit });
        }
    }
    Ok(ModuleInfo {
        functions: func_types.len() as u32,
        memory_initial: mem.initial as u32,
        memory_maximum: mem.maximum.map_or(limit, |m| m as u32),
    })
}

/// Validates `bytes` ([`validate`]) and returns the metered module (see the crate docs).
pub fn meter(bytes: &[u8], limits: &Limits) -> Result<alloc::vec::Vec<u8>, MeterError> {
    let info = validate(bytes, limits)?;
    let out = rewrite::rewrite(bytes, &info).map_err(|e| MeterError::Internal(alloc::format!("{e:?}")))?;
    wasmparser::Validator::new_with_features(ALLOWED_FEATURES)
        .validate_all(&out)
        .map_err(|e| MeterError::Internal(alloc::string::ToString::to_string(&e)))?;
    Ok(out)
}
