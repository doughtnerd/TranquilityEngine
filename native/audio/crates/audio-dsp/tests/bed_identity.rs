//! Bit identity of the bed path across native and wasm (ADR 0162, api-and-models §10 row A2:
//! "bit-identical native and wasm"). The scene (`examples/bed_probe/scenario.rs`) encodes 32 moving
//! voices and a 3rd-order clip rotated by a turning listener into a bed and decodes it for 64
//! quanta; the digest is FNV-1a 64 over the output's f32 bits.
//!
//! As the M1/M2 goldens and the bed spike's checksums: exact bits, no tolerance (`audioGolden.test.ts`
//! explains why a quantised hash is worse). The native digest is checked against the committed value
//! (any change to the encode, rotation or decode arithmetic shows here: update `DIGEST` only for an
//! intended change, and say so in the commit), and the same scene built for wasm32 (release,
//! `+simd128`, the mixer's flags) and run in Node must give the same digest. The wasm half needs
//! `node` and the `wasm32-unknown-unknown` target; without them it says so and passes.

#[path = "../examples/bed_probe/scenario.rs"]
#[allow(dead_code)]
mod scenario;

use std::process::Command;

/// The scene's digest (native and wasm), committed.
const DIGEST: &str = "eb26320cd582e0f8";

#[test]
fn native_digest_matches_the_committed_value() {
    assert_eq!(format!("{:016x}", scenario::digest()), DIGEST);
}

#[test]
fn wasm_digest_matches_native() {
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("skipped: node is not on PATH");
        return;
    }
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/examples/bed_probe/run.mjs");
    let audio = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    let build = Command::new(env!("CARGO"))
        .current_dir(audio)
        .args(["build", "--offline", "--release", "-p", "audio-dsp", "--example", "bed_probe", "--target", "wasm32-unknown-unknown", "--target-dir", "target/dsp-probe"])
        .env("CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS", "-C target-feature=+simd128")
        .output()
        .expect("cargo runs");
    if !build.status.success() {
        let err = String::from_utf8_lossy(&build.stderr);
        if err.contains("wasm32-unknown-unknown") && err.contains("target may not be installed") {
            eprintln!("skipped: the wasm32-unknown-unknown target is not installed");
            return;
        }
        panic!("wasm build failed:\n{err}");
    }
    let out = Command::new("node").args([script, "digest", "--no-build"]).output().expect("node runs");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let wasm = String::from_utf8_lossy(&out.stdout).trim().to_string();
    assert_eq!(wasm, format!("{:016x}", scenario::digest()), "wasm and native digests differ");
    assert_eq!(wasm, DIGEST);
}
