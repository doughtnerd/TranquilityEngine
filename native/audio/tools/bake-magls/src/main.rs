//! `bake-magls` (ADR 0162 task A3): designs Myco's order-3 MagLS binaural decoder from the shipped
//! HRIR set and writes `src/engine/audio/magls-o3.bin` (clip format 4, api-and-models §4.5).
//!
//! - `cargo run --release -p bake-magls` writes the asset.
//! - `--check` re-bakes it, compares it byte for byte with the committed file, checks the baked
//!   16 → 2 matrix in `audio-dsp/src/bed_matrix.rs` against its design, and runs the bake check of
//!   §9 (cues right at 12 of 12 azimuths, ILD within 1.7 dB of M1's HRTF below 2 kHz). Exit 1 on any
//!   failure. `npm run build:audio` runs it.
//! - `--print-matrix` prints the `BED_MATRIX` source for `bed_matrix.rs`.
//!
//! Deterministic: fixed grids and iteration counts, `libm` transcendentals, microfft's transform, no
//! time or random input.

mod linalg;
mod matrix;
mod sh;

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--print-matrix") => {
            print!("{}", matrix::rust_source(&matrix::baked()));
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("usage: bake-magls [--check | --print-matrix]");
            ExitCode::FAILURE
        }
    }
}
