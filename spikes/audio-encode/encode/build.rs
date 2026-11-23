//! Compiles libogg 1.3.5, libvorbis 1.3.7 (with vorbisenc) and libopus 1.5.2 (float build, no DNN) from the
//! sources `fetch.sh` unpacks into `spikes/audio-encode/.toolchain/src/`, plus `glue/glue.c`.
//! For wasm32-wasip1 the C compiler is wasi-sdk's clang (`CC_wasm32_wasip1`, set by `run.sh`); natively it's the
//! system's. Features `vorbis` and `opus` pick the libraries, so a build without either measures the pure-Rust part.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn mk_list(path: &Path, var: &str) -> Vec<String> {
    let text = fs::read_to_string(path).unwrap_or_else(|_| panic!("{} is readable (run fetch.sh)", path.display()));
    let mut out = Vec::new();
    let mut inside = false;
    for line in text.lines() {
        let t = line.trim();
        if !inside {
            if let Some(rest) = t.strip_prefix(var) {
                let rest = rest.trim_start();
                if let Some(rest) = rest.strip_prefix('=') {
                    inside = true;
                    let rest = rest.trim().trim_end_matches('\\').trim();
                    if !rest.is_empty() {
                        out.push(rest.to_string());
                    }
                    if !t.ends_with('\\') {
                        break;
                    }
                }
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

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let src = manifest.join("../.toolchain/src");
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let vorbis = env::var("CARGO_FEATURE_VORBIS").is_ok();
    let opus = env::var("CARGO_FEATURE_OPUS").is_ok();
    println!("cargo:rerun-if-changed=glue/glue.c");
    println!("cargo:rerun-if-changed=build.rs");

    // libogg's configure-generated header.
    fs::create_dir_all(out.join("ogg")).unwrap();
    fs::write(
        out.join("ogg/config_types.h"),
        "#ifndef __CONFIG_TYPES_H__\n#define __CONFIG_TYPES_H__\n#include <stdint.h>\n\
         typedef int16_t ogg_int16_t; typedef uint16_t ogg_uint16_t; typedef int32_t ogg_int32_t;\n\
         typedef uint32_t ogg_uint32_t; typedef int64_t ogg_int64_t; typedef uint64_t ogg_uint64_t;\n#endif\n",
    )
    .unwrap();

    let ogg = src.join("libogg-1.3.5");
    let vor = src.join("libvorbis-1.3.7");
    let op = src.join("opus-1.5.2");

    // One cc::Build per library: libvorbis's lib/mdct.h and libopus's celt/mdct.h must not see each other.
    let base = || {
        let mut b = cc::Build::new();
        b.warnings(false).include(&out).include(ogg.join("include"));
        b
    };
    if vorbis || opus {
        base().file(ogg.join("src/bitwise.c")).file(ogg.join("src/framing.c")).compile("spikeogg");
    }
    let mut glue = base();
    if vorbis {
        let mut b = base();
        b.include(vor.join("include")).include(vor.join("lib"));
        for f in [
            "analysis", "bitrate", "block", "codebook", "envelope", "floor0", "floor1", "info", "lookup", "lpc", "lsp",
            "mapping0", "mdct", "psy", "registry", "res0", "sharedbook", "smallft", "synthesis", "vorbisenc", "window",
        ] {
            b.file(vor.join(format!("lib/{f}.c")));
        }
        b.compile("spikevorbis");
        glue.include(vor.join("include")).define("SPIKE_VORBIS", None);
    }
    if opus {
        let mut b = base();
        for d in ["include", "celt", "silk", "silk/float", "src"] {
            b.include(op.join(d));
        }
        b.define("OPUS_BUILD", None).define("VAR_ARRAYS", None).define("HAVE_LRINTF", None).define("HAVE_LRINT", None);
        let mut files = Vec::new();
        files.extend(mk_list(&op.join("celt_sources.mk"), "CELT_SOURCES"));
        files.extend(mk_list(&op.join("silk_sources.mk"), "SILK_SOURCES"));
        files.extend(mk_list(&op.join("silk_sources.mk"), "SILK_SOURCES_FLOAT"));
        files.extend(mk_list(&op.join("opus_sources.mk"), "OPUS_SOURCES"));
        files.extend(mk_list(&op.join("opus_sources.mk"), "OPUS_SOURCES_FLOAT"));
        assert!(files.len() > 100, "opus source lists parsed ({} files)", files.len());
        for f in files {
            b.file(op.join(f));
        }
        b.compile("spikeopus");
        glue.include(op.join("include")).define("SPIKE_OPUS", None);
    }
    glue.file(manifest.join("glue/glue.c")).compile("spikeglue");
}
