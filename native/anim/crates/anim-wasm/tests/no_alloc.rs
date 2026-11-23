//! `write_inputs` and `evaluate` never allocate (ADR 0370): a counting global allocator sees no
//! allocation across frames that play, crossfade, inertialize, layer, cull, interpolate (LOD),
//! fire track events and report state changes, after setup.

mod common;

use anim_wire::core::*;
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
fn frames_do_not_allocate() {
    let (skel_model, skel_bytes) = skeleton(Shape::Humanoid, 5);
    let a_bytes = clip_with_event(&skel_model, 1.0, true, 1, 0.3);
    let b_bytes = clip(&skel_model, 0.5, false, 2);
    let mut core = core(16, 64);
    let s = core.load_skeleton(&skel_bytes);
    let a = core.load_clip(&a_bytes);
    let b = core.load_clip(&b_bytes);
    let mask = core.load_mask(&vec![0.5; skel_model.bones.len()]);
    let hs: Vec<u32> = (0..6).map(|_| core.create_instance(0, s, 0)).collect();
    let commands: Vec<Vec<u8>> = vec![
        play(hs[0], a, 0, 0.0, 1, 0),
        play(hs[1], a, 0, 0.2, 2, 0),
        play(hs[2], a, 0, 0.0, 3, 0),
        play(hs[2], b, 1, 0.1, 4, PLAY_ONCE),
        set_layer(hs[2], 1, mask, 0),
        play(hs[3], b, 0, 0.0, 5, PLAY_ONCE),
        play(hs[4], a, 0, 0.0, 6, 0),
        play(hs[5], a, 0, 0.0, 7, 0),
    ];
    let switch: Vec<Vec<u8>> = vec![
        play(hs[0], b, 0, 0.3, 8, PLAY_INERTIALIZE),
        play(hs[1], b, 0, 0.3, 9, 0),
        stop(hs[2], 1, 0.2),
        play(hs[3], a, 0, 0.0, 10, 0),
    ];
    let mut buf = Vec::new();
    for c in commands.iter().chain(&switch) {
        buf.extend_from_slice(c);
    }
    let first = commands.iter().map(|c| c.len()).sum::<usize>();
    core.commands_mut()[..buf.len()].copy_from_slice(&buf);
    set_lod(&mut core, hs[4], 2);
    set_flags(&mut core, hs[5], CULL_ROOT_MOTION_ONLY);

    let before = ALLOCS.load(Ordering::SeqCst);
    let mut changes = 0;
    core.write_inputs(first as u32);
    for frame in 0..90 {
        if frame == 20 {
            // The switch commands sit after the first batch in the buffer.
            let n = buf.len() - first;
            core.commands_mut().copy_within(first..buf.len(), 0);
            core.write_inputs(n as u32);
        } else if frame > 0 {
            core.write_inputs(0);
        }
        changes += core.evaluate(0, PASS_NORMAL, 1.0 / 60.0, 1.0 / 60.0);
    }
    assert_eq!(ALLOCS.load(Ordering::SeqCst), before);
    assert!(changes > 0, "state changes were reported");
}
