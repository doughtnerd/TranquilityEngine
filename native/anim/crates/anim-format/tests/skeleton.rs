mod common;

use anim_format::skeleton::*;
use anim_format::FormatError;
use common::*;

fn gen_skeleton(rng: &mut Rng) -> Skeleton {
    let strings = strings(rng, 1);
    let n = rng.range(1, 12) as usize;
    let bones: Vec<Bone> = (0..n)
        .map(|i| Bone {
            name: rng.below(strings.len() as u32),
            parent: if i == 0 || rng.below(5) == 0 {
                NO_PARENT
            } else {
                rng.below(i as u32) as u16
            },
            translation: [rng.f32(-1.0, 1.0), rng.f32(-1.0, 1.0), rng.f32(-1.0, 1.0)],
            rotation: [0.0, rng.f32(-1.0, 1.0), 0.0, 1.0],
            scale: [1.0, 1.0, rng.f32(0.5, 2.0)],
            inverse_bind: core::array::from_fn(|_| rng.f32(-2.0, 2.0)),
        })
        .collect();
    let roles = rng.bool().then(|| {
        let mut next = 0u16;
        (0..n)
            .map(|_| {
                if rng.bool() {
                    next += rng.range(1, 3) as u16;
                    next
                } else {
                    NO_ROLE
                }
            })
            .collect()
    });
    let joint_ranges = rng.bool().then(|| {
        (0..n)
            .map(|_| {
                let lo = rng.f32(-180.0, 180.0);
                JointRange {
                    swing_y: rng.f32(0.0, 180.0),
                    swing_z: rng.f32(0.0, 180.0),
                    twist_min: lo,
                    twist_max: rng.f32(lo, 180.0),
                }
            })
            .collect()
    });
    let mirror = rng.bool().then(|| {
        // Pair neighbours, leave the rest as centre bones: an involution.
        let mut m: Vec<u32> = (0..n as u32).collect();
        let mut i = 0;
        while i + 1 < n {
            if rng.bool() {
                m.swap(i, i + 1);
                i += 2;
            } else {
                i += 1;
            }
        }
        m
    });
    Skeleton {
        name: rng.opt_id(strings.len()),
        profile: rng.opt_id(strings.len()),
        mirror_axis: rng.below(3),
        strings,
        bones,
        roles,
        joint_ranges,
        mirror,
    }
}

#[test]
fn round_trips_arbitrary_skeletons() {
    for seed in 0..400 {
        let mut rng = Rng::new(seed);
        let s = gen_skeleton(&mut rng);
        let bytes = s.write().unwrap_or_else(|e| panic!("seed {seed}: {e}"));
        check_layout(&bytes);
        let v = SkeletonView::parse(&bytes).unwrap();
        assert_eq!(v.to_skeleton(), s, "seed {seed}");
        assert_eq!(v.to_skeleton().write().unwrap(), bytes);
    }
}

fn sample() -> Skeleton {
    let strings = ["Hips", "Spine", "LeftUpLeg", "RightUpLeg", "Humanoid"]
        .map(String::from)
        .to_vec();
    let bone = |name, parent| Bone {
        name,
        parent,
        translation: [0.0, 1.0, 0.0],
        rotation: [0.0, 0.0, 0.0, 1.0],
        scale: [1.0; 3],
        inverse_bind: [1.0, 0.0, 0.0, 0.5, 0.0, 1.0, 0.0, -1.0, 0.0, 0.0, 1.0, 0.25],
    };
    Skeleton {
        name: 0,
        profile: 4,
        mirror_axis: 0,
        strings,
        bones: vec![bone(0, NO_PARENT), bone(1, 0), bone(2, 0), bone(3, 0)],
        roles: Some(vec![0, 1, 2, NO_ROLE]),
        joint_ranges: Some(vec![
            JointRange {
                swing_y: 45.0,
                swing_z: 30.0,
                twist_min: -20.0,
                twist_max: 20.0
            };
            4
        ]),
        mirror: Some(vec![0, 1, 3, 2]),
    }
}

#[test]
fn views_read_the_documented_layout() {
    let bytes = sample().write().unwrap();
    assert_eq!(&bytes[0..8], b"MYCOSKEL");
    let v = SkeletonView::parse(&bytes).unwrap();
    assert_eq!(v.bone_count(), 4);
    assert_eq!(v.parent(0), None);
    assert_eq!(v.parent(3), Some(0));
    assert_eq!(v.role(2), Some(2));
    assert_eq!(v.role(3), None);
    assert_eq!(v.joint_range(1).unwrap().swing_y, 45.0);
    assert_eq!(v.mirror().unwrap().to_vec(), vec![0, 1, 3, 2]);
    assert_eq!(v.strings().get(v.profile()), Some("Humanoid"));
    // BONES is 16-aligned and the inverse bind (row-major 3x4, translation in column 3) is at 48.
    let b = v.section(section::BONES).unwrap();
    assert_eq!(b.offset % 16, 0);
    let rec = b.offset as usize + 96; // bone 1
    assert_eq!(u16::from_le_bytes([bytes[rec + 4], bytes[rec + 5]]), 0);
    let f = |o: usize| f32::from_le_bytes(bytes[rec + o..rec + o + 4].try_into().unwrap());
    assert_eq!([f(48 + 12), f(48 + 28), f(48 + 44)], [0.5, -1.0, 0.25]);
    // The root's parent is stored as 0xFFFF.
    let root = b.offset as usize;
    assert_eq!(
        u16::from_le_bytes([bytes[root + 4], bytes[root + 5]]),
        0xFFFF
    );
}

#[test]
fn corrupt_and_truncated_buffers_are_refused() {
    let mut rng = Rng::new(3);
    check_refusals(
        &sample().write().unwrap(),
        |b| SkeletonView::parse(b).map(|_| ()),
        &mut rng,
    );
    for seed in 0..10 {
        let mut g = Rng::new(700 + seed);
        let bytes = gen_skeleton(&mut g).write().unwrap();
        check_refusals(&bytes, |b| SkeletonView::parse(b).map(|_| ()), &mut rng);
    }
}

#[test]
fn invalid_skeletons_are_refused() {
    let err = |f: &dyn Fn(&mut Skeleton)| {
        let mut s = sample();
        f(&mut s);
        s.write().expect_err("invalid skeleton written")
    };
    // Parents must come first.
    assert!(matches!(
        err(&|s| s.bones[1].parent = 1),
        FormatError::Inconsistent { .. }
    ));
    assert!(matches!(
        err(&|s| s.bones[1].parent = 3),
        FormatError::Inconsistent { .. }
    ));
    assert!(matches!(
        err(&|s| s.bones[0].name = 9),
        FormatError::IndexOutOfRange { .. }
    ));
    assert!(matches!(
        err(&|s| s.bones[2].rotation[0] = f32::NAN),
        FormatError::BadFloat { .. }
    ));
    assert!(matches!(
        err(&|s| s.roles = Some(vec![0, 1, 1, NO_ROLE])),
        FormatError::Inconsistent { .. }
    ));
    assert!(matches!(
        err(&|s| s.roles = Some(vec![0, 1, 2])),
        FormatError::BadCount { .. }
    ));
    assert!(matches!(
        err(&|s| s.mirror = Some(vec![0, 1, 3, 3])),
        FormatError::Inconsistent { .. }
    ));
    assert!(matches!(
        err(&|s| s.mirror = Some(vec![0, 1, 2, 4])),
        FormatError::IndexOutOfRange { .. }
    ));
    assert!(matches!(
        err(&|s| s.mirror_axis = 3),
        FormatError::InvalidValue { .. }
    ));
    assert!(matches!(
        err(&|s| s.joint_ranges.as_mut().unwrap()[0].twist_max = -30.0),
        FormatError::BadFloat {
            what: "joint range"
        }
    ));
    assert!(matches!(
        err(&|s| s.joint_ranges.as_mut().unwrap()[0].swing_z = 200.0),
        FormatError::BadFloat {
            what: "joint range"
        }
    ));
    assert!(matches!(
        err(&|s| s.profile = 77),
        FormatError::IndexOutOfRange { .. }
    ));
}

#[test]
fn bone_reserved_bytes_must_be_zero() {
    let mut bytes = sample().write().unwrap();
    let off = SkeletonView::parse(&bytes)
        .unwrap()
        .section(section::BONES)
        .unwrap()
        .offset as usize;
    bytes[off + 6] = 1;
    assert!(matches!(
        SkeletonView::parse(&bytes),
        Err(FormatError::NonZeroReserved { .. })
    ));
}
