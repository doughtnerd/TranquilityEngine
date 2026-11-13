//! Ck1 (0171 amended by 0172, M5c; architecture §4.7's table, §3.3, §4.5-§4.6; api-and-models §10):
//! spike S4's live-edit click harness (`spikes/audio-mix/mix-core/live/live.ts`) on the real core,
//! for every edit class of §4.7, sent as main sends it in M5.
//!
//! **The method (S4's).** Two looping tone voices (S4's tones: 220/880/1760 Hz on bus 1, 330/990/
//! 1650 Hz on bus 2; every partial at or under 1760 Hz) play through a three-bus tree with no limiter
//! look-ahead, so the output is the mix itself. One edit is sent as one batch; the same run without
//! the edit is the reference. `abrupt` = the largest sample-to-sample step of (edited − reference)
//! over that difference's peak, from the edit on: a smooth change of these tones reads at or under
//! **0.23**, a jump about 1, and S4 calls anything over **0.3** a click.
//!
//! **Eight phases.** Each edit runs at eight phases: the batch lands at quantum 12 + k (S4's tone
//! phases), and every stamped record in it (a fade, the dip's F0) sits `16·k` frames into its
//! quantum, so the edit is tried at eight positions inside a quantum. The worst phase is reported
//! (`cargo test -p audio-core --test click_edits -- --nocapture` prints the table).
//!
//! **What each class sends** (§4.7): direct and smoothed edits are one asap `BUS_SLOT` or lane
//! `BUS_RAMP` (or `BUS_DUCK`, `LOUD_CONFIG`); structural edits are §3.3's stamped sequence, one
//! batch: a dip-down `BUS_RAMP` on the dip lane of each root at F0 over `DIP_FRAMES`, the structural
//! `BUS_SLOT`s at B (the first quantum start at or after F0 + `DIP_FRAMES`), the dip-up at B. A voice
//! that changes bus moves with the per-voice dip (`BusIndex.dipVoices`: FADE to 0 and `SET_PARAMS
//! bus` at B, FADE back in over `DIP_FRAMES`). Smooth classes must read ≤ 0.23 at every phase; each
//! structural edit's dip must stay under the click threshold (it reads ≤ 0.23 too, asserted).
//!
//! The send cases: a bus with a reverb send dips (the post-fader send follows the dip lane, R11), and
//! the last send removed under a dip rings its tail out (the run-out, Rv1) instead of cutting it (S4:
//! a cut tail read 0.25 and replayed stale on re-add).

mod common;

use audio_core::{bus, sends, status, QUANTUM};
use audio_wire::generated as wire;
use common::*;

const Q: usize = QUANTUM;
/// `DIP_FRAMES` at 48 kHz (R8: 20 ms).
const D: u32 = 960;
/// Main's lookahead in these runs: the sequence's F0 is this many frames after the batch's first
/// frame, plus the phase's offset.
const LOOKAHEAD: u32 = 256;
/// Quanta rendered per run (the edit at 12..19; a dip sequence ends ≈ 20 quanta after it).
const RUN_QUANTA: usize = 64;
/// S4: a smooth change of these tones reads at or under this.
const SMOOTH: f64 = 0.23;
/// S4's click threshold.
const CLICK: f64 = 0.3;

const TONE_A: u32 = 2;
const TONE_B: u32 = 3;
const V1: u32 = 0x0001_0001;
const V2: u32 = 0x0001_0002;
const FRAMES: usize = 48_000;

type Fx = (u32, [f32; 7]);
fn lp(hz: f32, q: f32) -> Fx {
    (0, [hz, q, 0.0, 0.0, 0.0, 0.0, 0.0])
}
fn hp(hz: f32, q: f32) -> Fx {
    (1, [hz, q, 0.0, 0.0, 0.0, 0.0, 0.0])
}
fn comp(threshold: f32) -> Fx {
    (2, [threshold, 6.0, 4.0, 0.003, 0.25, 0.0, 0.0])
}
fn rev(send: f32) -> Fx {
    (3, [send, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
}

/// A tree: per bus, its parent and effects.
type Tree = Vec<(u16, Vec<Fx>)>;

/// S4's base tree: Master, "Music" (low-pass 8 kHz), "SFX" (compressor −24 dB).
fn base() -> Tree {
    vec![(ROOT, vec![]), (0, vec![lp(8000.0, 1.0)]), (0, vec![comp(-24.0)])]
}

fn tones(spec: &[(f32, f32)]) -> Vec<f32> {
    (0..FRAMES).map(|i| spec.iter().map(|&(hz, a)| a * (2.0 * std::f64::consts::PI * hz as f64 * i as f64 / RATE as f64).sin() as f32).sum()).collect()
}

fn config_tree(tree: &Tree) -> Rec {
    Rec::Config(wire::BusConfig {
        voice_id: 0,
        frame_offset: wire::ASAP,
        buses: tree.iter().map(|(parent, fx)| wire::BusConfigBuses { parent: *parent, effects: fx.iter().map(|&(t, p)| wire::BusConfigBusesEffects { type_: t, p }).collect() }).collect(),
    })
}

/// A `BUS_SLOT` (head included) at `offset` frames after its batch's first frame (`ASAP` for asap).
fn slot(s: u16, flags: u16, seq: u16, parent: u16, fx: &[Fx], offset: u32) -> Rec {
    let r = wire::BusSlot {
        voice_id: 0,
        frame_offset: offset,
        slot: s,
        flags,
        sequence_id: seq,
        reserved: 0,
        reserved2: 0,
        parent,
        effects: fx.iter().map(|&(t, p)| wire::BusSlotEffects { type_: t, p }).collect(),
    };
    let mut b = vec![0u8; wire::BusSlot::FIXED_END + fx.len() * wire::BusSlotEffects::FIXED_END];
    r.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

/// A gain `BUS_RAMP` of `lane` on `bus` at `offset` (`ASAP` for asap), tagged with sequence `seq`.
fn ramp(bus: u32, lane: u32, gain: f32, frames: u32, seq: u32, offset: u32) -> Rec {
    Rec::Ramps(vec![wire::BusRamp { frame_offset: offset, shape: wire::pack_ramp_shape(0, seq, 0), ..lane_ramp(bus, lane, Some(gain), None, frames) }])
}

/// A FADE of `voice` to `target` over `frames` at `offset` (linear).
fn fade(voice: u32, target: f32, frames: u32, offset: u32) -> Rec {
    let mut b = vec![0u8; wire::Fade::FIXED_END];
    wire::Fade { voice_id: voice, frame_offset: offset, target, frames, flags: 0, shape: wire::pack_shape(0, 0) }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

/// `SET_PARAMS bus` of `voice` at `offset`.
fn set_bus_at(voice: u32, to: u32, offset: u32) -> Rec {
    Rec::Set(wire::SetParams { voice_id: voice, frame_offset: offset, mask: wire::SET_PARAMS_MASK_BUS, bus: to, ..Default::default() })
}

fn duck(rules: &[wire::BusDuckRules]) -> Rec {
    let r = wire::BusDuck { voice_id: 0, frame_offset: wire::ASAP, rules: rules.to_vec() };
    let mut b = vec![0u8; wire::BusDuck::FIXED_END + rules.len() * wire::BusDuckRules::FIXED_END];
    r.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

fn presence(mask: u32) -> Rec {
    let mut b = vec![0u8; wire::BusPresence::FIXED_END];
    wire::BusPresence { voice_id: 0, frame_offset: wire::ASAP, mask }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

fn loud_config(meters: &[u16]) -> Rec {
    let r = wire::LoudConfig { voice_id: 0, frame_offset: wire::ASAP, tp_gate_dbfs: -7.0, meters: meters.iter().map(|&slot| wire::LoudConfigMeters { slot, reserved: 0 }).collect() };
    let mut b = vec![0u8; wire::LoudConfig::FIXED_END + meters.len() * wire::LoudConfigMeters::FIXED_END];
    r.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

/// Where a structural sequence lands, relative to its batch's first frame: F0 and B.
#[derive(Clone, Copy)]
struct Frames {
    /// The batch's first frame (absolute).
    first: u64,
    /// The phase's offset inside a quantum (`16·k`).
    phase: u32,
}

impl Frames {
    /// F0, from the batch's first frame.
    fn f0(&self) -> u32 {
        LOOKAHEAD + self.phase
    }
    /// B: the first quantum start at or after F0 + D, from the batch's first frame.
    fn b(&self) -> u32 {
        let abs = self.first + (self.f0() + D) as u64;
        (abs.div_ceil(Q as u64) * Q as u64 - self.first) as u32
    }
}

/// §3.3's sequence: dip-downs for `roots` and `tombs` at F0, `slots` at B, dip-ups for `roots` at B,
/// all tagged `seq`; then each `(voice, to)` moved with the per-voice dip (FADE to 0 and SET_PARAMS
/// bus at B, FADE back to 1 over D).
fn sequence(f: Frames, seq: u16, roots: &[u16], tombs: &[u16], slots: Vec<(u16, u16, Vec<Fx>)>, voices: &[(u32, u32)]) -> Vec<Rec> {
    let mut v = Vec::new();
    for &r in roots.iter().chain(tombs) {
        v.push(ramp(r as u32, wire::LANE_DIP, 0.0, D, seq as u32, f.f0()));
    }
    for (s, parent, fx) in slots {
        v.push(slot(s, wire::BUS_SLOT_FLAGS_STRUCTURAL, seq, parent, &fx, f.b()));
    }
    for &r in roots {
        v.push(ramp(r as u32, wire::LANE_DIP, 1.0, D, seq as u32, f.b()));
    }
    for &(voice, to) in voices {
        v.push(fade(voice, 0.0, 0, f.b()));
        v.push(set_bus_at(voice, to, f.b()));
        v.push(fade(voice, 1.0, D, f.b()));
    }
    v
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Class {
    /// Direct or smoothed (§4.7): ≤ 0.23 at every phase, and something changed.
    Smooth,
    /// Changes nothing heard (bit-identical to the reference).
    Identical,
    /// §3.3's stamped sequence: the dip under the click threshold (≤ 0.23 asserted).
    Dip,
}

struct Edit {
    name: &'static str,
    class: Class,
    tree: fn() -> Tree,
    /// Extra records sent with the setup (rules, presence).
    setup: fn() -> Vec<Rec>,
    /// The edit's batches (each `Vec<Rec>` one batch, sent at once in order).
    edit: fn(Frames) -> Vec<Vec<Rec>>,
}

fn none() -> Vec<Rec> {
    vec![]
}

/// One run: the tree, the gains `[1, 0.8, 1]`, both voices; `warm` quanta; the edit (if any); the rest.
fn run(e: &Edit, warm: usize, phase: u32, with_edit: bool) -> (Vec<f32>, Mixer) {
    let mut m = Mixer::new(8);
    m.set_lookahead(0.0);
    m.load_clip(TONE_A, &tones(&[(220.0, 0.15), (880.0, 0.1), (1760.0, 0.05)]));
    m.load_clip(TONE_B, &tones(&[(330.0, 0.15), (990.0, 0.1), (1650.0, 0.05)]));
    let mut setup = vec![config_tree(&(e.tree)()), gains(0, &[1.0, 0.8, 1.0]), play(V1, TONE_A, 1, MIXED | LOOP), play(V2, TONE_B, 2, MIXED | LOOP)];
    setup.extend((e.setup)());
    m.submit(&setup);
    let mut out = m.render_n(warm).0;
    if with_edit {
        let f = Frames { first: m.frame, phase };
        for b in (e.edit)(f) {
            m.submit(&b);
        }
    }
    out.extend(m.render_n(RUN_QUANTA - warm).0);
    (out, m)
}

/// S4's `analyse`: (abrupt, the difference's peak, whether the runs agree before the edit).
fn analyse(reference: &[f32], got: &[f32], from: usize) -> (f64, f64, bool) {
    let (mut d_step, mut d_peak) = (0.0f64, 0.0f64);
    for i in from..reference.len() {
        let d = got[i] as f64 - reference[i] as f64;
        let dp = got[i - 1] as f64 - reference[i - 1] as f64;
        d_step = d_step.max((d - dp).abs());
        d_peak = d_peak.max(d.abs());
    }
    let pre = (0..from).all(|i| got[i] == reference[i]);
    (if d_peak > 1e-5 { d_step / d_peak } else { 0.0 }, d_peak, pre)
}

/// The worst `abrupt` of `e` over the eight phases, and its difference peak there.
fn worst(e: &Edit) -> (f64, f64) {
    let mut w = (0.0f64, 0.0f64);
    for k in 0..8u32 {
        let warm = 12 + k as usize;
        let (reference, _) = run(e, warm, k * 16, false);
        let (got, m) = run(e, warm, k * 16, true);
        let (abrupt, peak, pre) = analyse(&reference, &got, warm * Q);
        assert!(pre, "{}: the runs agree before the edit (phase {k})", e.name);
        assert_eq!(status::counters(&m.core).music.split_quanta, 0, "{}: no split (phase {k})", e.name);
        if abrupt > w.0 {
            w = (abrupt, peak);
        }
        if e.class == Class::Identical {
            assert_eq!(peak, 0.0, "{}: nothing heard changes (phase {k})", e.name);
        }
    }
    w
}

fn check_all(edits: &[Edit]) {
    let mut fails = Vec::new();
    for e in edits {
        let (abrupt, peak) = worst(e);
        let verdict = match e.class {
            Class::Identical => "identical",
            _ if abrupt > CLICK => "CLICK",
            _ => "smooth",
        };
        eprintln!("[Ck1] {:<72} {:?}: worst abrupt {abrupt:.3} (diff peak {peak:.4}) {verdict}", e.name, e.class);
        match e.class {
            Class::Smooth | Class::Dip if abrupt > SMOOTH || peak <= 1e-5 => fails.push(format!("{}: abrupt {abrupt:.3}, diff peak {peak:.5}", e.name)),
            _ => {}
        }
    }
    assert!(fails.is_empty(), "over {SMOOTH} (or no change heard): {fails:#?}");
}

// --- Direct and smoothed classes (§4.7 rows 1-4, 6-7) ---------------------------------------------

#[test]
fn every_direct_and_smoothed_class_is_smooth_at_eight_phases() {
    let send_tree = || vec![(ROOT, vec![]), (0, vec![lp(8000.0, 1.0)]), (0, vec![comp(-24.0), rev(0.3)])];
    let edits = [
        Edit { name: "bus volume, authored lane, drag ramp (10 ms) 1 -> 0.4", class: Class::Smooth, tree: base, setup: none, edit: |_| vec![vec![ramp(1, wire::LANE_AUTHORED, 0.4, 480, 0, wire::ASAP)]] },
        Edit { name: "bus mute toggle, authored lane (5 ms) 1 -> 0", class: Class::Smooth, tree: base, setup: none, edit: |_| vec![vec![ramp(2, wire::LANE_AUTHORED, 0.0, 240, 0, wire::ASAP)]] },
        Edit { name: "script fadeTo, runtime lane stamped at the phase, 0.8 -> 0.3 over 50 ms", class: Class::Smooth, tree: base, setup: none, edit: |f| vec![vec![ramp(1, wire::LANE_RUNTIME, 0.3, 2400, 0, f.f0())]] },
        Edit { name: "monitor solo gate, monitor lane (5 ms) 1 -> 0", class: Class::Smooth, tree: base, setup: none, edit: |_| vec![vec![ramp(2, wire::LANE_MONITOR, 0.0, 240, 0, wire::ASAP)]] },
        Edit { name: "filter cutoff 8000 -> 1200 Hz (BUS_SLOT, same kind)", class: Class::Smooth, tree: base, setup: none, edit: |_| vec![vec![slot(1, 0, 0, 0, &[lp(1200.0, 1.0)], wire::ASAP)]] },
        Edit { name: "filter cutoff 8000 -> 300 Hz, Q 12 dB (BUS_SLOT)", class: Class::Smooth, tree: base, setup: none, edit: |_| vec![vec![slot(1, 0, 0, 0, &[lp(300.0, 12.0)], wire::ASAP)]] },
        Edit { name: "reverb send level 0.3 -> 0.8 (BUS_SLOT)", class: Class::Smooth, tree: send_tree, setup: none, edit: |_| vec![vec![slot(2, 0, 0, 0, &[comp(-24.0), rev(0.8)], wire::ASAP)]] },
        Edit { name: "compressor threshold -24 -> -30 dB (smoothed, 20 ms)", class: Class::Smooth, tree: base, setup: none, edit: |_| vec![vec![slot(2, 0, 0, 0, &[comp(-30.0)], wire::ASAP)]] },
        Edit { name: "compressor threshold -24 -> -50 dB (smoothed, 20 ms)", class: Class::Smooth, tree: base, setup: none, edit: |_| vec![vec![slot(2, 0, 0, 0, &[comp(-50.0)], wire::ASAP)]] },
        Edit { name: "append an effect: high-pass 400 Hz after the low-pass", class: Class::Smooth, tree: base, setup: none, edit: |_| vec![vec![slot(1, 0, 0, 0, &[lp(8000.0, 1.0), hp(400.0, 1.0)], wire::ASAP)]] },
        Edit { name: "append the first reverb send (convolver off -> on)", class: Class::Smooth, tree: base, setup: none, edit: |_| vec![vec![slot(2, 0, 0, 0, &[comp(-24.0), rev(0.5)], wire::ASAP)]] },
        Edit { name: "snapshot retarget: snapshot lane gain 1 -> 0.5 over 20 ms", class: Class::Smooth, tree: base, setup: none, edit: |_| vec![vec![ramp(1, wire::LANE_SNAPSHOT, 0.5, 960, 0, wire::ASAP)]] },
        Edit {
            name: "snapshot retarget: snapshot low-pass off -> 1 kHz over 20 ms",
            class: Class::Smooth,
            tree: base,
            setup: none,
            edit: |_| vec![vec![Rec::Ramps(vec![lane_ramp(2, wire::LANE_SNAPSHOT, None, Some(1000.0), 960)])]],
        },
        Edit {
            name: "presence rule defined: SFX (playing) ducks Music to 0.5 (BUS_DUCK)",
            class: Class::Smooth,
            tree: base,
            setup: || vec![presence((1 << 1) | (1 << 2))],
            edit: |_| vec![vec![duck(&[wire::BusDuckRules { target: 1, trigger: 2, flags: 0, threshold_db: 0.0, amount: 0.5, attack: 0.05, release: 0.2 }])]],
        },
        Edit {
            name: "level rule defined: SFX over -40 dB ducks Music to 0.5 (BUS_DUCK)",
            class: Class::Smooth,
            tree: base,
            setup: none,
            edit: |_| vec![vec![duck(&[wire::BusDuckRules { target: 1, trigger: 2, flags: wire::DUCK_FLAG_LEVEL, threshold_db: -40.0, amount: 0.5, attack: 0.05, release: 0.2 }])]],
        },
    ];
    check_all(&edits);
}

#[test]
fn edits_that_change_nothing_heard_are_bit_identical() {
    let edits = [
        Edit { name: "add a bus at the end (fresh BUS_SLOT)", class: Class::Identical, tree: base, setup: none, edit: |_| vec![vec![slot(3, wire::BUS_SLOT_FLAGS_FRESH, 0, 0, &[], wire::ASAP)]] },
        Edit { name: "meter on (LOUD_CONFIG)", class: Class::Identical, tree: base, setup: none, edit: |_| vec![vec![loud_config(&[1])]] },
        Edit { name: "a second bus metered (LOUD_CONFIG)", class: Class::Identical, tree: base, setup: || vec![loud_config(&[1])], edit: |_| vec![vec![loud_config(&[1, 2])]] },
    ];
    check_all(&edits);
}

// --- Structural classes (§4.7's last row, §3.3) ---------------------------------------------------

#[test]
fn every_structural_edit_dips_under_the_click_threshold_at_eight_phases() {
    let two_fx = || vec![(ROOT, vec![]), (0, vec![lp(3000.0, 1.0), hp(150.0, 1.0)]), (0, vec![comp(-24.0)])];
    let edits = [
        Edit {
            name: "re-parent: SFX under Music",
            class: Class::Dip,
            tree: base,
            setup: none,
            edit: |f| vec![sequence(f, 1, &[2], &[], vec![(2, 1, vec![comp(-24.0)])], &[])],
        },
        Edit {
            name: "mid-tree insert: new bus 3 (fresh, direct), Music and SFX re-parented under it",
            class: Class::Dip,
            tree: base,
            setup: none,
            edit: |f| vec![vec![slot(3, wire::BUS_SLOT_FLAGS_FRESH, 0, 0, &[hp(200.0, 1.0)], wire::ASAP)], sequence(f, 2, &[1, 2], &[], vec![(1, 3, vec![lp(8000.0, 1.0)]), (2, 3, vec![comp(-24.0)])], &[])],
        },
        Edit {
            name: "effect reorder: [LP 3k, HP 150] -> [HP 150, LP 3k]",
            class: Class::Dip,
            tree: two_fx,
            setup: none,
            edit: |f| vec![sequence(f, 3, &[1], &[], vec![(1, 0, vec![hp(150.0, 1.0), lp(3000.0, 1.0)])], &[])],
        },
        Edit {
            name: "effect removal (slots shift): [LP 3k, HP 150] -> [HP 150]",
            class: Class::Dip,
            tree: two_fx,
            setup: none,
            edit: |f| vec![sequence(f, 4, &[1], &[], vec![(1, 0, vec![hp(150.0, 1.0)])], &[])],
        },
        Edit { name: "effect removal: the last effect (LP 8k) off Music", class: Class::Dip, tree: base, setup: none, edit: |f| vec![sequence(f, 5, &[1], &[], vec![(1, 0, vec![])], &[])] },
        Edit {
            name: "mid-list insert: HP 150 before the LP 8k",
            class: Class::Dip,
            tree: base,
            setup: none,
            edit: |f| vec![sequence(f, 6, &[1], &[], vec![(1, 0, vec![hp(150.0, 1.0), lp(8000.0, 1.0)])], &[])],
        },
        Edit {
            name: "bus removal: SFX tombstoned, its voice to the root",
            class: Class::Dip,
            tree: base,
            setup: none,
            edit: |f| vec![sequence(f, 7, &[], &[2], vec![(2, ROOT, vec![])], &[(V2, 0)])],
        },
        Edit { name: "a sound's bus: the SFX voice moved to Music (per-voice dip)", class: Class::Dip, tree: base, setup: none, edit: |f| vec![per_voice_move(f, V2, 1)] },
        Edit {
            name: "send removal (another send stays): Music's send off",
            class: Class::Dip,
            tree: || vec![(ROOT, vec![]), (0, vec![lp(8000.0, 1.0), rev(0.4)]), (0, vec![comp(-24.0), rev(0.4)])],
            setup: none,
            edit: |f| vec![sequence(f, 8, &[1], &[], vec![(1, 0, vec![lp(8000.0, 1.0)])], &[])],
        },
        Edit {
            name: "the send during a dip: SFX (reverb send 0.5) re-parented under Music",
            class: Class::Dip,
            tree: || vec![(ROOT, vec![]), (0, vec![lp(8000.0, 1.0)]), (0, vec![comp(-24.0), rev(0.5)])],
            setup: none,
            edit: |f| vec![sequence(f, 9, &[2], &[], vec![(2, 1, vec![comp(-24.0), rev(0.5)])], &[])],
        },
        Edit {
            name: "last-send removal: SFX's only send off (the tail runs out)",
            class: Class::Dip,
            tree: || vec![(ROOT, vec![]), (0, vec![lp(8000.0, 1.0)]), (0, vec![comp(-24.0), rev(0.5)])],
            setup: none,
            edit: |f| vec![sequence(f, 10, &[2], &[], vec![(2, 0, vec![comp(-24.0)])], &[])],
        },
    ];
    check_all(&edits);
}

/// A sound changing bus (§3.3: "a voice moved to another bus dips alone with the per-voice FADE and
/// `SET_PARAMS bus` records, from the same F0"): FADE to 0 over D at F0, the bus at B, FADE back in
/// over D at B.
fn per_voice_move(f: Frames, voice: u32, to: u32) -> Vec<Rec> {
    vec![fade(voice, 0.0, D, f.f0()), set_bus_at(voice, to, f.b()), fade(voice, 1.0, D, f.b())]
}

/// The same structural edits sent abruptly (one asap record, no dip) click: the harness tells a
/// click from a dip (S4: 0.75-1.0).
#[test]
fn the_same_edits_sent_abruptly_click() {
    let edits = [
        Edit { name: "re-parent sent abruptly", class: Class::Dip, tree: base, setup: none, edit: |_| vec![vec![slot(2, 0, 0, 1, &[comp(-24.0)], wire::ASAP)]] },
        Edit { name: "a sound's bus sent abruptly (asap SET_PARAMS bus)", class: Class::Dip, tree: base, setup: none, edit: |_| vec![vec![set_bus_at(V2, 1, wire::ASAP)]] },
        Edit {
            name: "mid-list insert sent abruptly",
            class: Class::Dip,
            tree: base,
            setup: none,
            edit: |_| vec![vec![slot(1, 0, 0, 0, &[hp(150.0, 1.0), lp(8000.0, 1.0)], wire::ASAP)]],
        },
    ];
    for e in &edits {
        let (abrupt, _) = worst(e);
        eprintln!("[Ck1] {:<72} control: worst abrupt {abrupt:.3}", e.name);
        assert!(abrupt > CLICK, "{}: abrupt {abrupt:.3} reads as a click", e.name);
    }
}

// --- The send run-out under a dip (Rv1) -----------------------------------------------------------

/// The last send removed by the stamped sequence: the convolver's input is at 0 from F0 + D (the
/// post-fader send follows the dip lane), the `BUS_SLOT` at B drops the send, and the tail rings out
/// afterwards: the output minus a dry-only run (the same tree, never a send) is non-zero after B and
/// decays, then is exactly 0 once the IR's length has passed, with no step (abrupt ≤ 0.23 against the
/// unedited run, above).
#[test]
fn the_last_send_removed_under_a_dip_rings_its_tail_out() {
    let with_send = || vec![(ROOT, vec![]), (0, vec![lp(8000.0, 1.0)]), (0, vec![comp(-24.0), rev(0.5)])];
    let edit = Edit { name: "last send", class: Class::Dip, tree: with_send, setup: none, edit: |f| vec![sequence(f, 11, &[2], &[], vec![(2, 0, vec![comp(-24.0)])], &[])] };
    // The dry run: no send ever, the same dip (so its dry level matches the edited run's sample for sample).
    let dry = Edit { name: "dry", class: Class::Dip, tree: base, setup: none, edit: |f| vec![sequence(f, 11, &[2], &[], vec![(2, 0, vec![comp(-24.0)])], &[])] };
    let warm = 12;
    let (got, m) = run(&edit, warm, 0, true);
    let (dry_out, _) = run(&dry, warm, 0, true);
    let f = Frames { first: (warm * Q) as u64, phase: 0 };
    let b = warm * Q + f.b() as usize;
    let wet: Vec<f32> = got.iter().zip(&dry_out).map(|(a, d)| a - d).collect();
    let per_q = |from: usize| wet[from..from + Q].iter().fold(0.0f32, |m, x| m.max(x.abs()));
    let first = per_q(b);
    let mid = per_q(b + 8 * Q);
    eprintln!("[Ck1] last-send run-out: wet peak in the quantum at B {first:.2e}, 8 quanta on {mid:.2e}");
    assert!(first > 1e-5, "the tail goes on after the send's removal at B ({first:e})");
    assert!(mid > 0.0 && mid < first, "and decays ({mid:e} < {first:e})");
    // The run-out is still live at the end of the run (it lasts the IR's length plus the idle margin).
    assert!(sends::run_out_quanta(&m.core.regions().reverb[..]) as usize > RUN_QUANTA - warm - (f.b() as usize / Q));
    // After the IR's length the wet signal is exactly gone (a longer run).
    let ir_quanta = audio_dsp::convolver::ir::frames(RATE).div_ceil(Q);
    let mut long = Mixer::new(8);
    long.set_lookahead(0.0);
    long.load_clip(TONE_A, &tones(&[(220.0, 0.15), (880.0, 0.1), (1760.0, 0.05)]));
    long.load_clip(TONE_B, &tones(&[(330.0, 0.15), (990.0, 0.1), (1650.0, 0.05)]));
    let mut short = Mixer::new(8);
    short.set_lookahead(0.0);
    short.load_clip(TONE_A, &tones(&[(220.0, 0.15), (880.0, 0.1), (1760.0, 0.05)]));
    short.load_clip(TONE_B, &tones(&[(330.0, 0.15), (990.0, 0.1), (1650.0, 0.05)]));
    for (mx, tree) in [(&mut long, with_send()), (&mut short, base())] {
        mx.submit(&[config_tree(&tree), gains(0, &[1.0, 0.8, 1.0]), play(V1, TONE_A, 1, MIXED | LOOP), play(V2, TONE_B, 2, MIXED | LOOP)]);
        mx.render_n(warm);
        let fr = Frames { first: mx.frame, phase: 0 };
        mx.submit(&sequence(fr, 11, &[2], &[], vec![(2, 0, vec![comp(-24.0)])], &[]));
    }
    let after = (f.b() as usize).div_ceil(Q) + ir_quanta + 4;
    let a = long.render_n(after).0;
    let s = short.render_n(after).0;
    let tail_end = after - 2;
    assert!(a[tail_end * Q..].iter().zip(&s[tail_end * Q..]).all(|(x, y)| x == y), "exactly the dry level once the IR's length has passed");
    assert_eq!(bus::count(&long.core), 3);
}
