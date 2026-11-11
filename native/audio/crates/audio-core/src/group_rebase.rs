//! The slip rebase (0166 M4a; architecture §3.6 "Held records", §4.3 rows "Stamped" and "Held";
//! api-and-models §3.1 "parked"; rulings R10; ADR 0167 §2 "A held group's stamped records are
//! rebased by its slip"; tree A2, A3, hook H2).
//!
//! When a group starts late (slip = start − stamp) or resumes after a hold (slip = the hold's
//! length), every record of a **member** whose frame is ≥ the stamp (or ≥ the hold's start) is
//! shifted by the slip, parked or still pending, so fades stay aligned to the music, not the clock.
//! Records of non-members (the outgoing group's fade-out) aren't shifted: a late start leaves a hole
//! of the slip's length at the seam (§11). Parked records past the 128th were applied at their own
//! frame already (`parkedOverflow`); they aren't rebased.
//!
//! **The hook (H2, C2b's skeleton).** The gate's start and resume (`groups::begin_quantum`) call
//! [`apply`]; it reaches the parked and pending records only through `due::rebase` (Z2a's API), so
//! C2d edits neither `due.rs` nor `groups.rs`.
//!
//! Owner: **C2d** (W6). Q1 left the signature; the body tagged `C2d:` is an inert stub.

use crate::core::Core;
use crate::due::Rebased;

/// Rebases the records of the entry at `index`'s members by `slip` frames: those with frame ≥
/// `from_frame` (the stamp for a late start, the hold's start for a resume). A zero slip moves
/// nothing. Called by the gate's start and resume (H2).
pub fn apply(core: &mut Core, index: u8, from_frame: u64, slip: u32) -> Rebased {
    // C2d: read the entry's members (`groups::entries`), then `due::rebase(core, is_member, from_frame, slip)`.
    let _ = (core, index, from_frame, slip);
    Rebased::default()
}
