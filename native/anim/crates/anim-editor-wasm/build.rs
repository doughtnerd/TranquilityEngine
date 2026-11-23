//! anim-editor-wasm's build script: embeds the source hash of `native/anim/` (the rule in
//! `anim-wasm/source_hash.rs`, shared by path) as `$OUT_DIR/source_hash.bin`, so the committed editor
//! module can be checked against its sources as the runtime module is (ADR 0370, after 0157).

#[path = "../anim-wasm/source_hash.rs"]
mod source_hash;

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let manifest =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let root = manifest.join("..").join("..");
    for entry in fs::read_dir(&root)
        .expect("native/anim is readable")
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
    // The shared crates (../common/) are hashed too.
    for path in source_hash::shared_watch(&root) {
        println!("cargo:rerun-if-changed={}", path.display());
    }

    let hash = source_hash::source_hash(&root);
    let out = PathBuf::from(env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    fs::write(out.join("source_hash.bin"), hash).expect("OUT_DIR is writable");
}
