//! Non-uniform convolution: correctness against the uniform convolver, then average and worst-case
//! cost per quantum. `cargo run --release --example nonuniform`.
use myco_spatial_spike::{Bench, Fft, NonUniform, Q};
use std::time::Instant;

fn main() {
    let mut b = Bench::new();
    for secs in [0.2f32, 1.0, 2.0] {
        let (diff, peak) = b.check_nonuniform(secs, 2000);
        println!("check {secs} s IR over 2000 quanta: max |uniform - nonuniform| = {diff:.2e} (peak {peak:.2})");
    }
    let budget = 128.0 / 48_000.0 * 1000.0;
    for secs in [2.0f32, 4.0, 8.0] {
        let len = (secs * 48_000.0) as usize;
        let mut fft = Fft::new();
        let ir: Vec<f32> = (0..len).map(|i| ((i * 2654435761usize) % 1000) as f32 / 1000.0 - 0.5).collect();
        let mut l = NonUniform::new(&mut fft, &ir);
        let mut r = NonUniform::new(&mut fft, &ir);
        let input = [0.1f32; Q];
        let (mut ol, mut or) = ([0.0f32; Q], [0.0f32; Q]);
        for _ in 0..400 { l.process(&mut fft, &input, &mut ol); r.process(&mut fft, &input, &mut or); }
        let mut times = Vec::with_capacity(4800);
        for _ in 0..4800 {
            let t = Instant::now();
            ol = [0.0; Q]; or = [0.0; Q];
            l.process(&mut fft, &input, &mut ol);
            r.process(&mut fft, &input, &mut or);
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let avg = times.iter().sum::<f64>() / times.len() as f64;
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let p99 = times[times.len() * 99 / 100];
        let max = times[times.len() - 1];
        println!("nonuniform {secs} s stereo: avg {avg:.4} ms ({:.1}%), p99 {p99:.4}, max {max:.4} ms ({:.1}%)  [sink {}]", avg / budget * 100.0, max / budget * 100.0, ol[3] + or[9]);
    }
}
