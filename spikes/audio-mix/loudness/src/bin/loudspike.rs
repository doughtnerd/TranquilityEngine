//! Native entry: `cargo run --release -- mode=check` or `mode=cost case=both k=4 runs=5 quanta=30000`.
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    loudspike::main(&args.join(" "));
}
