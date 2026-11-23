//! The editor module's compile calls through its public functions (the wasm exports' bodies):
//! clip compression against a bound and its determinism, the skeleton compile, the compressed
//! retarget bake and the pose-database bake. The Node test (`src/plugins/animation/editor/compile/
//! editorWasm.node.test.ts`) plays the module's output in the runtime core.

#[path = "../../anim-compress/tests/common/mod.rs"]
mod synth;

use std::path::PathBuf;

use anim_editor_wasm::*;
use anim_format::clip::ClipView;
use anim_format::posedb::{FeatureKind, PoseDbView};
use anim_format::skeleton::{SkeletonView, NO_ROLE};
use anim_retarget::{guess_bone_map, Profile, NO_BONE};
use synth::{Rng, Shape};

fn humanoid() -> (anim_format::skeleton::Skeleton, Vec<u8>) {
    let mut rng = Rng::new(7);
    let skel = synth::skeleton(Shape::Humanoid, &mut rng);
    let bytes = skel.write().unwrap();
    (skel, bytes)
}

fn raw_clip(skel: &anim_format::skeleton::Skeleton, seconds: f64, seed: u64) -> Vec<u8> {
    let mut rng = Rng::new(seed);
    synth::clip(skel, seconds, true, &mut rng).write().unwrap()
}

fn fixture(name: &str) -> Vec<u8> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../src/plugins/animation/runtime/wasm/fixtures");
    std::fs::read(dir.join(name)).unwrap()
}

#[test]
fn a_raw_clip_compresses_within_its_bound_with_a_report() {
    let (skel, skel_bytes) = humanoid();
    let raw = raw_clip(&skel, 1.0, 3);
    let (bytes, report) = compile_clip(&raw, &skel_bytes, &[1e-4]).unwrap();
    let view = ClipView::parse(&bytes).unwrap();
    assert!(view.compressed().is_some());
    assert!(
        view.section(anim_format::clip::section::RAW).is_none(),
        "the raw form isn't kept by default"
    );
    assert!(report.within_bounds);
    assert!(report.max_error <= 1e-4);
    assert_eq!(report.file_size, bytes.len());
    assert!(report.compressed_size < report.raw_size);
    let rec = report_record(&report);
    assert_eq!(rec.len(), REPORT_LEN);
    assert_eq!(rec[report::FILE_SIZE], bytes.len() as f64);
    assert_eq!(rec[report::WITHIN_BOUNDS], 1.0);
}

#[test]
fn compression_is_deterministic_and_follows_its_settings() {
    let (skel, skel_bytes) = humanoid();
    let raw = raw_clip(&skel, 0.8, 11);
    let a = compile_clip(&raw, &skel_bytes, &[1e-4]).unwrap().0;
    let b = compile_clip(&raw, &skel_bytes, &[1e-4]).unwrap().0;
    assert_eq!(a, b);
    // A looser bound gives a smaller clip; resampling changes the rate; keep_raw keeps the raw form.
    let loose = compile_clip(&raw, &skel_bytes, &[1e-2]).unwrap();
    assert!(loose.0.len() < a.len());
    assert!(loose.1.max_error <= 1e-2);
    let resampled = compile_clip(&raw, &skel_bytes, &[1e-4, 1e-4, 15.0])
        .unwrap()
        .0;
    assert_eq!(ClipView::parse(&resampled).unwrap().sample_rate(), 15.0);
    let kept = compile_clip(
        &raw,
        &skel_bytes,
        &[1e-4, 1e-4, 0.0, 32.0, 0.0, 0.0, 15.0, 1.0],
    )
    .unwrap()
    .0;
    let kv = ClipView::parse(&kept).unwrap();
    assert!(kv.section(anim_format::clip::section::RAW).is_some());
    assert!(
        kv.section(anim_format::clip::section::ROOT_CURVE).is_some(),
        "a root bone in the settings extracts the root curve"
    );
}

#[test]
fn clip_failures_say_why() {
    let (skel, skel_bytes) = humanoid();
    let raw = raw_clip(&skel, 0.5, 5);
    assert!(compile_clip(&raw, &[], &[])
        .unwrap_err()
        .0
        .contains("skeleton"));
    assert!(compile_clip(&raw, &[0; 8], &[])
        .unwrap_err()
        .0
        .starts_with("skeleton:"));
    assert!(compile_clip(&raw, &skel_bytes, &[-1.0])
        .unwrap_err()
        .0
        .contains("error"));
    let compressed = compile_clip(&raw, &skel_bytes, &[]).unwrap().0;
    assert!(compile_clip(&compressed, &skel_bytes, &[])
        .unwrap_err()
        .0
        .contains("raw form"));
}

#[test]
fn the_skeleton_compile_writes_roles_and_a_profile() {
    let (skel, bytes) = humanoid();
    let same = compile_skeleton(&bytes, &[], "").unwrap();
    assert_eq!(same, bytes, "canonical input stays byte-identical");
    let mut roles = vec![NO_ROLE; skel.bones.len()];
    roles[1] = 0;
    let out = compile_skeleton(&bytes, &roles, "asset:rigs/biped.skelprofile.json").unwrap();
    let v = SkeletonView::parse(&out).unwrap();
    assert_eq!(v.role(1), Some(0));
    assert_eq!(
        v.strings().get(v.profile()),
        Some("asset:rigs/biped.skelprofile.json")
    );
    assert!(compile_skeleton(&bytes, &[0, 1], "").is_err());
    assert!(compile_skeleton(&[1, 2, 3], &[], "").is_err());
}

#[test]
fn the_retarget_bake_compresses_for_the_target() {
    let (src, tgt, clip) = (
        fixture("retarget_src.skel"),
        fixture("retarget_tgt.skel"),
        fixture("retarget_walk.anim"),
    );
    let humanoid = Profile::humanoid();
    let map_of = |bytes: &[u8]| -> Vec<u16> {
        let v = SkeletonView::parse(bytes).unwrap();
        let d = anim_retarget::bake::SkeletonData::from_view(&v);
        let m = guess_bone_map(&d.name_refs(), &d.parents, &humanoid);
        (0..humanoid.roles.len() as u16)
            .map(|r| m.bone(r).unwrap_or(NO_BONE))
            .collect()
    };
    let (sm, tm) = (map_of(&src), map_of(&tgt));
    let side = |skeleton, map| RetargetInput {
        skeleton,
        profile: &[],
        map,
    };
    let (bytes, report) =
        compile_retarget(side(&src, &sm), side(&tgt, &tm), 1, &clip, 0, &[], &[1e-4]).unwrap();
    let v = ClipView::parse(&bytes).unwrap();
    assert!(v.compressed().is_some());
    assert_eq!(
        v.bone_count() as usize,
        SkeletonView::parse(&tgt).unwrap().bone_count()
    );
    assert!(report.within_bounds);
    let again = compile_retarget(side(&src, &sm), side(&tgt, &tm), 1, &clip, 0, &[], &[1e-4])
        .unwrap()
        .0;
    assert_eq!(bytes, again);
    assert!(
        compile_retarget(side(&src, &sm[1..]), side(&tgt, &tm), 1, &clip, 0, &[], &[]).is_err()
    );
}

#[test]
fn the_pose_database_bake_reads_its_records() {
    let mut rng = Rng::new(9);
    let skel = synth::skeleton(Shape::Chain(4), &mut rng);
    let skel_bytes = skel.write().unwrap();
    let a = synth::clip(&skel, 1.0, false, &mut rng).write().unwrap();
    let b = synth::clip(&skel, 1.0, true, &mut rng).write().unwrap();
    let clips = [a.clone(), b.clone()].concat();
    let lengths = [a.len() as u32, b.len() as u32];
    let schema = [
        FeatureKind::BonePosition as u8 as f32,
        2.0,
        1.0,
        0.0,
        FeatureKind::BoneVelocity as u8 as f32,
        3.0,
        1.0,
        0.0,
        FeatureKind::TrajectoryPosition as u8 as f32,
        -1.0,
        1.0,
        0.33,
    ];
    let ranges = [1.0, 0.0, 0.5, 1.0];
    let bytes = compile_posedb(
        &skel_bytes,
        "chain",
        &clips,
        &lengths,
        "asset:a.anim.bin\nasset:b.anim.bin",
        &ranges,
        "walk",
        &schema,
        &[30.0],
    )
    .unwrap();
    let v = PoseDbView::parse(&bytes).unwrap();
    assert!(v.frame_count() > 0);
    let again = compile_posedb(
        &skel_bytes,
        "chain",
        &clips,
        &lengths,
        "asset:a.anim.bin\nasset:b.anim.bin",
        &ranges,
        "walk",
        &schema,
        &[30.0],
    )
    .unwrap();
    assert_eq!(bytes, again);
    assert!(compile_posedb(
        &skel_bytes,
        "",
        &clips,
        &lengths,
        "only-one",
        &[],
        "",
        &schema,
        &[]
    )
    .is_err());
    assert!(compile_posedb(
        &skel_bytes,
        "",
        &clips,
        &[lengths[0], lengths[1] + 1],
        "a\nb",
        &[],
        "",
        &schema,
        &[]
    )
    .is_err());
}

#[test]
fn the_wasm_wrappers_keep_the_last_report_and_error() {
    let (skel, skel_bytes) = humanoid();
    let raw = raw_clip(&skel, 0.5, 21);
    let out = compress_clip(&raw, &skel_bytes, &[1e-4]);
    assert!(!out.is_empty());
    assert_eq!(last_error(), "");
    assert_eq!(last_report().len(), REPORT_LEN);
    assert!(skeleton_compile(&[0], &[], "").is_empty());
    assert!(!last_error().is_empty());
    assert!(last_report().is_empty());
    assert_eq!(compiler_version(), COMPILER_VERSION);
}
