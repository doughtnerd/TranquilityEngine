//! L-A1a: ADR 0162's byte vectors (spatial audio, M3), with the expected bytes derived **by hand** from
//! the tables of api-and-models §4.2–§4.5 and contracts C1–C7 (never by running the writers). Same
//! conventions as `cases.rs` (see `crate::vector`): envelopes carry version 1.1 (`0101`); f32 as
//! `f32::to_bits`, little-endian; each record commented with its field offsets.
//!
//! `cases::cases()` chains these after the M1/M2 vectors, so `tests/vectors.rs` checks each against
//! the interpretive codec and `gen_wire` writes them to `vectors/wire.json` for the TypeScript round
//! trip (rerun `gen_wire` after editing this file).
//!
//! Coverage required (L-A1a), envelope `seq` values 40..=49 where a message is a whole kind:
//! - SET_VOICE_FX: every mask bit at once with all four sends, stamped; and hp only, asap, auxBus 0xFFFF.
//! - BED_CONFIG: 5 buses and 3 slots (both arrays padded: 5 -> 8 B, 3 x 2 -> 8 B), one bus 0xFF and
//!   one slot 0xFFFF; 4 buses and 0 slots (no padding, empty hostBus); 0 buses and 0 slots (20 B).
//! - ZONE_CONFIG: 0 slots (24 B); 3 slots (72 B) with states 1, 2, 3 and one kernelId 0 (off); 4 slots.
//! - LISTENER: a ramped rotation, and a snap (flags bit0).
//! - PLAY with bit 7 `ambisonic` set; PLAY and SET_PARAMS with panner 2 (bed).
//! - STREAM_OPEN with 16 channels and convention 1 (FuMa).
//! - CLIP_BEGIN with format 3 (id 0xFFFF0200), 4 (id 0xFFFF0100) and 5 (id 0xFFFF02FF).
//! - `BlobHeader("ZoneKernelHeader")` and `BlobHeader("MaglsHeader")`, every field distinct.
//! - a STATUS whose ADR 0162 header fields are all distinct and non-zero, `flags` with bit 6, and the
//!   `beds`, `zones` and `zoneEvents` sections non-empty (the M1/M2 sections may be empty).
//! - a BATCH carrying one record of each new opcode.

use crate::vector::VectorCase;

#[allow(unused_imports)]
use crate::model::Value;
#[allow(unused_imports)]
use crate::vector::Subject;

/// ADR 0162's vectors. L-A1a: fill (empty until then, so `cases()` stays valid).
pub fn spatial_cases() -> Vec<VectorCase> {
    Vec::new() // L-A1a
}
