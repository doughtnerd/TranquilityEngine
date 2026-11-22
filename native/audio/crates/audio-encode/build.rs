//! audio-encode's build script:
//!
//! 1. Compiles the vendored C libraries (ADR 0345 §6: `native/audio/third_party/{libogg,libvorbis,opus}`, see each
//!    folder's `PROVENANCE.md`) and `glue/glue.c`. For `wasm32-wasip1` the C compiler is wasi-sdk's clang
//!    (`CC_wasm32_wasip1`, which `build.mjs` sets; else `$WASI_SDK_PATH/bin/clang`), with `-msimd128` (0345 §1).
//!    Natively (`cargo test`) it is the system's C compiler.
//! 2. Embeds the encoder's **own** source hash as `$OUT_DIR/encode_hash.bin` (16 bytes). It is not the audio core's
//!    hash: the encoder is rebuilt only when its own sources change (it needs wasi-sdk, which the core doesn't). The
//!    rule, which `src/export/audioEncoder.test.ts` recomputes in TypeScript:
//!    - files: every file under `crates/audio-encode/` (skipping directories named `target` or `tests`) and under
//!      `third_party/libogg/`, `third_party/libvorbis/` and `third_party/opus/`, plus `rust-toolchain.toml`;
//!    - key: the path relative to `native/audio/` with `/` separators; files in ascending byte order of their keys;
//!    - contents with every `\r\n` replaced by `\n`;
//!    - SHA-256 fed, per file: the key's UTF-8 bytes, a `0x00`, the normalised length as a little-endian `u64`, the
//!      normalised contents. The hash is the digest's first 16 bytes.
//! 3. On wasm32, links with `--strip-all`.

use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

/// The C libraries' folders under `native/audio/third_party/`.
const LIBRARIES: [&str; 3] = ["libogg", "libvorbis", "opus"];

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

fn collect(dir: &Path, key: &str, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else { continue };
        let Ok(kind) = entry.file_type() else { continue };
        let k = format!("{key}/{name}");
        if kind.is_dir() {
            if name != "target" && name != "tests" {
                collect(&entry.path(), &k, out);
            }
        } else if kind.is_file() {
            out.push((k, entry.path()));
        }
    }
}

/// The encoder's source hash (rule in the header).
fn encode_hash(root: &Path) -> [u8; 16] {
    let mut files = Vec::new();
    collect(&root.join("crates/audio-encode"), "crates/audio-encode", &mut files);
    for lib in LIBRARIES {
        collect(&root.join("third_party").join(lib), &format!("third_party/{lib}"), &mut files);
    }
    files.push(("rust-toolchain.toml".to_string(), root.join("rust-toolchain.toml")));
    files.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let mut h = Sha256::new();
    for (key, path) in files {
        let raw = fs::read(&path).unwrap_or_else(|_| panic!("{} is readable", path.display()));
        let mut text = Vec::with_capacity(raw.len());
        let mut i = 0;
        while i < raw.len() {
            if raw[i] == b'\r' && raw.get(i + 1) == Some(&b'\n') {
                i += 1;
                continue;
            }
            text.push(raw[i]);
            i += 1;
        }
        h.update(key.as_bytes());
        h.update([0u8]);
        h.update((text.len() as u64).to_le_bytes());
        h.update(&text);
    }
    let digest = h.finalize();
    let mut out = [0u8; 16];
    out.copy_from_slice(&digest[..16]);
    out
}

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let root = manifest.join("..").join("..");
    let third = root.join("third_party");
    let out = PathBuf::from(env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    let wasm = env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32");
    let target = env::var("TARGET").unwrap_or_default();

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=glue");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed={}", root.join("rust-toolchain.toml").display());
    println!("cargo:rerun-if-env-changed=WASI_SDK_PATH");
    for lib in LIBRARIES {
        println!("cargo:rerun-if-changed={}", third.join(lib).display());
    }

    // wasm32-wasip1 without an explicit CC: wasi-sdk from WASI_SDK_PATH.
    if target == "wasm32-wasip1" && env::var_os("CC_wasm32_wasip1").is_none() && env::var_os("CC").is_none() {
        if let Some(sdk) = env::var_os("WASI_SDK_PATH") {
            let sdk = PathBuf::from(sdk);
            env::set_var("CC_wasm32_wasip1", sdk.join("bin/clang"));
            env::set_var("AR_wasm32_wasip1", sdk.join("bin/llvm-ar"));
        }
    }

    // libogg's configure-generated header.
    fs::create_dir_all(out.join("ogg")).expect("OUT_DIR is writable");
    fs::write(
        out.join("ogg/config_types.h"),
        "#ifndef __CONFIG_TYPES_H__\n#define __CONFIG_TYPES_H__\n#include <stdint.h>\n\
         typedef int16_t ogg_int16_t; typedef uint16_t ogg_uint16_t; typedef int32_t ogg_int32_t;\n\
         typedef uint32_t ogg_uint32_t; typedef int64_t ogg_int64_t; typedef uint64_t ogg_uint64_t;\n#endif\n",
    )
    .expect("OUT_DIR is writable");

    let ogg = third.join("libogg");
    let vor = third.join("libvorbis");
    let op = third.join("opus");

    // One cc::Build per library: libvorbis's lib/mdct.h and libopus's celt/mdct.h must not see each other.
    let base = || {
        let mut b = cc::Build::new();
        // The C libraries are always optimised: libopus and libvorbis unoptimised make `cargo test` crawl.
        b.warnings(false).opt_level(3).include(&out).include(ogg.join("include"));
        if wasm {
            b.flag("-msimd128");
        }
        b
    };

    base().file(ogg.join("src/bitwise.c")).file(ogg.join("src/framing.c")).compile("mycoogg");

    let mut b = base();
    b.include(vor.join("include")).include(vor.join("lib"));
    for f in [
        "analysis", "bitrate", "block", "codebook", "envelope", "floor0", "floor1", "info", "lookup", "lpc", "lsp",
        "mapping0", "mdct", "psy", "registry", "res0", "sharedbook", "smallft", "synthesis", "vorbisenc", "window",
    ] {
        b.file(vor.join(format!("lib/{f}.c")));
    }
    b.compile("mycovorbis");

    // libopus, the float build without DNN (the decoder's fixed-point build is ADR 0337 A7's).
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
    assert!(files.len() > 100, "libopus source lists parsed ({} files)", files.len());
    for f in files {
        b.file(op.join(f));
    }
    b.compile("mycoopus");

    let mut glue = base();
    glue.include(vor.join("include")).include(op.join("include"));
    glue.file(manifest.join("glue/glue.c")).compile("mycoglue");

    fs::write(out.join("encode_hash.bin"), encode_hash(&root)).expect("OUT_DIR is writable");

    if wasm {
        println!("cargo:rustc-link-arg-cdylib=--strip-all");
    }
}
