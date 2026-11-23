//! Writes the Node budget benchmark's files (`anim-wasm/bench_budgets.mjs`): the 80-bone humanoid,
//! its clips and graphs, and the synthetic 30-minute matching database with its clips and graphs.
//! Generated, never committed. Usage: `cargo run --release -p anim-bench --example fixtures -- DIR`.

fn main() {
    let dir = std::env::args()
        .nth(1)
        .expect("usage: fixtures <output directory>");
    anim_bench::scenario::write_fixtures(std::path::Path::new(&dir)).expect("write the fixtures");
    println!("wrote {dir}");
}
