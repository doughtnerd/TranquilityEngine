//! M4 wire, per-voice family (task Z1; leaf L-Z1a fills the ignored cases): the `shape` word on FADE,
//! SET_PARAMS and STOP, PLAY `fadeZero`, the 176-byte STATUS header (API section 4.1, 4.2, 4.4).
//!
//! The first test is live: it pins the generator's "an older, shorter record reads the appended word
//! as 0" rule, which the rest rely on. Every other case is `#[ignore = "L-Z1a"]` until the leaf fills
//! it (`todo!()` bodies), with its brief in the case's doc comment.

use audio_wire::generated::*;

/// A FADE, STOP or SET_PARAMS of the old (pre-1.2) size reads `shape` as 0, and the writer always
/// writes the new size.
#[test]
fn older_records_without_the_shape_word_read_it_as_zero() {
    let mut buf = vec![0u8; 128];
    let fade = Fade { voice_id: 7, frame_offset: 96, target: 1.0, frames: 480, flags: 0, shape: pack_shape(fade_law::EQUAL_POWER_IN, 0x4000) };
    assert_eq!(fade.write(&mut buf, 0).unwrap(), 28);
    assert_eq!(Fade::read(&buf, 0).unwrap().0, fade);
    // The same record cut to 24 B with `words` = 6 (an older writer): shape reads 0.
    buf[2..4].copy_from_slice(&6u16.to_le_bytes());
    let (old, used) = Fade::read(&buf[..24], 0).unwrap();
    assert_eq!((old.shape, used), (0, 24));
    assert_eq!((old.target, old.frames), (1.0, 480));
    // `words` = 7 over a buffer that ends inside the shape word is TRUNCATED, not a short read.
    buf[2..4].copy_from_slice(&7u16.to_le_bytes());
    assert_eq!(Fade::read(&buf[..26], 0).unwrap_err(), ERR_TRUNCATED);
    // A record shorter than the old size is TRUNCATED.
    buf[2..4].copy_from_slice(&5u16.to_le_bytes());
    assert_eq!(Fade::read(&buf[..20], 0).unwrap_err(), ERR_TRUNCATED);

    let stop = Stop { voice_id: 3, frame_offset: ASAP, fade_frames: 240, reason: 1, shape: pack_shape(fade_law::EQUAL_POWER_OUT, 0) };
    assert_eq!(stop.write(&mut buf, 0).unwrap(), 24);
    buf[2..4].copy_from_slice(&5u16.to_le_bytes());
    assert_eq!(Stop::read(&buf[..20], 0).unwrap().0.shape, 0);

    let set = SetParams { voice_id: 3, frame_offset: 0, mask: SET_PARAMS_MASK_GAIN, gain: 0.5, ramp_frames: 128, shape: pack_shape(fade_law::S_CURVE, 1), ..Default::default() };
    assert_eq!(set.write(&mut buf, 0).unwrap(), 60);
    buf[2..4].copy_from_slice(&14u16.to_le_bytes());
    assert_eq!(SetParams::read(&buf[..56], 0).unwrap().0.shape, 0);
}

/// The shape word's packers and readers: law in bits 0-2, `startPhase` in bits 16-31, the other bits
/// ignored by the readers; `FadeLaw` values 0..3; the constants of API section 4.5 have their values.
#[test]
#[ignore = "L-Z1a"]
fn shape_word_packs_law_and_start_phase() {
    todo!("L-Z1a: pack_shape / shape_law / shape_start_phase over every law and phase 0, 1, 0x7fff, 0xffff; SHAPE_* constants")
}

/// FADE (28 B), SET_PARAMS (60 B) and STOP (24 B) round trip a non-zero shape word through the
/// generated writer and reader and through the interpretive codec (`Subject::Opcode`).
#[test]
#[ignore = "L-Z1a"]
fn longer_records_round_trip_the_shape_word() {
    todo!("L-Z1a: one record of each, every law, phases 0 and 0xffff; sizes 28 / 60 / 24; words field matches")
}

/// Fuzz: every truncation of each longer record (every length from 0 to its size, with `words`
/// unchanged and with `words` set to the cut) is `Err(TRUNCATED)` or an older record reading shape 0;
/// never a panic and never a read past the buffer.
#[test]
#[ignore = "L-Z1a"]
fn truncated_shape_word_never_panics() {
    todo!("L-Z1a: the truncation sweep of FADE, SET_PARAMS and STOP; a record that ends inside the shape word")
}

/// PLAY `flags` bit 8 `fadeZero` (`PLAY_FLAGS_FADE_ZERO`, 0x100): round trips with the other bits
/// untouched (panner, ambisonic, loop) and is not read from SET_PARAMS `flags` as a panner bit.
#[test]
#[ignore = "L-Z1a"]
fn play_fade_zero_flag_round_trips() {
    todo!("L-Z1a: PLAY with flags = FADE_ZERO | MIXED | panner 1; the writer keeps bit 8; PLAY stays 56 B")
}

/// STATUS: `HEADER_BYTES` and `STATUS_HEADER_BYTES` are 176; every M4 header field sits at its offset
/// of API section 4.4's table (144 musicRingCount ... 172 reserved) and round trips a distinct value;
/// sections move up 32 B.
#[test]
#[ignore = "L-Z1a"]
fn status_header_is_176_bytes_with_every_m4_field_at_its_offset() {
    todo!("L-Z1a: write a StatusBlock with distinct values for the 12 M4 fields, check each at its offset by hand, read it back")
}

/// STATUS worst case. Merge 1 (header only): 15,936 B = `STATUS_WORST_CASE_BYTES`. After W1 adds the
/// `musicRings` (16 x 8 B) and `groupStarts` (8 x 16 B) sections it is 16,192 B of 16,384; this case is
/// updated by L-W1a then. Here: a STATUS with every section at its cap writes exactly the constant and
/// fits `STATUS_BUFFER_BYTES`.
#[test]
#[ignore = "L-Z1a"]
fn status_worst_case_matches_the_constant() {
    todo!("L-Z1a: every section at its cap; n == STATUS_WORST_CASE_BYTES == 15_936; n <= STATUS_BUFFER_BYTES")
}

/// `vectors/wire.json` golden records: add to `vectors/cases.rs` a hand-derived case for FADE with a
/// non-zero shape (equal power in, phase 0x4000), STOP with equal power out, SET_PARAMS with an
/// S-curve, a PLAY with `fadeZero`, and a STATUS with every M4 header field non-zero; run `gen_wire`
/// and keep `vectors.rs` green. The hex is derived by hand from the section 4 tables, not from the
/// writers.
#[test]
#[ignore = "L-Z1a"]
fn golden_vectors_cover_every_longer_record() {
    todo!("L-Z1a: the five cases in vectors/cases.rs; every_vector_encodes_to_its_hand_derived_bytes stays green")
}
