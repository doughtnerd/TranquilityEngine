//! Baked navigation data layouts and the `myco.nav@1` file format (ADR 0065).
//!
//! * [`blob`]: Rust equivalents of Foxfire's baked blobs (`NavMeshBlob`, `NavVolumeBlob`, `NavLandingLinksBlob`,
//!   `NavChunkBorderBlob`, `NavFormationBlob`) and the gate table, field for field, `#[repr(C)]`.
//! * [`consts`]: area and gate id constants and the `area | gate << 6` encoding.
//! * [`fingerprint`]: Foxfire's `NavMeshFingerprint` over those arrays.
//! * [`file`]: the `myco.nav@1` container read and write.
#[cfg(target_endian = "big")]
compile_error!("nav-format stores arrays as raw little-endian bytes and only supports little-endian targets");

pub mod blob;
pub mod consts;
pub mod file;
pub mod fingerprint;
pub mod pod;

#[cfg(test)]
mod tests;

pub use blob::*;
pub use consts::*;
pub use file::{read, read_header, read_with, write, write_with, BakeFile, FileHeader, FormatError, SectionInfo, SectionKind};
pub use fingerprint::{ChainHash, Xxh3};
