//! `gen-equal-power` (0166 M4-0, Z2b; api-and-models §3.1 "Fade laws", architecture §4.4): the
//! 1,024-point quarter-sine table the equal-power fade laws read (`audio-dsp/src/equal_power.rs`).
//!
//! - `cargo run -p gen-equal-power` prints the `QUARTER_SINE` static (doc comment, attribute line
//!   and all) to paste over the one in `equal_power.rs`.
//! - `--check` compares the computed table with `audio_dsp::equal_power::QUARTER_SINE` bit for bit
//!   and exits 1 on any difference.
//!
//! Point `i` is `libm::sin(π/2 · i / (N − 1))` in f64, rounded to the nearest f32 (`as f32`), so
//! `[0] == 0.0` and `[N − 1] == 1.0` exactly. Deterministic: `libm`, no other input. A const
//! context can't call `sin`, so the table is generated and checked in.

use std::process::ExitCode;

use audio_dsp::equal_power::{FADE_CURVE_TABLE_POINTS, QUARTER_SINE};

/// The table, point `i` = `sin(π/2 · i / (N − 1))` rounded to f32.
fn table() -> Vec<f32> {
    (0..FADE_CURVE_TABLE_POINTS)
        .map(|i| libm::sin(core::f64::consts::FRAC_PI_2 * i as f64 / (FADE_CURVE_TABLE_POINTS - 1) as f64) as f32)
        .collect()
}

/// The Rust source of the `QUARTER_SINE` static for `table`: the existing doc comment line, then
/// `pub static QUARTER_SINE: [f32; FADE_CURVE_TABLE_POINTS] = [`, the values eight per line,
/// each printed with `{:?}` (shortest round-trip form, so it reads back bit for bit), and `];`.
/// Add `#[rustfmt::skip]` above it if rustfmt would reflow it.
fn source(table: &[f32]) -> String {
    let mut out = String::new();
    out.push_str("/// `sin(π/2 · i / (N − 1))`, `i` in `0..N` (see the module comment).\n");
    out.push_str("#[rustfmt::skip]\n");
    out.push_str("pub static QUARTER_SINE: [f32; FADE_CURVE_TABLE_POINTS] = [\n");
    for line in table.chunks(8) {
        out.push_str("    ");
        let values: Vec<String> = line.iter().map(|v| format!("{v:?}")).collect();
        out.push_str(&values.join(", "));
        out.push_str(",\n");
    }
    out.push_str("];\n");
    out
}

fn main() -> ExitCode {
    let t = table();
    if std::env::args().any(|a| a == "--check") {
        let differing = (0..FADE_CURVE_TABLE_POINTS).filter(|&i| t.get(i).map(|v| v.to_bits()) != Some(QUARTER_SINE[i].to_bits())).count();
        if differing != 0 || t.len() != FADE_CURVE_TABLE_POINTS {
            eprintln!("equal_power.rs: {differing} of {FADE_CURVE_TABLE_POINTS} points differ from the generator (len {})", t.len());
            return ExitCode::FAILURE;
        }
        println!("equal_power.rs: QUARTER_SINE matches ({FADE_CURVE_TABLE_POINTS} points)");
        return ExitCode::SUCCESS;
    }
    print!("{}", source(&t));
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_generator_matches_the_checked_in_table() {
        let t = table();
        assert_eq!(t.len(), FADE_CURVE_TABLE_POINTS);
        for (i, (a, b)) in t.iter().zip(QUARTER_SINE.iter()).enumerate() {
            assert_eq!(a.to_bits(), b.to_bits(), "point {i}");
        }
    }

    #[test]
    fn the_printed_source_reads_back_bit_for_bit() {
        let t = table();
        let src = source(&t);
        let body = src.split_once("= [").expect("static header").1.split_once("];").expect("static end").0;
        let parsed: Vec<f32> = body.split(',').map(str::trim).filter(|s| !s.is_empty()).map(|s| s.parse().expect("f32 literal")).collect();
        assert_eq!(parsed.len(), FADE_CURVE_TABLE_POINTS);
        for (i, (a, b)) in parsed.iter().zip(t.iter()).enumerate() {
            assert_eq!(a.to_bits(), b.to_bits(), "point {i}");
        }
    }
}
