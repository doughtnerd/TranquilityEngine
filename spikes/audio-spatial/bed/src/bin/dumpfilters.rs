//! Writes the SH-MagLS decoder filters (the data a runtime would load) to the path given.
use bedspike::cases::Shared;
fn main() {
    let path = std::env::args().nth(1).unwrap_or("target/filters_sh_magls.bin".into());
    let asset = include_bytes!("../../../../../src/plugins/audio/runtime/wasm/myco_hrir.bin");
    let sh = Shared::new(asset);
    let mut out = Vec::new();
    for ear in 0..2 { for c in &sh.sh_mag.h[ear] { out.extend_from_slice(&c.re.to_le_bytes()); out.extend_from_slice(&c.im.to_le_bytes()); } }
    std::fs::write(&path, &out).unwrap();
    println!("wrote {} bytes to {path}", out.len());
}
