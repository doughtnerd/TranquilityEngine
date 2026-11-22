//! The runtime retarget never allocates: a counting global allocator sees no allocation while it
//! runs (with root scaling and the pinning pass), after the map and scratch are built.

mod common;

use anim_retarget::{MapSettings, Profile, RetargetMap, RetargetOptions, RootAxis};
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
fn retarget_does_not_allocate() {
    let src = humanoid(Build {
        axes: Axes::YAlong,
        ..Build::default()
    });
    let tgt = humanoid(Build {
        axes: Axes::XAlong,
        leg: 1.3,
        arm_drop: 0.6,
        spine: 5,
        ..Build::default()
    });
    let p = Profile::humanoid();
    let map = RetargetMap::new(src.side(&p), tgt.side(&p), &MapSettings::default()).unwrap();
    let mut scratch = map.scratch();
    let poses: Vec<_> = (0..8)
        .map(|s| soa(&random_pose(&src, &mut Rng::new(s), 1.0)))
        .collect();
    let mut out = soa(&tgt.rest);
    let weights = [1.0, 0.5, 1.0, 1.0];
    let opts = RetargetOptions {
        root_axes: [RootAxis::Scaled, RootAxis::Unscaled, RootAxis::Locked],
        ik_weights: &weights,
    };
    let before = ALLOCS.load(Ordering::SeqCst);
    for pose in &poses {
        map.retarget(pose, &opts, &mut scratch, &mut out).unwrap();
    }
    let after = ALLOCS.load(Ordering::SeqCst);
    assert_eq!(after - before, 0, "retarget allocated");
}
