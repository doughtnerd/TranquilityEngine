//! `gen_wire [--check]`: writes (or, with `--check`, checks) every family's
//! `src/plugins/animation/runtime/wasm/wire/<family>.ts` and `vectors/<family>.json`.
//! Run from anywhere; the repository root is found from this crate's manifest dir.

use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    let check = std::env::args().any(|a| a == "--check");
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let outputs = match anim_wire::gen::generate_all() {
        Ok(o) => o,
        Err(e) => {
            eprintln!("gen_wire: {e}");
            return ExitCode::FAILURE;
        }
    };
    match anim_wire::gen::write_or_check(&root, &outputs, check) {
        Ok(stale) if check && !stale.is_empty() => {
            for p in stale {
                eprintln!("gen_wire: stale {}", p.display());
            }
            eprintln!("gen_wire: run `node native/anim/build.mjs`");
            ExitCode::FAILURE
        }
        Ok(stale) => {
            for p in stale {
                println!("gen_wire: wrote {}", p.display());
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("gen_wire: {e}");
            ExitCode::FAILURE
        }
    }
}
