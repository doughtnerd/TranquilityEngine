//! T41's runtime half through the core's calls: the `retarget` family's `RETARGET` node (a source
//! graph on skeleton A drives skeleton B) against the bake of the same clip, one case per root-axis
//! option, IK pin weights constant and by parameter, root motion scaling, refusals, snapshot and
//! restore; the setup exports (`profile_decode`, `guess_bone_map`, `retarget_map_create`,
//! `retarget_goal_count`); and the `MIRROR` node with the profile's flip table.
//!
//! The node and the bake run the same `RetargetMap::retarget`; the node samples the source at the
//! playhead (accumulated `f32` time) and the baked clip is sampled at the same time between its
//! frames, so the two agree to interpolation rounding: 2e-4 on matrix entries.

mod common;
mod rigs;

use anim_format::graph::{family, ParamValue};
use anim_format::NONE;
use anim_graph::retarget::{kind, RetargetParams, MAX_GOALS};
use anim_retarget::{MapSettings, Profile, RetargetMap, RootAxis};
use anim_wasm::init::Core;
use anim_wire::core::{STATUS_BAD_ASSET, STATUS_MISMATCH, STATUS_OK};
use common::graph::*;
use common::*;
use rigs::*;

const DT: f32 = 1.0 / 30.0;
const MAX_BONES: u32 = 64;
const TOL: f32 = 2e-4;

/// Source: T-pose, Y-along bones; target: A-pose, X-along bones, shorter legs, two spine bones.
fn rigs() -> (Rig, Rig) {
    let src = humanoid(Build {
        axes: Axes::YAlong,
        ..Build::default()
    });
    let tgt = humanoid(Build {
        axes: Axes::XAlong,
        arm_drop: 0.6,
        leg: 0.8,
        body: 1.1,
        spine: 2,
    });
    (src, tgt)
}

struct Setup {
    core: Core,
    src: Rig,
    tgt: Rig,
    src_file: Vec<u8>,
    tgt_file: Vec<u8>,
    src_skel: u32,
    tgt_skel: u32,
    map: u32,
    clip_bytes: Vec<u8>,
    clip: u32,
    source_graph: u32,
}

fn setup() -> Setup {
    let (src, tgt) = rigs();
    let (src_model, src_file) = skeleton_file(&src, true, false);
    let (_, tgt_file) = skeleton_file(&tgt, true, false);
    let mut core = core(16, MAX_BONES);
    let src_skel = core.load_skeleton(&src_file);
    let tgt_skel = core.load_skeleton(&tgt_file);
    assert!(src_skel != 0 && tgt_skel != 0);
    let map = core.retarget_map_create(
        src_skel,
        0,
        &src.map.bones,
        tgt_skel,
        0,
        &tgt.map.bones,
        anim_wasm::retarget::MAP_ALIGN,
    );
    assert_ne!(map, 0, "map (status {})", core.last_status());
    let clip_bytes = raw_clip(&src_model, &ClipSpec::new(1.0, true, 41));
    let clip = core.load_clip(&clip_bytes);
    let mut b = Builder::new();
    let p = b.player("clip");
    let g = core.load_graph(&b.build(p));
    assert_eq!(core.graph_bind(g, b.s("clip"), clip), STATUS_OK);
    Setup {
        core,
        src,
        tgt,
        src_file,
        tgt_file,
        src_skel,
        tgt_skel,
        map,
        clip_bytes,
        clip,
        source_graph: g,
    }
}

fn params(axes: [RootAxis; 3], goals: &[(f32, u32)]) -> RetargetParams {
    let mut g = [(0.0, NONE); MAX_GOALS];
    g[..goals.len()].copy_from_slice(goals);
    RetargetParams {
        map: 0,
        graph: 1,
        state_capacity: 4096,
        depth_capacity: 2,
        param_capacity: 8,
        root_axes: axes,
        goals: g,
        goal_count: goals.len(),
    }
}

/// A graph whose output is a RETARGET node (`map` and `src` its strings 0 and 1), with a float
/// parameter `pin` (index 0) for goals that read it.
fn retarget_graph(p: &RetargetParams) -> (Vec<u8>, u32, u32) {
    let mut b = Builder::new();
    let (m, g) = (b.s("map"), b.s("src"));
    assert_eq!((m, g), (0, 1));
    b.param("pin", ParamValue::Float(0.0));
    let n = b.node(family::RETARGET, kind::RETARGET, &[], &p.words());
    (b.build(n), m, g)
}

fn retarget_instance(s: &mut Setup, p: &RetargetParams) -> u32 {
    let (bytes, m, g) = retarget_graph(p);
    let (_, h) = instance(&mut s.core, &bytes, s.tgt_skel, &[(m, s.map), (g, s.source_graph)]);
    h
}

/// An instance on the target playing the bake of the clip with `axes` and `weights`.
fn baked_instance(s: &mut Setup, axes: [RootAxis; 3], weights: &[f32]) -> u32 {
    let packed = axes.iter().enumerate().fold(0u32, |acc, (i, a)| {
        acc | (match a {
            RootAxis::Scaled => 0,
            RootAxis::Unscaled => 1,
            RootAxis::Locked => 2,
        } << (2 * i))
    });
    let bytes = s
        .core
        .retarget_bake(s.map, &s.clip_bytes.clone(), packed, weights);
    assert!(!bytes.is_empty(), "bake (status {})", s.core.last_status());
    let clip = s.core.load_clip(&bytes);
    let mut b = Builder::new();
    let p = b.player("baked");
    let (_, h) = instance(&mut s.core, &b.build(p), s.tgt_skel, &[(b.s("baked"), clip)]);
    h
}

fn diff(a: &[f32], b: &[f32]) -> f32 {
    a.iter()
        .zip(b)
        .map(|(x, y)| (x - y).abs())
        .fold(0.0, f32::max)
}

/// Runs `frames` frames and returns the largest matrix difference between `a` and `b`.
fn compare(s: &mut Setup, a: u32, b: u32, frames: usize) -> f32 {
    let n = s.tgt.n();
    let mut worst = 0.0f32;
    for _ in 0..frames {
        frame(&mut s.core, DT);
        let ma = matrices(&s.core, a, MAX_BONES as usize, n);
        let mb = matrices(&s.core, b, MAX_BONES as usize, n);
        worst = worst.max(diff(&ma, &mb));
    }
    worst
}

#[test]
fn the_node_matches_the_bake_for_each_root_axis_option() {
    let mut out = Vec::new();
    for axis in [RootAxis::Scaled, RootAxis::Unscaled, RootAxis::Locked] {
        let mut s = setup();
        let axes = [axis, RootAxis::Scaled, axis];
        let node = retarget_instance(&mut s, &params(axes, &[]));
        let baked = baked_instance(&mut s, axes, &[]);
        let worst = compare(&mut s, node, baked, 20);
        assert!(worst <= TOL, "{axis:?}: node vs bake differ by {worst}");
        out.push(matrices(&s.core, node, MAX_BONES as usize, s.tgt.n()));
    }
    // The options do something: the hips' x and z differ between them (the clip walks along +z).
    assert!(diff(&out[0], &out[1]) > 1e-3, "scaled vs unscaled");
    assert!(diff(&out[1], &out[2]) > 1e-3, "unscaled vs locked");
}

#[test]
fn pin_weights_constant_and_by_parameter_match_the_bake() {
    let mut s = setup();
    let goals = s.core.retarget_goal_count(s.map) as usize;
    assert_eq!(goals, 4, "the Humanoid's arm and leg goals");
    let axes = [RootAxis::Scaled; 3];
    // Constant weight 1 on every goal.
    let full = params(axes, &vec![(1.0, NONE); goals]);
    let node = retarget_instance(&mut s, &full);
    let baked = baked_instance(&mut s, axes, &vec![1.0; goals]);
    let free = retarget_instance(&mut s, &params(axes, &[]));
    let worst = compare(&mut s, node, baked, 12);
    assert!(worst <= TOL, "pinned node vs pinned bake: {worst}");
    let n = s.tgt.n();
    let pinned = matrices(&s.core, node, MAX_BONES as usize, n);
    let unpinned = matrices(&s.core, free, MAX_BONES as usize, n);
    assert!(diff(&pinned, &unpinned) > 1e-4, "pinning moves the limbs");

    // Weights from parameter 0 (`pin` = 0.5): the same as the bake at 0.5.
    let mut s = setup();
    let by_param = params(axes, &vec![(0.0, 0); goals]);
    let node = retarget_instance(&mut s, &by_param);
    let baked = baked_instance(&mut s, axes, &vec![0.5; goals]);
    send(&mut s.core, &[set_float(node, 0, 0.5)]);
    let worst = compare(&mut s, node, baked, 12);
    assert!(worst <= TOL, "pin by parameter vs bake at 0.5: {worst}");
}

#[test]
fn root_motion_is_the_sources_scaled_per_axis() {
    let (src, tgt) = rigs();
    let profile = Profile::humanoid();
    let ratio = RetargetMap::new(
        src.side(&profile),
        tgt.side(&profile),
        &MapSettings::default(),
    )
    .unwrap()
    .leg_ratio();
    assert!((ratio - 0.8).abs() < 0.05, "leg ratio {ratio}");
    let mut s = setup();
    let axes = [RootAxis::Scaled, RootAxis::Unscaled, RootAxis::Locked];
    let node = retarget_instance(&mut s, &params(axes, &[]));
    let (_, source) = {
        let mut b = Builder::new();
        let p = b.player("clip");
        let bytes = b.build(p);
        let id = b.s("clip");
        let clip = s.clip;
        let skel = s.src_skel;
        instance(&mut s.core, &bytes, skel, &[(id, clip)])
    };
    for _ in 0..10 {
        frame(&mut s.core, DT);
        let (r, sr) = (root(&s.core, node), root(&s.core, source));
        assert!((r[0] - sr[0] * ratio).abs() < 1e-6, "x scaled");
        assert!((r[1] - sr[1]).abs() < 1e-6, "y unscaled");
        assert_eq!(r[2], 0.0, "z locked");
        assert_eq!(&r[3..], &sr[3..], "rotation unchanged");
    }
    assert!(root(&s.core, source)[2].abs() > 1e-3, "the source moves along z");
}

#[test]
fn a_missing_map_or_an_oversized_source_graph_outputs_nothing() {
    let mut s = setup();
    let n = s.tgt.n();
    let (bytes, _, g) = retarget_graph(&params([RootAxis::Scaled; 3], &[]));
    // The map unbound.
    let (_, unbound) = instance(&mut s.core, &bytes, s.tgt_skel, &[(g, s.source_graph)]);
    // A state capacity too small for the source graph.
    let mut small = params([RootAxis::Scaled; 3], &[]);
    small.state_capacity = 4;
    let tight = retarget_instance(&mut s, &small);
    // A map whose target is another skeleton (the source's, so the bone count differs).
    let other_map = s.core.retarget_map_create(
        s.tgt_skel,
        0,
        &s.tgt.map.bones.clone(),
        s.src_skel,
        0,
        &s.src.map.bones.clone(),
        0,
    );
    let (bytes2, m2, g2) = retarget_graph(&params([RootAxis::Scaled; 3], &[]));
    let (_, wrong) = instance(
        &mut s.core,
        &bytes2,
        s.tgt_skel,
        &[(m2, other_map), (g2, s.source_graph)],
    );
    frame(&mut s.core, DT);
    let rest = matrices_of(&s.tgt_file, &s.tgt.rest);
    for h in [unbound, tight, wrong] {
        let m = matrices(&s.core, h, MAX_BONES as usize, n);
        assert!(max_diff(&m, &rest) < 1e-5, "instance {h:x} shows the rest pose");
    }
}

#[test]
fn snapshot_and_restore_are_exact() {
    let mut s = setup();
    let goals = s.core.retarget_goal_count(s.map) as usize;
    let h = retarget_instance(&mut s, &params([RootAxis::Scaled; 3], &vec![(0.7, NONE); goals]));
    let n = s.tgt.n();
    for _ in 0..7 {
        frame(&mut s.core, DT);
    }
    let mut snap = vec![0u8; s.core.snapshot_bytes(h) as usize];
    assert_eq!(s.core.snapshot(h, &mut snap), STATUS_OK);
    let mut first = Vec::new();
    for _ in 0..6 {
        frame(&mut s.core, DT);
        first.push(matrices(&s.core, h, MAX_BONES as usize, n));
    }
    assert_eq!(s.core.restore(h, &snap), STATUS_OK);
    for expected in first {
        frame(&mut s.core, DT);
        assert_eq!(matrices(&s.core, h, MAX_BONES as usize, n), expected);
    }
}

#[test]
fn setup_exports_guess_decode_and_refuse() {
    let mut s = setup();
    let profile = Profile::humanoid();
    let roles = profile.roles.len();
    let mut bones = vec![0u16; roles];
    let mut conf = vec![0f32; roles];
    let n = s
        .core
        .guess_bone_map(&s.src_file.clone(), 0, &mut bones, &mut conf);
    assert_eq!(n as usize, roles);
    assert_eq!(bones, s.src.map.bones, "the native guess on the same names");
    assert_eq!(conf, s.src.map.confidence);

    // A custom profile: the Humanoid's own encoding guesses the same.
    let custom = s
        .core
        .profile_decode(&anim_retarget::encode::encode(&profile).unwrap());
    assert_ne!(custom, 0);
    let mut bones2 = vec![0u16; roles];
    let mut conf2 = vec![0f32; roles];
    s.core
        .guess_bone_map(&s.src_file.clone(), custom, &mut bones2, &mut conf2);
    assert_eq!(bones2, bones);

    // Refusals.
    assert_eq!(s.core.profile_decode(b"MYCOPROF\x01"), 0);
    assert_eq!(s.core.last_status(), STATUS_BAD_ASSET);
    assert_eq!(
        s.core
            .guess_bone_map(b"not a skeleton", 0, &mut bones, &mut conf),
        0
    );
    assert_eq!(s.core.last_status(), STATUS_BAD_ASSET);
    let short = &s.src.map.bones[..3].to_vec();
    let tgt_bones = s.tgt.map.bones.clone();
    assert_eq!(
        s.core
            .retarget_map_create(s.src_skel, 0, short, s.tgt_skel, 0, &tgt_bones, 0),
        0
    );
    assert_eq!(s.core.last_status(), STATUS_MISMATCH);
    // A map is bindable; a profile isn't.
    let g = s.source_graph;
    assert_eq!(s.core.graph_bind(g, 0, s.map), STATUS_OK);
    assert_ne!(s.core.graph_bind(g, 0, custom), STATUS_OK);
}

#[test]
fn mirror_uses_the_profiles_flip_table() {
    use anim_graph::mixing;
    use anim_math::layout::{local_to_model, unpack_pose};
    use anim_pose::mirror::{mirror_flipped, Flip, FlipTable};
    let rig = humanoid(Build {
        axes: Axes::YAlong,
        ..Build::default()
    });
    let (_, file) = skeleton_file(&rig, true, false);
    let n = rig.n();
    let mut core = core(4, MAX_BONES);
    let skel = core.load_skeleton(&file);

    // The export equals the profile's table.
    let mut words = vec![0u32; n];
    assert_eq!(
        core.retarget_mirror_table(&file, 0, &rig.map.bones, &mut words),
        n as u32
    );
    let mut model = vec![anim_math::AosTransform::identity(); n];
    local_to_model(&rig.parents, &rt::soa(&rig.rest), &mut model);
    let (partner, flips) =
        Profile::humanoid().mirror_table(&rig.map, &model, None, anim_pose::Axis::X);
    for b in 0..n {
        assert_eq!(words[b], mixing::mirror_word(partner[b], flips[b] as u8));
    }
    assert!(
        flips.iter().any(|&f| f != Flip::None),
        "this rig needs flips"
    );

    // The node with the table equals `mirror_flipped`; without the flips, plain `mirror`.
    let pose = random_pose(&rig, 7, 0.6);
    let clip = core.load_clip(&constant_clip(&pose));
    let src = rt::soa(&pose);
    let mut cases = Vec::new();
    for with_flips in [true, false] {
        let mut b = Builder::new();
        let p = b.player("c");
        let mut w = vec![0u32, NONE];
        w.extend(words.iter().map(|&x| if with_flips { x } else { x & 0xFFFF }));
        let m = b.node(family::MIXING, mixing::kind::MIRROR, &[p], &w);
        let (_, h) = instance(&mut core, &b.build(m), skel, &[(b.s("c"), clip)]);
        let table = FlipTable {
            parents: &rig.parents,
            flips: &flips,
        };
        let mut out = src.clone();
        mirror_flipped(&src, &partner, anim_pose::Axis::X, with_flips.then_some(table), &mut out);
        let mut expected = pose.clone();
        unpack_pose(&out, &mut expected);
        cases.push((h, expected));
    }
    frame(&mut core, DT);
    for (h, expected) in &cases {
        let m = matrices(&core, *h, MAX_BONES as usize, n);
        let e = matrices_of(&file, expected);
        assert!(max_diff(&m, &e) < 1e-5, "mirror node {h:x}: {}", max_diff(&m, &e));
    }
    let a = matrices(&core, cases[0].0, MAX_BONES as usize, n);
    let b = matrices(&core, cases[1].0, MAX_BONES as usize, n);
    assert!(diff(&a, &b) > 1e-3, "the flips change the result");
}
