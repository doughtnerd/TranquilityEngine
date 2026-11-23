//! Profiles: the built-in Humanoid, the boundary encoding (round trip and every refusal), the
//! bone map's role conversions, and the mirror table with flips.

mod common;

use anim_format::skeleton::JointRange;
use anim_math::layout::{soa_len, NO_PARENT};
use anim_math::{AosQuat, AosTransform, SoaTransform};
use anim_pose::mirror::{mirror_flipped, mirror_transform, Flip, FlipTable};
use anim_pose::Axis;
use anim_retarget::encode::{decode, encode, MAGIC};
use anim_retarget::profile::{humanoid as h, BoneMap, ChainKind, Profile, ProfileError};
use common::*;

#[test]
fn humanoid_profile_matches_godot_roles_and_is_valid() {
    let p = Profile::humanoid();
    p.validate().unwrap();
    assert_eq!(p.roles.len(), h::COUNT);
    let godot = [
        "Root",
        "Hips",
        "Spine",
        "Chest",
        "UpperChest",
        "Neck",
        "Head",
        "LeftEye",
        "RightEye",
        "Jaw",
        "LeftShoulder",
        "LeftUpperArm",
        "LeftLowerArm",
        "LeftHand",
        "LeftThumbMetacarpal",
        "LeftThumbProximal",
        "LeftThumbDistal",
        "LeftIndexProximal",
        "LeftIndexIntermediate",
        "LeftIndexDistal",
        "LeftMiddleProximal",
        "LeftMiddleIntermediate",
        "LeftMiddleDistal",
        "LeftRingProximal",
        "LeftRingIntermediate",
        "LeftRingDistal",
        "LeftLittleProximal",
        "LeftLittleIntermediate",
        "LeftLittleDistal",
    ];
    for (i, n) in godot.iter().enumerate() {
        assert_eq!(p.roles[i].name, *n);
        let right = n.replace("Left", "Right");
        if n.starts_with("Left") && i >= 10 {
            assert_eq!(p.roles[i + 19].name, right);
        }
    }
    for (r, n) in [
        (h::LEFT_UPPER_LEG, "LeftUpperLeg"),
        (h::RIGHT_TOES, "RightToes"),
        (h::LEFT_UPPER_ARM_TWIST, "LeftUpperArmTwist"),
        (h::RIGHT_LOWER_LEG_TWIST, "RightLowerLegTwist"),
    ] {
        assert_eq!(p.roles[r as usize].name, n);
    }
    // Mirror pairs.
    assert_eq!(p.roles[h::LEFT_HAND as usize].mirror, h::RIGHT_HAND);
    assert_eq!(p.roles[h::RIGHT_TOES as usize].mirror, h::LEFT_TOES);
    assert_eq!(p.roles[h::HEAD as usize].mirror, h::HEAD);
    // Chains: kinds, IK limbs, fingers.
    let c = |n: &str| &p.chains[p.chain(n).unwrap()];
    assert_eq!(
        c("LeftArm").roles,
        [
            h::LEFT_SHOULDER,
            h::LEFT_UPPER_ARM,
            h::LEFT_LOWER_ARM,
            h::LEFT_HAND
        ]
    );
    assert!(c("LeftArm").ik && c("RightLeg").ik && !c("Spine").ik);
    assert_eq!(c("RightLeg").kind, ChainKind::Leg);
    assert_eq!(
        p.chains
            .iter()
            .filter(|x| x.kind == ChainKind::Finger)
            .count(),
        10
    );
    assert_eq!(
        p.chains
            .iter()
            .filter(|x| x.kind == ChainKind::Twist)
            .count(),
        8
    );
    // Every role but Root and Hips has a joint range, all valid.
    for (i, r) in p.roles.iter().enumerate() {
        assert_eq!(r.range.is_some(), i >= 2, "{}", r.name);
    }
    assert_eq!(p.root, h::ROOT);
    assert_eq!(p.hips, h::HIPS);
}

#[test]
fn encoding_round_trips() {
    let mut p = Profile::humanoid();
    p.roles[h::LEFT_HAND as usize].flip = Some(Flip::Y);
    p.roles[h::RIGHT_HAND as usize].flip = Some(Flip::Y);
    let bytes = encode(&p).unwrap();
    assert_eq!(&bytes[..8], &MAGIC);
    assert_eq!(decode(&bytes).unwrap(), p);
}

fn malformed(bytes: &[u8]) -> &'static str {
    match decode(bytes) {
        Err(ProfileError::Malformed(what, _)) => what,
        other => panic!("expected a malformed refusal, got {other:?}"),
    }
}

fn invalid(bytes: &[u8]) -> &'static str {
    match decode(bytes) {
        Err(ProfileError::Invalid(what, _)) => what,
        other => panic!("expected an invalid refusal, got {other:?}"),
    }
}

/// A tiny two-role, one-chain profile and its bytes.
fn tiny() -> (Profile, Vec<u8>) {
    use anim_retarget::{Chain, Role};
    let p = Profile {
        name: "T".to_string(),
        roles: vec![
            Role {
                name: "A".to_string(),
                mirror: 0,
                flip: None,
                range: Some(JointRange {
                    swing_y: 10.0,
                    swing_z: 20.0,
                    twist_min: -5.0,
                    twist_max: 5.0,
                }),
                required: true,
            },
            Role {
                name: "B".to_string(),
                mirror: 1,
                flip: Some(Flip::X),
                range: None,
                required: false,
            },
        ],
        chains: vec![Chain {
            name: "C".to_string(),
            kind: ChainKind::Custom,
            roles: vec![0, 1],
            ik: false,
        }],
        root: 0xFFFF,
        hips: 0,
    };
    let b = encode(&p).unwrap();
    (p, b)
}

// Byte offsets in `tiny()`'s encoding.
const ROLE_A: usize = 20 + 2; // after the header and the 1-byte name "T"
const A_MIRROR: usize = ROLE_A + 2;
const A_FLIP: usize = A_MIRROR + 2;
const A_FLAGS: usize = A_FLIP + 1;
const A_RANGE: usize = A_FLAGS + 1;
const ROLE_B: usize = A_RANGE + 16;
const B_FLIP: usize = ROLE_B + 4;
const CHAIN: usize = ROLE_B + 2 + 2 + 2;
const C_KIND: usize = CHAIN + 2;
const C_FLAGS: usize = C_KIND + 1;
const C_COUNT: usize = C_FLAGS + 1;
const C_ROLES: usize = C_COUNT + 2;

#[test]
fn decode_refuses_malformed_bytes() {
    let (p, b) = tiny();
    assert_eq!(decode(&b).unwrap(), p);
    assert_eq!(b.len(), C_ROLES + 4);
    let with = |at: usize, v: &[u8]| {
        let mut x = b.clone();
        x[at..at + v.len()].copy_from_slice(v);
        x
    };
    assert_eq!(malformed(&with(0, b"MYCOPROX")), "magic");
    assert_eq!(malformed(&with(8, &2u32.to_le_bytes())), "version");
    assert_eq!(malformed(&with(12, &0u16.to_le_bytes())), "role count");
    assert_eq!(malformed(&with(14, &2000u16.to_le_bytes())), "chain count");
    // Truncation anywhere.
    for cut in 0..b.len() {
        assert!(decode(&b[..cut]).is_err(), "cut at {cut}");
    }
    let mut long = b.clone();
    long.push(0);
    assert_eq!(malformed(&long), "trailing bytes");
    assert_eq!(malformed(&with(ROLE_A, &[0])), "role name");
    assert_eq!(malformed(&with(ROLE_A + 1, &[0xFF])), "name is not UTF-8");
    assert_eq!(malformed(&with(A_FLIP, &[4])), "role flip");
    assert_eq!(malformed(&with(A_FLAGS, &[0x05])), "unknown role flags");
    assert_eq!(malformed(&with(B_FLIP, &[9])), "role flip");
    assert_eq!(malformed(&with(C_KIND, &[7])), "chain kind");
    assert_eq!(malformed(&with(C_FLAGS, &[2])), "unknown chain flags");
    assert_eq!(
        malformed(&with(C_COUNT, &0u16.to_le_bytes())),
        "chain role count"
    );
    assert_eq!(
        malformed(&with(C_COUNT, &3u16.to_le_bytes())),
        "chain role count"
    );
}

#[test]
fn decode_refuses_invalid_profiles() {
    let (_, b) = tiny();
    let with = |at: usize, v: &[u8]| {
        let mut x = b.clone();
        x[at..at + v.len()].copy_from_slice(v);
        x
    };
    assert_eq!(
        invalid(&with(A_MIRROR, &1u16.to_le_bytes())),
        "mirror map is not an involution"
    );
    assert_eq!(
        invalid(&with(A_MIRROR, &7u16.to_le_bytes())),
        "mirror map is not an involution"
    );
    assert_eq!(
        invalid(&with(A_RANGE, &f32::NAN.to_le_bytes())),
        "joint range"
    );
    assert_eq!(
        invalid(&with(A_RANGE, &200f32.to_le_bytes())),
        "joint range"
    );
    // twist min > max
    assert_eq!(
        invalid(&with(A_RANGE + 8, &10f32.to_le_bytes())),
        "joint range"
    );
    assert_eq!(invalid(&with(ROLE_B + 1, b"A")), "duplicate role name");
    assert_eq!(
        invalid(&with(C_ROLES, &9u16.to_le_bytes())),
        "chain role out of range"
    );
    assert_eq!(
        invalid(&with(C_ROLES + 2, &0u16.to_le_bytes())),
        "chain repeats a role"
    );
    assert_eq!(invalid(&with(C_FLAGS, &[1])), "IK chain needs three roles");
    assert_eq!(invalid(&with(16, &5u16.to_le_bytes())), "root role");
    assert_eq!(
        invalid(&with(16, &0u16.to_le_bytes())),
        "root and hips are the same role"
    );
    // encode refuses what decode would.
    let (mut p, _) = tiny();
    p.roles[1].mirror = 0;
    assert!(encode(&p).is_err());
}

#[test]
fn bone_map_role_conversions() {
    let mut m = BoneMap::new(4);
    m.set(0, 2);
    m.set(3, 0);
    m.set(9, 1); // out of range: ignored
    let roles = m.to_roles(3);
    assert_eq!(roles, [3, 0xFFFF, 0]);
    let back = BoneMap::from_roles(&roles, 4);
    assert_eq!(back.bones, m.bones);
    assert_eq!(back.confidence, [1.0, 0.0, 0.0, 1.0]);
    // A role on two bones keeps the first; out-of-range roles are ignored.
    let dup = BoneMap::from_roles(&[1, 1, 7], 4);
    assert_eq!(dup.bones, [0xFFFF, 0, 0xFFFF, 0xFFFF]);
}

/// The fixture with its right side's frames turned a half turn about local Z (model-space rest
/// rotations `M·I·M·C = C` on the right, identity elsewhere).
fn flipped_rig() -> Rig {
    let mut rig = humanoid(Build::default());
    let mut m = rig.rest_model();
    for (i, n) in rig.names.iter().enumerate() {
        if n.starts_with("Right") {
            m[i].rotation = Flip::Z.quat();
        }
    }
    for i in 0..rig.n() {
        let p = rig.parents[i];
        rig.rest[i] = if p == NO_PARENT {
            m[i]
        } else {
            let pm: AosTransform = m[p as usize];
            AosTransform::new(
                pm.rotation
                    .conjugate()
                    .rotate(m[i].translation - pm.translation),
                (pm.rotation.conjugate() * m[i].rotation).normalize_or_identity(),
                m[i].scale,
            )
        };
    }
    rig
}

#[test]
fn mirror_table_detects_flips_and_mirrors_with_them() {
    let rig = flipped_rig();
    let mut p = Profile::humanoid();
    let rest = rig.rest_model();
    let (partner, flips) = p.mirror_table(&rig.map, &rest, None, Axis::X);
    let (lh, rh) = (rig.index("LeftHand"), rig.index("RightHand"));
    assert_eq!(partner[lh] as usize, rh);
    assert_eq!(partner[rh] as usize, lh);
    assert_eq!(partner[0], 0);
    for (i, n) in rig.names.iter().enumerate() {
        let want = if n.starts_with("Left") || n.starts_with("Right") {
            Flip::Z
        } else {
            Flip::None
        };
        assert_eq!(flips[i], want, "{n}");
    }
    // A posed left arm mirrors onto the right at the reflected model positions and rotations.
    let mut pose = rig.rest.clone();
    for name in [
        "LeftShoulder",
        "LeftArm",
        "LeftForeArm",
        "LeftHand",
        "Spine",
    ] {
        let i = rig.index(name);
        pose[i].rotation = (pose[i].rotation * q(v(0.3, 1.0, -0.4), 0.7)).normalize_or_identity();
    }
    let mut out = vec![SoaTransform::identity(); soa_len(rig.n())];
    let table = FlipTable {
        parents: &rig.parents,
        flips: &flips,
    };
    mirror_flipped(&soa(&pose), &partner, Axis::X, Some(table), &mut out);
    let pm = model(&rig.parents, &pose);
    let mm = model(&rig.parents, &aos(&out, rig.n()));
    for i in 0..rig.n() {
        let s = partner[i] as usize;
        let want = mirror_transform(pm[s], Axis::X);
        assert!(
            (mm[i].translation - want.translation).length() < 1e-5,
            "{}",
            rig.names[i]
        );
        let wr: AosQuat = want.rotation * flips[i].quat();
        assert!(quat_close(mm[i].rotation, wr, 2e-6), "{}", rig.names[i]);
    }
    // The profile's explicit flip wins over the derived one.
    p.roles[h::LEFT_HAND as usize].flip = Some(Flip::Y);
    let (_, flips) = p.mirror_table(&rig.map, &rest, None, Axis::X);
    assert_eq!(flips[lh], Flip::Y);
    // A bone without a role takes the skeleton's mirror map, when given.
    let mut map = rig.map.clone();
    map.set(h::LEFT_HAND, 0xFFFF);
    let fallback: Vec<u32> = (0..rig.n() as u32)
        .map(|b| if b as usize == lh { rh as u32 } else { b })
        .collect();
    let (partner, _) = p.mirror_table(&map, &rest, Some(&fallback), Axis::X);
    assert_eq!(partner[lh] as usize, rh);
    let (partner, _) = p.mirror_table(&map, &rest, None, Axis::X);
    assert_eq!(partner[lh] as usize, lh);
}

#[test]
fn mirror_without_flips_needs_mirrored_frames() {
    // The unflipped fixture (identity frames, a mirror image on both sides) derives no flips.
    let rig = humanoid(Build::default());
    let (_, flips) = Profile::humanoid().mirror_table(&rig.map, &rig.rest_model(), None, Axis::X);
    assert!(flips.iter().all(|&f| f == Flip::None));
}
