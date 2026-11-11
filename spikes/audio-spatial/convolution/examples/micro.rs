// Unit costs behind the stagger planner's weights: one 4,096-point real FFT and one partition
// multiply-add (2,048 bins). `cargo run --release --example micro`
use audio_dsp::convolver::fft;
use microfft::Complex32;
use std::time::Instant;
fn main() {
    let mut tw = Box::new([Complex32::default(); fft::BINS]);
    fft::twiddles(&mut tw);
    let mut work = vec![Complex32::default(); fft::BINS];
    let mut buf: Vec<f32> = (0..fft::SIZE).map(|i| (i as f32 * 0.37).sin()).collect();
    let n = 20_000;
    let t = Instant::now();
    let mut s = 0.0;
    for _ in 0..n {
        let sp = fft::rfft(&mut buf, &mut work, &tw);
        s += sp[5].re;
        buf[0] = s * 1e-9;
    }
    let fft_us = t.elapsed().as_secs_f64() * 1e6 / n as f64;
    let x: Vec<Complex32> = (0..2048).map(|i| Complex32 { re: i as f32 * 1e-3, im: 1.0 }).collect();
    let h = x.clone();
    let mut acc = vec![Complex32::default(); 2048];
    let t = Instant::now();
    for k in 0..200_000 {
        acc[0].re += x[0].re * h[0].re;
        for ((a, x), h) in acc[1..].iter_mut().zip(&x[1..]).zip(&h[1..]) {
            *a += *x * *h;
        }
        acc[1].re += k as f32 * 1e-12;
    }
    let mac_us = t.elapsed().as_secs_f64() * 1e6 / 200_000.0;
    println!("rfft 4096: {fft_us:.2} us; partition multiply-add (2048 bins): {mac_us:.2} us; ratio {:.3} (acc {})", mac_us / fft_us, acc[7].re + s);
}
