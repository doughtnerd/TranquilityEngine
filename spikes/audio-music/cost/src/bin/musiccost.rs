//! Native entry: `cargo run --release -- mode=scene name=mus-typ seconds=20 runs=5` (see README).
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    musiccost::main(&args.join(" "));
}
