//! Sequence and parallel programs: tween members at offsets (`sequence(a, b)` is members at 0 and
//! `a`'s length, `parallel(a, b)` members all at 0; the host computes the offsets).
//!
//! Only the program moved here from `anim-wasm/src/timeline.rs` (ADR 0424 spike): the members, their
//! evaluation at a sequence time and the order in which they complete. Playing one (the playhead,
//! wrap modes, speed, seek, pause, the `SEQ_CREATE`/`SEQ_MEMBER` records, the value and weight
//! blocks, `CHANGE_MEMBER_DONE`) is a timeline instance and stays in the animation core's timeline,
//! with the `timeline` wire family.

use alloc::vec::Vec;

use crate::spec::{finite_or, Curves, Spec};

/// One tween of a sequence, starting `offset` seconds into it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Member {
    pub spec: Spec,
    /// Seconds into the sequence at which the tween's delay starts (≥ 0).
    pub offset: f32,
    /// The host's id, echoed when the member completes.
    pub host_id: u32,
    /// Done at the last evaluation.
    pub done: bool,
}

impl Member {
    /// A member at `offset` (non-finite or negative reads as 0).
    pub fn new(spec: Spec, offset: f32, host_id: u32) -> Member {
        Member {
            spec,
            offset: finite_or(offset, 0.0).max(0.0),
            host_id,
            done: false,
        }
    }

    /// Seconds from the sequence's start to this member's end (infinite for endless loops).
    pub fn end(&self) -> f64 {
        self.offset as f64 + self.spec.total()
    }
}

/// The sequence's length: its last member's end (0 for none, infinite with an endless member).
pub fn duration(members: &[Member]) -> f64 {
    members.iter().fold(0.0f64, |d, m| d.max(m.end()))
}

/// Evaluates every member at sequence time `t`: `write(i, Some(value))` for a member past its
/// delay, `write(i, None)` for one before it. With `emit`, `order` receives the members that
/// completed at this evaluation (done now, not at the last one), ordered by their end time, then
/// index; it is cleared first and never grows past `members.len()` (reserve that once).
pub fn eval<C, F>(
    curves: &C,
    members: &mut [Member],
    t: f32,
    emit: bool,
    order: &mut Vec<u32>,
    mut write: F,
) where
    C: Curves + ?Sized,
    F: FnMut(usize, Option<&[f32; 4]>),
{
    order.clear();
    for i in 0..members.len() {
        let m = &mut members[i];
        let mut v = [0.0f32; 4];
        let ev = m.spec.eval(t as f64 - m.offset as f64, curves, &mut v);
        write(i, if ev.started { Some(&v) } else { None });
        let completed = emit && ev.done && !m.done;
        m.done = ev.done;
        if completed {
            // Inserted in order (members come in index order, so after every earlier member that
            // ends no later): no general sort, which would link far more code than this needs.
            let end = members[i].end();
            let at = order.partition_point(|&j| {
                members[j as usize].end().partial_cmp(&end) != Some(core::cmp::Ordering::Greater)
            });
            order.insert(at, i as u32);
        }
    }
}
