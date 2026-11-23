//! `write_inputs`, `evaluate` and `debug_write` never allocate with graph assets (ADR 0370, T31):
//! a counting global allocator sees no allocation across frames that run state machines (cross-
//! fades, inertialization, a request through an any-state transition, travel, jump), a 2D blend
//! space with glide, sync and speed scaling, a masked slot with sections, a linked-graph swap, the
//! random selector, blackboard rows, and debug reports, after setup.

mod common;

use anim_format::graph::{family, ParamValue};
use anim_graph::logic;
use anim_wire::graph::{Link, BLACKBOARD_STRIDE, BLACKBOARD_VALUES};
use anim_wire::WireRecord;
use common::graph::*;
use common::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Counting;
static ALLOCS: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::SeqCst);
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

#[test]
fn graph_frames_do_not_allocate() {
    let (model, skel_bytes) = skeleton(Shape::Humanoid, 5);
    let mut core = core(16, 64);
    let s = core.load_skeleton(&skel_bytes);
    let mut b = Builder::new();
    let ids = locomotion(&mut b);
    // A linked-graph slot and a random selector beside it, layered by a blend.
    let (ln, li) = b.linked("Weapon", None, [4096, 1024, 4, 8]);
    let ps: Vec<u32> = (0..3).map(|_| b.player("idle")).collect();
    let sel = b.node(
        family::LOGIC,
        logic::kind::RANDOM,
        &ps,
        &[logic::RANDOM_SHUFFLE, 1],
    );
    let w = b.param("w", ParamValue::Float(0.3));
    let side = b.node(
        family::MIXING,
        anim_graph::mixing::kind::BLEND2,
        &[ln, sel],
        &[0, w],
    );
    let out = b.node(
        family::MIXING,
        anim_graph::mixing::kind::BLEND2,
        &[ids.output, side],
        &[0.25f32.to_bits(), anim_format::NONE],
    );
    let bytes = b.build(out);
    let clip = |seed: u64, speed: f64, looping: bool| {
        let mut spec = ClipSpec::new(1.0, looping, seed);
        spec.speed = speed;
        spec.sync = vec![("L", 0.0), ("R", 0.5)];
        spec.events = vec![(0.3, 0.5)];
        raw_clip(&model, &spec)
    };
    let ci = core.load_clip(&clip(1, 0.0, true));
    let cw = core.load_clip(&clip(2, 1.4, true));
    let cr = core.load_clip(&clip(3, 3.5, true));
    let shot = core.load_clip(&clip(4, 0.0, false));
    let weights: Vec<f32> = (0..model.bones.len())
        .map(|i| (i >= 10) as u32 as f32)
        .collect();
    let mask = core.load_mask(&weights);
    let mut lb = Builder::new();
    let lp = lb.player("run");
    let linked_bytes = lb.build(lp);
    let lg = core.load_graph(&linked_bytes);
    core.graph_bind(lg, lb.s("run"), cr);
    let binds = [
        (ids.idle, ci),
        (ids.walk, cw),
        (ids.run, cr),
        (ids.upper, mask),
    ];
    let (g, h0) = instance(&mut core, &bytes, s, &binds);
    let hs: Vec<u32> = std::iter::once(h0)
        .chain((0..5).map(|_| core.create_instance(0, s, g)))
        .collect();
    // Commands per frame, encoded before counting.
    let mut scripts: Vec<Vec<u8>> = Vec::new();
    for f in 0..90 {
        let mut buf = Vec::new();
        for (k, &h) in hs.iter().enumerate() {
            for c in loco_script(h, &ids, (f + 3 * k) % 45, shot) {
                buf.extend_from_slice(&c);
            }
        }
        match f {
            5 => buf.extend(debug_on(hs[0])),
            10 => buf.extend(
                Link {
                    instance: hs[0],
                    linked: li,
                    graph: lg,
                }
                .encode(),
            ),
            30 => buf.extend(jump(hs[1], 0, 1)),
            40 => buf.extend(travel(hs[2], 0, 0)),
            50 => buf.extend(seed(hs[3], 99)),
            60 => buf.extend(
                Link {
                    instance: hs[0],
                    linked: li,
                    graph: 0,
                }
                .encode(),
            ),
            _ => {}
        }
        scripts.push(buf);
    }
    let row = (hs[4] & 0xFFFF) as usize * (BLACKBOARD_STRIDE / 4) as usize;
    let v = (BLACKBOARD_VALUES / 4) as usize;

    let before = ALLOCS.load(Ordering::SeqCst);
    let mut changes = 0;
    let mut graph_changes = 0;
    let mut debug = 0;
    for (f, script) in scripts.iter().enumerate() {
        core.commands_mut()[..script.len()].copy_from_slice(script);
        if f % 7 == 0 {
            let bb = core.blackboard_mut();
            bb[row + v] = (f as f32 * 0.01).to_bits();
            bb[row] = 1;
        }
        core.write_inputs(script.len() as u32);
        changes += core.evaluate(0, anim_wire::core::PASS_NORMAL, 1.0 / 60.0, 1.0 / 60.0);
        graph_changes += core.graph_changes().len();
        debug += core.debug_write(hs[0]) as usize;
    }
    assert_eq!(ALLOCS.load(Ordering::SeqCst), before);
    let _ = changes;
    assert!(graph_changes > 0, "graph state changes were reported");
    assert!(debug > 0, "debug reports were written");
}
