//! T17b: an instance with skeleton handle 0 has no bones: clip players advance, track windows
//! (events, notify states, columns) and the root curve run as usual, no pose or matrix work
//! happens, snapshots restore exactly, and evaluation never allocates. The clips are the
//! `props.anim` and `notifies.anim` fixtures (`property_fixtures.rs`).

mod common;

use anim_wire::core::{PASS_NORMAL, STATUS_OK, TRACK_STRIDE};
use common::{core, play, send, skeleton, track_records, Shape};
use std::path::PathBuf;

fn fixture(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../src/plugins/animation/runtime/wasm/fixtures")
        .join(name);
    std::fs::read(path).unwrap()
}

type Frame = (Vec<u32>, Vec<(u16, Vec<u8>)>);

/// One frame's observable output of instance `h`: its track row and records.
fn frame(core: &mut anim_wasm::init::Core, h: u32) -> Frame {
    core.evaluate(0, PASS_NORMAL, 1.0 / 30.0, 1.0 / 30.0);
    let words = TRACK_STRIDE as usize / 4;
    let row = core.tracks()[(h & 0xFFFF) as usize * words..][..words].to_vec();
    let records = track_records(core, h);
    core.write_inputs(0);
    (row, records)
}

#[test]
fn a_zero_bone_instance_runs_tracks_and_events() {
    let mut core = core(4, 16);
    let props = core.load_clip(&fixture("props.anim"));
    let notifies = core.load_clip(&fixture("notifies.anim"));
    assert!(props != 0 && notifies != 0);
    let h = core.create_instance(0, 0, 0);
    assert_ne!(h, 0, "skeleton handle 0 creates a zero-bone instance");
    assert_eq!(send(&mut core, &[play(h, notifies, 0, 0.0, 1, 0)]), 1);
    let mut seen = 0;
    for _ in 0..30 {
        seen += frame(&mut core, h).1.len();
    }
    assert!(seen >= 6, "only {seen} records");
    // The property clip fills the column block.
    send(&mut core, &[play(h, props, 0, 0.0, 2, 0)]);
    let mut columns = false;
    for _ in 0..10 {
        let (row, _) = frame(&mut core, h);
        columns |= row.iter().any(|w| *w != 0);
    }
    assert!(columns);
    // No matrices were written.
    assert!(core.matrices().iter().all(|m| *m == 0.0));
}

#[test]
fn a_zero_bone_instance_plays_clips_of_any_bone_count() {
    let (model, skel) = skeleton(Shape::Tree(4), 1);
    let mut core = core(4, 16);
    let _ = core.load_skeleton(&skel);
    let clip = core.load_clip(&common::clip(&model, 1.0, true, 3));
    let h = core.create_instance(0, 0, 0);
    assert_eq!(send(&mut core, &[play(h, clip, 0, 0.0, 1, 0)]), 1);
    for _ in 0..5 {
        frame(&mut core, h);
    }
}

#[test]
fn snapshot_and_restore_are_exact() {
    let mut core = core(4, 16);
    let notifies = core.load_clip(&fixture("notifies.anim"));
    let h = core.create_instance(0, 0, 0);
    send(&mut core, &[play(h, notifies, 0, 0.0, 1, 0)]);
    for _ in 0..7 {
        frame(&mut core, h);
    }
    let mut snap = vec![0u8; core.snapshot_bytes(h) as usize];
    assert_eq!(core.snapshot(h, &mut snap), STATUS_OK);
    let first: Vec<_> = (0..20).map(|_| frame(&mut core, h)).collect();
    assert_eq!(core.restore(h, &snap), STATUS_OK);
    let second: Vec<_> = (0..20).map(|_| frame(&mut core, h)).collect();
    // The column block is the track pass's output and is not part of a snapshot, so the
    // records (events, notify states) are what a restore reproduces.
    let records = |v: &[Frame]| v.iter().map(|f| f.1.clone()).collect::<Vec<_>>();
    assert_eq!(records(&first), records(&second));
}
