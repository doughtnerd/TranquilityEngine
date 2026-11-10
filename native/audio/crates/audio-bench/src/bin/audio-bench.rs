//! Native entry of the audio core's lab benchmark (see the library's module comment):
//! `cargo run --release -p audio-bench -- mode=scene name=high seconds=60 runs=5`.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    audio_bench::main(&args.join(" "));
}
