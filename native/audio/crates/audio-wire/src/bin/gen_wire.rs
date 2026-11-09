//! `gen_wire [--check]`: write (or check) `generated.rs`, `wire.generated.ts` and `vectors/wire.json`.
//! Run from anywhere; the repository root is found from this crate's manifest dir.

use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    let check = std::env::args().any(|a| a == "--check");
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let outputs = match audio_wire::gen::generate_all() {
        Ok(o) => o,
        Err(e) => {
            eprintln!("gen_wire: {e}");
            return ExitCode::FAILURE;
        }
    };
    match audio_wire::gen::write_or_check(&root, &outputs, check) {
        Ok(stale) if stale.is_empty() => ExitCode::SUCCESS,
        Ok(stale) => {
            for p in stale {
                eprintln!("gen_wire: stale {}", p.display());
            }
            eprintln!("gen_wire: run `npm run build:audio`");
            ExitCode::FAILURE
        }
        Err(e) => {
            eprintln!("gen_wire: {e}");
            ExitCode::FAILURE
        }
    }
}
