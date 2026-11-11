//! Native runner: `bench [--runs 5] [--quanta 2000] [--warm 300] [--cases a,b] [--json]`.
use bedspike::cases::*;
use std::time::Instant;

fn pct(sorted: &[f64], p: f64) -> f64 {
    let n = sorted.len();
    let i = ((p * n as f64).ceil() as usize).clamp(1, n) - 1;
    sorted[i]
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let get = |k: &str, d: &str| args.iter().position(|a| a == k).map(|i| args[i + 1].clone()).unwrap_or(d.to_string());
    let runs: usize = get("--runs", "5").parse().unwrap();
    let quanta: usize = get("--quanta", "2000").parse().unwrap();
    let warm: usize = get("--warm", "300").parse().unwrap();
    let want = get("--cases", "");
    let names: Vec<&str> = if want.is_empty() { NAMES.to_vec() } else { want.split(',').collect() };
    let asset = include_bytes!("../../../../../src/plugins/audio/runtime/wasm/myco_hrir.bin");
    let shared = Shared::new(asset);
    // Timer overhead: two Instant::now calls back to back.
    let mut oh: Vec<f64> = (0..20000).map(|_| { let t = Instant::now(); t.elapsed().as_nanos() as f64 / 1000.0 }).collect();
    oh.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut json = String::from("{\"target\":\"native\",\"timer_overhead_us_p50\":");
    json += &format!("{:.4},\"cases\":{{", oh[oh.len() / 2]);
    let mut first = true;
    let mut sink = 0.0f32;
    for name in names {
        let mut case = make(name, &shared).expect("case");
        let mut res = Vec::new();
        for _ in 0..runs {
            case.reset();
            for _ in 0..warm { sink += case.quantum(); }
            let mut t = Vec::with_capacity(quanta);
            for _ in 0..quanta {
                let s = Instant::now();
                sink += case.quantum();
                t.push(s.elapsed().as_nanos() as f64 / 1000.0);
            }
            t.sort_by(|a, b| a.partial_cmp(b).unwrap());
            res.push(format!("{{\"p50\":{:.3},\"p99\":{:.3},\"p999\":{:.3},\"max\":{:.3},\"mean\":{:.3}}}", pct(&t, 0.5), pct(&t, 0.99), pct(&t, 0.999), t[t.len() - 1], t.iter().sum::<f64>() / t.len() as f64));
        }
        eprintln!("{name}: {}", res[0]);
        if !first { json += ","; }
        first = false;
        json += &format!("\"{name}\":[{}]", res.join(","));
        // checksum after a fixed number of quanta, to compare with wasm
        case.reset();
        let mut cs = 0.0f64;
        for _ in 0..50 { cs += case.quantum() as f64; }
        json.truncate(json.len() - 1);
        json += &format!(",{{\"checksum50\":{cs:.6}}}]");
    }
    json += &format!("}},\"sink\":{sink}}}");
    println!("{json}");
}
