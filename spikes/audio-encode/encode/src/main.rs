//! Native command for the reference numbers: `audio_encode <codec> [quality] [rate] [complexity] < in.wav > out`.
use std::io::{Read, Write};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let codec = args.get(1).map(String::as_str).unwrap_or("pcm");
    let quality: f32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0.5);
    let ceiling: Option<u32> = args.get(3).and_then(|s| s.parse().ok()).filter(|&r| r > 0);
    let complexity: i32 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(10);
    let mut input = Vec::new();
    std::io::stdin().read_to_end(&mut input).unwrap();
    let (bytes, stats) = audio_encode_spike::encode(&input, codec, quality, ceiling, complexity);
    std::io::stdout().write_all(&bytes).unwrap();
    eprintln!("{stats}");
}
