//! M4 wire, gate family (task W1; leaf L-W1a fills the ignored cases): PLAY `gate`, STREAM_OPEN
//! `music`, the `musicRings` and `groupStarts` STATUS sections and the fuzz rows of API section 4.5.
//!
//! Every case is `#[ignore = "L-W1a"]` until the leaf fills it (`todo!()` bodies); its brief is in the
//! case's doc comment. The first test is live and pins the packers the rest build on.

use audio_wire::generated::*;

#[test]
fn gate_packers_agree_with_the_constants() {
    assert_eq!(PLAY_GATE_ID_MASK, 0x3ff);
    assert_eq!(PLAY_GATE_SIZE_SHIFT, 10);
    assert_eq!(pack_gate(1023, 64), 0xffff);
    assert_eq!((gate_group_id(0xffff), gate_group_size(0xffff)), (1023, 64));
    assert_eq!(pack_gate(0, 7), 0, "id 0 is ungated whatever the size");
    assert_eq!((gate_group_id(0), gate_group_size(0)), (0, 0));
}

/// PLAY `gate` round trips through `Play::write` / `Play::read` and the interpretive codec for every
/// (id, size) corner: (1, 1), (1, 64), (1023, 1), (1023, 64), (512, 32), and 0 (ungated). `group`,
/// `flags` and the other fields are untouched; PLAY stays 56 B; the `gate` bytes sit at offset 22.
#[test]
#[ignore = "L-W1a"]
fn play_gate_round_trips_at_offset_22() {
    todo!("L-W1a")
}

/// STREAM_OPEN `flags` bit 1: `STREAM_OPEN_FLAG_MUSIC` (0x2) round trips next to `loop` (0x1); the body
/// stays 40 B; `STREAM_EVENT_MUSIC_FULL` is 4 and the `StreamEvent` enum has `MusicFull`.
#[test]
#[ignore = "L-W1a"]
fn stream_open_music_flag_round_trips() {
    todo!("L-W1a")
}

/// STATUS `musicRings` (8 B items: streamId, epochFlags with epoch in bits 0-29, primed bit 30, bound
/// bit 31) and `groupStarts` (16 B items: groupId u16, flags u16, slipFrames, startFrameLo, startFrameHi):
/// the counts at 144 and 146 are derived from the section lengths, the sections follow `zoneEvents` in
/// that order, and a hand-computed byte layout matches the writer.
#[test]
#[ignore = "L-W1a"]
fn status_music_sections_round_trip_with_derived_counts() {
    todo!("L-W1a")
}

/// Fuzz rows of API section 4.5: a PLAY of gate size 64 and id 1023; a STATUS with 8 `groupStarts`
/// (and with 9: refused as over its cap); a STATUS with 16 `musicRings` (and 17 refused); every
/// truncation of a STATUS with both sections is an error and never a panic; `musicRingCount` above 16
/// and `groupStartCount` above 8 in the header are refused on read.
#[test]
#[ignore = "L-W1a"]
fn fuzz_rows_of_the_gate_family() {
    todo!("L-W1a")
}

/// STATUS worst case: every section at its cap writes exactly `STATUS_WORST_CASE_BYTES` (16,192 B),
/// under `STATUS_BUFFER_BYTES` (16,384 B) with 192 B spare, and reads back equal. (`tests/m4_per_voice.rs`
/// and `tests/spatial_vectors.rs` already assert the total; this case pins the 128 + 128 B of the two
/// new sections by name.)
#[test]
#[ignore = "L-W1a"]
fn status_worst_case_has_192_bytes_spare() {
    todo!("L-W1a")
}

/// `vectors/wire.json`: add to `vectors/cases.rs` hand-derived cases for a gated PLAY (id 1023, size 64,
/// `fadeZero`), a STREAM_OPEN with `music`, and a STATUS with two `musicRings` and eight `groupStarts`.
/// Regenerate with `gen_wire`; do not hand-edit the JSON.
#[test]
#[ignore = "L-W1a"]
fn golden_vectors_cover_the_gate_family() {
    todo!("L-W1a")
}
