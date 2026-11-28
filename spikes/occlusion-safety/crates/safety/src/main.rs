//! usage: safety <scenes.bin> <out.json> [--step N] (N: evaluate every Nth frame of each path)
use safety::{data, rules, run};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let bytes = std::fs::read(&args[1]).expect("scenes.bin");
    let step = args.iter().position(|a| a == "--step").map(|i| args[i + 1].parse().unwrap()).unwrap_or(1);
    let scenes = data::read(&bytes);
    let rules = rules::rules();
    let t0 = std::time::Instant::now();
    let results = run::run(&scenes, &rules, step);
    eprintln!("{} result rows in {:.1}s", results.len(), t0.elapsed().as_secs_f64());
    let names: Vec<String> = rules.iter().map(|r| format!("\"{}\"", r.name)).collect();
    let json = format!("{{\"rules\":[{}],\"res\":[[256,128],[320,180]],\"rows\":{}}}", names.join(","), run::to_json(&results));
    std::fs::write(&args[2], json).expect("write");
}
