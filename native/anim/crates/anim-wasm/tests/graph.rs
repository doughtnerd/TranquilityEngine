//! The complete graph runtime (T31) through the core's calls: state machines (priority, `when`,
//! `how`, interruption, any-state, sub-machines, requests, travel, jump), blend spaces (weights,
//! glide, speed scaling), the random selector, choosers, slots with sections, linked graphs, sync
//! groups, notify gating, the mixing nodes, pose sources, inertialization routing, and the debug
//! records. Poses are compared with an implicit-graph instance playing the same clip at the same
//! time (the same sampling code, so equal within 1e-6), or with each other.

mod common;

use anim_format::graph::{family, CmpOp, CondNode, How, Interrupt, Operand, ParamValue, When};
use anim_format::skeleton::Skeleton;
use anim_format::NONE;
use anim_graph::{logic, mixing, sources, sync};
use anim_wasm::init::Core;
use anim_wire::core::{StateChange, CHANGE_REFUSED, PLAY_ONCE};
use anim_wire::debug::*;
use anim_wire::graph::*;
use anim_wire::WireRecord;
use common::graph::*;
use common::*;

const DT: f32 = 1.0 / 30.0;
const MAX_BONES: usize = 16;

struct Rig {
    core: Core,
    model: Skeleton,
    skel: u32,
    bones: usize,
}

fn rig() -> Rig {
    let (model, bytes) = skeleton(Shape::Chain(6), 3);
    let mut core = core(32, MAX_BONES as u32);
    let skel = core.load_skeleton(&bytes);
    assert_ne!(skel, 0);
    let bones = model.bones.len();
    Rig {
        core,
        model,
        skel,
        bones,
    }
}

impl Rig {
    fn clip(&mut self, spec: ClipSpec) -> u32 {
        let h = self.core.load_clip(&raw_clip(&self.model, &spec));
        assert_ne!(h, 0, "clip loads ({})", self.core.last_status());
        h
    }
    fn mats(&self, h: u32) -> Vec<f32> {
        matrices(&self.core, h, MAX_BONES, self.bones)
    }
    /// An implicit-graph instance showing `clip` at `time` (played from `time` and evaluated with
    /// dt 0).
    fn reference(&mut self, clip: u32, time: f32) -> Vec<f32> {
        let h = self.core.create_instance(1, self.skel, 0);
        let c = anim_wire::core::Play {
            instance: h,
            clip,
            play_id: 0,
            layer: 0,
            fade: 0.0,
            speed: 1.0,
            start: time,
            flags: PLAY_ONCE,
        }
        .encode();
        send(&mut self.core, &[c]);
        self.core.evaluate(1, 0, 0.0, 0.0);
        let m = self.mats(h);
        self.core.destroy_instance(h);
        m
    }
}

fn diff(a: &[f32], b: &[f32]) -> f32 {
    a.iter()
        .zip(b)
        .map(|(x, y)| (x - y).abs())
        .fold(0.0, f32::max)
}

fn entered(changes: &[GraphChange], machine: u32, state: u32) -> bool {
    changes
        .iter()
        .any(|c| c.kind == GRAPH_STATE_ENTERED && c.index == machine && c.value == state)
}

fn refused(core: &Core) -> Vec<StateChange> {
    changes(core)
        .into_iter()
        .filter(|c| c.kind == CHANGE_REFUSED)
        .collect()
}

/// Runs frames until machine `m` enters `state`; returns the frame (1-based) or `None` after `max`.
fn frames_until(core: &mut Core, m: u32, state: u32, max: usize) -> Option<usize> {
    (1..=max).find(|_| {
        frame(core, DT);
        entered(&graph_changes(core), m, state)
    })
}

fn three_state_machine(
    b: &mut Builder,
    trans: &[Vec<anim_format::graph::Transition>],
) -> MachineIds {
    let pa = b.player("a");
    let pb = b.player("b");
    let pc = b.player("c");
    b.machine(&[("A", pa, 0), ("B", pb, 0), ("C", pc, 0)], 0, trans, &[])
}

fn clips3(r: &mut Rig, b: &mut Builder) -> Vec<(u32, u32)> {
    let ca = r.clip(ClipSpec::new(1.0, true, 1));
    let cb = r.clip(ClipSpec::new(1.0, true, 2));
    let cc = r.clip(ClipSpec::new(1.0, true, 3));
    vec![(b.s("a"), ca), (b.s("b"), cb), (b.s("c"), cc)]
}

#[test]
fn transitions_fire_in_priority_order_and_report_state_changes() {
    let mut r = rig();
    let mut b = Builder::new();
    let go = b.param("go", ParamValue::Float(0.0));
    let c = b.cond(&[cmp_f(go, CmpOp::Gt, 0.5)]);
    let m = three_state_machine(
        &mut b,
        &[vec![
            tr(1, c, When::Now, How::Cut),
            tr(2, c, When::Now, How::Cut),
        ]],
    );
    let binds = clips3(&mut r, &mut b);
    let bytes = b.build(m.node);
    let (_, h) = instance(&mut r.core, &bytes, r.skel, &binds);
    send(&mut r.core, &[debug_on(h)]);
    frame(&mut r.core, DT);
    // Debug: both blocked by their condition (node 0 of program `c`, the operand reads 0).
    let rep = report(&mut r.core, h);
    assert_eq!(rep.header.instance, h);
    assert_eq!(rep.machines.len(), 1);
    assert_eq!(rep.machines[0].current, 0);
    assert_eq!(rep.transitions.len(), 2);
    for t in &rep.transitions {
        assert_eq!((t.blocker, t.detail, t.value), (BLOCK_CONDITION, 0, 0.0));
    }
    // With go = 1 (before the update): the first is ready, the second shadowed by it.
    send(&mut r.core, &[set_float(h, go, 1.0)]);
    let rep = report(&mut r.core, h);
    assert_eq!(rep.transitions[0].blocker, BLOCK_READY);
    assert_eq!(
        (rep.transitions[1].blocker, rep.transitions[1].detail),
        (BLOCK_SHADOWED, m.trans[0][0])
    );
    r.core.evaluate(0, 0, DT, DT);
    let ch = graph_changes(&r.core);
    assert!(entered(&ch, 0, 1), "{ch:?}");
    assert!(!entered(&ch, 0, 2));
    assert!(ch
        .iter()
        .any(|c| c.kind == GRAPH_STATE_EXITED && c.value == 0));
    let rep = report(&mut r.core, h);
    assert_eq!(rep.machines[0].current, 1);
    assert_eq!(rep.machines[0].last_fired, m.trans[0][0]);
    // The active node is B's player at full weight.
    assert_eq!(rep.weight(1), 1.0);
    assert_eq!(rep.weight(0), 0.0);
}

fn when_frame(when: When, spec: ClipSpec, b_extra: impl FnOnce(&mut Builder)) -> Option<usize> {
    let mut r = rig();
    let mut b = Builder::new();
    b_extra(&mut b);
    let m = three_state_machine(&mut b, &[vec![tr(1, NONE, when, How::Cut)]]);
    let ca = r.clip(spec);
    let cb = r.clip(ClipSpec::new(1.0, true, 2));
    let cc = r.clip(ClipSpec::new(1.0, true, 3));
    let binds = vec![(b.s("a"), ca), (b.s("b"), cb), (b.s("c"), cc)];
    let bytes = b.build(m.node);
    instance(&mut r.core, &bytes, r.skel, &binds);
    frames_until(&mut r.core, 0, 1, 60)
}

#[test]
fn when_now_fires_on_the_first_update() {
    assert_eq!(
        when_frame(When::Now, ClipSpec::new(1.0, true, 1), |_| {}),
        Some(1)
    );
}

#[test]
fn when_exit_waits_for_the_exit_marker() {
    let mut spec = ClipSpec::new(1.0, true, 1);
    spec.exits = vec![0.5];
    let f = when_frame(When::Exit, spec, |_| {}).unwrap();
    assert!((15..=16).contains(&f), "frame {f}");
}

#[test]
fn when_exit_without_markers_waits_for_the_end() {
    let f = when_frame(When::Exit, ClipSpec::new(0.4, false, 1), |_| {}).unwrap();
    assert!((12..=13).contains(&f), "frame {f}");
}

#[test]
fn when_marker_waits_for_the_named_sync_marker() {
    let mut spec = ClipSpec::new(1.0, true, 1);
    spec.sync = vec![("R", 0.1), ("L", 0.3)];
    let mut name = 0;
    let f = when_frame(When::Marker(0), spec, |b| {
        name = b.s("L");
    })
    .unwrap();
    assert_eq!(name, 0);
    assert!((9..=10).contains(&f), "frame {f}");
}

#[test]
fn when_normalized_time_waits_for_the_fraction() {
    let f = when_frame(
        When::NormalizedTime(0.5),
        ClipSpec::new(1.0, true, 1),
        |_| {},
    )
    .unwrap();
    assert!((15..=16).contains(&f), "frame {f}");
}

#[test]
fn debug_reports_when_not_reached() {
    let mut r = rig();
    let mut b = Builder::new();
    let m = three_state_machine(&mut b, &[vec![tr(1, NONE, When::Exit, How::Cut)]]);
    let mut spec = ClipSpec::new(1.0, true, 1);
    spec.exits = vec![0.5];
    let ca = r.clip(spec);
    let cb = r.clip(ClipSpec::new(1.0, true, 2));
    let cc = r.clip(ClipSpec::new(1.0, true, 3));
    let binds = vec![(b.s("a"), ca), (b.s("b"), cb), (b.s("c"), cc)];
    let bytes = b.build(m.node);
    let (_, h) = instance(&mut r.core, &bytes, r.skel, &binds);
    send(&mut r.core, &[debug_on(h)]);
    r.core.evaluate(0, 0, DT, DT);
    let rep = report(&mut r.core, h);
    assert_eq!(rep.transitions[0].blocker, BLOCK_WHEN);
    assert!((rep.machines[0].state_time - DT).abs() < 1e-6);
    assert!((rep.machines[0].normalized - DT).abs() < 1e-6);
    // The active player's node with its playhead.
    let n = rep.node(0).unwrap();
    assert_eq!((n.clip, n.weight), (ca, 1.0));
    assert!((n.time - DT).abs() < 1e-6 && (n.normalized - DT).abs() < 1e-6);
    // An instance not flagged writes nothing.
    let g2 = r.core.load_graph(&bytes);
    let h2 = r.core.create_instance(0, r.skel, g2);
    assert_eq!(r.core.debug_write(h2), 0);
}

fn how_rig(how: How, inertialize: bool) -> (Rig, u32, u32, u32) {
    let mut r = rig();
    let mut b = Builder::new();
    let go = b.param("go", ParamValue::Float(0.0));
    let c = b.cond(&[cmp_f(go, CmpOp::Gt, 0.5)]);
    let m = three_state_machine(&mut b, &[vec![tr(1, c, When::Now, how)]]);
    let out = if inertialize {
        b.node(family::MIXING, mixing::kind::INERTIALIZE, &[m.node], &[])
    } else {
        m.node
    };
    let binds = clips3(&mut r, &mut b);
    let cb = binds[1].1;
    let bytes = b.build(out);
    let (_, h) = instance(&mut r.core, &bytes, r.skel, &binds);
    send(&mut r.core, &[debug_on(h)]);
    for _ in 0..5 {
        frame(&mut r.core, DT);
    }
    send(&mut r.core, &[set_float(h, go, 1.0)]);
    r.core.evaluate(0, 0, DT, DT);
    (r, h, cb, go)
}

#[test]
fn how_cut_shows_the_target_from_its_start() {
    let (mut r, h, cb, _) = how_rig(How::Cut, false);
    let got = r.mats(h);
    let want = r.reference(cb, 0.0);
    assert!(diff(&got, &want) < 1e-6);
    frame(&mut r.core, DT);
    let want = r.reference(cb, DT);
    assert!(diff(&r.mats(h), &want) < 1e-5);
}

#[test]
fn how_crossfade_blends_with_its_shape_and_collapses() {
    let (mut r, h, cb, _) = how_rig(
        How::Crossfade {
            duration: 0.2,
            shape: 0,
        },
        false,
    );
    let rep = report(&mut r.core, h);
    assert_eq!(rep.machines[0].entries, 2);
    assert!(rep.weight(1) < 1e-6, "B starts at weight 0");
    frame(&mut r.core, DT);
    let rep = report(&mut r.core, h);
    assert!((rep.weight(1) - DT / 0.2).abs() < 1e-5, "{}", rep.weight(1));
    assert!((rep.weight(0) - (1.0 - DT / 0.2)).abs() < 1e-5);
    let mut exited = false;
    for _ in 0..6 {
        frame(&mut r.core, DT);
        exited |= graph_changes(&r.core)
            .iter()
            .any(|c| c.kind == GRAPH_STATE_EXITED && c.value == 0);
    }
    assert!(exited, "A leaves when the fade completes");
    let rep = report(&mut r.core, h);
    assert_eq!(rep.machines[0].entries, 1);
    assert_eq!(rep.machines[0].active, NONE);
    let want = r.reference(cb, 7.0 * DT);
    assert!(diff(&r.mats(h), &want) < 1e-4);
}

#[test]
fn how_smooth_shape_eases() {
    let (mut r, h, _, _) = how_rig(
        How::Crossfade {
            duration: 0.3,
            shape: 1,
        },
        false,
    );
    frame(&mut r.core, DT);
    let x = DT / 0.3;
    let rep = report(&mut r.core, h);
    assert!((rep.weight(1) - x * x * (3.0 - 2.0 * x)).abs() < 1e-5);
}

#[test]
fn how_inertialize_decays_the_pop_through_the_ancestor_node() {
    let (mut r, h, cb, _) = how_rig(How::Inertialize { duration: 0.2 }, true);
    let cut = r.reference(cb, 0.0);
    assert!(
        diff(&r.mats(h), &cut) > 1e-3,
        "the switch frame is still decaying"
    );
    for _ in 0..8 {
        frame(&mut r.core, DT);
    }
    let want = r.reference(cb, 8.0 * DT);
    assert!(diff(&r.mats(h), &want) < 1e-4, "settled on the target");
}

#[test]
fn inertialization_requests_route_to_the_requesters_ancestor() {
    // Node order puts another inertialization node between the machine and its own ancestor in
    // evaluation order; the request must still reach the ancestor.
    let mut r = rig();
    let mut b = Builder::new();
    let go = b.param("go", ParamValue::Float(0.0));
    let c = b.cond(&[cmp_f(go, CmpOp::Gt, 0.5)]);
    let pa = b.player("a");
    let pb = b.player("b");
    let m = b.machine(
        &[("A", pa, 0), ("B", pb, 0)],
        0,
        &[vec![tr(
            1,
            c,
            When::Now,
            How::Inertialize { duration: 0.3 },
        )]],
        &[],
    );
    let pc = b.player("c");
    let other = b.node(family::MIXING, mixing::kind::INERTIALIZE, &[pc], &[]);
    let own = b.node(family::MIXING, mixing::kind::INERTIALIZE, &[m.node], &[]);
    let out = b.node(
        family::MIXING,
        mixing::kind::BLEND2,
        &[own, other],
        &[0.0f32.to_bits(), NONE],
    );
    let binds = clips3(&mut r, &mut b);
    let cb = binds[1].1;
    let bytes = b.build(out);
    let (_, h) = instance(&mut r.core, &bytes, r.skel, &binds);
    for _ in 0..4 {
        frame(&mut r.core, DT);
    }
    send(&mut r.core, &[set_float(h, go, 1.0)]);
    r.core.evaluate(0, 0, DT, DT);
    let cut = r.reference(cb, 0.0);
    assert!(
        diff(&r.mats(h), &cut) > 1e-3,
        "the machine's own ancestor inertializes the switch"
    );
}

#[test]
fn how_bridge_enters_the_target_at_the_bridge_exit() {
    let mut r = rig();
    let mut b = Builder::new();
    let go = b.param("go", ParamValue::Float(0.0));
    let c = b.cond(&[cmp_f(go, CmpOp::Gt, 0.5)]);
    let pa = b.player("a");
    let pb = b.player("b");
    let bridge = b.player("bridge");
    let m = b.machine(
        &[("A", pa, 0), ("B", pb, 0)],
        0,
        &[vec![tr(
            1,
            c,
            When::Now,
            How::Bridge {
                node: bridge,
                duration: 0.1,
                shape: 0,
            },
        )]],
        &[],
    );
    let ca = r.clip(ClipSpec::new(1.0, true, 1));
    let cb = r.clip(ClipSpec::new(1.0, true, 2));
    let mut bs = ClipSpec::new(0.6, false, 4);
    bs.exits = vec![0.2];
    let cbr = r.clip(bs);
    let binds = vec![(b.s("a"), ca), (b.s("b"), cb), (b.s("bridge"), cbr)];
    let bytes = b.build(m.node);
    let (_, h) = instance(&mut r.core, &bytes, r.skel, &binds);
    send(&mut r.core, &[debug_on(h)]);
    frame(&mut r.core, DT);
    send(&mut r.core, &[set_float(h, go, 1.0)]);
    r.core.evaluate(0, 0, DT, DT);
    assert!(
        !entered(&graph_changes(&r.core), 0, 1),
        "not yet: the bridge plays"
    );
    let rep = report(&mut r.core, h);
    assert_eq!(rep.machines[0].target, 1);
    assert_eq!(rep.machines[0].current, 0);
    let f = frames_until(&mut r.core, 0, 1, 30).unwrap();
    assert!(
        (6..=7).contains(&f),
        "entered at the bridge's exit marker (0.2 s): frame {f}"
    );
    let rep = report(&mut r.core, h);
    assert_eq!(rep.machines[0].current, 1);
    assert!(rep.weight(bridge) > 0.0, "fading from the bridge");
}

fn interrupt_rig(interrupt: impl FnOnce(&mut Builder, u32) -> Interrupt) -> (Rig, u32, MachineIds) {
    let mut r = rig();
    let mut b = Builder::new();
    let go = b.param("go", ParamValue::Float(0.0));
    let go2 = b.param("go2", ParamValue::Float(0.0));
    let c = b.cond(&[cmp_f(go, CmpOp::Gt, 0.5)]);
    let c2 = b.cond(&[cmp_f(go2, CmpOp::Gt, 0.5)]);
    // B→C is transition 1 (A has one transition, index 0).
    let mut ab = tr(
        1,
        c,
        When::Now,
        How::Crossfade {
            duration: 0.5,
            shape: 0,
        },
    );
    ab.interrupt = interrupt(&mut b, 1);
    let bc = tr(
        2,
        c2,
        When::Now,
        How::Crossfade {
            duration: 0.1,
            shape: 0,
        },
    );
    let m = three_state_machine(&mut b, &[vec![ab], vec![bc]]);
    assert_eq!(m.trans[1][0], 1);
    let binds = clips3(&mut r, &mut b);
    let bytes = b.build(m.node);
    let (_, h) = instance(&mut r.core, &bytes, r.skel, &binds);
    send(&mut r.core, &[debug_on(h)]);
    frame(&mut r.core, DT);
    send(&mut r.core, &[set_float(h, go, 1.0)]);
    r.core.evaluate(0, 0, DT, DT);
    send(&mut r.core, &[set_float(h, go2, 1.0)]);
    r.core.evaluate(0, 0, DT, DT);
    (r, h, m)
}

#[test]
fn interruption_never_waits_for_the_fade() {
    let (mut r, h, _) = interrupt_rig(|_, _| Interrupt::Never);
    assert!(!entered(&graph_changes(&r.core), 0, 2));
    let rep = report(&mut r.core, h);
    assert_eq!(rep.transitions[0].blocker, BLOCK_INTERRUPT);
    // After the 0.5 s fade it fires.
    let f = frames_until(&mut r.core, 0, 2, 30).unwrap();
    assert!((13..=15).contains(&f), "frame {f}");
}

#[test]
fn interruption_any_fires_mid_fade() {
    let (mut r, h, _) = interrupt_rig(|_, _| Interrupt::Any);
    assert!(entered(&graph_changes(&r.core), 0, 2));
    assert_eq!(report(&mut r.core, h).machines[0].entries, 3);
}

#[test]
fn interruption_list_allows_listed_transitions_only() {
    let (r, _, _) = interrupt_rig(|b, bc| b.interrupts(&[bc]));
    assert!(entered(&graph_changes(&r.core), 0, 2));
    let (r, _, _) = interrupt_rig(|b, _| b.interrupts(&[0]));
    assert!(!entered(&graph_changes(&r.core), 0, 2));
}

#[test]
fn any_state_transitions_come_first_and_skip_the_current_state() {
    let mut r = rig();
    let mut b = Builder::new();
    let go = b.param("go", ParamValue::Float(0.0));
    let dead = b.param("dead", ParamValue::Float(0.0));
    let c = b.cond(&[cmp_f(go, CmpOp::Gt, 0.5)]);
    let cd = b.cond(&[cmp_f(dead, CmpOp::Gt, 0.5)]);
    let pa = b.player("a");
    let pb = b.player("b");
    let pc = b.player("c");
    let m = b.machine(
        &[("A", pa, 0), ("B", pb, 0), ("Dead", pc, 0)],
        0,
        &[vec![tr(1, c, When::Now, How::Cut)]],
        &[tr(2, cd, When::Now, How::Cut)],
    );
    let binds = clips3(&mut r, &mut b);
    let bytes = b.build(m.node);
    let (_, h) = instance(&mut r.core, &bytes, r.skel, &binds);
    send(
        &mut r.core,
        &[set_float(h, go, 1.0), set_float(h, dead, 1.0)],
    );
    r.core.evaluate(0, 0, DT, DT);
    let ch = graph_changes(&r.core);
    assert!(entered(&ch, 0, 2) && !entered(&ch, 0, 1), "{ch:?}");
    // In Dead with dead still true: no re-entry (any-state transitions skip the current state).
    frame(&mut r.core, DT);
    assert!(!entered(&graph_changes(&r.core), 0, 2));
}

#[test]
fn sub_machines_leave_through_their_exit_state_and_restart_on_entry() {
    let mut r = rig();
    let mut b = Builder::new();
    let go = b.param("go", ParamValue::Float(0.0));
    let c = b.cond(&[cmp_f(go, CmpOp::Gt, 0.5)]);
    let px = b.player("a");
    let py = b.player("b");
    let inner = b.machine(
        &[("X", px, 0), ("Y", py, anim_format::graph::STATE_EXIT)],
        0,
        &[vec![tr(1, c, When::Now, How::Cut)]],
        &[],
    );
    let pc = b.player("c");
    let outer = b.machine(
        &[("Sub", inner.node, 0), ("After", pc, 0)],
        0,
        &[vec![tr(1, NONE, When::Exit, How::Cut)]],
        &[],
    );
    let binds = clips3(&mut r, &mut b);
    let bytes = b.build(outer.node);
    let (_, h) = instance(&mut r.core, &bytes, r.skel, &binds);
    for _ in 0..3 {
        frame(&mut r.core, DT);
        assert!(!entered(&graph_changes(&r.core), outer.index, 1));
    }
    send(&mut r.core, &[set_float(h, go, 1.0)]);
    r.core.evaluate(0, 0, DT, DT);
    let ch = graph_changes(&r.core);
    assert!(entered(&ch, inner.index, 1), "{ch:?}");
    let f = if entered(&ch, outer.index, 1) {
        0
    } else {
        frames_until(&mut r.core, outer.index, 1, 3).unwrap()
    };
    assert!(f <= 1);
    // Back into Sub: the inner machine restarts at its entry.
    send(
        &mut r.core,
        &[set_float(h, go, 0.0), jump(h, outer.index, 0)],
    );
    r.core.evaluate(0, 0, DT, DT);
    let ch = graph_changes(&r.core);
    assert!(
        entered(&ch, outer.index, 0) && entered(&ch, inner.index, 0),
        "{ch:?}"
    );
}

#[test]
fn requests_are_consumed_by_the_transition_that_reads_them_or_expire() {
    let mut r = rig();
    let mut b = Builder::new();
    let gate = b.param("gate", ParamValue::Float(1.0));
    let name = b.s("Jump");
    let c = b.cond(&[CondNode::All(2), req(name), cmp_f(gate, CmpOp::Gt, 0.5)]);
    let m = three_state_machine(
        &mut b,
        &[
            vec![tr(1, c, When::Now, How::Cut)],
            vec![tr(0, NONE, When::Now, How::Cut)],
        ],
    );
    let binds = clips3(&mut r, &mut b);
    let bytes = b.build(m.node);
    let (_, h) = instance(&mut r.core, &bytes, r.skel, &binds);
    send(&mut r.core, &[debug_on(h)]);
    frame(&mut r.core, DT);
    // Consumed.
    send(&mut r.core, &[request(h, name, 0.2)]);
    r.core.evaluate(0, 0, DT, DT);
    let ch = graph_changes(&r.core);
    assert!(ch
        .iter()
        .any(|c| c.kind == GRAPH_REQUEST_CONSUMED && c.index == name && c.value == m.trans[0][0]));
    assert!(entered(&ch, 0, 1));
    frame(&mut r.core, DT); // B → A
                            // Expires unread while the gate is closed; the stale request never fires later.
    send(
        &mut r.core,
        &[set_float(h, gate, 0.0), request(h, name, 0.1)],
    );
    let rep = report(&mut r.core, h);
    assert_eq!(rep.requests.len(), 1);
    assert!((rep.requests[0].life - 0.1).abs() < 1e-6);
    let mut expired_at = None;
    r.core.evaluate(0, 0, DT, DT);
    for f in 1..=6 {
        if graph_changes(&r.core)
            .iter()
            .any(|c| c.kind == GRAPH_REQUEST_EXPIRED && c.index == name)
        {
            expired_at = Some(f);
            break;
        }
        frame(&mut r.core, DT);
    }
    let f = expired_at.expect("expired");
    assert!((3..=4).contains(&f), "after 0.1 s: frame {f}");
    send(&mut r.core, &[set_float(h, gate, 1.0)]);
    r.core.evaluate(0, 0, DT, DT);
    assert!(!entered(&graph_changes(&r.core), 0, 1));
    // A request for a name no condition reads is refused.
    send(&mut r.core, &[request(h, 999, 0.1)]);
    assert_eq!(refused(&r.core)[0].status, STATUS_NO_SUCH);
}

#[test]
fn travel_takes_the_shortest_path_with_a_deterministic_tie_break() {
    let mut r = rig();
    let mut b = Builder::new();
    let never = b.param("never", ParamValue::Float(0.0));
    let c = b.cond(&[cmp_f(never, CmpOp::Gt, 0.5)]);
    let t = |to: u32| tr(to, c, When::Now, How::Cut);
    let players: Vec<u32> = (0..7).map(|i| b.player(["a", "b", "c"][i % 3])).collect();
    let names = ["S0", "S1", "S2", "S3", "S4", "S5", "S6"];
    let states: Vec<(&str, u32, u32)> = names
        .iter()
        .zip(&players)
        .map(|(n, p)| (*n, *p, 0))
        .collect();
    // S0 → S3 | S1 (that order); S1 → S5; S3 → S5; S0 → S2 → S4 → S5 (longer); S6 unreachable.
    let m = b.machine(
        &states,
        0,
        &[
            vec![t(3), t(1), t(2)],
            vec![t(5)],
            vec![t(4)],
            vec![t(5)],
            vec![t(5)],
            vec![t(0)],
            vec![],
        ],
        &[],
    );
    let binds = clips3(&mut r, &mut b);
    let bytes = b.build(m.node);
    let (_, h) = instance(&mut r.core, &bytes, r.skel, &binds);
    send(&mut r.core, &[debug_on(h), travel(h, 0, 5)]);
    assert!(refused(&r.core).is_empty());
    let rep = report(&mut r.core, h);
    assert_eq!(rep.machines[0].travel, 5);
    // The hop: S0→S3 ready, the others blocked as off the path.
    assert_eq!(rep.transitions[0].blocker, BLOCK_READY);
    assert_eq!(rep.transitions[1].blocker, BLOCK_TRAVEL);
    r.core.evaluate(0, 0, DT, DT);
    assert!(entered(&graph_changes(&r.core), 0, 3));
    frame(&mut r.core, DT);
    assert!(entered(&graph_changes(&r.core), 0, 5));
    let rep = report(&mut r.core, h);
    assert_eq!((rep.machines[0].current, rep.machines[0].travel), (5, NONE));
    frame(&mut r.core, DT);
    assert!(
        graph_changes(&r.core).is_empty(),
        "travel ended at the target"
    );
    // Unreachable: refused with STATUS_UNREACHABLE; a jump cuts there.
    send(&mut r.core, &[travel(h, 0, 6)]);
    let rf = refused(&r.core);
    assert_eq!((rf[0].status, rf[0].layer), (STATUS_UNREACHABLE, 0));
    send(&mut r.core, &[jump(h, 0, 6)]);
    r.core.evaluate(0, 0, DT, DT);
    assert!(entered(&graph_changes(&r.core), 0, 6));
    // A bad machine or state is refused.
    send(&mut r.core, &[jump(h, 3, 0), travel(h, 0, 99)]);
    assert!(refused(&r.core).iter().all(|c| c.status == STATUS_NO_SUCH));
}

fn bs_params(x: u32, y: u32, speed: u32, glide_ms: f32, flags: u32, coords: &[f32]) -> Vec<u32> {
    let mut p = vec![
        x,
        y,
        speed,
        glide_ms.to_bits(),
        flags,
        0.0f32.to_bits(),
        0.0f32.to_bits(),
    ];
    p.extend(coords.iter().map(|c| c.to_bits()));
    p
}

#[test]
fn blend_space_2d_weights_follow_the_triangulation() {
    let mut r = rig();
    let mut b = Builder::new();
    let x = b.param("x", ParamValue::Float(0.0));
    let y = b.param("y", ParamValue::Float(0.0));
    let ps: Vec<u32> = (0..5).map(|i| b.player(["a", "b", "c"][i % 3])).collect();
    let coords = [-1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0, 0.2, 0.1];
    let bs = b.node(
        family::SOURCES,
        sources::kind::BLEND_SPACE_2D,
        &ps,
        &bs_params(x, y, NONE, 0.0, 0, &coords),
    );
    let binds = clips3(&mut r, &mut b);
    let bytes = b.build(bs);
    let (_, h) = instance(&mut r.core, &bytes, r.skel, &binds);
    send(&mut r.core, &[debug_on(h)]);
    let points: Vec<[f32; 2]> = coords.chunks(2).map(|c| [c[0], c[1]]).collect();
    let t = sources::triangulate::triangulate(&points);
    for q in [
        [0.3f32, -0.4],
        [-0.9, 0.9],
        [2.0, 0.0],
        [0.2, 0.1],
        [0.0, -3.0],
    ] {
        send(&mut r.core, &[set_float(h, x, q[0]), set_float(h, y, q[1])]);
        r.core.evaluate(0, 0, DT, DT);
        let (idx, w) = sources::triangulate::weights(&points, &t.triangles, &t.hull, q);
        let rep = report(&mut r.core, h);
        for (i, &p) in ps.iter().enumerate() {
            let want: f32 = (0..3).filter(|&k| idx[k] == i as u32).map(|k| w[k]).sum();
            assert!(
                (rep.weight(p) - want).abs() < 1e-6,
                "{q:?} sample {i}: {} vs {want}",
                rep.weight(p)
            );
        }
    }
}

#[test]
fn blend_space_1d_is_piecewise_linear_and_glides() {
    let mut r = rig();
    let mut b = Builder::new();
    let x = b.param("x", ParamValue::Float(0.0));
    let ps: Vec<u32> = (0..3).map(|i| b.player(["a", "b", "c"][i])).collect();
    let bs = b.node(
        family::SOURCES,
        sources::kind::BLEND_SPACE_1D,
        &ps,
        &bs_params(x, NONE, NONE, 100.0, 0, &[3.0, 0.0, 1.0]),
    );
    let binds = clips3(&mut r, &mut b);
    let bytes = b.build(bs);
    let (_, h) = instance(&mut r.core, &bytes, r.skel, &binds);
    send(&mut r.core, &[debug_on(h)]);
    frame(&mut r.core, DT);
    assert_eq!(
        report(&mut r.core, h).weight(ps[1]),
        1.0,
        "x = 0 is sample 1"
    );
    // To x = 2 (halfway between 1 and 3) over 100 ms.
    send(&mut r.core, &[set_float(h, x, 2.0)]);
    r.core.evaluate(0, 0, DT, DT);
    let rep = report(&mut r.core, h);
    // Glided a third of the way: x = 2/3, between samples 1 (x 0) and 2 (x 1).
    let g = 2.0 * DT / 0.1;
    assert!(
        (rep.weight(ps[2]) - g).abs() < 1e-5,
        "{}",
        rep.weight(ps[2])
    );
    for _ in 0..3 {
        frame(&mut r.core, DT);
    }
    let rep = report(&mut r.core, h);
    assert!((rep.weight(ps[0]) - 0.5).abs() < 1e-6 && (rep.weight(ps[2]) - 0.5).abs() < 1e-6);
    // Past the ends: clamped.
    send(&mut r.core, &[set_float(h, x, -5.0)]);
    for _ in 0..4 {
        frame(&mut r.core, DT);
    }
    assert_eq!(report(&mut r.core, h).weight(ps[1]), 1.0);
}

#[test]
fn blend_space_speed_scales_by_the_sampled_root_speed() {
    let mut r = rig();
    let mut b = Builder::new();
    let x = b.param("x", ParamValue::Float(0.5));
    let speed = b.param("speed", ParamValue::Float(2.0));
    let p0 = b.player("slow");
    let p1 = b.player("fast");
    let bs = b.node(
        family::SOURCES,
        sources::kind::BLEND_SPACE_1D,
        &[p0, p1],
        &bs_params(x, NONE, speed, 0.0, sources::BS_SPEED, &[0.0, 1.0]),
    );
    let mut slow = ClipSpec::new(1.0, true, 5);
    slow.speed = 1.0;
    let mut fast = ClipSpec::new(1.0, true, 6);
    fast.speed = 3.0;
    let cs = r.clip(slow);
    let cf = r.clip(fast);
    let binds = vec![(b.s("slow"), cs), (b.s("fast"), cf)];
    let bytes = b.build(bs);
    let (_, h) = instance(&mut r.core, &bytes, r.skel, &binds);
    for _ in 0..3 {
        frame(&mut r.core, DT);
    }
    // Blended root speed 2 = the parameter: rate 1, 2 m/s.
    assert!(
        (root(&r.core, h)[2] - 2.0 * DT).abs() < 1e-4,
        "{:?}",
        root(&r.core, h)
    );
    send(&mut r.core, &[set_float(h, speed, 4.0)]);
    r.core.evaluate(0, 0, DT, DT);
    assert!(
        (root(&r.core, h)[2] - 4.0 * DT).abs() < 1e-4,
        "{:?}",
        root(&r.core, h)
    );
}

fn random_picks(mode: u32, avoid: u32, seed_value: u32, n: usize) -> Vec<u32> {
    let mut r = rig();
    let mut b = Builder::new();
    let ps: Vec<u32> = (0..3).map(|i| b.player(["a", "b", "c"][i])).collect();
    let mut words = vec![mode, avoid];
    words.extend([1.0f32, 2.0, 1.0].iter().map(|w| w.to_bits()));
    let sel = b.node(family::LOGIC, logic::kind::RANDOM, &ps, &words);
    let m = b.machine(&[("Idle", sel, 0)], 0, &[], &[]);
    let binds = clips3(&mut r, &mut b);
    let bytes = b.build(m.node);
    let (_, h) = instance(&mut r.core, &bytes, r.skel, &binds);
    send(&mut r.core, &[debug_on(h), seed(h, seed_value)]);
    (0..n)
        .map(|_| {
            send(&mut r.core, &[jump(h, 0, 0)]);
            r.core.evaluate(0, 0, DT, DT);
            let rep = report(&mut r.core, h);
            let picked: Vec<u32> = (0..3)
                .filter(|&i| rep.weight(ps[i as usize]) > 0.0)
                .collect();
            assert_eq!(picked.len(), 1);
            picked[0]
        })
        .collect()
}

#[test]
fn random_selector_is_deterministic_by_seed_and_avoids_repeats() {
    let a = random_picks(logic::RANDOM_WEIGHTED, 0, 1234, 40);
    assert_eq!(
        a,
        random_picks(logic::RANDOM_WEIGHTED, 0, 1234, 40),
        "same seed, same picks"
    );
    assert_ne!(
        a,
        random_picks(logic::RANDOM_WEIGHTED, 0, 4321, 40),
        "another seed differs"
    );
    assert!(
        a.windows(2).any(|w| w[0] == w[1]),
        "without avoidRepeat a pick may repeat"
    );
    // Weighted: choice 1 (weight 2) about half the time.
    let ones = a.iter().filter(|&&p| p == 1).count();
    assert!((10..=30).contains(&ones), "{ones}");
    let b = random_picks(logic::RANDOM_WEIGHTED, 1, 1234, 40);
    assert!(b.windows(2).all(|w| w[0] != w[1]), "avoidRepeat 1: {b:?}");
    let c = random_picks(logic::RANDOM_WEIGHTED, 2, 99, 40);
    assert!(
        c.windows(3)
            .all(|w| w[0] != w[1] && w[1] != w[2] && w[0] != w[2]),
        "avoidRepeat 2: {c:?}"
    );
}

#[test]
fn shuffle_and_round_robin() {
    let s = random_picks(logic::RANDOM_SHUFFLE, 1, 77, 14);
    // The instance's creation made the first pick of the first cycle; whole cycles follow.
    for cycle in s[2..].chunks(3) {
        let mut c = cycle.to_vec();
        c.sort();
        assert_eq!(c, vec![0, 1, 2], "{s:?}");
    }
    assert!(
        s.windows(2).all(|w| w[0] != w[1]),
        "no repeat across cycles: {s:?}"
    );
    let rr = random_picks(logic::RANDOM_ROUND_ROBIN, 0, 77, 6);
    // The instance's first entry picked 0; re-entries continue in order.
    assert_eq!(rr, vec![1, 2, 0, 1, 2, 0]);
}

#[test]
fn chooser_picks_the_first_matching_row_else_the_fallback() {
    let mut r = rig();
    let mut b = Builder::new();
    let mode = b.param("mode", ParamValue::Int(0));
    let row = |b: &mut Builder, v: i32| {
        b.cond(&[CondNode::Compare {
            operand: Operand::Param(mode),
            op: CmpOp::Eq,
            value: v as u32,
        }])
    };
    let r0 = row(&mut b, 0);
    let r1 = row(&mut b, 1);
    let p0 = b.player("a");
    let p1 = b.player("b");
    let p2 = b.player("c");
    let ch = b.chooser(&[(r0, p0), (r1, p1)], p2, logic::CHOOSER_EVERY_UPDATE, 0.0);
    let binds = clips3(&mut r, &mut b);
    let bytes = b.build(ch);
    let (_, h) = instance(&mut r.core, &bytes, r.skel, &binds);
    send(&mut r.core, &[debug_on(h)]);
    for (v, want) in [(0, p0), (1, p1), (5, p2), (0, p0)] {
        send(&mut r.core, &[set_int(h, mode, v)]);
        r.core.evaluate(0, 0, DT, DT);
        assert_eq!(report(&mut r.core, h).weight(want), 1.0, "mode {v}");
    }
}

fn slot_rig() -> (Rig, u32, u32, u32, u32) {
    let mut r = rig();
    let mut b = Builder::new();
    let base = b.player("a");
    let (s0, _) = b.slot("Upper", base, NONE, Some("G"));
    let (s1, _) = b.slot("Other", s0, NONE, Some("G"));
    let ca = r.clip(ClipSpec::new(2.0, true, 1));
    let shot = r.clip(ClipSpec::new(1.0, false, 8));
    let binds = vec![(b.s("a"), ca)];
    let bytes = b.build(s1);
    let (_, h) = instance(&mut r.core, &bytes, r.skel, &binds);
    (r, h, shot, ca, s0)
}

fn slot_play(
    instance: u32,
    slot: u32,
    clip: u32,
    play_id: u32,
    start: f32,
    end: f32,
    flags: u32,
) -> Vec<u8> {
    SlotPlay {
        instance,
        slot,
        clip,
        play_id,
        blend_in: 0.0,
        blend_out: 0.0,
        speed: 1.0,
        start,
        end,
        flags,
    }
    .encode()
}

#[test]
fn slots_play_sections_and_report_finished() {
    let (mut r, h, shot, _, _) = slot_rig();
    frame(&mut r.core, DT);
    send(&mut r.core, &[slot_play(h, 0, shot, 7, 0.2, 0.5, 0)]);
    r.core.evaluate(0, 0, DT, DT);
    // Full weight, no mask: the slot's clip, from the section start plus one frame.
    let want = r.reference(shot, 0.2 + DT);
    assert!(diff(&r.mats(h), &want) < 1e-5);
    let mut finished = None;
    for f in 2..=20 {
        frame(&mut r.core, DT);
        if graph_changes(&r.core)
            .iter()
            .any(|c| c.kind == GRAPH_SLOT_FINISHED && c.value == 7 && c.index == 0)
        {
            finished = Some(f);
            break;
        }
    }
    let f = finished.expect("finished");
    assert!((9..=10).contains(&f), "a 0.3 s section: frame {f}");
}

#[test]
fn slot_next_sections_chain_and_loops_hold() {
    let (mut r, h, shot, _, _) = slot_rig();
    send(&mut r.core, &[slot_play(h, 0, shot, 3, 0.0, 0.2, 0)]);
    r.core.evaluate(0, 0, DT, DT);
    send(
        &mut r.core,
        &[SlotNextSection {
            instance: h,
            slot: 0,
            play_id: 3,
            start: 0.6,
            end: 0.8,
            flags: 0,
        }
        .encode()],
    );
    assert!(refused(&r.core).is_empty());
    r.core.evaluate(0, 0, DT, DT);
    let mut finished = None;
    for f in 3..=30 {
        frame(&mut r.core, DT);
        if graph_changes(&r.core)
            .iter()
            .any(|c| c.kind == GRAPH_SLOT_FINISHED && c.value == 3)
        {
            finished = Some(f);
            break;
        }
    }
    let f = finished.unwrap();
    assert!(
        (12..=13).contains(&f),
        "0.2 s + 0.2 s of sections: frame {f}"
    );
    // A looping section never finishes.
    send(
        &mut r.core,
        &[slot_play(h, 0, shot, 4, 0.1, 0.3, SECTION_LOOP)],
    );
    for _ in 0..40 {
        frame(&mut r.core, DT);
        assert!(!graph_changes(&r.core)
            .iter()
            .any(|c| c.kind == GRAPH_SLOT_FINISHED));
    }
}

#[test]
fn slot_plays_are_interrupted_by_plays_their_group_and_stops() {
    let (mut r, h, shot, _, _) = slot_rig();
    send(&mut r.core, &[slot_play(h, 0, shot, 8, 0.0, 0.0, 0)]);
    r.core.evaluate(0, 0, DT, DT);
    send(&mut r.core, &[slot_play(h, 0, shot, 9, 0.0, 0.0, 0)]);
    let ch = graph_changes(&r.core);
    assert!(ch.iter().any(|c| c.kind == GRAPH_SLOT_INTERRUPTED
        && c.value == 8
        && c.reason == REASON_INTERRUPTED));
    r.core.evaluate(0, 0, DT, DT);
    // Slot 1 shares group G: playing there stops slot 0's play.
    send(&mut r.core, &[slot_play(h, 1, shot, 10, 0.0, 0.0, 0)]);
    let ch = graph_changes(&r.core);
    assert!(ch.iter().any(|c| c.kind == GRAPH_SLOT_INTERRUPTED
        && c.value == 9
        && c.index == 0
        && c.reason == REASON_INTERRUPTED));
    r.core.evaluate(0, 0, DT, DT);
    send(
        &mut r.core,
        &[SlotStop {
            instance: h,
            slot: 1,
            play_id: 0,
            fade: 0.1,
        }
        .encode()],
    );
    let ch = graph_changes(&r.core);
    assert!(ch
        .iter()
        .any(|c| c.kind == GRAPH_SLOT_INTERRUPTED && c.value == 10 && c.reason == REASON_STOPPED));
}

#[test]
fn a_masked_upper_body_slot_keeps_the_legs() {
    let mut r = rig();
    let mut b = Builder::new();
    let base = b.player("a");
    let mask = b.s("upper");
    let (s0, _) = b.slot("Upper", base, mask, None);
    let ca = r.clip(ClipSpec::new(2.0, true, 1));
    let shot = r.clip(ClipSpec::new(1.0, false, 8));
    let weights: Vec<f32> = (0..r.bones)
        .map(|i| if i >= 3 { 1.0 } else { 0.0 })
        .collect();
    let mk = r.core.load_mask(&weights);
    let binds = vec![(b.s("a"), ca), (mask, mk)];
    let bytes = b.build(s0);
    let (_, h) = instance(&mut r.core, &bytes, r.skel, &binds);
    send(&mut r.core, &[slot_play(h, 0, shot, 1, 0.0, 0.0, 0)]);
    r.core.evaluate(0, 0, 0.0, 0.0);
    let got = r.mats(h);
    let legs = r.reference(ca, 0.0);
    // Bone 0 (masked out) keeps the base: its matrix equals the base clip's.
    assert!(diff(&got[..12], &legs[..12]) < 1e-6);
    let arms = r.reference(shot, 0.0);
    assert!(diff(&got[3 * 12..4 * 12], &arms[3 * 12..4 * 12]) > 1e-4 || diff(&legs, &arms) < 1e-6);
}

#[test]
fn linked_graphs_swap_at_runtime_and_take_parameters_by_name() {
    let mut r = rig();
    let c1 = r.clip(ClipSpec::new(1.0, true, 11));
    let c2 = r.clip(ClipSpec::new(1.0, true, 12));
    let c3 = r.clip(ClipSpec::new(1.0, true, 13));
    // G1: one clip. G2: a blend of two by its parameter "w".
    let mut b1 = Builder::new();
    let p = b1.player("c1");
    let g1_bytes = b1.build(p);
    let g1 = r.core.load_graph(&g1_bytes);
    r.core.graph_bind(g1, b1.s("c1"), c1);
    let mut b2 = Builder::new();
    let w2 = b2.param("w", ParamValue::Float(0.0));
    let pa = b2.player("c2");
    let pb = b2.player("c3");
    let bl = b2.node(family::MIXING, mixing::kind::BLEND2, &[pa, pb], &[0, w2]);
    let g2_bytes = b2.build(bl);
    let g2 = r.core.load_graph(&g2_bytes);
    r.core.graph_bind(g2, b2.s("c2"), c2);
    r.core.graph_bind(g2, b2.s("c3"), c3);
    // Outer: its own "w" and a linked slot with room for either.
    let mut b = Builder::new();
    let w = b.param("w", ParamValue::Float(0.0));
    let (ln, li) = b.linked("Weapon", None, [512, 64, 4, 8]);
    let bytes = b.build(ln);
    let (_, h) = instance(&mut r.core, &bytes, r.skel, &[]);
    frame(&mut r.core, DT);
    let rest = r.mats(h);
    let link = |g: u32| {
        Link {
            instance: h,
            linked: li,
            graph: g,
        }
        .encode()
    };
    send(&mut r.core, &[link(g1)]);
    r.core.evaluate(0, 0, 0.0, 0.0);
    assert!(diff(&r.mats(h), &r.reference(c1, 0.0)) < 1e-6);
    send(&mut r.core, &[link(g2)]);
    r.core.evaluate(0, 0, 0.0, 0.0);
    assert!(diff(&r.mats(h), &r.reference(c2, 0.0)) < 1e-6);
    send(&mut r.core, &[set_float(h, w, 1.0)]);
    r.core.evaluate(0, 0, 0.0, 0.0);
    assert!(
        diff(&r.mats(h), &r.reference(c3, 0.0)) < 1e-6,
        "the outer w reached G2's w"
    );
    send(&mut r.core, &[link(0)]);
    r.core.evaluate(0, 0, 0.0, 0.0);
    assert!(diff(&r.mats(h), &rest) < 1e-6, "unlinked: nothing");
    // A graph that doesn't fit is refused.
    let mut b3 = Builder::new();
    let (ln3, li3) = b3.linked("Small", None, [4, 0, 0, 0]);
    let small = b3.build(ln3);
    let (_, h3) = instance(&mut r.core, &small, r.skel, &[]);
    send(
        &mut r.core,
        &[Link {
            instance: h3,
            linked: li3,
            graph: g2,
        }
        .encode()],
    );
    assert_eq!(
        refused(&r.core)[0].status,
        anim_wire::core::STATUS_TOO_LARGE
    );
}

#[test]
fn a_linked_slot_runs_its_default_graph_from_the_first_frame() {
    let mut r = rig();
    let c1 = r.clip(ClipSpec::new(1.0, true, 11));
    let mut b1 = Builder::new();
    let p = b1.player("c1");
    let g1_bytes = b1.build(p);
    let g1 = r.core.load_graph(&g1_bytes);
    r.core.graph_bind(g1, b1.s("c1"), c1);
    let mut b = Builder::new();
    let (ln, _) = b.linked("Weapon", Some("sword"), [512, 64, 4, 8]);
    let sword = b.s("sword");
    let bytes = b.build(ln);
    let (_, h) = instance(&mut r.core, &bytes, r.skel, &[(sword, g1)]);
    r.core.evaluate(0, 0, 0.0, 0.0);
    assert!(diff(&r.mats(h), &r.reference(c1, 0.0)) < 1e-6);
}

#[test]
fn layer_weight_commands_drive_layers() {
    let mut r = rig();
    let h = one_node(&mut r, |b| {
        let pa = b.player("a");
        let pb = b.player("b");
        let p = mixing::layer_params(1, mixing::LAYER_OVERRIDE, NONE, 0.0);
        b.node(family::MIXING, mixing::kind::LAYER, &[pa, pb], &p)
    });
    let ra = r.clip(ClipSpec::new(1.0, true, 1));
    let rb = r.clip(ClipSpec::new(1.0, true, 2));
    let (wa, wb) = (r.reference(ra, 0.0), r.reference(rb, 0.0));
    let lw = |w: f32| {
        LayerWeight {
            instance: h,
            layer: 1,
            weight: w,
        }
        .encode()
    };
    send(&mut r.core, &[lw(0.0)]);
    r.core.evaluate(0, 0, 0.0, 0.0);
    assert!(diff(&r.mats(h), &wa) < 1e-6);
    send(&mut r.core, &[lw(1.0)]);
    r.core.evaluate(0, 0, 0.0, 0.0);
    assert!(diff(&r.mats(h), &wb) < 1e-6);
    send(
        &mut r.core,
        &[LayerWeight {
            instance: h,
            layer: 9,
            weight: 1.0,
        }
        .encode()],
    );
    assert_eq!(refused(&r.core)[0].status, STATUS_NO_SUCH);
}

fn sync_phases(grouped: bool) -> (f32, f32) {
    let mut r = rig();
    let mut b = Builder::new();
    let pw = b.player("walk");
    let pr = b.player("run");
    let bl = b.node(
        family::MIXING,
        mixing::kind::BLEND2,
        &[pw, pr],
        &[0.7f32.to_bits(), NONE],
    );
    let out = if grouped {
        b.node(family::SYNC, sync::kind::SYNC_GROUP, &[bl], &[])
    } else {
        bl
    };
    let mut walk = ClipSpec::new(1.0, true, 21);
    walk.sync = vec![("L", 0.0), ("R", 0.5)];
    let mut run = ClipSpec::new(0.6, true, 22);
    run.sync = vec![("L", 0.1), ("R", 0.25)];
    let cw = r.clip(walk);
    let cr = r.clip(run);
    let binds = vec![(b.s("walk"), cw), (b.s("run"), cr)];
    let bytes = b.build(out);
    let (_, h) = instance(&mut r.core, &bytes, r.skel, &binds);
    send(&mut r.core, &[debug_on(h)]);
    for _ in 0..47 {
        frame(&mut r.core, DT);
    }
    let rep = report(&mut r.core, h);
    let tw = rep.node(pw).unwrap().time;
    let tr_ = rep.node(pr).unwrap().time;
    // Phase over the L→R→L cycle: segment index + fraction.
    let phase = |t: f32, marks: [f32; 2], d: f32| {
        let (l, rr) = (marks[0], marks[1]);
        let t = if t < l { t + d } else { t };
        if t < rr {
            (t - l) / (rr - l)
        } else {
            1.0 + (t - rr) / (l + d - rr)
        }
    };
    (phase(tw, [0.0, 0.5], 1.0), phase(tr_, [0.1, 0.25], 0.6))
}

#[test]
fn sync_groups_keep_feet_phase_aligned_across_a_blend() {
    let (pw, pr) = sync_phases(true);
    assert!((pw - pr).abs() < 1e-4, "walk {pw} run {pr}");
    let (pw, pr) = sync_phases(false);
    assert!(
        (pw - pr).abs() > 0.05,
        "without the group they drift: {pw} {pr}"
    );
}

fn events_fired(weight_of_b: f32, gate: Option<f32>) -> usize {
    let mut r = rig();
    let mut b = Builder::new();
    let pa = b.player("a");
    let a = match gate {
        Some(f) => b.node(
            family::SYNC,
            sync::kind::NOTIFY_GATE,
            &[pa],
            &[f.to_bits(), NONE],
        ),
        None => pa,
    };
    let pb = b.player("b");
    let bl = b.node(
        family::MIXING,
        mixing::kind::BLEND2,
        &[a, pb],
        &[weight_of_b.to_bits(), NONE],
    );
    let mut spec = ClipSpec::new(1.0, true, 1);
    spec.events = vec![(0.2, 0.5)];
    let ca = r.clip(spec);
    let cb = r.clip(ClipSpec::new(1.0, true, 2));
    let binds = vec![(b.s("a"), ca), (b.s("b"), cb)];
    let bytes = b.build(bl);
    let (_, h) = instance(&mut r.core, &bytes, r.skel, &binds);
    let mut n = 0;
    for _ in 0..20 {
        frame(&mut r.core, DT);
        n += track_records(&r.core, h)
            .iter()
            .filter(|(op, _)| *op == anim_wire::tracks::Event::OPCODE)
            .count();
    }
    n
}

#[test]
fn notifies_fire_only_past_their_weight_threshold() {
    assert_eq!(events_fired(0.3, None), 1, "weight 0.7 > 0.5");
    assert_eq!(events_fired(0.7, None), 0, "weight 0.3");
    assert_eq!(events_fired(0.0, Some(0.0)), 0, "a gate of 0 mutes");
    assert_eq!(events_fired(0.4, Some(0.5)), 0, "0.6 × 0.5 = 0.3");
}

fn one_node(r: &mut Rig, build: impl FnOnce(&mut Builder) -> u32) -> u32 {
    let mut b = Builder::new();
    let out = build(&mut b);
    let ca = r.clip(ClipSpec::new(1.0, true, 1));
    let cb = r.clip(ClipSpec::new(1.0, true, 2));
    let binds = vec![(b.s("a"), ca), (b.s("b"), cb)];
    let bytes = b.build(out);
    instance(&mut r.core, &bytes, r.skel, &binds).1
}

#[test]
fn blend_by_enum_and_bool() {
    let mut r = rig();
    let mut e = 0;
    let mut bo = 0;
    let h = one_node(&mut r, |b| {
        e = b.param("e", ParamValue::Int(0));
        let pa = b.player("a");
        let pb = b.player("b");
        b.node(
            family::MIXING,
            mixing::kind::BLEND_ENUM,
            &[pa, pb, pa],
            &[e, 0],
        )
    });
    // References: the same clips as `one_node` binds, loaded again.
    let ra = r.clip(ClipSpec::new(1.0, true, 1));
    let rb = r.clip(ClipSpec::new(1.0, true, 2));
    let ca_ref = r.reference(ra, 0.0);
    let cb_ref = r.reference(rb, 0.0);
    send(&mut r.core, &[set_int(h, e, 1)]);
    r.core.evaluate(0, 0, 0.0, 0.0);
    assert!(diff(&r.mats(h), &cb_ref) < 1e-6);
    send(&mut r.core, &[set_int(h, e, 7)]);
    r.core.evaluate(0, 0, 0.0, 0.0);
    assert!(
        diff(&r.mats(h), &ca_ref) < 1e-6,
        "out of range: the last input"
    );
    let h2 = one_node(&mut r, |b| {
        bo = b.param("b", ParamValue::Bool(false));
        let pa = b.player("a");
        let pb = b.player("b");
        b.node(
            family::MIXING,
            mixing::kind::BLEND_BOOL,
            &[pa, pb],
            &[bo, 0.1f32.to_bits()],
        )
    });
    send(&mut r.core, &[debug_on(h2), set_bool(h2, bo, true)]);
    r.core.evaluate(0, 0, DT, DT);
    let rep = report(&mut r.core, h2);
    // A 0.1 s blend: one frame in, b (node 1) at 1/3, a (node 0) at 2/3.
    assert!((rep.weight(1) - 1.0 / 3.0).abs() < 1e-5, "{rep:?}");
    assert!((rep.weight(0) - 2.0 / 3.0).abs() < 1e-5, "{rep:?}");
}

#[test]
fn additive_with_a_reference_pose_rebuilds_the_source() {
    let mut r = rig();
    let mut ref_node = 0;
    let h = one_node(&mut r, |b| {
        let base = b.node(family::SOURCES, sources::kind::REFERENCE_POSE, &[], &[0]);
        let pa = b.player("a");
        ref_node = b.node(family::SOURCES, sources::kind::REFERENCE_POSE, &[], &[0]);
        b.node(
            family::MIXING,
            mixing::kind::ADDITIVE,
            &[base, pa, ref_node],
            &[1.0f32.to_bits(), NONE],
        )
    });
    r.core.evaluate(0, 0, 0.0, 0.0);
    let ra = r.clip(ClipSpec::new(1.0, true, 1));
    let want = r.reference(ra, 0.0);
    assert!(diff(&r.mats(h), &want) < 1e-4, "rest + (a − rest) = a");
}

#[test]
fn reference_and_bind_poses_skin_to_identity() {
    let mut r = rig();
    for kind in [sources::kind::REFERENCE_POSE, sources::kind::BIND_POSE] {
        let h = one_node(&mut r, |b| b.node(family::SOURCES, kind, &[], &[0]));
        r.core.evaluate(0, 0, DT, DT);
        let m = r.mats(h);
        for bone in m.chunks(12) {
            let id = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0];
            assert!(diff(bone, &id) < 1e-4, "kind {kind}: {bone:?}");
        }
    }
}

#[test]
fn time_scale_advances_its_child_faster() {
    let mut r = rig();
    let h = one_node(&mut r, |b| {
        let pa = b.player("a");
        b.node(
            family::MIXING,
            mixing::kind::TIME_SCALE,
            &[pa],
            &[2.0f32.to_bits(), NONE],
        )
    });
    for _ in 0..3 {
        frame(&mut r.core, DT);
    }
    let ra = r.clip(ClipSpec::new(1.0, true, 1));
    let want = r.reference(ra, 6.0 * DT);
    assert!(diff(&r.mats(h), &want) < 1e-5);
    assert!(
        (root(&r.core, h)[2] - 2.0 * DT).abs() < 1e-5,
        "root motion at the scaled rate"
    );
}

#[test]
fn mirror_reflects_pose_and_root_motion_and_is_its_own_inverse() {
    let mut r = rig();
    let partners: Vec<u32> = (0..6).collect();
    let mut words = vec![2u32, NONE];
    words.extend_from_slice(&partners);
    let w2 = words.clone();
    let h = one_node(&mut r, |b| {
        let pa = b.player("a");
        let m1 = b.node(family::MIXING, mixing::kind::MIRROR, &[pa], &words);
        b.node(family::MIXING, mixing::kind::MIRROR, &[m1], &w2)
    });
    let words3 = {
        let mut w = vec![2u32, NONE];
        w.extend_from_slice(&partners);
        w
    };
    let h1 = one_node(&mut r, |b| {
        let pa = b.player("a");
        b.node(family::MIXING, mixing::kind::MIRROR, &[pa], &words3)
    });
    frame(&mut r.core, DT);
    let ra = r.clip(ClipSpec::new(1.0, true, 1));
    let want = r.reference(ra, DT);
    assert!(diff(&r.mats(h), &want) < 1e-6, "mirrored twice");
    assert!(diff(&r.mats(h1), &want) > 1e-3, "mirrored once differs");
    assert!(
        (root(&r.core, h1)[2] + DT).abs() < 1e-5,
        "z root motion reflected: {:?}",
        root(&r.core, h1)
    );
}

#[test]
fn pose_snapshot_holds_a_captured_pose() {
    let mut r = rig();
    let mut s = 0;
    let mut snap = 0;
    let h = one_node(&mut r, |b| {
        s = b.param("s", ParamValue::Float(0.0));
        let pa = b.player("a");
        snap = b.node(family::SOURCES, sources::kind::POSE_SNAPSHOT, &[], &[1]);
        b.node(family::MIXING, mixing::kind::BLEND2, &[pa, snap], &[0, s])
    });
    for _ in 0..4 {
        frame(&mut r.core, DT);
    }
    let held = r.mats(h);
    send(
        &mut r.core,
        &[CapturePose {
            instance: h,
            node: snap,
        }
        .encode()],
    );
    assert!(refused(&r.core).is_empty());
    send(&mut r.core, &[set_float(h, s, 1.0)]);
    for _ in 0..5 {
        r.core.evaluate(0, 0, DT, DT);
        assert!(diff(&r.mats(h), &held) < 1e-6);
        r.core.write_inputs(0);
    }
    send(
        &mut r.core,
        &[CapturePose {
            instance: h,
            node: 0,
        }
        .encode()],
    );
    assert_eq!(refused(&r.core)[0].status, STATUS_NO_SUCH);
}

#[test]
fn parameters_through_the_blackboard_view() {
    let mut r = rig();
    let mut b = Builder::new();
    let go = b.param("go", ParamValue::Float(0.0));
    let n = b.param("n", ParamValue::Int(0));
    let c = b.cond(&[
        CondNode::All(2),
        cmp_f(go, CmpOp::Ge, 0.5),
        CondNode::Compare {
            operand: Operand::Param(n),
            op: CmpOp::Eq,
            value: 3,
        },
    ]);
    let m = three_state_machine(&mut b, &[vec![tr(1, c, When::Now, How::Cut)]]);
    let binds = clips3(&mut r, &mut b);
    let bytes = b.build(m.node);
    let (_, h) = instance(&mut r.core, &bytes, r.skel, &binds);
    let row = (h & 0xFFFF) as usize * (BLACKBOARD_STRIDE / 4) as usize;
    let v = (BLACKBOARD_VALUES / 4) as usize;
    {
        let bb = r.core.blackboard_mut();
        bb[row + v] = 0.75f32.to_bits();
        bb[row + v + 4] = 3;
        bb[row] = 0b10; // only n is dirty: go stays 0
    }
    frame(&mut r.core, DT);
    assert!(!entered(&graph_changes(&r.core), 0, 1));
    assert_eq!(r.core.blackboard_mut()[row], 0, "masks cleared");
    {
        let bb = r.core.blackboard_mut();
        bb[row + v] = f32::NAN.to_bits();
        bb[row] = 0b01;
    }
    frame(&mut r.core, DT);
    assert!(!entered(&graph_changes(&r.core), 0, 1), "a NaN is skipped");
    {
        let bb = r.core.blackboard_mut();
        bb[row + v] = 0.75f32.to_bits();
        bb[row] = 0b01;
    }
    frame(&mut r.core, DT);
    assert!(entered(&graph_changes(&r.core), 0, 1));
    // SET_PARAM with the wrong type is refused.
    send(&mut r.core, &[set_int(h, go, 1)]);
    assert_eq!(refused(&r.core)[0].status, STATUS_NO_SUCH);
}

#[test]
fn graph_commands_refuse_implicit_instances() {
    let mut r = rig();
    let h = r.core.create_instance(0, r.skel, 0);
    send(&mut r.core, &[set_float(h, 0, 1.0), travel(h, 0, 0)]);
    let rf = refused(&r.core);
    assert_eq!(rf.len(), 2);
    assert!(rf
        .iter()
        .all(|c| c.status == anim_wire::core::STATUS_MISMATCH));
}

#[test]
fn curve_and_state_time_operands() {
    let mut r = rig();
    let mut b = Builder::new();
    let name = b.s("lean");
    let c = b.cond(&[CondNode::Compare {
        operand: Operand::Curve(name),
        op: CmpOp::Ge,
        value: 0.5f32.to_bits(),
    }]);
    let ct = b.cond(&[CondNode::Compare {
        operand: Operand::StateTime,
        op: CmpOp::Ge,
        value: 0.2f32.to_bits(),
    }]);
    let m = three_state_machine(
        &mut b,
        &[
            vec![tr(1, c, When::Now, How::Cut)],
            vec![tr(2, ct, When::Now, How::Cut)],
        ],
    );
    let mut spec = ClipSpec::new(1.0, true, 1);
    spec.curve = Some(("lean", 1.0));
    let ca = r.clip(spec);
    let cb = r.clip(ClipSpec::new(1.0, true, 2));
    let cc = r.clip(ClipSpec::new(1.0, true, 3));
    let binds = vec![(b.s("a"), ca), (b.s("b"), cb), (b.s("c"), cc)];
    let bytes = b.build(m.node);
    instance(&mut r.core, &bytes, r.skel, &binds);
    // The curve reaches 0.5 at 0.5 s.
    let f = frames_until(&mut r.core, 0, 1, 30).unwrap();
    assert!((15..=16).contains(&f), "frame {f}");
    let f = frames_until(&mut r.core, 0, 2, 30).unwrap();
    assert!((6..=7).contains(&f), "0.2 s in B: frame {f}");
}

/// The locomotion graph's clips over `r`'s skeleton, bound: (binds, shot clip).
fn loco_clips(r: &mut Rig, ids: &Loco) -> (Vec<(u32, u32)>, u32) {
    let mut idle = ClipSpec::new(1.0, true, 31);
    idle.speed = 0.0;
    idle.sync = vec![("L", 0.0), ("R", 0.5)];
    let mut walk = ClipSpec::new(1.0, true, 32);
    walk.speed = 1.4;
    walk.sync = vec![("L", 0.05), ("R", 0.55)];
    let mut run = ClipSpec::new(0.7, true, 33);
    run.speed = 3.5;
    run.sync = vec![("L", 0.0), ("R", 0.35)];
    let ci = r.clip(idle);
    let cw = r.clip(walk);
    let cr = r.clip(run);
    let shot = r.clip(ClipSpec::new(1.0, false, 34));
    let weights: Vec<f32> = (0..r.bones)
        .map(|i| if i >= 3 { 1.0 } else { 0.0 })
        .collect();
    let mask = r.core.load_mask(&weights);
    (
        vec![
            (ids.idle, ci),
            (ids.walk, cw),
            (ids.run, cr),
            (ids.upper, mask),
        ],
        shot,
    )
}

#[test]
fn snapshot_and_restore_are_exact_through_transitions_and_inertialization() {
    let mut r = rig();
    let mut b = Builder::new();
    let ids = locomotion(&mut b);
    let (binds, shot) = loco_clips(&mut r, &ids);
    let bytes = b.build(ids.output);
    let (_, h) = instance(&mut r.core, &bytes, r.skel, &binds);
    type Frame = (Vec<f32>, [f32; 7], Vec<GraphChange>);
    let run = |r: &mut Rig, from: usize, to: usize| -> Vec<Frame> {
        (from..to)
            .map(|f| {
                let cmds = loco_script(h, &ids, f, shot);
                send(&mut r.core, &cmds);
                r.core.evaluate(0, 0, DT, DT);
                (r.mats(h), root(&r.core, h), graph_changes(&r.core))
            })
            .collect()
    };
    let before = run(&mut r, 0, 21);
    // The jump (frame 20) inertializes: the snapshot is taken mid-decay, mid-slot, mid-fade.
    assert!(before.iter().any(|f| f
        .2
        .iter()
        .any(|c| c.kind == GRAPH_STATE_ENTERED && c.value == 2)));
    let snap_len = r.core.snapshot_bytes(h) as usize;
    let mut snap = vec![0u8; snap_len];
    assert_eq!(r.core.snapshot(h, &mut snap), 0);
    let first = run(&mut r, 21, 50);
    assert!(
        first.iter().any(|f| f
            .2
            .iter()
            .any(|c| c.kind == GRAPH_STATE_ENTERED && c.value == 0)),
        "the replay crosses the jump's exit and the stop's inertialization"
    );
    assert_eq!(r.core.restore(h, &snap), 0);
    let second = run(&mut r, 21, 50);
    for (i, (a, b)) in first.iter().zip(&second).enumerate() {
        assert_eq!(a.0, b.0, "matrices, frame {}", 21 + i);
        assert_eq!(a.1, b.1, "root, frame {}", 21 + i);
        assert_eq!(a.2, b.2, "state changes, frame {}", 21 + i);
    }
}
