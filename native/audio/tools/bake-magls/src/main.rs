//! `bake-magls` (ADR 0162 task A3): designs Myco's order-3 MagLS binaural decoder from the shipped
//! HRIR set and writes `src/engine/audio/magls-o3.bin` (clip format 4, api-and-models §4.5: the
//! 32-byte `MaglsHeader` then f32 `[16][2][256]` at the HRIR's 44.1 kHz, 32,800 B). The filters are
//! derived from the IRCAM Listen IRC_Composite_C data, so its licence and acknowledgement carry over
//! (docs/design/0157-audio-core/hrir-licence.md).
//!
//! - `cargo run --release -p bake-magls` writes the asset and prints the bake check.
//! - `--check` re-bakes it, compares it byte for byte with the committed file, checks the baked
//!   16 → 2 matrix in `audio-dsp/src/bed_matrix.rs` against its design, and runs the bake check of
//!   §9 (cues right at 12 of 12 azimuths, ILD within 1.7 dB of M1's HRTF below 2 kHz). Exit 1 on any
//!   failure. `npm run build:audio` runs it.
//! - `--print-matrix` prints the `BED_MATRIX` source for `bed_matrix.rs`.
//!
//! Deterministic: fixed grids and iteration counts, `libm` transcendentals, microfft's transform, no
//! time or random input (the clock only times the run for the log).

mod check;
mod hrir;
mod linalg;
mod magls;
mod matrix;
mod sh;

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use audio_dsp::hrtf::database::HrirDatabase;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..")
}

fn bake() -> Result<(Vec<u8>, check::Report), String> {
    let hrir_path = repo().join("src/plugins/audio/runtime/wasm/myco_hrir.bin");
    let bytes = std::fs::read(&hrir_path).map_err(|e| format!("{}: {e}", hrir_path.display()))?;
    let asset = hrir::read_asset(&bytes)?;
    let table = hrir::table_at_asset_rate(&asset);
    let db = HrirDatabase::parse(&table).map_err(|e| format!("HRIR table: {e:?}"))?;
    let filters = magls::design(&db);
    let report = check::run(&db, &filters);
    Ok((magls::asset_bytes(&filters, asset.header.rate), report))
}

fn print_report(r: &check::Report) {
    println!("bake check (api-and-models §9), bed vs M1's HRTF:");
    for l in &r.lines {
        println!("{l}");
    }
    println!("  cues right at {} of {} azimuths (elevation 0)", r.azimuths_right, r.azimuths_total);
    for (k, (lo, hi)) in check::BANDS.iter().enumerate() {
        println!("  ILD {lo:>5}-{hi:<5} Hz: mean |diff| {:.2} dB, max {:.2} dB{}", r.ild_mean[k], r.ild_max[k], if k < 3 { format!(" (limit {})", check::ILD_LIMIT_DB) } else { String::new() });
    }
    println!("  ITD 200-1200 Hz: max |diff| {:.0} us at elevation 0, {:.0} us over all 48 directions", r.itd_max0, r.itd_max);
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let asset_path = repo().join("src/engine/audio/magls-o3.bin");
    match args.first().map(String::as_str) {
        Some("--print-matrix") => {
            print!("{}", matrix::rust_source(&matrix::baked()));
            ExitCode::SUCCESS
        }
        None | Some("--check") => {
            let checking = !args.is_empty();
            let start = Instant::now();
            let (bytes, report) = match bake() {
                Ok(x) => x,
                Err(e) => {
                    eprintln!("bake-magls: {e}");
                    return ExitCode::FAILURE;
                }
            };
            let secs = start.elapsed().as_secs_f64();
            print_report(&report);
            let mut ok = report.passed();
            if !ok {
                eprintln!("bake-magls: the bake check failed");
            }
            if checking {
                match std::fs::read(&asset_path) {
                    Ok(committed) if committed == bytes => println!("magls-o3.bin: {} B, reproduced byte for byte", bytes.len()),
                    Ok(committed) => {
                        eprintln!("bake-magls: magls-o3.bin ({} B) differs from the bake ({} B): run `cargo run --release -p bake-magls` and commit it", committed.len(), bytes.len());
                        ok = false;
                    }
                    Err(e) => {
                        eprintln!("bake-magls: {}: {e}", asset_path.display());
                        ok = false;
                    }
                }
                let m = matrix::baked();
                let same = (0..2).all(|e| (0..16).all(|c| m[e][c].to_bits() == audio_dsp::bed_matrix::BED_MATRIX[e][c].to_bits()));
                if same {
                    println!("bed_matrix.rs: BED_MATRIX matches its design");
                } else {
                    eprintln!("bake-magls: audio-dsp/src/bed_matrix.rs's BED_MATRIX differs from the design; paste `--print-matrix`");
                    ok = false;
                }
            } else if let Err(e) = std::fs::write(&asset_path, &bytes) {
                eprintln!("bake-magls: {}: {e}", asset_path.display());
                return ExitCode::FAILURE;
            } else {
                println!("wrote {} ({} B)", asset_path.display(), bytes.len());
            }
            println!("bake time {secs:.2} s");
            if ok {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        _ => {
            eprintln!("usage: bake-magls [--check | --print-matrix]");
            ExitCode::FAILURE
        }
    }
}
