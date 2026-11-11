//! Class S records: the voice-local split (0166 M4-0; api-and-models §3.1 "Class G and class S";
//! architecture §4.4 "`render`" step 3; rulings R2, R3; ADR 0167 §1.1; tree A1, hook H1).
//!
//! Every per-voice record that isn't gain-like (SET_PARAMS with pitch, low-pass, direction, score,
//! bus or flag bits; SET_VOICE_FX; SET_PAUSED; SEEK; SET_LOOP) applies by splitting **that voice's**
//! render at the record's sample: the voice alone renders `[from, k)`, applies the record, then
//! renders `[k, to)`. Two class G records for one voice at different offsets in one quantum take
//! this path too (the second one's sample becomes a boundary). Sends and beds already tap per
//! range, so a split voice's taps stay exact. Each voice-local split counts `voiceSplits`.
//!
//! **The hook (H1, Z2a's skeleton in `voices.rs`).** The per-voice loop renders each flagged voice
//! in the sub-ranges [`boundaries`] returns, applying the records due at each piece's first sample
//! before rendering it; a voice without the due flag takes one range, exactly as today. So Z2c
//! fills this file and never edits `voices.rs`.
//!
//! Owner: **Z2c** (W3, on the flip branch). Q1 left the types and the signature; the stub returns
//! the single range `[from, to)` (today's behaviour).

use crate::due::DueRecord;
use crate::QUANTUM;

/// A voice's sub-range boundaries in one range of a quantum: `at[0] == from`,
/// `at[len - 1] == to`, strictly increasing, so piece `j` is `at[j]..at[j + 1]`. At most one
/// boundary per sample plus the end (`QUANTUM + 1`); sample offsets fit a byte (`QUANTUM` = 128).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pieces {
    pub len: u8,
    pub at: [u8; QUANTUM + 1],
}

impl Pieces {
    /// The single range `[from, to)`.
    pub fn whole(from: usize, to: usize) -> Pieces {
        let mut at = [0u8; QUANTUM + 1];
        at[0] = from as u8;
        at[1] = to as u8;
        Pieces { len: 2, at }
    }

    /// The pieces as `(start, end)` sample offsets, in order.
    pub fn ranges(&self) -> impl Iterator<Item = (usize, usize)> + '_ {
        self.at[..self.len as usize].windows(2).map(|w| (w[0] as usize, w[1] as usize))
    }

    /// Pieces past the first: the voice-local splits this range takes (each counts `voiceSplits`).
    pub fn splits(&self) -> u32 {
        (self.len as u32).saturating_sub(2)
    }
}

/// The sub-ranges voice `voice_id` renders over `from..to` (sample offsets in the quantum at
/// absolute frame `frame`), given its due records in frame order (`due::DueList::for_voice`):
/// - a boundary at each class S record's sample inside `(from, to)`;
/// - a boundary at the sample of every class G record after the voice's first class G sample in
///   this quantum, when they differ (two class G offsets → the class S path);
/// - none for a record at or before `from`: it applies before the first piece. That covers a late
///   record (offset 0, counted late by the caller) and a voice that starts inside the quantum,
///   for which the caller passes its start offset as `from` (§3.1: a due record at a voice's own
///   start frame applies before its first sample).
///
/// Writes `out`; the caller counts `out.splits()` in `voiceSplits`. Control rate: one pass over the
/// voice's records, no per-sample work.
pub fn boundaries<'r>(records: impl Iterator<Item = &'r DueRecord>, frame: u64, from: usize, to: usize, out: &mut Pieces) {
    // Z2c. Until then: one range, as today.
    let _ = (records, frame);
    *out = Pieces::whole(from, to);
}
