//! The audio core's source hash (api-and-models §5). Included by `build.rs` (which embeds the hash
//! in the wasm) and by `tests/source_hash.rs`; `src/plugins/audio/runtime/wasm/sourceHash.test.ts`
//! recomputes the same hash in TypeScript, so the rule below must match it byte for byte.
//!
//! The rule:
//! - Files: every `*.rs`, `Cargo.toml`, `Cargo.lock` and `rust-toolchain.toml` under the root
//!   (`native/audio/`), skipping any directory named `target`, `vectors` or `tests` at any depth.
//! - Each file's key is its path relative to the root with `/` separators. Files are taken in
//!   ascending byte order of their keys.
//! - Contents are normalised by replacing every `\r\n` with `\n` (a Windows checkout with
//!   `core.autocrlf` must hash like a Linux one).
//! - For each file, in order, the SHA-256 is fed: the key's UTF-8 bytes, one `0x00` byte, the
//!   normalised length as a little-endian `u64` (8 bytes), then the normalised contents.
//! - The hash is the digest's first 16 bytes. Its text form is 32 lowercase hex digits.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

/// Directories never descended into, at any depth.
pub const SKIPPED_DIRS: [&str; 3] = ["target", "vectors", "tests"];

/// File names hashed besides `*.rs`.
pub const HASHED_NAMES: [&str; 3] = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"];

/// The hashed files under `root` as `(key, path)`: `key` relative to `root` with `/` separators,
/// sorted by `key` in ascending byte order.
pub fn hashed_files(root: &Path) -> Vec<(String, PathBuf)> {
    // STUB(A0.1-L2): a build script can't `todo!()` without breaking every build.
    let _ = root;
    Vec::new()
}

/// `contents` with every `\r\n` replaced by `\n`.
pub fn normalise(contents: &[u8]) -> Vec<u8> {
    // STUB(A0.1-L2)
    contents.to_vec()
}

/// The source hash of `root` per the rule above.
pub fn source_hash(root: &Path) -> [u8; 16] {
    // STUB(A0.1-L2)
    let _ = root;
    [0; 16]
}

/// 32 lowercase hex digits.
pub fn to_hex(hash: &[u8; 16]) -> String {
    // STUB(A0.1-L2)
    let _ = hash;
    String::new()
}
