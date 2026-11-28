//! audio-offline's build script: embeds the audio core's source hash (audio-wasm's
//! `source_hash.rs`, the same rule and the same root) as `$OUT_DIR/source_hash.bin`, so the
//! offline wasm reports the hash `hash.json` records (as the decoder does); and, on wasm32, links
//! with `--strip-all`. Memory stays exported: the render runs alone (a worker, or Node).

#[path = "../audio-wasm/source_hash.rs"]
mod source_hash;

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let root = manifest.join("..").join("..");

    // Re-run when a hashed file changes or a file is added (as audio-wasm's build.rs does).
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

    // The shared crates it links (SHARED_CRATES under ../common/) are hashed too.
    for path in source_hash::shared_watch(&root) {
        println!("cargo:rerun-if-changed={}", path.display());
    }

    let hash = source_hash::source_hash(&root);
    let out = PathBuf::from(env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    fs::write(out.join("source_hash.bin"), hash).expect("OUT_DIR is writable");

    if env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        println!("cargo:rustc-link-arg-cdylib=--strip-all");
    }
}
