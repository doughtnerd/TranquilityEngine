//! The standalone tween module's source hash (ADR 0424; the animation core's rule over the crates
//! this module compiles). Included by `build.rs` (which embeds the hash in the wasm) and by
//! `tests/source_hash.rs`; `src/engine/tween/wasm/sourceHash.test.ts` recomputes the same hash in
//! TypeScript, so the rule below must match it byte for byte.
//!
//! The rule:
//! - The hashed tree is `native/` (the base), but only the directories in [`HASHED_DIRS`] (this
//!   module and every crate it compiles from the repository) and the files in [`HASHED_FILES`]
//!   (the animation workspace's manifest, whose `[workspace.dependencies]` `anim-math` and
//!   `anim-wire` inherit).
//! - Files: every `*.rs`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml` and `config.toml`
//!   (`.cargo/config.toml` sets `+simd128`) under those directories, skipping any directory named
//!   `target`, `vectors`, `tests` or `pkg` at any depth.
//! - Each file's key is its path relative to the base with `/` separators (`tween/src/lib.rs`).
//!   Files are taken in ascending byte order of their keys.
//! - Contents are normalised by replacing every `\r\n` with `\n` (a Windows checkout with
//!   `core.autocrlf` must hash like a Linux one).
//! - For each file, in order, the SHA-256 is fed: the key's UTF-8 bytes, one `0x00` byte, the
//!   normalised length as a little-endian `u64` (8 bytes), then the normalised contents.
//! - The hash is the digest's first 16 bytes. Its text form is 32 lowercase hex digits.
#![allow(dead_code)]

use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

/// The directories hashed, relative to the base (`native/`): this module and the crates it
/// compiles (add one when it gains a path dependency).
pub const HASHED_DIRS: [&str; 6] = [
    "anim/crates/anim-math",
    "anim/crates/anim-wire",
    "common/curve",
    "common/tween",
    "common/wire",
    "tween",
];

/// Single files hashed, relative to the base.
pub const HASHED_FILES: [&str; 1] = ["anim/Cargo.toml"];

/// Directories never descended into, at any depth.
pub const SKIPPED_DIRS: [&str; 4] = ["target", "vectors", "tests", "pkg"];

/// File names hashed besides `*.rs`.
pub const HASHED_NAMES: [&str; 4] = [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "config.toml",
];

/// The hashed files under `base` as `(key, path)`, sorted by `key` in ascending byte order.
/// Symbolic links are neither followed nor hashed, names that aren't UTF-8 are skipped, and a
/// missing directory or file is left out.
pub fn hashed_files(base: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    for dir in HASHED_DIRS {
        collect(&base.join(dir), dir, &mut out);
    }
    for file in HASHED_FILES {
        let path = base.join(file);
        if fs::symlink_metadata(&path).is_ok_and(|m| m.is_file()) {
            out.push((file.to_string(), path));
        }
    }
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
        let key = format!("{prefix}/{name}");
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

/// What the build script watches (`cargo:rerun-if-changed`): each entry of each hashed directory
/// that the hash can see (not the skipped directories, so cargo never scans build output), and
/// the hashed files.
pub fn watch(base: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for dir in HASHED_DIRS {
        let Ok(entries) = fs::read_dir(base.join(dir)) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !SKIPPED_DIRS.contains(&name.as_str()) {
                out.push(entry.path());
            }
        }
    }
    out.extend(HASHED_FILES.iter().map(|f| base.join(f)));
    out
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

/// The source hash of `base` per the rule above. Panics if a hashed file can't be read: a build
/// script must fail loudly rather than embed a hash of a tree it didn't see.
pub fn source_hash(base: &Path) -> [u8; 16] {
    let mut hasher = Sha256::new();
    for (key, path) in hashed_files(base) {
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
