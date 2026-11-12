//! The group hold on starve (0166 M4a; architecture §4.3 rows "Started" and "Held", §2.2; rulings
//! R11; ADR 0167 §2 "A stem that runs dry mid-piece holds its whole group", §3.6 owner decision 6;
//! tree A3, hook H2).
//!
//! When any gated **mixed** member of a started group would starve this quantum (the existing check:
//! buffered < the quantum + a 5 ms fade, `voices.rs`'s stream branch), every gated member takes the
//! 5 ms starve fade (`STARVE_FADE_SECONDS`) **together**, then holds silent with its position
//! pinned; decoded members too. The group resumes when every member has ≥ 4,096 frames buffered
//! (or its input ended): all at offset 0 with a 5 ms fade-in, their queued records rebased by the
//! hold's length (`group_rebase::apply`), a resume reported with the slip. Held more than 1 s, the
//! group is abandoned (`groups::decide`). An ungated stream voice starves alone, as today.
//!
//! **The hooks (H2, C2b's skeleton).** The starve path in `voices.rs` calls [`on_starve`]; every
//! gated member asks [`must_hold`] before rendering; `groups::begin_quantum` calls [`try_resume`]
//! for a held entry. So C2c fills this file and edits neither `voices.rs` nor `groups.rs`.
//!
//! Owner: **C2c** (W6). Q1 left the signatures; bodies tagged `C2c:` are inert stubs.

use crate::groups::GroupEntry;

/// What a starving voice does ([`on_starve`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StarveAction {
    /// Starve alone, as today (ungated, or its group isn't started).
    Alone,
    /// Its group is held from this quantum: take the starve fade with the others, then hold.
    Group,
}

/// A member of the entry at `index` (`entries[index]`) would starve in the quantum at `frame`:
/// moves a started group to HELD (counts `groupsHeld` in `groups_held`, saturating) and says what
/// the voice does. Called from the starve path in `voices.rs` (H2).
pub fn on_starve(entries: &mut [GroupEntry], index: u8, voice_id: u32, frame: u64, groups_held: &mut u16) -> StarveAction {
    // C2c.
    let _ = (entries, index, voice_id, frame, groups_held);
    StarveAction::Alone
}

/// `true` while the entry at `index` is held: a gated member that isn't starving itself still
/// fades out with the group this quantum and holds silent, position pinned.
pub fn must_hold(entries: &[GroupEntry], index: u8) -> bool {
    // C2c.
    let _ = (entries, index);
    false
}

/// A held `entry` in the quantum at `frame`, `all_ready` when every member has ≥ 4,096 frames
/// buffered or its input ended: resumes it (state STARTED, `start_frame` = `frame`, the resume event
/// pending) and returns the slip (the hold's length, `held_frames`) for `group_rebase::apply` and
/// `maxSlipFrames`; `None` while it stays held (`held_frames` grows by the quantum).
pub fn try_resume(entry: &mut GroupEntry, frame: u64, all_ready: bool) -> Option<u32> {
    // C2c.
    let _ = (entry, frame, all_ready);
    None
}
