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

use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

/// Directories never descended into, at any depth.
pub const SKIPPED_DIRS: [&str; 3] = ["target", "vectors", "tests"];

/// File names hashed besides `*.rs`.
pub const HASHED_NAMES: [&str; 3] = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"];

/// The hashed files under `root` as `(key, path)`: `key` relative to `root` with `/` separators,
/// sorted by `key` in ascending byte order.
///
/// Keys are built from the names walked under `root` (never canonicalised, so `..` in `root` is
/// harmless). Symbolic links are neither followed nor hashed, and names that aren't UTF-8 are
/// skipped; neither occurs in a normal tree. Unreadable directories are skipped, not reported.
pub fn hashed_files(root: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    collect(root, "", &mut out);
    out.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    out
}

fn collect(dir: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let key = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if file_type.is_dir() {
            if !SKIPPED_DIRS.contains(&name.as_str()) {
                collect(&entry.path(), &key, out);
            }
        } else if file_type.is_file()
            && (name.ends_with(".rs") || HASHED_NAMES.contains(&name.as_str()))
        {
            out.push((key, entry.path()));
        }
    }
}

/// `contents` with every `\r\n` replaced by `\n`.
pub fn normalise(contents: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(contents.len());
    let mut i = 0;
    while i < contents.len() {
        if contents[i] == b'\r' && contents.get(i + 1) == Some(&b'\n') {
            out.push(b'\n');
            i += 2;
        } else {
            out.push(contents[i]);
            i += 1;
        }
    }
    out
}

/// The source hash of `root` per the rule above.
///
/// Panics if a hashed file can't be read: a build script must fail loudly rather than embed a
/// hash of a tree it didn't see.
pub fn source_hash(root: &Path) -> [u8; 16] {
    let mut hasher = Sha256::new();
    for (key, path) in hashed_files(root) {
        let raw = fs::read(&path)
            .unwrap_or_else(|e| panic!("cannot read {} for the source hash: {e}", path.display()));
        let contents = normalise(&raw);
        hasher.update(key.as_bytes());
        hasher.update([0u8]);
        hasher.update((contents.len() as u64).to_le_bytes());
        hasher.update(&contents);
    }
    let digest = hasher.finalize();
    let mut out = [0u8; 16];
    out.copy_from_slice(&digest[..16]);
    out
}

/// 32 lowercase hex digits.
pub fn to_hex(hash: &[u8; 16]) -> String {
    hash.iter().map(|b| format!("{b:02x}")).collect()
}
