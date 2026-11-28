//! `anim-format` (ADR 0370, 0371, 0372): binary layouts for `myco.anim@1` clips
//! ([`clip`]), `myco.skel@1` skeletons ([`skeleton`]), `myco.animgraph@1` compiled graphs
//! ([`graph`]) and `myco.posedb@1` pose databases ([`posedb`]).
//!
//! # The contract
//!
//! Each module's docs hold its layout tables; they are the contract the TypeScript header reader
//! follows. The rules every format shares:
//!
//! - **Container** ([`container`]): a 32-byte header (magic, format version, flags, file length,
//!   section count), a table of 16-byte section entries (kind, offset, length, count), then the
//!   sections.
//! - **Little-endian**, flat `repr(C)`-style records with explicit reserved fields (always 0), no
//!   implicit padding, every record a multiple of 4 bytes.
//! - **Alignment:** every section starts on a 4-byte boundary, 16 for payloads read with SIMD
//!   loads (raw samples, the compressed bitstream, root curves, feature matrices). Writers put
//!   every section on 16. A loader that wants typed-array views places the file at a 16-byte
//!   aligned address.
//! - **References:** a `u32` index or string id; [`NONE`] (`0xFFFF_FFFF`) means none. Strings live
//!   in each file's [string table](strings).
//! - **Readers** (`*View::parse`) validate everything up front (bounds of every section and range,
//!   enum values, reserved fields, float finiteness, cross-references, acyclicity) and return a
//!   [`FormatError`] rather than misread; they never panic. After a successful parse the
//!   accessors read straight from the buffer.
//! - **Writers** (`write` on each owned model) return `Vec<u8>` and run the reader over their own
//!   output, so they never emit a file the reader would refuse.
//! - **Versions:** each format has its own `FORMAT_VERSION`; unknown section kinds and flag bits
//!   are refused, so additions bump the version.
//!
//! No `unsafe`: values are decoded with `from_le_bytes`.

#![forbid(unsafe_code)]

mod bytes;
pub mod clip;
pub mod container;
mod error;
pub mod frames;
pub mod graph;
mod macros;
pub mod posedb;
pub mod skeleton;
pub mod strings;

pub use bytes::{align16, align4, align_up, is_aligned, F32s, U32s, NONE};
pub use container::SectionEntry;
pub use error::{FormatError, Result};
pub use strings::{StringInterner, StringTable};
