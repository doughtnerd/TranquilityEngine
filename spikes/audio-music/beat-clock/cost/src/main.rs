use beatcost::run;
use std::hint::black_box;
use std::time::Instant;
fn main() {
    let quanta: u32 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(2_000_000);
    let reps: usize = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(7);
    println!("native: {quanta} quanta per rep, {reps} reps; ns per quantum for all instances (budget: one 44.1 kHz quantum = 2902 us)");
    for force in [0u32, 1] {
        for n in [1u32, 4, 16, 64] {
            black_box(run(n, quanta / 10, force));
            let mut t: Vec<f64> = (0..reps).map(|_| { let s = Instant::now(); black_box(run(black_box(n), quanta, force)); s.elapsed().as_nanos() as f64 / quanta as f64 }).collect();
            t.sort_by(|a, b| a.partial_cmp(b).unwrap());
            println!("mode={} n={:>2} instances: p50 {:7.2} ns/quantum  min {:7.2}  max {:7.2}  ({:.4}% of a quantum at p50)", if force == 1 { "worst(every quantum crosses)" } else { "normal(120/90 BPM)" }, n, t[t.len() / 2], t[0], t[t.len() - 1], t[t.len() / 2] / 2_902_000.0 * 100.0);
        }
    }
}
