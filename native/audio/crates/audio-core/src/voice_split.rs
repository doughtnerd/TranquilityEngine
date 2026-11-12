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
//! Owner: **Z2c** (W3, on the flip branch). H1's `next_piece` also stops a piece at the next record
//! the gain loop doesn't take, and at the record after the one it takes; these boundaries state the
//! same cuts up front, so the rendered output and the `voiceSplits` count are the same either way
//! (H1's own guarantee that every record lands on its sample doesn't rest on this file).

use crate::due::{Class, DueRecord};
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
    out.at[0] = from as u8;
    let mut len = 1usize;
    // The voice's first class G sample in this quantum, once seen.
    let mut first_g: Option<usize> = None;
    for r in records {
        let k = crate::due::offset(r, frame);
        if k >= to {
            break;
        }
        let cut = match crate::due::classify(r) {
            Class::G => match first_g {
                None => {
                    first_g = Some(k);
                    false
                }
                Some(g) => k != g,
            },
            // Class S (and, defensively, anything else that reached a voice's list).
            Class::S | Class::Quantum => true,
        };
        // At or before `from`: applies before the first piece. Records come in frame order, so a
        // sample already a boundary is skipped (one boundary per sample).
        if cut && k > from && k > out.at[len - 1] as usize {
            out.at[len] = k as u8;
            len += 1;
        }
    }
    out.at[len] = to as u8;
    out.len = (len + 1) as u8;
}

#[cfg(test)]
mod tests {
    use super::*;
    use audio_wire::generated::{op, SET_PARAMS_MASK_GAIN, SET_PARAMS_MASK_LP_HZ, SET_PARAMS_MASK_PITCH};

    const F: u64 = 1_280; // the quantum's first frame

    fn rec(op: u16, mask: u32, at: i64) -> DueRecord {
        DueRecord { frame: (F as i64 + at) as u64, voice_id: 1, op: op as u8, mask: mask as u8, ..Default::default() }
    }
    fn s(at: i64) -> DueRecord {
        rec(op::SET_PARAMS, SET_PARAMS_MASK_PITCH, at)
    }
    fn g(at: i64) -> DueRecord {
        rec(op::SET_PARAMS, SET_PARAMS_MASK_GAIN, at)
    }
    fn cut(records: &[DueRecord], from: usize, to: usize) -> (Vec<(usize, usize)>, u32) {
        let mut p = Pieces::whole(0, 0);
        boundaries(records.iter(), F, from, to, &mut p);
        (p.ranges().collect(), p.splits())
    }

    #[test]
    fn the_table() {
        let q = QUANTUM;
        #[rustfmt::skip]
        let cases: &[(&str, Vec<DueRecord>, usize, usize, Vec<(usize, usize)>)] = &[
            ("no records: one range", vec![], 0, q, vec![(0, q)]),
            ("class S inside", vec![s(50)], 0, q, vec![(0, 50), (50, q)]),
            ("every class S record", vec![rec(op::SET_PAUSED, 0, 10), rec(op::SEEK, 0, 20), rec(op::SET_LOOP, 0, 30), rec(op::SET_PARAMS, SET_PARAMS_MASK_LP_HZ, 40)], 0, q,
                vec![(0, 10), (10, 20), (20, 30), (30, 40), (40, q)]),
            ("two at one sample: one boundary", vec![s(50), s(50)], 0, q, vec![(0, 50), (50, q)]),
            ("at from: applies before", vec![s(0)], 0, q, vec![(0, q)]),
            ("late (offset 0): applies before", vec![s(-40)], 0, q, vec![(0, q)]),
            ("before a start offset", vec![s(10), s(30), s(80)], 30, q, vec![(30, 80), (80, q)]),
            ("at or past to: not in this range", vec![s(20), s(64), s(90)], 0, 64, vec![(0, 20), (20, 64)]),
            ("last sample", vec![s(127)], 0, q, vec![(0, 127), (127, q)]),
            ("one class G: the gain loop's", vec![g(40)], 0, q, vec![(0, q)]),
            ("class G at one sample twice: no cut", vec![g(40), g(40)], 0, q, vec![(0, q)]),
            ("two class G offsets: the second cuts", vec![g(30), rec(op::FADE, 0, 70)], 0, q, vec![(0, 70), (70, q)]),
            ("three class G offsets", vec![g(30), g(70), rec(op::STOP, 0, 100)], 0, q, vec![(0, 70), (70, 100), (100, q)]),
            ("class G at from counts as the first", vec![g(0), g(60)], 0, q, vec![(0, 60), (60, q)]),
            ("G and S mixed", vec![g(20), s(40), g(40), g(90)], 0, q, vec![(0, 40), (40, 90), (90, q)]),
        ];
        for (what, records, from, to, want) in cases {
            let (got, splits) = cut(records, *from, *to);
            assert_eq!(&got, want, "{what}");
            assert_eq!(splits as usize, want.len() - 1, "{what}: splits");
        }
    }

    #[test]
    fn a_boundary_at_every_sample_fits() {
        let records: Vec<DueRecord> = (0..QUANTUM as i64).map(s).collect();
        let (got, splits) = cut(&records, 0, QUANTUM);
        assert_eq!(got.len(), QUANTUM);
        assert_eq!(splits as usize, QUANTUM - 1);
        assert!(got.iter().enumerate().all(|(i, &(a, b))| a == i && b == i + 1));
    }
}
