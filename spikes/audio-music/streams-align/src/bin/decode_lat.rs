//! Timing runner (NATIVE decode, not the wasm worker): how long the decoder takes to open a file, seek to a start
//! frame and produce the first 4,096-frame chunk (what a primed stream needs before the ring can start) and a full
//! 32,768-frame ring. This is the decoder's share of the prime lead; it excludes fetch, the postMessage hops and the
//! wasm slowdown (est. 1.5-3x). Usage: `decode_lat [--runs R] [--iters N]` (default 7 x 100; expected ~40 s on an
//! idle machine). Smoke: `decode_lat --runs 2 --iters 5`.
use audio_decode::{Decoder, FormatHint};
use std::sync::Arc;
use std::time::Instant;

fn pct(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[(((v.len() - 1) as f64) * p).round() as usize]
}

fn arg(name: &str, default: usize) -> usize {
    let a: Vec<String> = std::env::args().collect();
    a.iter().position(|x| x == name).and_then(|i| a.get(i + 1)).and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn main() {
    let (runs, iters) = (arg("--runs", 7), arg("--iters", 100));
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let fx = root.join("native/audio/crates/audio-decode/tests/fixtures");
    let files: Vec<(&str, std::path::PathBuf, FormatHint)> = vec![
        ("town.mp3 (3.3 MB, real music)", root.join("samples/flappy/music/town.mp3"), FormatHint::Mp3),
        ("tone-48000-stereo.ogg (Vorbis)", fx.join("tone-48000-stereo.ogg"), FormatHint::Ogg),
        ("tone-48000-stereo.flac", fx.join("tone-48000-stereo.flac"), FormatHint::Flac),
        ("tone-48000-stereo.wav", fx.join("tone-48000-stereo.wav"), FormatHint::Wav),
    ];
    println!("| file | stage | start frame | runs | p50 ms (median of runs) | p99 ms | p99.9 ms | max ms |\n|---|---|---|---|---|---|---|---|");
    for (name, path, hint) in files {
        let bytes: Arc<dyn AsRef<[u8]> + Send + Sync> = Arc::new(std::fs::read(&path).unwrap());
        let probe = Decoder::open(bytes.clone(), hint).unwrap();
        let info = probe.info();
        let frames = info.frames.unwrap_or(0);
        let ch = info.channels as usize;
        for (stage, start, chunks) in [("open + first chunk", 0u64, 1usize), ("open + seek + first chunk", (frames / 2).min(1_000_000), 1), ("open + seek + full ring (8 chunks)", (frames / 2).min(1_000_000), 8)] {
            if start == 0 && stage.contains("seek") {
                continue;
            }
            let mut buf = vec![0f32; 4096 * ch];
            let mut per_run: Vec<[f64; 4]> = vec![];
            for _ in 0..runs {
                let mut t: Vec<f64> = Vec::with_capacity(iters);
                for _ in 0..iters {
                    let t0 = Instant::now();
                    let mut d = Decoder::open(bytes.clone(), hint).unwrap();
                    if start > 0 {
                        d.seek(start).unwrap();
                    }
                    for _ in 0..chunks {
                        let n = d.read_f32(&mut buf).unwrap();
                        std::hint::black_box(n);
                    }
                    t.push(t0.elapsed().as_secs_f64() * 1e3);
                }
                per_run.push([pct(&mut t, 0.5), pct(&mut t, 0.99), pct(&mut t, 0.999), *t.last().unwrap()]);
            }
            let med = |k: usize| {
                let mut v: Vec<f64> = per_run.iter().map(|r| r[k]).collect();
                pct(&mut v, 0.5)
            };
            println!("| {name} | {stage} | {start} | {runs}x{iters} | {:.3} | {:.3} | {:.3} | {:.3} |", med(0), med(1), med(2), per_run.iter().map(|r| r[3]).fold(0.0, f64::max));
        }
    }
}
