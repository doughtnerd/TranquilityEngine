//! The fuel pass through the editor module's boundary (T45t): `meter_module` accepts the sample node
//! module (`examples/plugin-sample`) unmetered and refuses it metered, and the unmetered fixture the
//! Node tests meter (`src/plugins/animation/runtime/wasm/fixtures/plugin_sample_raw.wasm`: the
//! loader meters it through `meter_node_module`, the export step writes the metered bytes) is
//! checked to be the sample's raw build, not metered. Its bytes depend on the toolchain, so they
//! aren't compared; regenerate with `MYCO_UPDATE_FIXTURES=1 cargo test -p anim-editor-wasm --test node_module`.

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use anim_editor_wasm::{meter_module, meter_node_module};
use anim_meter::is_metered;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../src/plugins/animation/runtime/wasm/fixtures")
}

/// plugin-sample for wasm32-unknown-unknown (release), unmetered.
fn raw_sample() -> Vec<u8> {
    let target = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("plugin-sample-raw");
    let manifest =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/plugin-sample/Cargo.toml");
    let status = Command::new(env!("CARGO"))
        .args([
            "build",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
            "--manifest-path",
        ])
        .arg(&manifest)
        .arg("--target-dir")
        .arg(&target)
        .env_remove("RUSTFLAGS")
        .env_remove("CARGO_ENCODED_RUSTFLAGS")
        .status()
        .expect("run cargo");
    assert!(status.success(), "building plugin-sample for wasm32 failed");
    fs::read(target.join("wasm32-unknown-unknown/release/plugin_sample.wasm")).unwrap()
}

#[test]
fn the_sample_meters_once_and_the_raw_fixture_is_unmetered() {
    let path = fixtures().join("plugin_sample_raw.wasm");
    if std::env::var_os("MYCO_UPDATE_FIXTURES").is_some() {
        fs::write(&path, raw_sample()).unwrap();
    }
    let raw = fs::read(&path).expect("plugin_sample_raw.wasm: run with MYCO_UPDATE_FIXTURES=1");
    assert!(
        !is_metered(&raw),
        "the raw fixture is metered; regenerate it"
    );
    let metered = meter_module(&raw).expect("the sample meters");
    assert!(is_metered(&metered));
    assert_eq!(
        meter_node_module(&raw),
        metered,
        "the export and the Rust call agree"
    );
    assert_eq!(
        meter_module(&raw).unwrap(),
        metered,
        "metering is deterministic"
    );
    let again = meter_module(&metered).unwrap_err();
    assert!(again.0.contains("metered already"), "{}", again.0);
}
