//! With feature `libopus`: compiles libopus 1.5.2's decoder side, FIXED_POINT, with `-ffreestanding` against the stub
//! headers in `cstub/` (wasm32-unknown-unknown has no libc). All of CELT, SILK (common + fixed) and src/ is compiled;
//! wasm-ld's --gc-sections drops what the decoder doesn't reach. On wasm32 the cdylib links with --strip-all, as
//! audio-decode's own build.rs does for the shipped decoder.
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn mk_list(path: &Path, var: &str) -> Vec<String> {
    let text = fs::read_to_string(path).unwrap_or_else(|_| panic!("{} is readable (run fetch.sh)", path.display()));
    let mut out = Vec::new();
    let mut lines = text.lines().skip_while(|l| !l.trim_start().starts_with(&format!("{var} =")));
    if lines.next().is_none() {
        return out;
    }
    for l in lines {
        let f = l.trim().trim_end_matches('\\').trim();
        if !f.is_empty() {
            out.push(f.to_string());
        }
        if !l.trim_end().ends_with('\\') {
            break;
        }
    }
    out
}

fn main() {
    if env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        println!("cargo:rustc-link-arg-cdylib=--strip-all");
    }
    if env::var("CARGO_FEATURE_LIBOPUS").is_err() {
        return;
    }
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let op = manifest.join("../.toolchain/src/opus-1.5.2");
    let mut b = cc::Build::new();
    b.warnings(false);
    if env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        b.flag("-ffreestanding").include(manifest.join("cstub"));
        if env::var("CARGO_CFG_TARGET_FEATURE").map(|f| f.contains("simd128")).unwrap_or(false) {
            b.flag("-msimd128");
        }
    }
    for d in ["include", "celt", "silk", "silk/fixed", "src"] {
        b.include(op.join(d));
    }
    b.define("OPUS_BUILD", None).define("FIXED_POINT", None).define("DISABLE_FLOAT_API", None).define("VAR_ARRAYS", None);
    let mut files = Vec::new();
    files.extend(mk_list(&op.join("celt_sources.mk"), "CELT_SOURCES"));
    files.extend(mk_list(&op.join("silk_sources.mk"), "SILK_SOURCES"));
    files.extend(mk_list(&op.join("opus_sources.mk"), "OPUS_SOURCES"));
    // Everything is compiled; only what opus_decoder_create / opus_decode reach survives the link.
    assert!(files.len() > 100, "opus sources ({} files)", files.len());
    for f in &files {
        b.file(op.join(f));
    }
    b.compile("spikeopusdec");
}
