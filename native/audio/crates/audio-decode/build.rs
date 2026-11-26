//! audio-decode's build script: embeds the audio core's source hash (audio-wasm's
//! `source_hash.rs`, the same rule and the same root) as `$OUT_DIR/source_hash.bin`, so the decoder
//! wasm reports the hash `hash.json` records; and, on wasm32, links with `--strip-all` (no name
//! section: 112 KB of the module). `npm run build:audio` adds `+simd128` and remaps CARGO_HOME in
//! symphonia's panic locations. Memory stays exported (the linker's default): the decoder runs
//! alone in a worker (see `src/lib.rs`).
//!
//! ADR 0351 A7 (0359 §4): it also compiles the vendored libopus (`native/audio/third_party/opus`, see its
//! `PROVENANCE.md`) **fixed point** for `src/opus.rs`: CELT, SILK and `src/` (the link keeps what the decoder
//! reaches), every external symbol renamed by the force-included `opus/rename.h`. On wasm32 the C compiler is clang
//! for `wasm32-unknown-unknown` (`CC_wasm32_unknown_unknown`, else `clang`), freestanding against `opus/cstub/` (no
//! libc, no imports), with `-msimd128` when the Rust build has `+simd128`; natively (`cargo test`) the system's C
//! compiler. The C code is always optimised (an unoptimised libopus makes the tests crawl).

#[path = "../audio-wasm/source_hash.rs"]
mod source_hash;

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

/// Reads a `NAME = a.c b.c \` list from one of libopus's `*_sources.mk` files.
fn mk_list(path: &Path, var: &str) -> Vec<String> {
    let text = fs::read_to_string(path).unwrap_or_else(|_| panic!("{} is readable", path.display()));
    let mut out = Vec::new();
    let mut inside = false;
    for line in text.lines() {
        let t = line.trim();
        if !inside {
            let Some(rest) = t.strip_prefix(var) else { continue };
            let Some(rest) = rest.trim_start().strip_prefix('=') else { continue };
            inside = true;
            let rest = rest.trim().trim_end_matches('\\').trim();
            if !rest.is_empty() {
                out.push(rest.to_string());
            }
            if !t.ends_with('\\') {
                break;
            }
            continue;
        }
        let f = t.trim_end_matches('\\').trim();
        if !f.is_empty() {
            out.push(f.to_string());
        }
        if !t.ends_with('\\') {
            break;
        }
    }
    out
}

/// Compiles libopus's decoder side (module comment).
fn build_opus(root: &Path, manifest: &Path) {
    let op = root.join("third_party").join("opus");
    let ours = manifest.join("opus");
    println!("cargo:rerun-if-changed={}", op.display());
    println!("cargo:rerun-if-changed={}", ours.display());
    let wasm = env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32");
    let mut b = cc::Build::new();
    b.warnings(false).opt_level(3);
    if wasm {
        if env::var_os("CC_wasm32_unknown_unknown").is_none() && env::var_os("CC").is_none() {
            b.compiler("clang");
        }
        b.flag("-ffreestanding").include(ours.join("cstub"));
        if env::var("CARGO_CFG_TARGET_FEATURE").map(|f| f.split(',').any(|x| x == "simd128")).unwrap_or(false) {
            b.flag("-msimd128");
        }
    }
    b.flag("-include").flag(ours.join("rename.h").to_str().expect("a UTF-8 path"));
    for d in ["include", "celt", "silk", "silk/fixed", "src"] {
        b.include(op.join(d));
    }
    b.define("OPUS_BUILD", None).define("FIXED_POINT", None).define("DISABLE_FLOAT_API", None).define("VAR_ARRAYS", None);
    let mut files = Vec::new();
    files.extend(mk_list(&op.join("celt_sources.mk"), "CELT_SOURCES"));
    files.extend(mk_list(&op.join("silk_sources.mk"), "SILK_SOURCES"));
    files.extend(mk_list(&op.join("opus_sources.mk"), "OPUS_SOURCES"));
    assert!(files.len() > 100, "libopus source lists parsed ({} files)", files.len());
    for f in files {
        b.file(op.join(f));
    }
    b.compile("mycoopusdec");
}

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

    build_opus(&root, &manifest);

    if env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        println!("cargo:rustc-link-arg-cdylib=--strip-all");
    }
}

