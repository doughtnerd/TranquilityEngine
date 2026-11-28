//! vis-wasm's build script: embeds the source hash (`source_hash.rs`) of `native/visibility/` as
//! `$OUT_DIR/source_hash.bin`, read by `src/lib.rs`, so a committed wasm that no longer matches its sources fails
//! `npm test` (ADR 0447, after 0370 and 0157).

#[path = "source_hash.rs"]
mod source_hash;

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let manifest =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let root = manifest.join("..").join("..");

    // Re-run when a hashed file changes or a file is added. Not on the root itself: cargo scans a directory
    // recursively, and the root holds `target/`.
    for entry in fs::read_dir(&root)
        .expect("native/visibility is readable")
        .flatten()
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        if path.is_dir() {
            if !source_hash::SKIPPED_DIRS.contains(&name.as_str()) {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        } else if name.ends_with(".rs") || source_hash::HASHED_NAMES.contains(&name.as_str()) {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }

    let hash = source_hash::source_hash(&root);
    let out = PathBuf::from(env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    fs::write(out.join("source_hash.bin"), hash).expect("OUT_DIR is writable");
}
