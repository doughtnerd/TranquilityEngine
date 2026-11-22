//! The core through its calls and views: loading assets, code-first play, crossfade and layers
//! through the implicit graph, a graph asset, LOD, culling, root motion, events, snapshot and
//! restore, stale handles and refused bytes.
//!
//! Tolerances against `anim-offline`: 1e-4 on bone-matrix entries. Both sides decode the same
//! compressed samples; the core is f32 (decode, nlerp, a chain of up to ~10 parent compositions
//! with offsets under 0.35 m per bone and up to two blends), the reference f64, so differences are
//! a few f32 ulps of values near 1 per operation: about 1e-6 to 1e-5 in practice.

mod common;

use anim_format::graph::{family, AnimGraph, Node};
use anim_format::NONE;
use anim_graph::mixing;
use anim_graph::sources;
use anim_wire::core::*;
use common::*;

const DT: f32 = 1.0 / 30.0;
const TOL: f64 = 1e-4;

struct Fixture {
    core: anim_wasm::init::Core,
    skel_bytes: Vec<u8>,
    bones: usize,
    skel: u32,
    a_bytes: Vec<u8>,
    b_bytes: Vec<u8>,
    a: u32,
    b: u32,
    reference: Reference,
}

const MAX_BONES: usize = 64;

fn fixture() -> Fixture {
    let (skel_model, skel_bytes) = skeleton(Shape::Tree(12), 7);
    let a_bytes = clip(&skel_model, 2.0, true, 11);
    let b_bytes = clip(&skel_model, 1.0, true, 12);
    let mut core = core(8, MAX_BONES as u32);
    let skel = core.load_skeleton(&skel_bytes);
    let a = core.load_clip(&a_bytes);
    let b = core.load_clip(&b_bytes);
    assert!(skel != 0 && a != 0 && b != 0, "status {}", core.last_status());
    Fixture {
        core,
        reference: Reference::new(&skel_bytes),
        skel_bytes,
        bones: skel_model.bones.len(),
        skel,
        a_bytes,
        b_bytes,
        a,
        b,
    }
}

fn step(f: &mut Fixture, frames: usize) {
    for _ in 0..frames {
        f.core.write_inputs(0);
        f.core.evaluate(0, PASS_NORMAL, DT, DT);
    }
}

fn mats(f: &Fixture, h: u32) -> Vec<f32> {
    matrices(&f.core, h, MAX_BONES, f.bones)
}

#[test]
fn play_matches_the_reference() {
    let mut f = fixture();
    let h = f.core.create_instance(0, f.skel, 0);
    assert_eq!(send(&mut f.core, &[play(h, f.a, 0, 0.0, 1, 0)]), 1);
    step(&mut f, 10);
    let expected = f.reference.matrices(&f.reference.sample(&f.a_bytes, 10.0 / 30.0));
    let d = max_diff(&mats(&f, h), &expected);
    assert!(d < TOL, "max difference {d}");
}

#[test]
fn an_instance_without_a_play_shows_the_rest_pose() {
    let mut f = fixture();
    let h = f.core.create_instance(0, f.skel, 0);
    step(&mut f, 1);
    let expected = f.reference.matrices(&f.reference.rest);
    assert!(max_diff(&mats(&f, h), &expected) < TOL);
}

#[test]
fn crossfade_blends_by_the_fade_and_reports_the_interrupted_play() {
    let mut f = fixture();
    let h = f.core.create_instance(0, f.skel, 0);
    send(&mut f.core, &[play(h, f.a, 0, 0.0, 1, 0)]);
    step(&mut f, 10);
    assert_eq!(send(&mut f.core, &[play(h, f.b, 0, 0.5, 2, 0)]), 1);
    let c = changes(&f.core);
    assert_eq!(c.len(), 1);
    assert_eq!((c[0].kind, c[0].play_id, c[0].instance), (CHANGE_INTERRUPTED, 1, h));
    f.core.evaluate(0, PASS_NORMAL, DT, DT);
    step(&mut f, 5);
    // 6 frames into the fade: B at 0.2 s, A at 16/30 s, B's weight 0.2 / 0.5.
    let pa = f.reference.sample(&f.a_bytes, 16.0 / 30.0);
    let pb = f.reference.sample(&f.b_bytes, 0.2);
    let blended = anim_offline::pose::lerp(&pa, &pb, 0.4);
    let d = max_diff(&mats(&f, h), &f.reference.matrices(&blended));
    assert!(d < TOL, "max difference {d}");
    // After the fade, B alone.
    step(&mut f, 15);
    let pb = f.reference.sample(&f.b_bytes, 0.7);
    let d = max_diff(&mats(&f, h), &f.reference.matrices(&pb));
    assert!(d < TOL, "max difference {d}");
}

#[test]
fn a_first_fade_fades_in_from_the_rest_pose() {
    let mut f = fixture();
    let h = f.core.create_instance(0, f.skel, 0);
    send(&mut f.core, &[play(h, f.a, 0, 0.3, 1, 0)]);
    step(&mut f, 3);
    let pa = f.reference.sample(&f.a_bytes, 0.1);
    let blended = anim_offline::pose::lerp(&f.reference.rest, &pa, 0.1 / 0.3);
    assert!(max_diff(&mats(&f, h), &f.reference.matrices(&blended)) < TOL);
}

#[test]
fn a_masked_layer_blends_its_bones_by_weight() {
    let mut f = fixture();
    let h = f.core.create_instance(0, f.skel, 0);
    let weights: Vec<f32> = (0..f.bones).map(|i| if i >= 4 { 1.0 } else { 0.0 }).collect();
    let mask = f.core.load_mask(&weights);
    assert_ne!(mask, 0);
    let n = send(
        &mut f.core,
        &[
            play(h, f.a, 0, 0.0, 1, 0),
            play(h, f.b, 1, 0.0, 2, 0),
            set_layer(h, 1, mask, 0),
        ],
    );
    assert_eq!(n, 3);
    set_layer_weight(&mut f.core, h, 1, 0.5);
    step(&mut f, 4);
    let t = 4.0 / 30.0;
    let base = f.reference.sample(&f.a_bytes, t);
    let over = f.reference.sample(&f.b_bytes, t);
    let w: Vec<f64> = weights.iter().map(|w| *w as f64).collect();
    let expected = anim_offline::pose::blend_masked(&base, &over, &w, 0.5);
    let d = max_diff(&mats(&f, h), &f.reference.matrices(&expected));
    assert!(d < TOL, "max difference {d}");
}

#[test]
fn a_zero_weight_layer_leaves_the_base_bit_for_bit() {
    let mut f = fixture();
    let h1 = f.core.create_instance(0, f.skel, 0);
    let h2 = f.core.create_instance(0, f.skel, 0);
    send(
        &mut f.core,
        &[
            play(h1, f.a, 0, 0.0, 0, 0),
            play(h2, f.a, 0, 0.0, 0, 0),
            play(h2, f.b, 1, 0.0, 0, 0),
        ],
    );
    set_layer_weight(&mut f.core, h2, 1, 0.0);
    step(&mut f, 5);
    assert_eq!(mats(&f, h1), mats(&f, h2));
}

#[test]
fn update_rate_lod_interpolates_between_the_last_two_poses() {
    let mut f = fixture();
    let full = f.core.create_instance(0, f.skel, 0);
    let lod = f.core.create_instance(0, f.skel, 0);
    send(&mut f.core, &[play(full, f.a, 0, 0.0, 0, 0), play(lod, f.a, 0, 0.0, 0, 0)]);
    set_lod(&mut f.core, lod, 2);
    step(&mut f, 1); // both evaluate t1
    assert_eq!(mats(&f, full), mats(&f, lod));
    step(&mut f, 1); // lod: not due, still t1
    let t1 = f.reference.sample(&f.a_bytes, DT as f64);
    assert!(max_diff(&mats(&f, lod), &f.reference.matrices(&t1)) < TOL);
    step(&mut f, 1); // lod: evaluates t3, shows halfway between t1 and t3
    let t3 = f.reference.sample(&f.a_bytes, 3.0 * DT as f64);
    let half = anim_offline::pose::lerp(&t1, &t3, 0.5);
    let d = max_diff(&mats(&f, lod), &f.reference.matrices(&half));
    assert!(d < TOL, "max difference {d}");
    step(&mut f, 1); // lod: shows t3
    let d = max_diff(&mats(&f, lod), &f.reference.matrices(&t3));
    assert!(d < TOL, "max difference {d}");
}

#[test]
fn snapshot_and_restore_give_identical_later_frames() {
    let mut f = fixture();
    let h = f.core.create_instance(0, f.skel, 0);
    send(&mut f.core, &[play(h, f.a, 0, 0.0, 1, 0), play(h, f.b, 1, 0.2, 2, 0)]);
    set_lod(&mut f.core, h, 2);
    set_layer_weight(&mut f.core, h, 1, 0.6);
    step(&mut f, 7);
    // An inertialized switch in progress, a fade on layer 1 and LOD history in the snapshot.
    send(&mut f.core, &[play(h, f.b, 0, 0.3, 3, PLAY_INERTIALIZE)]);
    f.core.evaluate(0, PASS_NORMAL, DT, DT);
    step(&mut f, 2);
    let n = f.core.snapshot_bytes(h) as usize;
    assert!(n > 0);
    let mut snap = vec![0u8; n];
    assert_eq!(f.core.snapshot(h, &mut snap), STATUS_OK);

    let record = |f: &mut Fixture| -> Vec<Vec<f32>> {
        (0..12)
            .map(|i| {
                f.core.write_inputs(0);
                f.core.evaluate(0, PASS_NORMAL, DT * (1.0 + i as f32 * 0.1), DT);
                [mats(f, h), root(&f.core, h).to_vec()].concat()
            })
            .collect()
    };
    let first = record(&mut f);
    assert_eq!(f.core.restore(h, &snap), STATUS_OK);
    let second = record(&mut f);
    assert_eq!(first, second, "identical after restore");

    // Into another instance of the same skeleton and graph: the same frames.
    let other = f.core.create_instance(0, f.skel, 0);
    assert_eq!(f.core.restore(other, &snap), STATUS_OK);
    set_lod(&mut f.core, other, 2);
    set_layer_weight(&mut f.core, other, 1, 0.6);
    assert_eq!(f.core.restore(h, &snap), STATUS_OK);
    let mut both = Vec::new();
    for i in 0..12 {
        f.core.write_inputs(0);
        f.core.evaluate(0, PASS_NORMAL, DT * (1.0 + i as f32 * 0.1), DT);
        both.push((mats(&f, h), mats(&f, other)));
    }
    for (i, (a, b)) in both.iter().enumerate() {
        assert_eq!(a, b, "frame {i}");
        assert_eq!(a, &first[i][..a.len()], "frame {i}");
    }

    // A snapshot of another skeleton is refused.
    let (other_skel, other_bytes) = skeleton(Shape::Chain(5), 3);
    let s2 = f.core.load_skeleton(&other_bytes);
    let h2 = f.core.create_instance(0, s2, 0);
    assert_eq!(f.core.restore(h2, &snap), STATUS_BAD_RECORD, "{}", other_skel.bones.len());
    snap[0] ^= 1;
    assert_eq!(f.core.restore(h, &snap), STATUS_BAD_RECORD);
}

#[test]
fn stale_handles_do_nothing() {
    let mut f = fixture();
    let h = f.core.create_instance(0, f.skel, 0);
    send(&mut f.core, &[play(h, f.a, 0, 0.0, 1, 0)]);
    step(&mut f, 3);
    let before = mats(&f, h);
    assert_eq!(f.core.destroy_instance(h), STATUS_OK);
    assert_eq!(f.core.destroy_instance(h), STATUS_STALE_HANDLE);
    assert_eq!(send(&mut f.core, &[play(h, f.a, 0, 0.0, 9, 0)]), 0);
    let c = changes(&f.core);
    assert_eq!((c[0].kind, c[0].play_id, c[0].status), (CHANGE_REFUSED, 9, STATUS_STALE_HANDLE));
    step(&mut f, 3);
    assert_eq!(mats(&f, h), before, "a destroyed instance's row is left alone");
    assert_eq!(f.core.snapshot_bytes(h), 0);
    assert_eq!(f.core.snapshot(h, &mut [0; 16]), STATUS_STALE_HANDLE);

    // A new instance reuses the slot with a new generation; the old handle stays stale.
    let h2 = f.core.create_instance(0, f.skel, 0);
    assert_eq!(h2 & 0xFFFF, h & 0xFFFF);
    assert_ne!(h2, h);
    assert_eq!(f.core.destroy_instance(h), STATUS_STALE_HANDLE);

    // Released assets: stale everywhere; a playing instance shows nothing for its clip.
    send(&mut f.core, &[play(h2, f.a, 0, 0.0, 0, 0)]);
    assert_eq!(f.core.release(f.a), STATUS_OK);
    assert_eq!(f.core.release(f.a), STATUS_STALE_HANDLE);
    step(&mut f, 1);
    let rest = f.reference.matrices(&f.reference.rest);
    assert!(max_diff(&mats(&f, h2), &rest) < TOL);
    assert_eq!(send(&mut f.core, &[play(h2, f.a, 0, 0.0, 4, 0)]), 0);
    assert_eq!(changes(&f.core)[0].status, STATUS_STALE_HANDLE);
    assert_eq!(f.core.create_instance(0, f.a, 0), 0);
    assert_eq!(f.core.last_status(), STATUS_STALE_HANDLE);
    assert_eq!(f.core.create_instance(0, f.b, 0), 0);
    assert_eq!(f.core.last_status(), STATUS_WRONG_KIND);
    let _ = &f.skel_bytes;
}

#[test]
fn bad_bytes_are_refused() {
    let mut f = fixture();
    assert_eq!(f.core.load_clip(&[0u8; 100]), 0);
    assert_eq!(f.core.last_status(), STATUS_BAD_ASSET);
    let skel_bytes = f.skel_bytes.clone();
    assert_eq!(f.core.load_clip(&skel_bytes), 0);
    assert_eq!(f.core.last_status(), STATUS_BAD_ASSET);
    assert_eq!(f.core.load_skeleton(&skel_bytes[..skel_bytes.len() - 8]), 0);
    assert_eq!(f.core.last_status(), STATUS_BAD_ASSET);
    let mut flipped = f.a_bytes.clone();
    flipped[40] ^= 0x55;
    assert_eq!(f.core.load_clip(&flipped), 0);
    assert_eq!(f.core.load_graph(&f.a_bytes.clone()), 0);
    assert_eq!(f.core.last_status(), STATUS_BAD_ASSET);
    // More bones than init allows.
    let (_, big) = skeleton(Shape::Chain(MAX_BONES + 1), 1);
    assert_eq!(f.core.load_skeleton(&big), 0);
    assert_eq!(f.core.last_status(), STATUS_TOO_LARGE);
    // A clip for another skeleton plays nowhere.
    let (small, small_bytes) = skeleton(Shape::Chain(3), 2);
    let s = f.core.load_skeleton(&small_bytes);
    let h = f.core.create_instance(0, s, 0);
    assert_eq!(send(&mut f.core, &[play(h, f.a, 0, 0.0, 5, 0)]), 0);
    assert_eq!(changes(&f.core)[0].status, STATUS_MISMATCH);
    let _ = small;
    // A command naming no layer the implicit graph has.
    let h = f.core.create_instance(0, f.skel, 0);
    assert_eq!(send(&mut f.core, &[play(h, f.a, MAX_LAYERS, 0.0, 6, 0)]), 0);
    // An unknown opcode ends the batch.
    let mut junk = play(h, f.a, 0, 0.0, 7, 0);
    junk[0] = 0xEE;
    assert_eq!(send(&mut f.core, &[junk, play(h, f.a, 0, 0.0, 8, 0)]), 0);
}

#[test]
fn a_play_reports_finished_once() {
    let mut f = fixture();
    let h = f.core.create_instance(0, f.skel, 0);
    send(&mut f.core, &[play(h, f.b, 0, 0.0, 42, PLAY_ONCE)]);
    let mut finished = Vec::new();
    for _ in 0..60 {
        f.core.write_inputs(0);
        f.core.evaluate(0, PASS_NORMAL, DT, DT);
        finished.extend(changes(&f.core).into_iter().filter(|c| c.kind == CHANGE_FINISHED));
    }
    assert_eq!(finished.len(), 1);
    assert_eq!((finished[0].play_id, finished[0].layer, finished[0].instance), (42, 0, h));
    // It holds its last frame.
    let end = f.reference.sample(&f.b_bytes, 1.0);
    assert!(max_diff(&mats(&f, h), &f.reference.matrices(&end)) < TOL);
}

#[test]
fn stop_fades_a_layer_out_and_interrupts_its_play() {
    let mut f = fixture();
    let h = f.core.create_instance(0, f.skel, 0);
    send(&mut f.core, &[play(h, f.a, 0, 0.0, 1, 0), play(h, f.b, 1, 0.0, 2, 0)]);
    step(&mut f, 2);
    send(&mut f.core, &[stop(h, 1, 0.2)]);
    let c = changes(&f.core);
    assert_eq!((c[0].kind, c[0].play_id, c[0].layer), (CHANGE_INTERRUPTED, 2, 1));
    f.core.evaluate(0, PASS_NORMAL, DT, DT);
    step(&mut f, 6);
    let base = f.reference.sample(&f.a_bytes, 9.0 * DT as f64);
    assert!(max_diff(&mats(&f, h), &f.reference.matrices(&base)) < TOL);
}

#[test]
fn inertialization_keeps_the_switch_continuous() {
    let mut f = fixture();
    let cut = f.core.create_instance(0, f.skel, 0);
    let soft = f.core.create_instance(0, f.skel, 0);
    send(&mut f.core, &[play(cut, f.a, 0, 0.0, 0, 0), play(soft, f.a, 0, 0.0, 0, 0)]);
    step(&mut f, 8);
    let before = mats(&f, cut);
    assert_eq!(before, mats(&f, soft));
    send(
        &mut f.core,
        &[play(cut, f.b, 0, 0.0, 0, 0), play(soft, f.b, 0, 0.4, 0, PLAY_INERTIALIZE)],
    );
    f.core.evaluate(0, PASS_NORMAL, DT, DT);
    // anim-offline's inertialization from the last two shown poses (A at 8 and 7 frames) to B,
    // one frame and three frames after the switch. Tolerance 1e-3: the offsets go through
    // axis-angle conversions and a quintic in f32 (angles to about 1e-6 rad, amplified by the
    // velocity term's 1/dt and the bone chain).
    let r = &f.reference;
    let dt = DT as f64;
    let offsets = anim_offline::pose::inertialize_begin(
        &r.sample(&f.a_bytes, 8.0 * dt),
        &r.sample(&f.a_bytes, 7.0 * dt),
        &r.sample(&f.b_bytes, dt),
        None,
        dt,
        0.4,
    )
    .unwrap();
    let expected = anim_offline::pose::inertialize_apply(&offsets, dt, &r.sample(&f.b_bytes, dt));
    let expected = r.matrices(&expected);
    let later =
        anim_offline::pose::inertialize_apply(&offsets, 3.0 * dt, &r.sample(&f.b_bytes, 3.0 * dt));
    let later = r.matrices(&later);
    let d = max_diff(&mats(&f, soft), &expected);
    assert!(d < 1e-3, "max difference {d}");
    let jump = |m: &[f32]| m.iter().zip(&before).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
    assert!(jump(&mats(&f, soft)) < jump(&mats(&f, cut)), "smaller than the cut's jump");
    step(&mut f, 2);
    let d = max_diff(&mats(&f, soft), &later);
    assert!(d < 1e-3, "max difference {d}");
    // After the blend time, the new clip exactly as cut.
    step(&mut f, 12);
    let d = mats(&f, cut).iter().zip(mats(&f, soft)).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
    assert_eq!(d, 0.0);
}

#[test]
fn culled_instances_advance_their_playheads_with_a_frozen_pose() {
    let mut f = fixture();
    let vis = f.core.create_instance(0, f.skel, 0);
    let root_only = f.core.create_instance(0, f.skel, 0);
    send(&mut f.core, &[play(vis, f.a, 0, 0.0, 0, 0), play(root_only, f.a, 0, 0.0, 0, 0)]);
    step(&mut f, 2);
    let frozen = mats(&f, vis);
    set_flags(&mut f.core, vis, CULL_WHEN_VISIBLE);
    set_flags(&mut f.core, root_only, CULL_ROOT_MOTION_ONLY);
    step(&mut f, 5);
    assert_eq!(mats(&f, vis), frozen);
    assert_eq!(root(&f.core, vis), [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0]);
    assert!(root(&f.core, root_only)[..3].iter().any(|v| *v != 0.0), "root motion reported");
    set_flags(&mut f.core, vis, FLAG_VISIBLE | CULL_WHEN_VISIBLE);
    step(&mut f, 1);
    let now = f.reference.sample(&f.a_bytes, 8.0 * DT as f64);
    assert!(max_diff(&mats(&f, vis), &f.reference.matrices(&now)) < TOL);
}

#[test]
fn root_motion_follows_the_root_curve() {
    let mut f = fixture();
    let h = f.core.create_instance(0, f.skel, 0);
    send(&mut f.core, &[play(h, f.a, 0, 0.0, 0, 0)]);
    step(&mut f, 3);
    let view = anim_format::clip::ClipView::parse(&f.a_bytes).unwrap();
    let at = |t: f64| -> [f64; 4] {
        let x = t * view.sample_rate() as f64;
        let f0 = x.floor() as usize;
        let a = x - f0 as f64;
        let p = view.root_frame(f0).unwrap();
        let q = view.root_frame(f0 + 1).unwrap();
        core::array::from_fn(|k| p[k] as f64 + (q[k] as f64 - p[k] as f64) * a)
    };
    let (p, q) = (at(2.0 * DT as f64), at(3.0 * DT as f64));
    let (s, c) = p[3].sin_cos();
    let (dx, dz) = (q[0] - p[0], q[2] - p[2]);
    let expected = [c * dx - s * dz, q[1] - p[1], s * dx + c * dz];
    let r = root(&f.core, h);
    for k in 0..3 {
        assert!((r[k] as f64 - expected[k]).abs() < 1e-5, "{r:?} vs {expected:?}");
    }
    let yaw = 2.0 * (r[4] as f64).atan2(r[6] as f64);
    assert!((yaw - (q[3] - p[3])).abs() < 1e-5);
    // Baking the root out keeps the root bone in place (its matrix stays at rest in x and z).
    set_flags(&mut f.core, h, FLAG_VISIBLE | FLAG_BAKE_ROOT);
    step(&mut f, 1);
    let m = mats(&f, h);
    assert!(m[3].abs() < 1e-5 && m[11].abs() < 1e-5, "root x {} z {}", m[3], m[11]);
}

#[test]
fn time_scale_worlds_and_passes_select_what_runs() {
    let mut f = fixture();
    let a = f.core.create_instance(0, f.skel, 0);
    let fixed = f.core.create_instance(0, f.skel, 0);
    let elsewhere = f.core.create_instance(1, f.skel, 0);
    for h in [a, fixed, elsewhere] {
        send(&mut f.core, &[play(h, f.a, 0, 0.0, 0, 0)]);
    }
    set_flags(&mut f.core, fixed, FLAG_VISIBLE | FLAG_FIXED);
    set_time_scale(&mut f.core, a, 0.5);
    step(&mut f, 4); // normal pass of world 0: `a` only
    let half = f.reference.sample(&f.a_bytes, 2.0 * DT as f64);
    assert!(max_diff(&mats(&f, a), &f.reference.matrices(&half)) < TOL);
    let zero = vec![0.0f32; f.bones * 12];
    assert_eq!(mats(&f, fixed), zero, "the fixed instance didn't run");
    assert_eq!(mats(&f, elsewhere), zero, "world 1 didn't run");
    f.core.evaluate(0, PASS_FIXED, DT, DT);
    f.core.evaluate(1, PASS_NORMAL, DT, DT);
    let one = f.reference.sample(&f.a_bytes, DT as f64);
    assert!(max_diff(&mats(&f, fixed), &f.reference.matrices(&one)) < TOL);
    assert!(max_diff(&mats(&f, elsewhere), &f.reference.matrices(&one)) < TOL);
}

#[test]
fn a_graph_asset_blends_its_bound_clips() {
    let mut f = fixture();
    let player = Node {
        family: family::SOURCES,
        kind: sources::kind::CLIP_PLAYER,
        inputs_first: 0,
        inputs_count: 0,
        params_first: 0,
        params_count: 5,
        name: NONE,
    };
    let pa = sources::clip_player_params(0, 1.0, 0, 0.0, NONE);
    let pb = sources::clip_player_params(1, 1.0, 0, 0.0, NONE);
    let mut words = Vec::new();
    words.extend_from_slice(&pa);
    words.extend_from_slice(&pb);
    words.extend_from_slice(&[0.25f32.to_bits(), NONE]);
    let graph = AnimGraph {
        name: NONE,
        output: 2,
        skeleton: NONE,
        strings: vec!["walk.anim".into(), "run.anim".into()],
        nodes: vec![
            player,
            Node {
                params_first: 5,
                ..player
            },
            Node {
                family: family::MIXING,
                kind: mixing::kind::BLEND2,
                inputs_first: 0,
                inputs_count: 2,
                params_first: 10,
                params_count: 2,
                name: NONE,
            },
        ],
        inputs: vec![0, 1],
        param_blocks: words,
        ..AnimGraph::default()
    };
    let g = f.core.load_graph(&graph.write().unwrap());
    assert_ne!(g, 0, "status {}", f.core.last_status());
    assert_eq!(f.core.graph_bind(g, 0, f.a), STATUS_OK);
    assert_eq!(f.core.graph_bind(g, 1, f.b), STATUS_OK);
    assert_eq!(f.core.graph_bind(g, 2, f.b), STATUS_MISMATCH);
    assert_eq!(f.core.graph_bind(g, 0, f.skel), STATUS_WRONG_KIND);
    let h = f.core.create_instance(0, f.skel, g);
    assert_ne!(h, 0);
    // Code-first commands are for implicit-graph instances.
    assert_eq!(send(&mut f.core, &[play(h, f.a, 0, 0.0, 1, 0)]), 0);
    assert_eq!(changes(&f.core)[0].status, STATUS_MISMATCH);
    step(&mut f, 5);
    let t = 5.0 * DT as f64;
    let blended = anim_offline::pose::lerp(
        &f.reference.sample(&f.a_bytes, t),
        &f.reference.sample(&f.b_bytes, t),
        0.25,
    );
    let d = max_diff(&mats(&f, h), &f.reference.matrices(&blended));
    assert!(d < TOL, "max difference {d}");

    // A graph with a node this build doesn't know loads, says so, and passes its input through.
    let mut unknown = graph.clone();
    unknown.nodes.push(Node {
        family: family::MIXING,
        kind: 999,
        inputs_first: 0,
        inputs_count: 1,
        params_first: 0,
        params_count: 0,
        name: NONE,
    });
    unknown.output = 3;
    let g2 = f.core.load_graph(&unknown.write().unwrap());
    assert_ne!(g2, 0);
    assert_eq!(f.core.last_status(), STATUS_UNKNOWN_NODES);
}
