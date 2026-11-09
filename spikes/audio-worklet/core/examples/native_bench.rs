//! Native baseline for the wasm numbers: `cargo run --release --example native_bench`.
use myco_audio_spike::{Mixer, Q};
use std::time::Instant;

fn main() {
    let sr = 48_000.0;
    let budget_ms = Q as f64 / sr as f64 * 1000.0;
    println!("budget per quantum: {budget_ms:.3} ms");
    for &(logical, cap) in &[(16, 16), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024), (4096, 256), (4096, 512)] {
        let mut m = Mixer::new(sr);
        m.set_voices(logical, cap);
        for _ in 0..200 { m.process(); }
        let n = 3000;
        let t = Instant::now();
        for _ in 0..n { m.process(); }
        let ms = t.elapsed().as_secs_f64() * 1000.0 / n as f64;
        println!("logical {logical:5} real {cap:5}: {ms:.4} ms/quantum ({:.1}% of budget)", ms / budget_ms * 100.0);
    }
}
