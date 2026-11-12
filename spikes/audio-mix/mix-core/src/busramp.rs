//! S4 (M5): a stamped bus-gain ramp (a start frame inside the quantum, a length in frames, from/to) next to today's
//! `Ramp::next` loop. The stamped form needs no quantum split: the quantum's gain is hold(from), ramp, hold(to) in one pass,
//! the way M4-0's in-voice ramps start at their sample (`audio-core/src/curves.rs`, `due.rs`).
use audio_dsp::ramp::Ramp;

pub const Q: usize = 128;

/// One ramp record. `start` is an absolute frame (u64: no wrap in 12 million years at 48 kHz).
#[derive(Clone, Copy, Debug)]
pub struct Stamped {
    pub start: u64,
    pub frames: u32,
    pub from: f32,
    pub to: f32,
}

impl Stamped {
    /// Writes the per-sample gain of the quantum starting at `q0` into `out`; true once the ramp has ended inside or
    /// before this quantum. Frame `k` (0-based) of the ramp is `from + (to - from) * (k + 1) / frames`, the same rule
    /// as `Ramp::next`, and the last frame is exactly `to`.
    #[inline]
    pub fn fill(&self, q0: u64, out: &mut [f32; Q]) -> bool {
        let rel = self.start as i64 - q0 as i64; // sample of the quantum where the ramp's frame 0 falls (may be < 0 or >= Q)
        let hold_from = rel.clamp(0, Q as i64) as usize;
        for s in out[..hold_from].iter_mut() {
            *s = self.from;
        }
        let end_rel = rel + self.frames as i64; // first sample after the ramp
        let ramp_end = end_rel.clamp(hold_from as i64, Q as i64) as usize;
        if ramp_end > hold_from {
            let step = (self.to - self.from) / self.frames as f32;
            let k0 = (hold_from as i64 - rel) as f32; // frames of the ramp already run before the first ramp sample here
            let base = self.from + step * (k0 + 1.0);
            for (j, s) in out[hold_from..ramp_end].iter_mut().enumerate() {
                *s = base + step * j as f32;
            }
            if end_rel <= Q as i64 && end_rel > 0 {
                out[ramp_end - 1] = self.to;
            }
        }
        for s in out[ramp_end..].iter_mut() {
            *s = self.to;
        }
        end_rel <= Q as i64
    }
}

/// Today's path (`bus.rs` mixdown): the bus's `Ramp` stepped per sample into the stereo block.
#[inline]
pub fn apply_ramp(r: &mut Ramp, l: &mut [f32], rr: &mut [f32]) {
    if r.is_settled() {
        let g = r.value;
        if g != 1.0 {
            for x in l.iter_mut().chain(rr.iter_mut()) {
                *x *= g;
            }
        }
    } else {
        for i in 0..Q {
            let g = r.next();
            l[i] *= g;
            rr[i] *= g;
        }
    }
}

#[inline]
pub fn apply_curve(l: &mut [f32], r: &mut [f32], g: &[f32; Q]) {
    for i in 0..Q {
        l[i] *= g[i];
        r[i] *= g[i];
    }
}
