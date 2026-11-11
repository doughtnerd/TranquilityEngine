//! Native runner: `cargo run --release -- bench|check|memory|list`.

use convolution_spike::cases::{make, specs, Spec};
use convolution_spike::util::quantile;
use convolution_spike::{checks, conv::Scratch, conv::Zone};
use std::time::Instant;

const QUANTUM_US: f64 = 128.0 / 48_000.0 * 1e6; // 2666.67

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("bench") => bench(&args),
        Some("check") => {
            let stride = arg(&args, "--stride").map_or(5, |s| s.parse().unwrap());
            let secs: Vec<u32> = arg(&args, "--secs").map_or(vec![1, 2, 4], |s| s.split(',').map(|x| x.parse().unwrap()).collect());
            let t = Instant::now();
            let r = checks::run_all(stride, &secs);
            println!("{}", r.lines.join("\n"));
            println!("({:.1} s)", t.elapsed().as_secs_f64());
            std::process::exit(if r.fails == 0 { 0 } else { 1 });
        }
        Some("memory") => memory(),
        Some("list") => {
            for s in specs() {
                println!("{}", s.name);
            }
        }
        _ => eprintln!("usage: spike bench [--runs 7] [--quanta 4000] [--filter a,b] [--json out.json] | check [--stride 5] [--secs 1,2,4] | memory | list"),
    }
}

struct Row {
    spec: Spec,
    pooled: Vec<f64>,
    run_p999: Vec<f64>,
    run_max: Vec<f64>,
    mem: usize,
    note: String,
}

fn bench(args: &[String]) {
    let runs: u32 = arg(args, "--runs").map_or(7, |s| s.parse().unwrap());
    let quanta: usize = arg(args, "--quanta").map_or(4000, |s| s.parse().unwrap());
    let filter: Vec<String> = arg(args, "--filter").map_or(vec![], |s| s.split(',').map(String::from).collect());
    // Clock overhead: median of an Instant pair with nothing between.
    let mut ov: Vec<f64> = (0..20_000)
        .map(|_| {
            let t = Instant::now();
            t.elapsed().as_nanos() as f64
        })
        .collect();
    ov.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let overhead_ns = ov[ov.len() / 2];
    eprintln!("native, {runs} runs x {quanta} quanta per case, clock pair overhead {overhead_ns:.0} ns (included in the figures)");
    let mut rows = Vec::new();
    for spec in specs() {
        if !filter.is_empty() && !filter.iter().any(|f| spec.name.contains(f.as_str())) {
            continue;
        }
        let (mut pooled, mut run_p999, mut run_max) = (Vec::new(), Vec::new(), Vec::new());
        let (mut mem, mut note) = (0, String::new());
        for run in 0..runs {
            let mut c = make(&spec, run);
            let n = c.samples(quanta);
            let mut sink = 0.0f32;
            for _ in 0..(if n < 500 { 3 } else { 300 }) {
                c.prepare();
                sink += c.step();
            }
            let mut t = Vec::with_capacity(n);
            for _ in 0..n {
                c.prepare();
                let s = Instant::now();
                sink += c.step();
                t.push(s.elapsed().as_nanos() as f64 / 1000.0);
            }
            std::hint::black_box(sink);
            mem = c.mem_bytes();
            note = c.note();
            let mut s = t.clone();
            s.sort_by(|a, b| a.partial_cmp(b).unwrap());
            run_p999.push(quantile(&s, 0.999));
            run_max.push(*s.last().unwrap());
            pooled.extend(t);
        }
        pooled.sort_by(|a, b| a.partial_cmp(b).unwrap());
        eprintln!("  {:<28} p50 {:>8.1} us  p99.9 {:>8.1}  max {:>8.1}", spec.name, quantile(&pooled, 0.5), quantile(&pooled, 0.999), pooled.last().unwrap());
        rows.push(Row { spec, pooled, run_p999, run_max, mem, note });
    }
    print_table(&rows, runs, quanta);
    if let Some(path) = arg(args, "--json") {
        let mut s = format!("{{\"meta\":{{\"runner\":\"native\",\"runs\":{runs},\"quanta\":{quanta},\"clock_overhead_ns\":{overhead_ns:.0},\"quantum_us\":{QUANTUM_US:.3}}},\"cases\":[");
        for (i, r) in rows.iter().enumerate() {
            let list = |v: &Vec<f64>| v.iter().map(|x| format!("{x:.2}")).collect::<Vec<_>>().join(",");
            s += &format!(
                "{}{{\"name\":\"{}\",\"group\":\"{}\",\"units\":{},\"samples\":{},\"p50_us\":{:.2},\"p99_us\":{:.2},\"p999_us\":{:.2},\"max_us\":{:.2},\"run_p999_us\":[{}],\"run_max_us\":[{}],\"mem_bytes\":{},\"note\":\"{}\"}}",
                if i > 0 { "," } else { "" },
                r.spec.name,
                r.spec.group,
                r.spec.units,
                r.pooled.len(),
                quantile(&r.pooled, 0.5),
                quantile(&r.pooled, 0.99),
                quantile(&r.pooled, 0.999),
                r.pooled.last().unwrap(),
                list(&r.run_p999),
                list(&r.run_max),
                r.mem,
                r.note
            );
        }
        s += "]}";
        std::fs::write(&path, s).unwrap();
        eprintln!("wrote {path}");
    }
}

fn print_table(rows: &[Row], runs: u32, quanta: usize) {
    println!("| case | n | samples | p50 us | p99 us | p99.9 us | max us | p50 % | p99.9 % | max % | worst-run p99.9 us | mem/zone KB | note |");
    println!("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for r in rows {
        let (p50, p99, p999, max) = (quantile(&r.pooled, 0.5), quantile(&r.pooled, 0.99), quantile(&r.pooled, 0.999), *r.pooled.last().unwrap());
        let worst = r.run_p999.iter().cloned().fold(0.0, f64::max);
        let pct = |v: f64| if r.spec.group == "switch" && r.spec.name.contains("atonce") { "-".to_string() } else { format!("{:.2}", v / QUANTUM_US * 100.0) };
        println!(
            "| {} | {} | {} | {:.1} | {:.1} | {:.1} | {:.1} | {} | {} | {} | {:.1} | {} | {} |",
            r.spec.name,
            r.spec.units,
            r.pooled.len(),
            p50,
            p99,
            p999,
            max,
            pct(p50),
            pct(p999),
            pct(max),
            worst,
            if r.mem > 0 { format!("{:.0}", r.mem as f64 / 1024.0) } else { "-".into() },
            r.note
        );
    }
    println!("\n({runs} runs, >= {quanta} quanta per run; % of a {QUANTUM_US:.1} us quantum; samples pooled over runs)");
}

fn memory() {
    println!("| IR | kernels KB | whole zone KB (kernels + input spectra delay lines + rings + accumulators) | head partitions | tail partitions |");
    println!("|---|---|---|---|---|");
    for secs in [1usize, 2, 4] {
        let frames = 48_000 * secs;
        let z = Zone::alloc(frames, convolution_spike::conv::M1_SCHED);
        println!("| {secs} s stereo | {:.0} | {:.0} | {} | {} |", z.kernel_bytes() as f64 / 1024.0, z.bytes() as f64 / 1024.0, z.head, z.tail);
    }
    let m1 = audio_dsp::convolver::region_bytes(48_000.0);
    println!("\nShared across zones (one set per core): FFT twiddles + scratch = {} B. M1's whole region for its 1.8 s IR = {} B.", Scratch::bytes(), m1);
}
