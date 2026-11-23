//! The spatial assets' preparation (ADR 0331): `myco_hrir_prepare` and `myco_magls_prepare` on the
//! committed assets, pinned by SHA-256 at twelve context rates, and the ABI's blob and refusals.
//!
//! The digests were recorded from the TypeScript preparation this module replaced
//! (`core/hrirResample.ts` before ADR 0331), so they pin the port as bit-exact: the HRTF golden
//! scenes (ADR 0157 H5, 0162 A3) render these blobs and keep their digests. A change here means the
//! HRIR or MagLS data the core receives changed; ADR 0331 says what that takes.

use std::fs;
use std::path::PathBuf;

use myco_audio_decode::spatial::{prepare_hrir, prepare_magls};
use myco_audio_decode::*;
use sha2::{Digest, Sha256};

fn repo_file(path: &str) -> Vec<u8> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    fs::read(root.join(path)).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn hrir_asset() -> Vec<u8> {
    repo_file("src/plugins/audio/runtime/wasm/myco_hrir.bin")
}

fn magls_asset() -> Vec<u8> {
    repo_file("src/engine/audio/magls-o3.bin")
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// (rate, HRIR blob bytes, its SHA-256, MagLS blob bytes, its SHA-256).
const PINNED: &[(f64, usize, &str, usize, &str)] = &[
    (44100.0, 247696, "49047d89684bd773fd6c62c0ce3a36f6e53c2f43c480ffddcb9a6f485a82fbd5", 32800, "eaaaa7f278262c59f29be23335654c8e4c2b4a2fe3b0c8e2ec74df97cccb0d52"),
    (48000.0, 247696, "e3614308b75e174f53fdbcadb86ebbf76e46d9df8e247e42234035223522ff7c", 32800, "72e6aac61d568b6a739e5d6534c7b44ed44d2defa077ca6ae6d4e5a0f9edfa8b"),
    (96000.0, 493456, "c42e4d26880bbb4c78a0d9f71e96b1c67040abaa169bda7fb567eff3c1fd74ca", 65568, "57636772063d74c112ad29e3b439933933831d1914716710260a4205d4cd25b2"),
    (22050.0, 124816, "9263be32bc3fc05ab9696a53fbe57e83e87212b399c0a898515363d6bea18904", 16416, "9e03c9639a4043264af8df86179f940fe8fba4ba9c308d022eeadf1a80ba832d"),
    (88200.0, 493456, "d3efee5cb2054c181df566083f0935b0f3f71961dafe54599c388ebce5df3abc", 65568, "7babc1c739367ae16c50affab98444674ad6cd98b88b167fadbaa211f5a54293"),
    (32000.0, 124816, "7c4f405b009598acc55d2413df8fb8ff470285bc61650c23d63aa7c5040e7d1d", 16416, "153f5fb8a61f0d7fb0323a312501cae1f8ab483bb6bc5456539132629b5e992c"),
    (8000.0, 32656, "ca22c77b8c0cf99d8d137ac2752f3d84b006756c1ef7e8a367e3e3392ea559c0", 4128, "756c42de7aa22965fe88cec3233baa6ed87c2a7ceb007f71b889cfd29cdd2e9e"),
    (16000.0, 63376, "2b2c57323801a32973c33abe3b18db0cd94b411301ef96555a7b9bbe457331a1", 8224, "6fde81cc7f913249757a7006c7dc07796e102074f26bc553e32ae3d12302c82d"),
    (24000.0, 124816, "293f74a1f4d75ba98f41d1f6da2aa211b8456c870874527a60bc3d65a0408b7a", 16416, "abdb0fa2944159965a5a5fd2677eaa82b12b87b65799e4bcaaf06ced2267a9a9"),
    (47999.6, 247696, "19a59e05a7c71cec1f51b979bf6b4defe45eb1ff813db117408e1f1830c89785", 32800, "b1bfb6b06dbd526d7d3d0af561962b35c21db55c73019c22924749a461c73acf"),
    (11025.0, 63376, "e2c1838741bf41b49976197433b908956e88aa6c14d0a6a3289ef8474e144742", 8224, "643a96f2204052197260a2e7f9a06041098a93256a8aa388dedde4dd8d852933"),
    (176400.0, 984976, "f84725590f0ef5ad926f48bd06f2779bc02a2f7c602bf3f735c80e4d7424f772", 131104, "11cef59515b17224f6adb21e38bbba8938e4a07f1185ddc1f045fb8601aaa396"),
];

#[test]
fn hrir_blobs_match_the_pinned_digests() {
    let asset = hrir_asset();
    for &(rate, bytes, digest, _, _) in PINNED {
        let blob = prepare_hrir(&asset, rate).expect("the committed asset prepares");
        assert_eq!(blob.len(), bytes, "HRIR at {rate}");
        assert_eq!(hex(&blob), digest, "HRIR at {rate}");
    }
}

#[test]
fn magls_blobs_match_the_pinned_digests() {
    let asset = magls_asset();
    for &(rate, _, _, bytes, digest) in PINNED {
        let blob = prepare_magls(&asset, rate).expect("the committed asset prepares");
        assert_eq!(blob.len(), bytes, "MagLS at {rate}");
        assert_eq!(hex(&blob), digest, "MagLS at {rate}");
    }
}

#[test]
fn magls_at_the_asset_rate_is_the_asset() {
    let asset = magls_asset();
    assert_eq!(prepare_magls(&asset, 44100.0).unwrap(), asset);
}

#[test]
fn hrir_header_and_delays_at_the_context_rate() {
    let blob = prepare_hrir(&hrir_asset(), 48000.0).unwrap();
    let word = |at: usize| u32::from_le_bytes(blob[at..at + 4].try_into().unwrap());
    assert_eq!((word(0), word(4), word(8)), (10, 24, 256));
    assert_eq!(f32::from_bits(word(12)), 48000.0);
    for i in 0..480 {
        let delay = f32::from_bits(word(16 + i * 4));
        assert!(delay > 10.0 && delay < 55.0, "delay {i}: {delay}");
    }
}

#[test]
fn layouts_that_are_not_the_documented_ones_are_refused() {
    let hrir = hrir_asset();
    assert_eq!(prepare_hrir(&hrir[..1000], 48000.0).unwrap_err().code, ERR_FORMAT);
    let magls = magls_asset();
    assert_eq!(prepare_magls(&magls[..magls.len() - 4], 48000.0).unwrap_err().code, ERR_FORMAT);
    let mut bad = magls.clone();
    bad[0] = 0;
    assert_eq!(prepare_magls(&bad, 48000.0).unwrap_err().code, ERR_FORMAT);
    let mut bad = magls.clone();
    bad[8..12].copy_from_slice(&2u32.to_le_bytes()); // order 2
    assert_eq!(prepare_magls(&bad, 48000.0).unwrap_err().code, ERR_FORMAT);
}

/// Copies `bytes` into a `myco_decode_alloc` block (owned by the next call).
fn block(bytes: &[u8]) -> *mut u8 {
    let p = myco_decode_alloc(bytes.len() as u32);
    assert!(!p.is_null());
    // SAFETY: `p` is a fresh block of `bytes.len()` bytes.
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len()) };
    p
}

#[test]
fn the_abi_keeps_the_blob_until_the_next_prepare() {
    assert_eq!(myco_decode_abi_version(), 0x106);
    let asset = hrir_asset();
    let n = unsafe { myco_hrir_prepare(block(&asset), asset.len() as u32, 48000.0) };
    let want = prepare_hrir(&asset, 48000.0).unwrap();
    assert_eq!(n as usize, want.len());
    assert_eq!(myco_spatial_blob_len() as usize, want.len());
    // SAFETY: the blob lives until the next prepare.
    let got = unsafe { std::slice::from_raw_parts(myco_spatial_blob_ptr(), want.len()) };
    assert_eq!(got, &want[..]);

    let magls = magls_asset();
    let n = unsafe { myco_magls_prepare(block(&magls), magls.len() as u32, 0.0) };
    assert_eq!(n, ERR_ARG);
    assert_eq!(myco_spatial_blob_len(), 0);
    assert!(myco_spatial_blob_ptr().is_null());
    let n = unsafe { myco_magls_prepare(std::ptr::null_mut(), 16, 48000.0) };
    assert_eq!(n, ERR_ARG);
}
