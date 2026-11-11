// SPDX-License-Identifier: Apache-2.0 OR MIT
//! The stagger planner (ADR 0162 C1, api-and-models §5.2, architecture §4.4): picks each new
//! convolver instance's [`Phase`], so the tail work of several instances (the shared reverb and
//! the zone slots) is spread over the 16-quantum tail cycle by modelled load. It replaces
//! architecture §10's "never share a tail quantum" (0157): keeping transforms apart is only
//! possible up to 4 stereo instances and loads the multiply-adds into squeezed windows, so the
//! objective is the busiest quantum's modelled load instead (convolution spike, finding 4).
//!
//! Ported from the convolution spike's load balancer (`spikes/audio-spatial/convolution/src/conv.rs`,
//! `plan_stagger`, `add_channel`, `modelled_slot_load`), with two changes: instances already
//! running (the shared reverb, running zone slots) are **fixed** and only the new ones are
//! planned; and nothing allocates (it runs in the worklet's `onmessage`, when ZONE_CONFIG starts a
//! slot, on the audio thread).
//!
//! **Model.** Load per quantum slot `s = (k + 1) % 16`, in 4,096-point-transform equivalents: a
//! channel on `(f, i)` puts [`TRANSFORM_WEIGHT`] at slot `f` (forward) and at slot `i` (inverse),
//! and spreads `MAC_WEIGHT * tail_parts` evenly over the slots `f + 1 ..= i - 1` (its partition
//! multiply-adds). Weights from the spike's `examples/micro.rs` (native: 20.7 µs per transform,
//! 1.06 µs per partition multiply-add; the wasm ratio is unmeasured). An instance with no tail
//! partitions runs no tail work and adds nothing.
//!
//! **Search.** The smallest cap, in steps of [`CAP_STEP`] from `floor(20 * total / 16) / 20` up,
//! on any slot's load for which a depth-first search over the new instances' channels (instance
//! order, left then right) finds an assignment; each channel's pairs are tried in order of
//! (resulting peak, resulting sum of squared slot loads, `f`, `i`), and each attempt is bounded by
//! [`NODE_BUDGET`] nodes. The phase only moves **when** work runs, never the block grid, so an
//! instance's output is bit-identical on every valid phase (spike check "staggered ==
//! unstaggered").

use super::instance::{phase_is_valid, Phase};
use super::CYCLE;

/// The most instances one call plans: `MAX_ZONE_SLOTS` (api-and-models §4.6).
pub const MAX_PLANNED: usize = 4;
/// Modelled load of one 4,096-point transform (forward or inverse).
pub const TRANSFORM_WEIGHT: f64 = 1.0;
/// Modelled load of one tail partition's spectrum multiply-add.
pub const MAC_WEIGHT: f64 = 0.055;
/// The cap search's step, in transform equivalents.
pub const CAP_STEP: f64 = 0.05;
/// Search nodes per cap attempt.
pub const NODE_BUDGET: u32 = 20_000;

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

/// Plans phases for new instances with `tail_parts[n]` tail partitions each, around the `fixed`
/// instances (which keep their phases), and writes them to `out[..tail_parts.len()]`. Returns
/// `false`, writing nothing, when `tail_parts` is longer than [`MAX_PLANNED`] or than `out`, or a
/// fixed phase is invalid. Every written phase is valid (`f + 2 <= i <= 15` per channel).
/// Deterministic (native and wasm agree); allocates nothing.
pub fn plan_stagger(fixed: &[Load], tail_parts: &[usize], out: &mut [Phase]) -> bool {
    let n = tail_parts.len();
    if n > MAX_PLANNED || n > out.len() || fixed.iter().any(|ins| !phase_is_valid(ins.phase)) {
        return false;
    }
    if n == 0 {
        return true;
    }
    // Starting cap: the spike's `4 + 2 * MAC_WEIGHT * parts` per instance (two transforms and the
    // multiply-add spread per channel), fixed instances included. Instances with no tail add nothing.
    let mut total = 0.0;
    for p in fixed.iter().map(|ins| ins.tail_parts).chain(tail_parts.iter().copied()) {
        if p > 0 {
            total += 4.0 * TRANSFORM_WEIGHT + 2.0 * MAC_WEIGHT * p as f64;
        }
    }
    let mut s = Search {
        parts: tail_parts,
        channels: 2 * n,
        cap: (total / CYCLE as f64 * 20.0).floor() / 20.0,
        budget: 0,
        chosen: [(0, 2); 2 * MAX_PLANNED],
    };
    let fixed_load = modelled_load(fixed);
    loop {
        let mut load = fixed_load;
        s.budget = NODE_BUDGET;
        if dfs(&mut s, 0, &mut load) {
            for k in 0..n {
                out[k] = [s.chosen[2 * k], s.chosen[2 * k + 1]];
            }
            return true;
        }
        s.cap += CAP_STEP;
    }
}

/// Slot count as a length.
const N: usize = CYCLE as usize;
/// Candidate `(f, i)` pairs for one channel: `f` in `0..N-2`, `i` in `f+2..N`.
const MAX_CANDIDATES: usize = (N - 2) * (N - 1) / 2;

/// The search over the new instances' channels (instance order, left then right).
struct Search<'a> {
    parts: &'a [usize],
    channels: usize,
    cap: f64,
    budget: u32,
    chosen: [(u8, u8); 2 * MAX_PLANNED],
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

/// Depth-first search from channel `ch`; on success `s.chosen[ch..]` holds the pairs.
fn dfs(s: &mut Search<'_>, ch: usize, load: &mut [f64; N]) -> bool {
    if ch == s.channels {
        return true;
    }
    let p = s.parts[ch / 2];
    if p == 0 {
        // No tail work, so no load: the first pair is as good as any.
        s.chosen[ch] = (0, 2);
        return dfs(s, ch + 1, load);
    }
    if s.budget == 0 {
        return false;
    }
    s.budget -= 1;
    let mut cands = [(0.0f64, 0.0f64, 0u32, 0u32); MAX_CANDIDATES];
    let mut n = 0;
    for f in 0..CYCLE - 2 {
        for i in f + 2..CYCLE {
            let mut l = *load;
            add_channel(&mut l, f, i, p, 1.0);
            let top = l.iter().copied().fold(0.0, f64::max);
            if top > s.cap + 1e-9 {
                continue;
            }
            let sq: f64 = l.iter().map(|x| x * x).sum();
            let cand = (top, sq, f, i);
            let mut k = n;
            while k > 0 && pair_less(cand, cands[k - 1]) {
                cands[k] = cands[k - 1];
                k -= 1;
            }
            cands[k] = cand;
            n += 1;
        }
    }
    for k in 0..n {
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
    use crate::convolver::instance::SHARED_PHASE;

    const SENTINEL: Phase = [(u8::MAX, u8::MAX); 2];

    /// The convolution spike's planner (`spikes/audio-spatial/convolution/src/conv.rs` at 88cf6b61),
    /// the reference for `matches_the_spike_with_nothing_fixed`. Its `plan_unique` / occupancy-count
    /// path is dropped (`plan_stagger` never uses it).
    mod spike {
        pub type Sched = [(u32, u32); 2];
        const MAC_WEIGHT: f64 = 0.055;

        fn add_channel(load: &mut [f64; 16], f: u32, i: u32, parts: usize, sign: f64) {
            load[f as usize] += sign;
            load[i as usize] += sign;
            let slots = (i - f - 1) as f64;
            for s in f + 1..i {
                load[s as usize] += sign * MAC_WEIGHT * parts as f64 / slots;
            }
        }

        pub fn plan_stagger(tail_parts: &[usize]) -> Vec<Sched> {
            let channels = tail_parts.len() * 2;
            struct Search<'a> {
                parts: &'a [usize],
                channels: usize,
                cap: f64,
                budget: u32,
                out: Vec<(u32, u32)>,
            }
            fn dfs(s: &mut Search, ch: usize, load: &mut [f64; 16]) -> bool {
                if ch == s.channels {
                    return true;
                }
                if s.budget == 0 {
                    return false;
                }
                s.budget -= 1;
                let p = s.parts[ch / 2];
                let mut cands: Vec<(f64, f64, u32, u32)> = Vec::new();
                for f in 0..14u32 {
                    for i in f + 2..16 {
                        let mut l = *load;
                        add_channel(&mut l, f, i, p, 1.0);
                        let peak = l.iter().cloned().fold(0.0, f64::max);
                        if peak > s.cap + 1e-9 {
                            continue;
                        }
                        let sq: f64 = l.iter().map(|x| x * x).sum();
                        cands.push((peak, sq, f, i));
                    }
                }
                cands.sort_by(|a, b| a.partial_cmp(b).unwrap());
                for (_, _, f, i) in cands {
                    add_channel(load, f, i, p, 1.0);
                    s.out.push((f, i));
                    if dfs(s, ch + 1, load) {
                        return true;
                    }
                    s.out.pop();
                    add_channel(load, f, i, p, -1.0);
                }
                false
            }
            let total: f64 = tail_parts.iter().map(|&p| 4.0 + 2.0 * MAC_WEIGHT * p as f64).sum();
            let mut cap = (total / 16.0 * 20.0).floor() / 20.0;
            loop {
                let mut s = Search { parts: tail_parts, channels, cap, budget: 20_000, out: Vec::new() };
                if dfs(&mut s, 0, &mut [0.0; 16]) {
                    return s.out.chunks(2).map(|c| [c[0], c[1]]).collect();
                }
                cap += 0.05;
            }
        }

        pub fn modelled_slot_load(scheds: &[Sched], parts: &[usize]) -> [f64; 16] {
            let mut load = [0.0f64; 16];
            for (s, &p) in scheds.iter().zip(parts) {
                for &(f, i) in s {
                    add_channel(&mut load, f, i, p, 1.0);
                }
            }
            load
        }
    }

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
        fixed
            .iter()
            .copied()
            .chain(tail.iter().map(|&p| Load { phase: SHARED_PHASE, tail_parts: p }))
            .collect()
    }

    fn with_planned(fixed: &[Load], tail: &[usize], out: &[Phase]) -> Vec<Load> {
        fixed
            .iter()
            .copied()
            .chain(tail.iter().zip(out).map(|(&p, &ph)| Load { phase: ph, tail_parts: p }))
            .collect()
    }

    #[test]
    fn never_above_the_sequential_peak() {
        const SIZES: [usize; 5] = [0, 6, 22, 45, 92];
        let fixed_sets = [vec![], vec![Load { phase: SHARED_PHASE, tail_parts: 41 }]];
        for fixed in &fixed_sets {
            for n in 1..=MAX_PLANNED {
                for code in 0..SIZES.len().pow(n as u32) {
                    let tail: Vec<usize> =
                        (0..n).map(|k| SIZES[code / SIZES.len().pow(k as u32) % SIZES.len()]).collect();
                    let mut out = [SENTINEL; MAX_PLANNED];
                    assert!(plan_stagger(fixed, &tail, &mut out), "refused {:?}", tail);
                    assert!(out[..n].iter().all(|&ph| phase_is_valid(ph)), "invalid phase for {:?}", tail);
                    let got = peak(&modelled_load(&with_planned(fixed, &tail, &out[..n])));
                    let want = peak(&modelled_load(&sequential_all(fixed, &tail)));
                    assert!(got <= want + 1e-9, "{:?}: planned peak {} above sequential {}", tail, got, want);
                }
            }
        }
    }

    #[test]
    fn matches_the_spike_with_nothing_fixed() {
        let cases: [&[usize]; 7] = [&[45], &[45, 45], &[45, 45, 45], &[45; 4], &[92; 4], &[22, 45, 92, 6], &[41, 45]];
        for parts in cases {
            let want: Vec<Phase> = spike::plan_stagger(parts)
                .iter()
                .map(|s| [(s[0].0 as u8, s[0].1 as u8), (s[1].0 as u8, s[1].1 as u8)])
                .collect();
            let mut out = [SENTINEL; MAX_PLANNED];
            assert!(plan_stagger(&[], parts, &mut out));
            assert_eq!(&out[..parts.len()], &want[..], "tail parts {:?}", parts);
        }

        // Spike findings (README 4): four 2 s zones, load-balanced 2.4; the M1 schedule 4.7.
        let four = [45usize; 4];
        let spike_plan = spike::plan_stagger(&four);
        let spike_peak = spike::modelled_slot_load(&spike_plan, &four).iter().cloned().fold(0.0, f64::max);
        let m1 = vec![[(0u32, 15u32), (1, 14)]; 4];
        let m1_peak = spike::modelled_slot_load(&m1, &four).iter().cloned().fold(0.0, f64::max);
        assert!((spike_peak - 2.4).abs() <= 0.05, "spike balanced peak {spike_peak}");
        assert!((m1_peak - 4.7).abs() <= 0.05, "spike M1 peak {m1_peak}");

        let mut out = [SENTINEL; MAX_PLANNED];
        assert!(plan_stagger(&[], &four, &mut out));
        let ours = peak(&modelled_load(&with_planned(&[], &four, &out[..4])));
        assert!((ours - spike_peak).abs() <= 1e-9, "ported peak {ours} vs spike {spike_peak}");
    }

    #[test]
    fn plans_around_the_shared_reverb_and_running_slots() {
        let running = [(5, 11), (7, 13)];
        let fixed = [
            Load { phase: SHARED_PHASE, tail_parts: 41 },
            Load { phase: running, tail_parts: 45 },
        ];
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
}
