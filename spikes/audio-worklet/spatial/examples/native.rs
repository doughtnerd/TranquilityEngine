//! Native baseline: `cargo run --release --example native`.
use myco_spatial_spike::Bench;
use std::time::Instant;

fn time(f: &mut dyn FnMut(usize)) -> f64 {
    let (warm, n) = (50, 1050);
    f(warm);
    let t = Instant::now(); f(warm); let tw = t.elapsed().as_secs_f64();
    let t = Instant::now(); f(n); let tn = t.elapsed().as_secs_f64();
    (tn - tw) * 1000.0 / (n - warm) as f64
}

fn main() {
    let budget = 128.0 / 48_000.0 * 1000.0;
    let mut b = Bench::new();
    let cases: Vec<(&str, Box<dyn Fn(&mut Bench, usize)>)> = vec![
        ("fir 128 taps, 1 voice", Box::new(|b, n| b.fir(1, 128, n))),
        ("fir 256 taps, 1 voice", Box::new(|b, n| b.fir(1, 256, n))),
        ("fft 128 taps, 1 voice", Box::new(|b, n| b.fft(1, 128, n, false))),
        ("fft 256 taps, 1 voice", Box::new(|b, n| b.fft(1, 256, n, false))),
        ("fft 256 taps, 32 voices", Box::new(|b, n| b.fft(32, 256, n, false))),
        ("moving fft 256 taps, 1 voice", Box::new(|b, n| b.fft(1, 256, n, true))),
        ("ambisonics 3rd order, 256 taps, 64 voices", Box::new(|b, n| b.ambi(64, 256, n))),
        ("ambisonics 3rd order, 256 taps, 256 voices", Box::new(|b, n| b.ambi(256, 256, n))),
        ("convolution reverb 2 s stereo", Box::new(|b, n| b.reverb(2.0, n))),
        ("convolution reverb 4 s stereo", Box::new(|b, n| b.reverb(4.0, n))),
    ];
    for (name, f) in cases.iter() {
        let ms = time(&mut |n| f(&mut b, n));
        println!("{name:45} {ms:.4} ms ({:.1}%)", ms / budget * 100.0);
    }
    println!("(sink {})", b.sink);
}
