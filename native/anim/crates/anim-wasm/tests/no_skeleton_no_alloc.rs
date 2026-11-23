//! T17b: evaluating zero-bone instances (skeleton handle 0) never allocates (a counting global
//! allocator sees nothing across frames that run property and event tracks).

mod common;

use anim_wire::core::PASS_NORMAL;
use common::{core, play, send};
use std::alloc::{GlobalAlloc, Layout, System};
use std::path::PathBuf;
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

fn fixture(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../src/plugins/animation/runtime/wasm/fixtures")
        .join(name);
    std::fs::read(path).unwrap()
}

#[test]
fn zero_bone_frames_do_not_allocate() {
    let mut core = core(4, 16);
    let props = core.load_clip(&fixture("props.anim"));
    let notifies = core.load_clip(&fixture("notifies.anim"));
    let h = core.create_instance(0, 0, 0);
    send(&mut core, &[play(h, notifies, 0, 0.0, 1, 0)]);
    send(&mut core, &[play(h, props, 1, 0.0, 2, 0)]);
    let before = ALLOCS.load(Ordering::SeqCst);
    for _ in 0..120 {
        core.evaluate(0, PASS_NORMAL, 1.0 / 30.0, 1.0 / 30.0);
        core.write_inputs(0);
    }
    assert_eq!(ALLOCS.load(Ordering::SeqCst), before);
}
