// SPDX-License-Identifier: Apache-2.0 OR MIT
//! The stagger planner (ADR 0162 C1, api-and-models §5.2, architecture §4.4): picks each new
//! convolver instance's [`Phase`], so the tail work of several instances (the shared reverb and
//! the zone slots) is spread over the 16-quantum tail cycle by modelled load. It replaces
//! architecture §10's "never share a tail quantum" (0157): keeping transforms apart is only
//! possible up to 4 stereo instances and loads the multiply-adds into squeezed windows, so the
//! objective is the busiest quantum's modelled load instead (convolution spike, finding 4).
//!
//! Ported from the convolution spike's load balancer (`spikes/audio-spatial/convolution/src/conv.rs`,
//! `plan_stagger`, `add_channel`, `modelled_slot_load`). Instances already running (the shared
//! reverb, running zone slots) are **fixed**; only the new ones are planned. It runs in the
//! worklet's `onmessage`, when ZONE_CONFIG starts a slot, on the audio thread, so nothing
//! allocates and the work is **bounded**.
//!
//! **Model** (the spike's). Load per quantum slot `s = (k + 1) % 16`, in 4,096-point-transform
//! equivalents: a channel on `(f, i)` puts [`TRANSFORM_WEIGHT`] at slot `f` (forward) and at slot
//! `i` (inverse), and spreads `MAC_WEIGHT * tail_parts` evenly over the slots `f + 1 ..= i - 1`
//! (its partition multiply-adds). Weights from the spike's `examples/micro.rs` (native: 20.7 µs per
//! transform, 1.06 µs per partition multiply-add; the wasm ratio is unmeasured). An instance with
//! no tail partitions runs no tail work, adds nothing and gets `(0, 2)`.
//!
//! **Search.** As the spike: the smallest cap, in steps of [`CAP_STEP`] from
//! `floor(20 * total / 16) / 20`, under which a depth-first search over the new channels finds an
//! assignment, each channel's pairs tried in order of (resulting peak, resulting sum of squared
//! slot loads, `f`, `i`). What changed, and why: the spike walks the cap up one step at a time and
//! gives every attempt 20,000 nodes, and a failing attempt (every step below the answer) spends
//! them all. Ported as is, a plan took 20 to 300 ms native (release) and seconds in a debug build:
//! fine for the spike's offline tables, two orders of magnitude over the audio thread's budget.
//! Here:
//! - the steps are **bisected** between the start and the first path's peak (an upper bound: with
//!   no cap the search's first path always completes);
//! - each attempt gets [`NODE_BUDGET`] nodes;
//! - the instances are searched largest first, and channels with equal parts take
//!   non-decreasing pairs (the load depends only on the multiset of placements, so this drops
//!   permutations of the same plan, not plans);
//! - a node is pruned when the remaining channels can't fit the cap's headroom, and each pair is
//!   scored in O(1) from prefix maxima and sums ([`Eval`]);
//! - then a local search ([`improve`]) from the result and from a staggered full-window start;
//! - the plan is never worse than the sequential one (every new instance on [`SHARED_PHASE`]).
//!
//! Over every mix of 1 to 4 new instances of 6, 22, 45 and 92 tail partitions (340 cases, nothing
//! fixed), the mean modelled peak is 4.28 sequential, 2.20 with the spike's planner, 2.29 here
//! (95% of the spike's reduction), at about 65 µs per plan on average and 0.2 ms at most (native,
//! release). The phase only moves **when** work runs, never the block grid, so an instance's
//! output is bit-identical on every valid phase (`instance.rs`'s test).

use super::instance::{phase_is_valid, Phase, SHARED_PHASE};
use super::CYCLE;

/// The most instances one call plans: `MAX_ZONE_SLOTS` (api-and-models §4.6).
pub const MAX_PLANNED: usize = 4;
/// Modelled load of one 4,096-point transform (forward or inverse).
pub const TRANSFORM_WEIGHT: f64 = 1.0;
/// Modelled load of one tail partition's spectrum multiply-add.
pub const MAC_WEIGHT: f64 = 0.055;
/// The cap search's step, in transform equivalents.
pub const CAP_STEP: f64 = 0.05;
/// Search nodes per cap attempt (the spike: 20,000).
pub const NODE_BUDGET: u32 = 32;
/// Most passes of [`improve`] per start.
pub const IMPROVE_PASSES: u32 = 8;

/// One instance's share of the tail cycle: its phase and its tail partition count.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Load {
    pub phase: Phase,
    pub tail_parts: usize,
}

/// Modelled load per slot of `instances` (every phase valid; an invalid phase adds nothing).
pub fn modelled_load(instances: &[Load]) -> [f64; CYCLE as usize] {
    let mut load = [0.0; N];
    for ins in instances {
        if phase_is_valid(ins.phase) && ins.tail_parts > 0 {
            for &(f, i) in &ins.phase {
                add_channel(&mut load, f as u32, i as u32, ins.tail_parts, 1.0);
            }
        }
    }
    load
}

/// The busiest slot's load.
pub fn peak(load: &[f64; CYCLE as usize]) -> f64 {
    load.iter().copied().fold(0.0, f64::max)
}

/// Slot count as a length.
const N: usize = CYCLE as usize;
/// Candidate `(f, i)` pairs for one channel: `f` in `0..N-2`, `i` in `f+2..N`.
const MAX_CANDIDATES: usize = (N - 2) * (N - 1) / 2;
/// The new channels' placements, largest instance first, left then right.
type Plan = [(u8, u8); 2 * MAX_PLANNED];

/// Plans phases for new instances with `tail_parts[n]` tail partitions each, around the `fixed`
/// instances (which keep their phases), and writes them to `out[..tail_parts.len()]`. Returns
/// `false`, writing nothing, when `tail_parts` is longer than [`MAX_PLANNED`] or than `out`, or a
/// fixed phase is invalid. Every written phase is valid (`f + 2 <= i <= 15` per channel), and the
/// plan's modelled peak is never above the sequential one (every new instance on
/// [`SHARED_PHASE`]). Deterministic (native and wasm agree); allocates nothing; bounded work.
pub fn plan_stagger(fixed: &[Load], tail_parts: &[usize], out: &mut [Phase]) -> bool {
    let n = tail_parts.len();
    if n > MAX_PLANNED || n > out.len() || fixed.iter().any(|ins| !phase_is_valid(ins.phase)) {
        return false;
    }
    // The instances with a tail, largest first (stable).
    let mut order = [0usize; MAX_PLANNED];
    let mut sorted = [0usize; MAX_PLANNED];
    let mut m = 0;
    for (k, &p) in tail_parts.iter().enumerate() {
        if p > 0 {
            let mut j = m;
            while j > 0 && sorted[j - 1] < p {
                sorted[j] = sorted[j - 1];
                order[j] = order[j - 1];
                j -= 1;
            }
            sorted[j] = p;
            order[j] = k;
            m += 1;
        }
    }
    let parts = &sorted[..m];
    let fixed_load = modelled_load(fixed);
    let best = if m > 0 { search(&fixed_load, parts) } else { [(0, 2); 2 * MAX_PLANNED] };
    for o in out[..n].iter_mut() {
        *o = [(0, 2); 2];
    }
    for (r, &k) in order[..m].iter().enumerate() {
        out[k] = [best[2 * r], best[2 * r + 1]];
    }
    true
}

/// Plans one new instance of `tail_parts` around the `fixed` instances (ADR 0162 C3: a zone slot
/// starts one at a time) by exhaustive search: every left pair, then the right pair that scores
/// best on top of it, by `(peak, sum of squared slot loads, f, i)`. Optimal under the model, so
/// never above [`plan_stagger`]'s plan for one instance nor the sequential one, and much smaller
/// code (the mixer links this, not the bounded multi-instance search). `None` when a fixed phase
/// is invalid; `(0, 2)` per channel without a tail. 105 + 105 × 105 O(1) scores; no allocation.
pub fn plan_one(fixed: &[Load], tail_parts: usize) -> Option<Phase> {
    if fixed.iter().any(|ins| !phase_is_valid(ins.phase)) {
        return None;
    }
    let mut best = PLAN_START;
    for f0 in 0..PLAN_ROWS {
        plan_one_row(fixed, tail_parts, f0, &mut best);
    }
    Some(best.2)
}

/// [`plan_one`]'s search so far: the best `(peak, sum of squares, phase)`.
pub type PlanBest = (f64, f64, Phase);
/// Where [`plan_one_row`]'s search starts.
pub const PLAN_START: PlanBest = (f64::INFINITY, f64::INFINITY, [(0, 2); 2]);
/// Rows of [`plan_one`]'s search (left forward slots `0..14`).
pub const PLAN_ROWS: u32 = N as u32 - 2;

/// One row of [`plan_one`]'s search, the left pairs with forward slot `f0`, folded into `best`
/// (from [`PLAN_START`]): after rows `0..`[`PLAN_ROWS`] in order, `best.2` is [`plan_one`]'s phase
/// (ADR 0162 C3b spreads the search over quanta). Nothing without a tail or for an invalid fixed
/// phase. At most 14 × 105 scores; no allocation.
pub fn plan_one_row(fixed: &[Load], tail_parts: usize, f0: u32, best: &mut PlanBest) {
    if tail_parts == 0 || fixed.iter().any(|ins| !phase_is_valid(ins.phase)) {
        return;
    }
    let base = modelled_load(fixed);
    for i0 in f0 + 2..N as u32 {
        let mut l = base;
        add_channel(&mut l, f0, i0, tail_parts, 1.0);
        Eval::new(&l).each(tail_parts, |top, sq, f, i| {
            if less((top, sq), (best.0, best.1)) {
                *best = (top, sq, [(f0 as u8, i0 as u8), (f as u8, i as u8)]);
            }
        });
    }
}

/// The plan for `parts` (all non-zero, largest first) around `fixed`.
fn search(fixed: &[f64; N], parts: &[usize]) -> Plan {
    let channels = 2 * parts.len();
    // Starting cap: the spike's `4 + 2 * MAC_WEIGHT * parts` per instance (two transforms and the
    // multiply-add spread per channel), fixed instances included, as an average per slot.
    let total = fixed.iter().sum::<f64>() + parts.iter().map(|&p| 4.0 * TRANSFORM_WEIGHT + 2.0 * MAC_WEIGHT * p as f64).sum::<f64>();
    let start = (total / CYCLE as f64 * 20.0).floor() / 20.0;
    let cap_at = |k: u32| (0..k).fold(start, |c, _| c + CAP_STEP);
    let mut s = Search { parts, channels, cap: f64::INFINITY, budget: NODE_BUDGET, chosen: [(0, 2); 2 * MAX_PLANNED] };
    // Upper bound: with no cap the first path completes, and the search at any cap at or above
    // its peak takes the same path.
    let mut load = *fixed;
    let _ = dfs(&mut s, 0, &mut load);
    let mut best = s.chosen;
    let top = peak(&load_of(fixed, parts, &best));
    let mut hi = 0u32;
    while cap_at(hi) + 1e-9 < top {
        hi += 1;
    }
    let mut lo = 0u32;
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        s.cap = cap_at(mid);
        s.budget = NODE_BUDGET;
        let mut load = *fixed;
        if dfs(&mut s, 0, &mut load) {
            best = s.chosen;
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    improve(fixed, parts, &mut best);
    // A second start: full-width windows, staggered by one slot per channel.
    let mut alt = [(0u8, 2u8); 2 * MAX_PLANNED];
    for (c, a) in alt.iter_mut().enumerate().take(channels) {
        *a = (c as u8, (N - channels + c) as u8);
    }
    improve(fixed, parts, &mut alt);
    if less(key(fixed, parts, &alt), key(fixed, parts, &best)) {
        best = alt;
    }
    // Never above the sequential plan.
    let mut seq = [(0u8, 2u8); 2 * MAX_PLANNED];
    for (c, q) in seq.iter_mut().enumerate().take(channels) {
        *q = SHARED_PHASE[c % 2];
    }
    if key(fixed, parts, &best).0 > key(fixed, parts, &seq).0 {
        best = seq;
    }
    best
}

/// A plan's `(peak, sum of squared slot loads)`.
fn key(fixed: &[f64; N], parts: &[usize], plan: &Plan) -> (f64, f64) {
    let l = load_of(fixed, parts, plan);
    (peak(&l), l.iter().map(|x| x * x).sum())
}

/// `a` is lower than `b` by more than rounding: a lower peak, or the same peak and a lower sum of
/// squares.
fn less(a: (f64, f64), b: (f64, f64)) -> bool {
    a.0 < b.0 - 1e-9 || (a.0 <= b.0 + 1e-9 && a.1 < b.1 - 1e-9)
}

/// Local search: moves one channel at a time to the pair that most lowers the plan's
/// `(peak, sum of squares)`, until a pass moves nothing (or [`IMPROVE_PASSES`]). A move must lower
/// that pair by more than rounding, so the plan never gets worse. Not in the spike.
fn improve(fixed: &[f64; N], parts: &[usize], plan: &mut Plan) {
    for _ in 0..IMPROVE_PASSES {
        let mut moved = false;
        for c in 0..2 * parts.len() {
            let p = parts[c / 2];
            let mut base = load_of(fixed, parts, plan);
            let (f0, i0) = plan[c];
            add_channel(&mut base, f0 as u32, i0 as u32, p, -1.0);
            let mut now = (f64::INFINITY, f64::INFINITY);
            let mut best = (f64::INFINITY, f64::INFINITY, f0 as u32, i0 as u32);
            Eval::new(&base).each(p, |top, sq, f, i| {
                if (f, i) == (f0 as u32, i0 as u32) {
                    now = (top, sq);
                }
                if pair_less((top, sq, f, i), best) {
                    best = (top, sq, f, i);
                }
            });
            if less((best.0, best.1), now) {
                plan[c] = (best.2 as u8, best.3 as u8);
                moved = true;
            }
        }
        if !moved {
            break;
        }
    }
}

/// `fixed` plus the channels of `plan` (new instances with `parts` tail partitions, all > 0).
fn load_of(fixed: &[f64; N], parts: &[usize], plan: &Plan) -> [f64; N] {
    let mut load = *fixed;
    for (c, &(f, i)) in plan.iter().enumerate().take(2 * parts.len()) {
        add_channel(&mut load, f as u32, i as u32, parts[c / 2], 1.0);
    }
    load
}

/// A base load prepared to score every pair of one more channel in O(1) each: prefix and suffix
/// maxima and prefix sums. The peak is exact (what adding the channel with [`add_channel`] and
/// taking the maximum gives: rounding is monotone, so `max(l + d) == max(l) + d`); the sum of
/// squares differs from a full recompute by rounding only.
struct Eval {
    load: [f64; N],
    pre: [f64; N + 1],
    suf: [f64; N + 1],
    sum: [f64; N + 1],
    sq: f64,
}

impl Eval {
    fn new(load: &[f64; N]) -> Self {
        let (mut pre, mut suf, mut sum) = ([0.0f64; N + 1], [0.0f64; N + 1], [0.0f64; N + 1]);
        let mut sq = 0.0;
        for s in 0..N {
            pre[s + 1] = pre[s].max(load[s]);
            sum[s + 1] = sum[s] + load[s];
            sq += load[s] * load[s];
        }
        for s in (0..N).rev() {
            suf[s] = suf[s + 1].max(load[s]);
        }
        Eval { load: *load, pre, suf, sum, sq }
    }

    /// Calls `visit(peak, sum of squares, f, i)` for every pair, `f` then `i` ascending.
    fn each(&self, parts: usize, mut visit: impl FnMut(f64, f64, u32, u32)) {
        let l = &self.load;
        let mac = MAC_WEIGHT * parts as f64;
        for f in 0..N - 2 {
            let mut inner = 0.0f64;
            for i in f + 2..N {
                inner = inner.max(l[i - 1]);
                let w = (i - f - 1) as f64;
                let d = mac / w;
                let top = self.pre[f].max(self.suf[i + 1]).max(l[f] + TRANSFORM_WEIGHT).max(l[i] + TRANSFORM_WEIGHT).max(inner + d);
                let sq = self.sq
                    + (2.0 * l[f] + TRANSFORM_WEIGHT) * TRANSFORM_WEIGHT
                    + (2.0 * l[i] + TRANSFORM_WEIGHT) * TRANSFORM_WEIGHT
                    + 2.0 * d * (self.sum[i] - self.sum[f + 1])
                    + w * d * d;
                visit(top, sq, f as u32, i as u32);
            }
        }
    }
}

/// The cap search over the new channels.
struct Search<'a> {
    parts: &'a [usize],
    channels: usize,
    cap: f64,
    budget: u32,
    chosen: Plan,
}

/// Adds (`sign` = 1) or removes (`sign` = -1) one channel on `(f, i)` with `parts` tail partitions.
fn add_channel(load: &mut [f64; N], f: u32, i: u32, parts: usize, sign: f64) {
    load[f as usize] += sign * TRANSFORM_WEIGHT;
    load[i as usize] += sign * TRANSFORM_WEIGHT;
    let slots = (i - f - 1) as f64;
    for s in f + 1..i {
        load[s as usize] += sign * MAC_WEIGHT * parts as f64 / slots;
    }
}

/// Lexicographic `(peak, sum of squares, f, i)` order (the spike's `partial_cmp` on tuples; no NaN).
fn pair_less(a: (f64, f64, u32, u32), b: (f64, f64, u32, u32)) -> bool {
    a.0 < b.0 || (a.0 == b.0 && (a.1 < b.1 || (a.1 == b.1 && (a.2, a.3) < (b.2, b.3))))
}

/// Whether channels `ch..` can still fit under the cap, by two necessary conditions (so a `false`
/// only cuts subtrees with no solution, and costs no budget): their whole load (two transforms and
/// their multiply-adds each) fits in the slots' total headroom, and their transforms (a whole
/// [`TRANSFORM_WEIGHT`] in one slot each) fit in the slots' whole-transform headroom.
fn fits(s: &Search<'_>, ch: usize, load: &[f64; N]) -> bool {
    let (mut room, mut whole) = (0.0f64, 0u32);
    for &l in load.iter() {
        let h = s.cap + 1e-9 - l;
        if h > 0.0 {
            room += h;
            whole = whole.saturating_add((h / TRANSFORM_WEIGHT) as u32);
        }
    }
    let mut need = 0.0f64;
    for c in ch..s.channels {
        need += 2.0 * TRANSFORM_WEIGHT + MAC_WEIGHT * s.parts[c / 2] as f64;
    }
    need <= room + 1e-9 && 2 * (s.channels - ch) as u32 <= whole
}

/// Depth-first search from channel `ch` under `s.cap`; on success `s.chosen[ch..]` holds the
/// pairs. Each channel's pairs are tried in `(peak, sum of squares, f, i)` order, as the spike's.
fn dfs(s: &mut Search<'_>, ch: usize, load: &mut [f64; N]) -> bool {
    if ch == s.channels {
        return true;
    }
    let p = s.parts[ch / 2];
    // Symmetry: a channel with the same parts as the one before takes a pair no smaller.
    let floor = if ch > 0 && s.parts[(ch - 1) / 2] == p { s.chosen[ch - 1] } else { (0, 0) };
    if s.budget == 0 || !fits(s, ch, load) {
        return false;
    }
    s.budget -= 1;
    let mut cands = [(0.0f64, 0.0f64, 0u32, 0u32); MAX_CANDIDATES];
    let mut n = 0;
    let cap = s.cap;
    Eval::new(load).each(p, |top, sq, f, i| {
        if (f as u8, i as u8) >= floor && top <= cap + 1e-9 {
            cands[n] = (top, sq, f, i);
            n += 1;
        }
    });
    // Picked lazily (a selection step per try): most nodes only try their first pair. Stops when
    // the budget is spent (the rest would fail at once).
    for k in 0..n {
        if s.budget == 0 {
            break;
        }
        let mut m = k;
        for j in k + 1..n {
            if pair_less(cands[j], cands[m]) {
                m = j;
            }
        }
        cands.swap(k, m);
        let (_, _, f, i) = cands[k];
        add_channel(load, f, i, p, 1.0);
        s.chosen[ch] = (f as u8, i as u8);
        if dfs(s, ch + 1, load) {
            return true;
        }
        add_channel(load, f, i, p, -1.0);
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    const SENTINEL: Phase = [(u8::MAX, u8::MAX); 2];
    const SHARED_REVERB: Load = Load { phase: SHARED_PHASE, tail_parts: 41 };

    /// Every instance, fixed ones included, on `SHARED_PHASE`.
    fn sequential_all(fixed: &[Load], tail: &[usize]) -> Vec<Load> {
        fixed
            .iter()
            .map(|ins| Load { phase: SHARED_PHASE, ..*ins })
            .chain(tail.iter().map(|&p| Load { phase: SHARED_PHASE, tail_parts: p }))
            .collect()
    }

    /// The fixed instances as they are, the new ones on `SHARED_PHASE`.
    fn sequential_new(fixed: &[Load], tail: &[usize]) -> Vec<Load> {
        fixed.iter().copied().chain(tail.iter().map(|&p| Load { phase: SHARED_PHASE, tail_parts: p })).collect()
    }

    fn with_planned(fixed: &[Load], tail: &[usize], out: &[Phase]) -> Vec<Load> {
        fixed.iter().copied().chain(tail.iter().zip(out).map(|(&p, &ph)| Load { phase: ph, tail_parts: p })).collect()
    }

    fn planned_peak(fixed: &[Load], tail: &[usize]) -> f64 {
        let mut out = [SENTINEL; MAX_PLANNED];
        assert!(plan_stagger(fixed, tail, &mut out), "refused {tail:?}");
        assert!(out[..tail.len()].iter().all(|&ph| phase_is_valid(ph)), "invalid phase for {tail:?}");
        peak(&modelled_load(&with_planned(fixed, tail, &out[..tail.len()])))
    }

    #[test]
    fn never_above_the_sequential_peak() {
        // Every mix of 1 to 4 new instances (with repetition) of these sizes, with nothing fixed
        // and around the shared reverb: 780 cases each.
        const SIZES: [usize; 5] = [0, 6, 22, 45, 92];
        for fixed in [&[][..], &[SHARED_REVERB][..]] {
            for n in 1..=MAX_PLANNED {
                for code in 0..SIZES.len().pow(n as u32) {
                    let tail: Vec<usize> = (0..n).map(|k| SIZES[code / SIZES.len().pow(k as u32) % SIZES.len()]).collect();
                    let got = planned_peak(fixed, &tail);
                    let want = peak(&modelled_load(&sequential_all(fixed, &tail)));
                    assert!(got <= want + 1e-9, "{tail:?}: planned peak {got} above sequential {want}");
                }
            }
        }
    }

    #[test]
    fn matches_the_spike_with_nothing_fixed() {
        // (tail parts, sequential peak, the spike's planner's peak), the spike's computed with its
        // `plan_stagger` at 88cf6b61 (README finding 4: four 2 s zones 2.4 against 4.7).
        let cases: [(&[usize], f64, f64); 9] = [
            (&[45], 1.176_785_714_285_714_3, 1.0),
            (&[45, 45], 2.353_571_428_571_428_6, 1.247_5),
            (&[45, 45, 45], 3.530_357_142_857_143, 2.0),
            (&[45; 4], 4.707_142_857_142_857, 2.426_071_428_571_428_4),
            (&[92; 4], 5.445_714_285_714_286, 3.831_190_476_190_476),
            (&[22, 45, 92, 6], 4.648_214_285_714_285, 2.247_761_904_761_904_6),
            (&[41, 45], 2.337_857_142_857_142_6, 1.225_5),
            (&[22; 4], 4.345_714_285_714_285, 2.0),
            (&[6; 4], 4.094_285_714_285_714, 1.304_071_428_571_428_6),
        ];
        let (mut sum_seq, mut sum_spike, mut sum_ours) = (0.0, 0.0, 0.0);
        for (parts, seq, spike) in cases {
            assert!((peak(&modelled_load(&sequential_all(&[], parts))) - seq).abs() < 1e-12, "{parts:?}: the model moved");
            let ours = planned_peak(&[], parts);
            // The bounded search gives up at most 0.25 transform equivalents (about 5 µs) on a case.
            assert!(ours <= spike + 0.25, "{parts:?}: {ours} against the spike's {spike}");
            sum_seq += seq;
            sum_spike += spike;
            sum_ours += ours;
        }
        // At least 85% of the spike's reduction over these cases (96% today).
        let kept = (sum_seq - sum_ours) / (sum_seq - sum_spike);
        assert!(kept >= 0.85, "kept {kept} of the spike's reduction");
        assert_eq!(planned_peak(&[], &[45]), 1.0);
        assert_eq!(planned_peak(&[], &[22; 4]), 2.0);
    }

    #[test]
    fn the_pair_scores_match_a_full_recompute() {
        let mut base = modelled_load(&[SHARED_REVERB, Load { phase: [(3, 9), (5, 12)], tail_parts: 22 }]);
        base[7] += 0.3;
        let e = Eval::new(&base);
        let mut seen = 0;
        e.each(45, |top, sq, f, i| {
            let mut l = base;
            add_channel(&mut l, f, i, 45, 1.0);
            assert_eq!(top, peak(&l), "({f}, {i})");
            let full: f64 = l.iter().map(|x| x * x).sum();
            assert!((sq - full).abs() < 1e-9, "({f}, {i}): {sq} vs {full}");
            seen += 1;
        });
        assert_eq!(seen, MAX_CANDIDATES);
    }

    #[test]
    fn plans_around_the_shared_reverb_and_running_slots() {
        let running = [(5, 11), (7, 13)];
        let fixed = [SHARED_REVERB, Load { phase: running, tail_parts: 45 }];
        let tail = [45, 92];
        let mut out = [SENTINEL; MAX_PLANNED];
        assert!(plan_stagger(&fixed, &tail, &mut out));
        assert!(out[..2].iter().all(|&ph| phase_is_valid(ph)));
        assert!(out[2..].iter().all(|&ph| ph == SENTINEL), "out past the new instances was written");
        assert_eq!(fixed[0].phase, SHARED_PHASE);
        assert_eq!(fixed[1].phase, running);
        let got = peak(&modelled_load(&with_planned(&fixed, &tail, &out[..2])));
        let want_new = peak(&modelled_load(&sequential_new(&fixed, &tail)));
        assert!(got <= want_new + 1e-9, "planned {got} above sequential (fixed kept) {want_new}");
        // An instance without a tail gets (0, 2) and changes nothing.
        let mut out2 = [SENTINEL; MAX_PLANNED];
        assert!(plan_stagger(&fixed, &[45, 0, 92], &mut out2));
        assert_eq!(out2[1], [(0, 2); 2]);
        assert_eq!((out2[0], out2[2]), (out[0], out[1]));
    }

    #[test]
    fn refuses_too_many_or_a_short_out() {
        let mut out = [SENTINEL; 5];
        assert!(!plan_stagger(&[], &[45; 5], &mut out));
        assert_eq!(out, [SENTINEL; 5]);

        let mut short = [SENTINEL; 1];
        assert!(!plan_stagger(&[], &[45, 45], &mut short));
        assert_eq!(short, [SENTINEL; 1]);

        let bad = [Load { phase: [(3, 4), (0, 15)], tail_parts: 45 }];
        let mut out = [SENTINEL; 2];
        assert!(!plan_stagger(&bad, &[45], &mut out));
        assert_eq!(out, [SENTINEL; 2]);

        let mut out = [SENTINEL; 2];
        assert!(plan_stagger(&[], &[], &mut out));
        assert_eq!(out, [SENTINEL; 2]);
    }

    #[test]
    fn plan_one_is_never_worse_than_plan_stagger_or_sequential() {
        const SIZES: [usize; 5] = [0, 6, 22, 45, 92];
        let running: [Load; 3] = [
            SHARED_REVERB,
            Load { phase: [(5, 11), (7, 13)], tail_parts: 45 },
            Load { phase: [(2, 9), (3, 15)], tail_parts: 92 },
        ];
        for k in 0..=running.len() {
            let fixed = &running[..k];
            for &p in &SIZES {
                let one = plan_one(fixed, p).unwrap();
                assert!(phase_is_valid(one));
                let got = peak(&modelled_load(&with_planned(fixed, &[p], &[one])));
                let staggered = planned_peak(fixed, &[p]);
                let seq = peak(&modelled_load(&sequential_new(fixed, &[p])));
                assert!(got <= staggered + 1e-9 && got <= seq + 1e-9, "{k} fixed, {p} parts: {got} vs {staggered} / {seq}");
            }
        }
        assert_eq!(plan_one(&[], 0), Some([(0, 2); 2]));
        assert_eq!(plan_one(&[Load { phase: [(3, 4), (0, 15)], tail_parts: 45 }], 45), None);
        // Zones started one by one around the shared reverb stay close to planning them together.
        let mut fixed = vec![SHARED_REVERB];
        for _ in 0..4 {
            let ph = plan_one(&fixed, 45).unwrap();
            fixed.push(Load { phase: ph, tail_parts: 45 });
        }
        let one_by_one = peak(&modelled_load(&fixed));
        let together = planned_peak(&[SHARED_REVERB], &[45; 4]);
        let seq = peak(&modelled_load(&sequential_all(&[SHARED_REVERB], &[45; 4])));
        eprintln!("4 x 45 around the shared reverb: one by one {one_by_one}, together {together}, sequential {seq}");
        assert!(one_by_one < seq);
    }

    /// Time per plan for the busiest real case: four new 2 s zones around the shared reverb.
    /// `cargo test --release -p audio-dsp --lib plan_time -- --ignored --nocapture`.
    #[test]
    #[ignore = "timing: release build"]
    fn plan_time() {
        let mut out = [SENTINEL; MAX_PLANNED];
        let cases: [&[usize]; 4] = [&[45], &[45, 45], &[45; 4], &[92, 45, 22, 6]];
        for tail in cases {
            let runs = 200;
            let mut worst = 0.0f64;
            let t0 = std::time::Instant::now();
            for _ in 0..runs {
                let t = std::time::Instant::now();
                assert!(plan_stagger(&[SHARED_REVERB], tail, &mut out));
                worst = worst.max(t.elapsed().as_secs_f64());
            }
            println!("{tail:?} around the shared reverb: mean {:.1} µs, max {:.1} µs", t0.elapsed().as_secs_f64() / runs as f64 * 1e6, worst * 1e6);
        }
    }
}
