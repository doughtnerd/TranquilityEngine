//! audio-wasm's build script (api-and-models §5):
//! 1. embeds the source hash (`source_hash.rs`) as `$OUT_DIR/source_hash.bin`, read by `lib.rs`;
//! 2. on wasm32, links with imported memory and a 256 KB stack, so a plain `cargo build` gives the
//!    same module as `npm run build:audio` (which adds only `+simd128`).

#[path = "source_hash.rs"]
mod source_hash;

use std::env;
use std::fs;
use std::path::PathBuf;

/// architecture §5.1: the shadow stack is fixed at 256 KB.
const STACK_BYTES: u32 = 256 * 1024;

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let root = manifest.join("..").join("..");

    // Re-run when a hashed file changes or a file is added. Not on the root itself: cargo scans a
    // directory recursively, and the root holds `target/`.
    for entry in fs::read_dir(&root).expect("native/audio is readable").flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        if path.is_dir() {
            if !source_hash::SKIPPED_DIRS.contains(&name.as_str()) && !name.starts_with('.') {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        } else if name.ends_with(".rs") || source_hash::HASHED_NAMES.contains(&name.as_str()) {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }

    let hash = source_hash::source_hash(&root);
    let out = PathBuf::from(env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    fs::write(out.join("source_hash.bin"), hash).expect("OUT_DIR is writable");

    if env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        println!("cargo:rustc-link-arg-cdylib=--import-memory");
        println!("cargo:rustc-link-arg-cdylib=-zstack-size={STACK_BYTES}");
        // No name section in the shipped wasm (as the decoder, B1): about 13 KB of the 150 KB gate. A trap's stack
        // trace then shows function indices; build natively or without this line to debug with names.
        println!("cargo:rustc-link-arg-cdylib=--strip-all");
    }
}
