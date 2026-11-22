//! A drive step and the bodies → local conversion never allocate: a counting global allocator
//! sees nothing across steps after setup (one test in this binary, so no other thread allocates).

use anim_math::layout::{local_to_model, pack_pose, soa_len, NO_PARENT};
use anim_math::{AosQuat, AosTransform, AosVec3, SoaTransform};
use anim_physics::pose::{bodies_to_local, body_from_bone};
use anim_physics::{Drive, DriveInput, Ragdoll, RagdollDesc, NO_BONE};
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

const PARENTS: [u16; 6] = [NO_PARENT, 0, 1, 2, 1, 4];

fn pose(k: f32) -> Vec<SoaTransform> {
    let p: Vec<AosTransform> = (0..PARENTS.len())
        .map(|i| {
            let a = 0.1 * k + 0.05 * i as f32;
            AosTransform::new(
                AosVec3::new(0.0, 0.2, 0.0),
                AosQuat::new(a.sin() * 0.5, 0.0, 0.0, 1.0).normalize_or_identity(),
                AosVec3::one(),
            )
        })
        .collect();
    let mut s = vec![SoaTransform::identity(); soa_len(p.len())];
    pack_pose(&p, &mut s);
    s
}

#[test]
fn steps_do_not_allocate() {
    let rd = Ragdoll::new(RagdollDesc::from_skeleton(&PARENTS, &[], NO_BONE), &PARENTS).unwrap();
    let (now, prev) = (pose(1.0), pose(0.0));
    let mut scratch = rd.scratch();
    let mut out = vec![Drive::default(); PARENTS.len()];
    let mut local = pose(2.0);
    let mut model = vec![AosTransform::identity(); PARENTS.len()];
    local_to_model(&PARENTS, &now, &mut model);
    let bodies = model.clone();
    let before = ALLOCS.load(Ordering::SeqCst);
    for _ in 0..10 {
        let input = DriveInput {
            now: &now,
            prev: Some(&prev),
            dt: 1.0 / 60.0,
            strength: 1.0,
            pin: 1.0,
            multipliers: &[],
        };
        rd.drive(&input, &mut scratch, &mut out).unwrap();
        bodies_to_local(
            &PARENTS,
            |b| Some(body_from_bone(&bodies[b], AosQuat::identity())),
            &mut local,
            &mut model,
        );
    }
    assert_eq!(ALLOCS.load(Ordering::SeqCst), before);
}
