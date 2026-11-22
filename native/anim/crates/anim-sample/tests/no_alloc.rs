//! Sampling never allocates: a counting global allocator sees no allocation while poses and
//! property tracks are sampled (after setup).

#[path = "../../anim-compress/tests/common/mod.rs"]
mod common;

use anim_compress::{compress, Settings};
use anim_format::clip::ClipView;
use anim_math::layout::soa_len;
use anim_math::{AosQuat, AosTransform, AosVec3, SoaTransform};
use anim_sample::{ClipSampler, Form, SegmentCache};
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
fn sampling_does_not_allocate() {
    let mut rng = Rng::new(3);
    let skel = skeleton(Shape::Humanoid, &mut rng);
    let clip = clip(&skel, 2.0, true, &mut rng);
    let settings = Settings {
        keep_raw: true,
        ..Settings::default()
    };
    let bytes = compress(&clip, Some(&skel), &settings).unwrap().bytes;
    let view = ClipView::parse(&bytes).unwrap();
    let rest: Vec<AosTransform> = skel
        .bones
        .iter()
        .map(|b| {
            let [tx, ty, tz] = b.translation;
            let [x, y, z, w] = b.rotation;
            AosTransform::new(
                AosVec3::new(tx, ty, tz),
                AosQuat::new(x, y, z, w),
                AosVec3::one(),
            )
        })
        .collect();
    let comp = ClipSampler::new(view, Form::Compressed).unwrap();
    let raw = ClipSampler::new(view, Form::Raw).unwrap();
    let mut scratch = vec![AosTransform::default(); comp.scratch_len()];
    let mut out = vec![SoaTransform::default(); soa_len(rest.len())];
    let mut mem = vec![0.0f32; comp.cache_len()];
    let mut cache = SegmentCache::new(&mut mem);

    let before = ALLOCS.load(Ordering::SeqCst);
    let mut t = 0.0f32;
    while t < 2.0 {
        comp.sample_pose(t, &rest, &mut scratch, &mut out, Some(&mut cache))
            .unwrap();
        comp.sample_pose(t, &rest, &mut scratch, &mut out, None)
            .unwrap();
        raw.sample_pose(t, &rest, &mut scratch, &mut out, None)
            .unwrap();
        t += 0.013;
    }
    assert_eq!(ALLOCS.load(Ordering::SeqCst), before);
}
