//! Damaged graphs and snapshots through the core's calls: a graph whose machine, chooser, slot or
//! linked-graph table names a node of another kind is refused at load, and a snapshot whose state
//! words the graph can't run is refused at restore. Neither may trap the shared core (a panic
//! here is the trap in the wasm build). The graph cases are the shapes fuzzing found.

mod common;

use anim_format::graph::{family, AnimGraph};
use anim_format::skeleton::Skeleton;
use anim_graph::{logic, slots};
use anim_wasm::init::Core;
use anim_wire::core::{STATUS_BAD_ASSET, STATUS_BAD_RECORD, STATUS_OK};
use common::graph::*;
use common::*;

const DT: f32 = 1.0 / 30.0;
/// The snapshot header's words (the state follows; its length is header word 4).
const HEADER_WORDS: usize = 12;

struct Rig {
    core: Core,
    model: Skeleton,
    skel: u32,
    bones: usize,
}

fn rig() -> Rig {
    let (model, bytes) = skeleton(Shape::Chain(6), 3);
    let mut core = core(8, 16);
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

    /// The locomotion graph's clip and mask bindings, and a one-shot clip for its slot.
    fn loco_assets(&mut self, ids: &Loco) -> (Vec<(u32, u32)>, u32) {
        let mut idle = ClipSpec::new(1.0, true, 31);
        idle.speed = 0.0;
        idle.sync = vec![("L", 0.0), ("R", 0.5)];
        let mut walk = ClipSpec::new(1.0, true, 32);
        walk.speed = 1.4;
        walk.sync = vec![("L", 0.05), ("R", 0.55)];
        let mut run = ClipSpec::new(0.7, true, 33);
        run.speed = 3.5;
        run.sync = vec![("L", 0.0), ("R", 0.35)];
        let ci = self.clip(idle);
        let cw = self.clip(walk);
        let cr = self.clip(run);
        let shot = self.clip(ClipSpec::new(1.0, false, 34));
        let weights: Vec<f32> = (0..self.bones)
            .map(|i| if i >= 3 { 1.0 } else { 0.0 })
            .collect();
        let mask = self.core.load_mask(&weights);
        let binds = vec![
            (ids.idle, ci),
            (ids.walk, cw),
            (ids.run, cr),
            (ids.upper, mask),
        ];
        (binds, shot)
    }

    /// Runs frames `from..to` of the locomotion script (the slot plays at frame 14).
    fn frames(&mut self, h: u32, ids: &Loco, shot: u32, from: usize, to: usize) {
        for f in from..to {
            send(&mut self.core, &loco_script(h, ids, f, shot));
            self.core.evaluate(0, 0, DT, DT);
        }
    }

    fn snapshot(&mut self, h: u32) -> Vec<u8> {
        let mut snap = vec![0u8; self.core.snapshot_bytes(h) as usize];
        assert_eq!(self.core.snapshot(h, &mut snap), STATUS_OK);
        snap
    }
}

/// The locomotion graph (machine, blend space, slot) changed by `damage`.
fn locomotion_with(damage: impl FnOnce(&mut AnimGraph, &Loco)) -> (Vec<u8>, Loco) {
    let mut b = Builder::new();
    let ids = locomotion(&mut b);
    let mut g = b.g.clone();
    g.output = ids.output;
    damage(&mut g, &ids);
    (g.write().unwrap(), ids)
}

/// Loads `graph`; when it loads, runs the locomotion script over it, slot play included.
fn load_and_run(graph: &[u8], ids: &Loco) -> u32 {
    let mut r = rig();
    let (binds, shot) = r.loco_assets(ids);
    let g = r.core.load_graph(graph);
    if g != 0 {
        for &(id, asset) in &binds {
            r.core.graph_bind(g, id, asset);
        }
        let h = r.core.create_instance(0, r.skel, g);
        assert_ne!(h, 0, "instance ({})", r.core.last_status());
        r.frames(h, ids, shot, 0, 40);
    }
    g
}

fn assert_refused(graph: &[u8], ids: &Loco, what: &str) {
    let mut r = rig();
    assert_eq!(r.core.load_graph(graph), 0, "{what}: refused");
    assert_eq!(
        r.core.last_status(),
        STATUS_BAD_ASSET,
        "{what}: as a bad asset"
    );
    // And nothing traps if a caller goes on regardless.
    assert_eq!(load_and_run(graph, ids), 0);
}

#[test]
fn the_undamaged_graph_loads_and_runs() {
    let (graph, ids) = locomotion_with(|_, _| {});
    assert_ne!(load_and_run(&graph, &ids), 0);
}

#[test]
fn a_slot_entry_on_a_node_that_is_not_a_slot_is_refused() {
    // Fuzzing: the slot entry moved to the blend space, and to the state machine; the slot play
    // then wrote a slot's words into that node's (shorter) state and trapped.
    let (graph, ids) = locomotion_with(|g, ids| g.slots[0].node = ids.blend_space);
    assert_refused(&graph, &ids, "slot entry on a blend space");
    let (graph, ids) = locomotion_with(|g, ids| g.slots[0].node = ids.machine.node);
    assert_refused(&graph, &ids, "slot entry on the state machine");
    // Fuzzing: the slot node's family flipped (the entry stays).
    let (graph, ids) =
        locomotion_with(|g, ids| g.nodes[ids.slot as usize].family = family::MATCHING);
    assert_refused(&graph, &ids, "slot entry on a matching node");
    let (graph, ids) =
        locomotion_with(|g, ids| g.nodes[ids.slot as usize].kind = slots::kind::LINKED);
    assert_refused(&graph, &ids, "slot entry on a linked-graph node");
}

#[test]
fn a_machine_entry_on_a_logic_node_of_another_kind_is_refused() {
    let (graph, ids) = locomotion_with(|g, ids| {
        g.nodes[ids.machine.node as usize].kind = logic::kind::CHOOSER;
    });
    assert_refused(&graph, &ids, "machine entry on a chooser");
    let (graph, ids) = locomotion_with(|g, ids| {
        g.nodes[ids.machine.node as usize].kind = logic::kind::RANDOM;
    });
    assert_refused(&graph, &ids, "machine entry on a random selector");
}

#[test]
fn a_chooser_entry_on_a_node_of_another_kind_is_refused() {
    // A chooser whose table entry names the state machine (a logic node too).
    let (graph, ids) = locomotion_with(|g, ids| {
        g.choosers.push(anim_format::graph::Chooser {
            node: ids.machine.node,
            rows_first: 0,
            rows_count: 0,
            fallback: ids.blend_space,
        });
    });
    assert_refused(&graph, &ids, "chooser entry on the state machine");
}

#[test]
fn a_linked_graph_entry_on_a_node_of_another_kind_is_refused() {
    let (graph, ids) = locomotion_with(|g, ids| {
        let name = g.strings.len() as u32;
        g.strings.push("Linked".into());
        g.linked.push(anim_format::graph::LinkedGraph {
            name,
            node: ids.slot,
            default_graph: anim_format::NONE,
        });
    });
    assert_refused(&graph, &ids, "linked entry on the slot");
}

#[test]
fn two_entries_on_one_node_are_refused() {
    let (graph, ids) = locomotion_with(|g, _| {
        let again = g.slots[0];
        g.slots.push(again);
    });
    assert_refused(&graph, &ids, "two slot entries on one slot");
}

#[test]
fn a_damaged_snapshot_is_refused_and_never_traps() {
    // Every state word in turn, set to values that index past the graph's tables (and to a
    // count of 0): each restore either succeeds or is refused, the instance keeps running, and
    // a clean snapshot still restores afterwards.
    let (graph, ids) = locomotion_with(|_, _| {});
    let mut r = rig();
    let (binds, shot) = r.loco_assets(&ids);
    let (_, h) = instance(&mut r.core, &graph, r.skel, &binds);
    // Mid crossfade, with the slot playing (frame 14).
    r.frames(h, &ids, shot, 0, 16);
    let clean = r.snapshot(h);
    assert_eq!(r.core.restore(h, &clean), STATUS_OK);
    let word = |b: &[u8], i: usize| u32::from_le_bytes(b[4 * i..4 * i + 4].try_into().unwrap());
    let state_words = word(&clean, 4) as usize;
    let mut refused = 0;
    for i in HEADER_WORDS..HEADER_WORDS + state_words {
        for v in [anim_format::NONE - 1, 0x8000_0001, 154, 0] {
            let mut bad = clean.clone();
            bad[4 * i..4 * i + 4].copy_from_slice(&v.to_le_bytes());
            match r.core.restore(h, &bad) {
                STATUS_OK => {}
                STATUS_BAD_RECORD => refused += 1,
                s => panic!("word {i} = {v:#x}: status {s}"),
            }
            r.frames(h, &ids, shot, 16, 20);
            assert_eq!(
                r.core.restore(h, &clean),
                STATUS_OK,
                "word {i}: clean restores"
            );
        }
    }
    assert!(refused > 0, "some damage is refused");
}

#[test]
fn a_refused_snapshot_leaves_the_instance_as_it_was() {
    let (graph, ids) = locomotion_with(|_, _| {});
    let mut r = rig();
    let (binds, shot) = r.loco_assets(&ids);
    let (_, h) = instance(&mut r.core, &graph, r.skel, &binds);
    r.frames(h, &ids, shot, 0, 10);
    let before = r.snapshot(h);
    // Damage words until one is refused, then the instance's own snapshot is unchanged.
    let state_words = u32::from_le_bytes(before[16..20].try_into().unwrap()) as usize;
    let refused = (HEADER_WORDS..HEADER_WORDS + state_words).find_map(|i| {
        let mut bad = before.clone();
        bad[4 * i..4 * i + 4].copy_from_slice(&0x8000_0001u32.to_le_bytes());
        let status = r.core.restore(h, &bad);
        if status == STATUS_OK {
            assert_eq!(r.core.restore(h, &before), STATUS_OK);
        }
        (status == STATUS_BAD_RECORD).then_some(i)
    });
    assert!(refused.is_some(), "some damage is refused");
    assert_eq!(r.snapshot(h), before, "the instance is untouched");
}
