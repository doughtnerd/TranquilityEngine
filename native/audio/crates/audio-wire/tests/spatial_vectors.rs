//! L-A1a: ADR 0162's wire records (spatial audio, M3): golden vectors, round trips through the
//! generated Rust, refusals and a seeded fuzz. The vectors themselves are in `vectors/spatial_cases.rs`;
//! `tests/vectors.rs` already checks every case against the interpretive codec.
//!
//! Skeleton by the A1 lead: every test is `#[ignore]`d with its intent; L-A1a fills and un-ignores them.

#[allow(unused_imports)]
use audio_wire::cases::cases;
#[allow(unused_imports)]
use audio_wire::gen::codec::{encode, to_hex};
#[allow(unused_imports)]
use audio_wire::generated::*;
#[allow(unused_imports)]
use audio_wire::schema::schema;
#[allow(unused_imports)]
use audio_wire::vector::Subject;

/// Every ADR 0162 opcode (SET_VOICE_FX, BED_CONFIG, ZONE_CONFIG, LISTENER), both blob headers
/// (`ZoneKernelHeader`, `MaglsHeader`) and a STATUS with non-empty `beds`/`zones`/`zoneEvents` have at
/// least one vector, plus every case the coverage list of `spatial_cases.rs` names.
#[test]
#[ignore = "L-A1a"]
fn every_m3_record_has_a_vector() {
    todo!("L-A1a")
}

/// Each `Subject::Opcode` vector of an ADR 0162 opcode, decoded from its hex with the generated
/// `read`, then written again with `write`, gives the same bytes and the same length; likewise the
/// blob headers and the M3 STATUS vector through `StatusBlock`.
#[test]
#[ignore = "L-A1a"]
fn m3_vectors_round_trip_through_the_generated_rust() {
    todo!("L-A1a")
}

/// BED_CONFIG's two arrays pad to whole words with zero bytes (5 buses -> 8 B, 3 slots -> 8 B), the
/// record's `words` counts the padding, and a reader given non-zero padding still reads the arrays.
#[test]
#[ignore = "L-A1a"]
fn bed_config_pads_each_array_to_four_bytes() {
    todo!("L-A1a")
}

/// Caps: BED_CONFIG `slotCount` 5 and ZONE_CONFIG `slotCount` 5 are refused on read (`ERR_MALFORMED`)
/// and on write (`ERR_OVERSIZE`); 4 is accepted.
#[test]
#[ignore = "L-A1a"]
fn slot_counts_above_four_are_refused() {
    todo!("L-A1a")
}

/// Truncation: every ADR 0162 record cut at each length below its size (and with `words` claiming
/// more than the buffer) is refused with `ERR_TRUNCATED`, never a panic; a record read with another
/// opcode's reader is `ERR_MALFORMED`.
#[test]
#[ignore = "L-A1a"]
fn truncated_m3_records_are_refused() {
    todo!("L-A1a")
}

/// A LISTENER with NaN or zero quaternion components and a SET_VOICE_FX with NaN sends parse (the
/// wire carries them; the core ignores them, K2) and round-trip bit for bit.
#[test]
#[ignore = "L-A1a"]
fn non_finite_values_survive_the_wire() {
    todo!("L-A1a")
}

/// Seeded fuzz (fixed seed, a small LCG as `wire.roundtrip.test.ts`): 1,000 random byte buffers built
/// from valid ADR 0162 records with random truncation, random `words`, BED_CONFIG with a bad host and
/// huge counts, ZONE_CONFIG with `slotCount` above 4, LISTENER with NaN. Every generated reader
/// returns `Ok` or an `ERR_*` code; none panics or reads out of bounds.
#[test]
#[ignore = "L-A1a"]
fn fuzz_m3_records_never_panic() {
    todo!("L-A1a")
}

/// STATUS worst case (api-and-models §4.3): every section at its cap (ended, demoted, starved 1,024;
/// playheads 256; clip and stream events 64; peaks 32; beds 4; zones 4; zoneEvents 16) writes exactly
/// `STATUS_WORST_CASE_BYTES` (15,904 B, at most `STATUS_BUFFER_BYTES`) and reads back equal.
#[test]
#[ignore = "L-A1a"]
fn status_worst_case_is_15904_bytes() {
    todo!("L-A1a")
}
