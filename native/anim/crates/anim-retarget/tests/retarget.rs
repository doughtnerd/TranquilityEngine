//! Chain retargeting: identity, differing bone axes, differing rest poses (with and without
//! alignment), differing proportions (root scaling per axis option, IK goals and pinning),
//! differing chain bone counts, determinism, and agreement with `anim-offline::retarget`.

mod common;

use anim_math::{AosTransform, AosVec3, SoaTransform};
use anim_offline::retarget as o;
use anim_retarget::profile::humanoid as h;
use anim_retarget::{MapSettings, Profile, RetargetMap, RetargetOptions, RootAxis};
use common::*;

/// Rotation tolerance per quaternion component (about 4e-6 rad): f32 composition down a chain of
/// up to a dozen bones, each step rounding at about 6e-8.
const ROT_TOL: f32 = 2e-6;
/// Position tolerance, metres.
const POS_TOL: f32 = 2e-5;

fn build(src: &Rig, tgt: &Rig, align: bool) -> RetargetMap {
    let p = Profile::humanoid();
    RetargetMap::new(src.side(&p), tgt.side(&p), &MapSettings { align_chains: align }).unwrap()
}

fn run(map: &RetargetMap, src_pose: &[AosTransform], opts: &RetargetOptions<'_>) -> Vec<AosTransform> {
    let mut scratch = map.scratch();
    let mut out = soa(&vec![AosTransform::identity(); map.target_bone_count()]);
    map.retarget(&soa(src_pose), opts, &mut scratch, &mut out).unwrap();
    aos(&out, map.target_bone_count())
}

/// A pose that turns every bone but keeps non-root translations at rest (retargeting keeps the
/// target's own bone lengths).
fn pose(rig: &Rig, seed: u64, max: f32) -> Vec<AosTransform> {
    random_pose(rig, &mut Rng::new(seed), max)
}

#[test]
fn guess_maps_the_fixture_fully() {
    let rig = humanoid(Build::default());
    let p = Profile::humanoid();
    assert!(rig.map.missing_required(&p).is_empty());
    // Every bone has a role (so every bone is driven).
    let roles = rig.map.to_roles(rig.n());
    for (b, r) in roles.iter().enumerate() {
        assert_ne!(*r, 0xFFFF, "bone {} unmapped", rig.names[b]);
    }
}

#[test]
fn identity_retarget_reproduces_the_pose() {
    for axes in [Axes::Model, Axes::YAlong, Axes::XAlong] {
        let rig = humanoid(Build { axes, ..Build::default() });
        let map = build(&rig, &rig, true);
        assert_eq!(map.leg_ratio(), 1.0);
        for seed in 0..20 {
            let p = pose(&rig, seed, 1.2);
            let got = run(&map, &p, &RetargetOptions::default());
            for i in 0..rig.n() {
                assert!(
                    quat_close(got[i].rotation, p[i].rotation, ROT_TOL),
                    "{axes:?} seed {seed} bone {}: {:?} vs {:?}",
                    rig.names[i],
                    got[i].rotation,
                    p[i].rotation
                );
                let d = (got[i].translation - p[i].translation).length();
                assert!(d < POS_TOL, "{axes:?} seed {seed} bone {}: {d}", rig.names[i]);
            }
        }
    }
}

fn dir(m: &[AosTransform], a: usize, b: usize) -> AosVec3 {
    let d = m[b].translation - m[a].translation;
    d.scale(1.0 / d.length())
}

/// Each chain's segments point the same way in model space on both skeletons.
fn assert_directions(src: &Rig, sm: &[AosTransform], tgt: &Rig, tm: &[AosTransform], what: &str) {
    let segs = [
        ("LeftArm", "LeftForeArm"),
        ("LeftForeArm", "LeftHand"),
        ("RightArm", "RightForeArm"),
        ("RightForeArm", "RightHand"),
        ("LeftUpLeg", "LeftLeg"),
        ("LeftLeg", "LeftFoot"),
        ("LeftFoot", "LeftToeBase"),
        ("Neck", "Head"),
        ("LeftHandIndex1", "LeftHandIndex2"),
        ("Spine", "Spine1"),
    ];
    for (a, b) in segs {
        let ds = dir(sm, src.index(a), src.index(b));
        let dt = dir(tm, tgt.index(a), tgt.index(b));
        assert!(ds.dot(dt) > 1.0 - 1e-6, "{what}: {a}->{b}: {ds:?} vs {dt:?}");
    }
}

#[test]
fn differing_bone_axes_give_matching_model_space() {
    // Y-down-the-bone source, X-down-the-bone target, same joint positions.
    let src = humanoid(Build { axes: Axes::YAlong, ..Build::default() });
    let tgt = humanoid(Build { axes: Axes::XAlong, ..Build::default() });
    let map = build(&src, &tgt, true);
    for seed in 0..10 {
        let p = pose(&src, 100 + seed, 1.0);
        let got = run(&map, &p, &RetargetOptions::default());
        let sm = model(&src.parents, &p);
        let tm = model(&tgt.parents, &got);
        for i in 0..src.n() {
            let d = (sm[i].translation - tm[i].translation).length();
            assert!(d < POS_TOL, "seed {seed} bone {}: {d}", src.names[i]);
        }
        assert_directions(&src, &sm, &tgt, &tm, "axes");
    }
}

#[test]
fn differing_rest_poses_align_per_option() {
    // T-pose source, A-pose target (arms 45 degrees down), different bone axes too.
    let src = humanoid(Build { axes: Axes::YAlong, ..Build::default() });
    let tgt = humanoid(Build {
        axes: Axes::XAlong,
        arm_drop: 0.785,
        ..Build::default()
    });
    // Aligned: directions match.
    let map = build(&src, &tgt, true);
    for seed in 0..10 {
        let p = pose(&src, 200 + seed, 1.0);
        let got = run(&map, &p, &RetargetOptions::default());
        assert_directions(&src, &model(&src.parents, &p), &tgt, &model(&tgt.parents, &got), "aligned");
    }
    // Unaligned: the source's rest pose leaves the target in its own rest pose (the A-pose arm
    // stays 45 degrees off the source's T-pose arm).
    let map = build(&src, &tgt, false);
    let got = run(&map, &src.rest, &RetargetOptions::default());
    let tm = model(&tgt.parents, &got);
    let tr = tgt.rest_model();
    let (a, b) = (tgt.index("LeftArm"), tgt.index("LeftForeArm"));
    assert!(dir(&tm, a, b).dot(dir(&tr, a, b)) > 1.0 - 1e-6);
    let ds = dir(&src.rest_model(), src.index("LeftArm"), src.index("LeftForeArm"));
    assert!(dir(&tm, a, b).dot(ds) < 0.6f32.cos());
}

/// A walk-like frame: hips forward and down, left leg bent with the foot where it was at rest.
fn planted(src: &Rig, forward: f32) -> Vec<AosTransform> {
    let mut p = src.rest.clone();
    p[0].translation = p[0].translation + v(0.0, -0.05, forward);
    p[src.index("Spine")].rotation = (p[src.index("Spine")].rotation * q(v(1.0, 0.0, 0.0), 0.1)).normalize_or_identity();
    p
}

#[test]
fn root_scales_by_leg_ratio_per_axis_option() {
    let src = humanoid(Build::default());
    let tgt = humanoid(Build {
        leg: 1.3,
        body: 1.1,
        axes: Axes::XAlong,
        ..Build::default()
    });
    let map = build(&src, &tgt, true);
    // Leg length ratio against the f64 reference's limb lengths.
    let limb = |r: &Rig| {
        let idx = [r.index("LeftUpLeg") as u16, r.index("LeftLeg") as u16, r.index("LeftFoot") as u16];
        o::limb_length(&r.parents, &p64(&r.rest), idx)
    };
    let want = limb(&tgt) / limb(&src);
    assert!((map.leg_ratio() as f64 - want).abs() < 1e-6, "{} vs {want}", map.leg_ratio());
    let p = planted(&src, 0.4);
    let moved = v(0.0, -0.05, 0.4);
    let rest_hips = tgt.rest_model()[0].translation;
    let ratio = map.leg_ratio();
    for (axes, expect) in [
        ([RootAxis::Scaled; 3], moved.scale(ratio)),
        ([RootAxis::Unscaled; 3], moved),
        ([RootAxis::Locked; 3], v(0.0, 0.0, 0.0)),
        ([RootAxis::Scaled, RootAxis::Locked, RootAxis::Unscaled], v(0.0, 0.0, 0.4)),
    ] {
        let got = run(&map, &p, &RetargetOptions { root_axes: axes, ik_weights: &[] });
        let hips = model(&tgt.parents, &got)[0].translation;
        let d = (hips - (rest_hips + expect)).length();
        assert!(d < POS_TOL, "{axes:?}: {d}");
    }
}

#[test]
fn feet_pin_to_scaled_goals() {
    let src = humanoid(Build::default());
    let tgt = humanoid(Build {
        leg: 1.3,
        body: 0.9,
        axes: Axes::YAlong,
        ..Build::default()
    });
    let map = build(&src, &tgt, true);
    let goals = map.goals();
    let names: Vec<&str> = goals.iter().map(|g| g.chain.as_str()).collect();
    assert_eq!(names, ["LeftArm", "RightArm", "LeftLeg", "RightLeg"]);
    let lfoot = tgt.index("LeftFoot");
    let mut scratch = map.scratch();
    let mut out = soa(&tgt.rest);
    let weights = [0.0, 0.0, 1.0, 1.0];
    let opts = RetargetOptions {
        root_axes: [RootAxis::Scaled; 3],
        ik_weights: &weights,
    };
    let mut first: Option<AosVec3> = None;
    for step in 0..5 {
        // The source walks forward and crouches with its left foot planted (solved by IK on
        // the source itself, so the source foot really stays put).
        let mut sp = planted(&src, 0.05 * step as f32);
        plant_source_foot(&src, &mut sp);
        let src_model = model(&src.parents, &sp);
        map.retarget(&soa(&sp), &opts, &mut scratch, &mut out).unwrap();
        let tm = model(&tgt.parents, &aos(&out, tgt.n()));
        // Goal = target hip joint (after FK) + scaled source hip-to-foot (f64 reference).
        let g = &goals[2];
        let fk = run(&map, &sp, &RetargetOptions::default());
        let fk_model = model(&tgt.parents, &fk);
        let want = o::goal(
            v64(src_model[g.source.root as usize].translation),
            v64(src_model[g.source.tip as usize].translation),
            v64(fk_model[g.limb.root as usize].translation),
            g.ratio as f64,
        );
        let goal = scratch.goals()[2];
        assert!((v64(goal) - want).length() < 1e-5, "goal formula");
        let foot = tm[lfoot].translation;
        assert!((foot - goal).length() < 1e-4, "step {step}: foot {foot:?} vs goal {goal:?}");
        // The planted source foot gives a planted target foot.
        match first {
            None => first = Some(foot),
            Some(f) => assert!((foot - f).length() < 2e-4, "step {step}: target foot slid"),
        }
        // The scratch's model pose is the output's.
        assert!((scratch.target_model()[lfoot].translation - foot).length() < 1e-5);
    }
    // Weight 0 leaves the FK pose.
    let sp = planted(&src, 0.2);
    let a = run(&map, &sp, &RetargetOptions::default());
    let b = run(&map, &sp, &RetargetOptions { root_axes: [RootAxis::Scaled; 3], ik_weights: &[0.0; 4] });
    for i in 0..tgt.n() {
        assert_eq!(a[i].rotation.x.to_bits(), b[i].rotation.x.to_bits());
    }
}

/// Keeps the source's left foot at its rest position with anim-rig's two-bone IK.
fn plant_source_foot(src: &Rig, pose: &mut [AosTransform]) {
    use anim_rig::two_bone::{two_bone, TwoBone, TwoBoneGoal};
    let rest = src.rest_model();
    let foot = src.index("LeftFoot");
    let mut local = soa(pose);
    let mut m = model(&src.parents, pose);
    let mut rp = anim_rig::RigPose::new(&src.parents, &mut local, &mut m);
    let limb = TwoBone {
        root: src.index("LeftUpLeg") as u16,
        mid: src.index("LeftLeg") as u16,
        tip: foot as u16,
    };
    two_bone(&mut rp, limb, &TwoBoneGoal::new(rest[foot].translation));
    drop(rp);
    pose.copy_from_slice(&aos(&local, src.n()));
}

#[test]
fn chains_of_different_bone_counts_resample() {
    for (ns, nt) in [(3usize, 5usize), (5, 2), (2, 3), (1, 4)] {
        let src = humanoid(Build { spine: ns, ..Build::default() });
        let tgt = humanoid(Build {
            spine: nt,
            axes: Axes::XAlong,
            ..Build::default()
        });
        let map = build(&src, &tgt, true);
        let spine = map.chains().iter().find(|c| c.name == "Spine").unwrap();
        assert_eq!((spine.source.len(), spine.target.len()), (ns, nt));
        // Bend every source spine joint by the same amount: the neck ends up turned by the whole
        // bend on both skeletons, and the head points the same way.
        let mut p = src.rest.clone();
        let bend = 0.6 / ns as f32;
        for name in spine_names(ns) {
            let i = src.index(&name);
            p[i].rotation = (p[i].rotation * q(v(1.0, 0.0, 0.3), bend)).normalize_or_identity();
        }
        let got = run(&map, &p, &RetargetOptions::default());
        let sm = model(&src.parents, &p);
        let tm = model(&tgt.parents, &got);
        let (sn, tn) = (src.index("Neck"), tgt.index("Neck"));
        let delta_s = sm[sn].rotation * src.rest_model()[sn].rotation.conjugate();
        let delta_t = tm[tn].rotation * tgt.rest_model()[tn].rotation.conjugate();
        assert!(quat_close(delta_s, delta_t, ROT_TOL), "{ns}->{nt}: neck turn");
        let ds = dir(&sm, sn, src.index("Head"));
        let dt = dir(&tm, tn, tgt.index("Head"));
        assert!(ds.dot(dt) > 1.0 - 1e-6, "{ns}->{nt}: head direction");
    }
}

fn spine_names(n: usize) -> Vec<String> {
    (0..n).map(|i| if i == 0 { "Spine".to_string() } else { format!("Spine{i}") }).collect()
}

#[test]
fn deterministic_bit_for_bit() {
    let src = humanoid(Build { axes: Axes::YAlong, ..Build::default() });
    let tgt = humanoid(Build { leg: 1.2, axes: Axes::XAlong, arm_drop: 0.6, spine: 4, ..Build::default() });
    let map = build(&src, &tgt, true);
    let w = [1.0, 0.5, 1.0, 0.25];
    let opts = RetargetOptions { root_axes: [RootAxis::Scaled; 3], ik_weights: &w };
    let p = soa(&pose(&src, 7, 1.0));
    let mut s1 = map.scratch();
    let mut s2 = map.scratch();
    let mut a = vec![SoaTransform::identity(); anim_math::layout::soa_len(tgt.n())];
    let mut b = a.clone();
    map.retarget(&p, &opts, &mut s1, &mut a).unwrap();
    map.retarget(&p, &opts, &mut s2, &mut b).unwrap();
    // A reused scratch gives the same bits too.
    let mut c = a.clone();
    map.retarget(&p, &opts, &mut s1, &mut c).unwrap();
    let bits = |x: &[SoaTransform]| -> Vec<u32> {
        aos(x, tgt.n())
            .iter()
            .flat_map(|t| {
                [
                    t.translation.x, t.translation.y, t.translation.z, t.rotation.x, t.rotation.y,
                    t.rotation.z, t.rotation.w,
                ]
            })
            .map(f32::to_bits)
            .collect()
    };
    assert_eq!(bits(&a), bits(&b));
    assert_eq!(bits(&a), bits(&c));
}

#[test]
fn refuses_wrong_lengths() {
    let src = humanoid(Build { spine: 1, ..Build::default() });
    let tgt = humanoid(Build { spine: 5, ..Build::default() });
    let map = build(&src, &tgt, true);
    let mut s = map.scratch();
    let mut out = soa(&tgt.rest);
    let o = RetargetOptions::default();
    assert_eq!(
        map.retarget(&soa(&tgt.rest), &o, &mut s, &mut out),
        Err(anim_retarget::RetargetError::SourceLength)
    );
    let mut short = soa(&src.rest);
    assert_eq!(
        map.retarget(&soa(&src.rest), &o, &mut s, &mut short),
        Err(anim_retarget::RetargetError::OutLength)
    );
    let other = build(&tgt, &src, true);
    let mut wrong = other.scratch();
    assert_eq!(
        map.retarget(&soa(&src.rest), &o, &mut wrong, &mut out),
        Err(anim_retarget::RetargetError::Scratch)
    );
}

#[test]
fn matches_the_f64_reference() {
    let cases = [
        (Build::default(), Build::default(), true),
        (Build { axes: Axes::YAlong, ..Build::default() }, Build { axes: Axes::XAlong, ..Build::default() }, true),
        (
            Build { axes: Axes::YAlong, ..Build::default() },
            Build { axes: Axes::XAlong, arm_drop: 0.7, leg: 1.25, body: 1.1, spine: 5, ..Build::default() },
            true,
        ),
        (
            Build { spine: 2, ..Build::default() },
            Build { axes: Axes::YAlong, arm_drop: 0.5, leg: 0.8, spine: 4, ..Build::default() },
            false,
        ),
    ];
    for (ci, (bs, bt, align)) in cases.into_iter().enumerate() {
        let src = humanoid(bs);
        let tgt = humanoid(bt);
        let map = build(&src, &tgt, align);
        let setup = o::Setup {
            source_parents: src.parents.clone(),
            source_rest: p64(&src.rest),
            target_parents: tgt.parents.clone(),
            target_rest: p64(&tgt.rest),
            roots: map.root_bones().to_vec(),
            chains: map
                .chains()
                .iter()
                .map(|c| o::ChainPair { source: c.source.clone(), target: c.target.clone() })
                .collect(),
            align,
            ratio: map.leg_ratio() as f64,
        };
        assert_eq!(map.root_bones(), &[(0, 0)], "hips only (no Root bone)");
        for seed in 0..25 {
            let p = pose(&src, 1000 + seed, 1.3);
            for axes in [[RootAxis::Scaled; 3], [RootAxis::Unscaled, RootAxis::Locked, RootAxis::Scaled]] {
                let got = run(&map, &p, &RetargetOptions { root_axes: axes, ik_weights: &[] });
                let oaxes = axes.map(|a| match a {
                    RootAxis::Scaled => o::RootAxis::Scaled,
                    RootAxis::Unscaled => o::RootAxis::Unscaled,
                    RootAxis::Locked => o::RootAxis::Locked,
                });
                let want = o::retarget(&setup, oaxes, &p64(&p));
                for i in 0..tgt.n() {
                    let (g, w) = (t64(got[i]), want[i]);
                    // Angle between the rotations: 2·atan2(|a − b'|, |a + b'|) (b' sign-aligned).
                    let b = if g.rotation.dot(w.rotation) < 0.0 { -w.rotation } else { w.rotation };
                    let diff = (g.rotation + (-b)).length();
                    let sum = (g.rotation + b).length();
                    let angle = 2.0 * diff.atan2(sum);
                    assert!(angle < 1e-5, "case {ci} seed {seed} bone {}: {angle}", tgt.names[i]);
                    let dp = (g.translation - w.translation).length();
                    assert!(dp < 2e-5, "case {ci} seed {seed} bone {}: {dp}", tgt.names[i]);
                }
            }
        }
    }
}

#[test]
fn humanoid_chain_order_drives_twists_last() {
    let p = Profile::humanoid();
    let last_non_twist = p.chains.iter().rposition(|c| c.kind != anim_retarget::ChainKind::Twist).unwrap();
    let first_twist = p.chains.iter().position(|c| c.kind == anim_retarget::ChainKind::Twist).unwrap();
    assert!(first_twist > last_non_twist);
    assert_eq!(p.roles.len(), h::COUNT);
}
