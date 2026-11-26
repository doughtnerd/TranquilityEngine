//! The standalone tween module's build script: embeds the source hash (`source_hash.rs`) of the
//! crates it compiles as `$OUT_DIR/source_hash.bin`, read by `src/lib.rs`, so a committed wasm that
//! no longer matches its sources fails `npm test` (ADR 0420, as the animation core's).

#[path = "source_hash.rs"]
mod source_hash;

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let manifest =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let base = manifest.join("..");
    for path in source_hash::watch(&base) {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    let hash = source_hash::source_hash(&base);
    let out = PathBuf::from(env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    fs::write(out.join("source_hash.bin"), hash).expect("OUT_DIR is writable");
}
