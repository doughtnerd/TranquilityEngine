//! `guess_bone_map` against real-world naming sets (name + parent lists): Mixamo, the Unreal
//! mannequin, Blender Rigify's DEF bones, VRM/VRoid's J_Bip and 3ds Max Biped.

use anim_retarget::profile::humanoid as h;
use anim_retarget::{guess_bone_map, BoneMap, Chain, ChainKind, Profile, Role};

struct Set {
    names: Vec<String>,
    parents: Vec<u16>,
}

fn set(rows: &[(String, Option<String>)]) -> Set {
    let names: Vec<String> = rows.iter().map(|r| r.0.clone()).collect();
    let parents = rows
        .iter()
        .enumerate()
        .map(|(i, r)| match &r.1 {
            None => 0xFFFF,
            Some(p) => {
                let k = names.iter().position(|n| n == p).unwrap_or_else(|| panic!("no parent {p}"));
                assert!(k < i, "{} before its parent {p}", r.0);
                k as u16
            }
        })
        .collect();
    Set { names, parents }
}

struct Rows(Vec<(String, Option<String>)>);

impl Rows {
    fn add(&mut self, name: &str, parent: Option<&str>) {
        self.0.push((name.to_string(), parent.map(str::to_string)));
    }
    /// A chain of bones, each the parent of the next.
    fn chain(&mut self, parent: &str, names: &[String]) {
        let mut p = parent.to_string();
        for n in names {
            self.add(n, Some(&p));
            p = n.clone();
        }
    }
}

fn guess(s: &Set) -> BoneMap {
    let names: Vec<&str> = s.names.iter().map(String::as_str).collect();
    guess_bone_map(&names, &s.parents, &Profile::humanoid())
}

fn name_of<'a>(s: &'a Set, m: &BoneMap, role: u16) -> Option<&'a str> {
    m.bone(role).map(|b| s.names[b as usize].as_str())
}

fn expect(s: &Set, m: &BoneMap, pairs: &[(u16, &str)]) {
    let p = Profile::humanoid();
    for &(role, want) in pairs {
        assert_eq!(
            name_of(s, m, role),
            Some(want),
            "role {}",
            p.roles[role as usize].name
        );
    }
}

/// Every required role, both shoulders, all 30 fingers and both toes.
fn assert_full(s: &Set, m: &BoneMap, what: &str) {
    let p = Profile::humanoid();
    assert!(m.missing_required(&p).is_empty(), "{what}: missing {:?}", m.missing_required(&p));
    let mut want: Vec<u16> = vec![h::LEFT_SHOULDER, h::RIGHT_SHOULDER, h::LEFT_TOES, h::RIGHT_TOES];
    want.extend(h::LEFT_FINGERS..h::LEFT_FINGERS + 15);
    want.extend(h::RIGHT_FINGERS..h::RIGHT_FINGERS + 15);
    for r in want {
        assert!(
            m.bone(r).is_some(),
            "{what}: {} unmapped",
            p.roles[r as usize].name
        );
    }
    // No bone serves two roles, and every confidence is in range.
    let mut used: Vec<u16> = m.bones.iter().copied().filter(|&b| b != 0xFFFF).collect();
    let n = used.len();
    used.sort();
    used.dedup();
    assert_eq!(used.len(), n, "{what}: a bone has two roles");
    for (r, &c) in m.confidence.iter().enumerate() {
        assert!((0.0..=1.0).contains(&c));
        assert_eq!(c > 0.0, m.bones[r] != 0xFFFF, "{what}: role {r} confidence");
    }
    // Deterministic.
    assert_eq!(guess(s), *m);
    let _ = s;
}

fn mixamo() -> Set {
    let mut r = Rows(Vec::new());
    let m = |x: &str| format!("mixamorig:{x}");
    r.add(&m("Hips"), None);
    r.chain(&m("Hips"), &[m("Spine"), m("Spine1"), m("Spine2"), m("Neck"), m("Head"), m("HeadTop_End")]);
    r.add(&m("LeftEye"), Some(&m("Head")));
    r.add(&m("RightEye"), Some(&m("Head")));
    for side in ["Left", "Right"] {
        let s = |x: &str| m(&format!("{side}{x}"));
        r.chain(&m("Spine2"), &[s("Shoulder"), s("Arm"), s("ForeArm"), s("Hand")]);
        for f in ["Thumb", "Index", "Middle", "Ring", "Pinky"] {
            let bones: Vec<String> = (1..=4).map(|i| s(&format!("Hand{f}{i}"))).collect();
            r.chain(&s("Hand"), &bones);
        }
    }
    for side in ["Left", "Right"] {
        let s = |x: &str| m(&format!("{side}{x}"));
        r.chain(&m("Hips"), &[s("UpLeg"), s("Leg"), s("Foot"), s("ToeBase"), s("Toe_End")]);
    }
    set(&r.0)
}

#[test]
fn mixamo_is_fully_mapped() {
    let s = mixamo();
    let m = guess(&s);
    assert_full(&s, &m, "mixamo");
    expect(
        &s,
        &m,
        &[
            (h::HIPS, "mixamorig:Hips"),
            (h::SPINE, "mixamorig:Spine"),
            (h::CHEST, "mixamorig:Spine1"),
            (h::UPPER_CHEST, "mixamorig:Spine2"),
            (h::NECK, "mixamorig:Neck"),
            (h::HEAD, "mixamorig:Head"),
            (h::LEFT_EYE, "mixamorig:LeftEye"),
            (h::LEFT_UPPER_ARM, "mixamorig:LeftArm"),
            (h::LEFT_LOWER_ARM, "mixamorig:LeftForeArm"),
            (h::RIGHT_HAND, "mixamorig:RightHand"),
            (h::LEFT_UPPER_LEG, "mixamorig:LeftUpLeg"),
            (h::LEFT_LOWER_LEG, "mixamorig:LeftLeg"),
            (h::RIGHT_TOES, "mixamorig:RightToeBase"),
            (h::LEFT_FINGERS, "mixamorig:LeftHandThumb1"),
            (h::LEFT_FINGERS + 14, "mixamorig:LeftHandPinky3"),
        ],
    );
    assert_eq!(m.bone(h::ROOT), None, "Mixamo's hips is the root");
    assert_eq!(m.confidence[h::HIPS as usize], 1.0);
}

fn unreal() -> Set {
    let mut r = Rows(Vec::new());
    r.add("root", None);
    r.chain("root", &["pelvis", "spine_01", "spine_02", "spine_03"].map(String::from));
    for s in ["l", "r"] {
        let n = |x: &str| format!("{x}_{s}");
        r.chain("spine_03", &[n("clavicle"), n("upperarm"), n("lowerarm"), n("hand")]);
        for f in ["index", "middle", "pinky", "ring", "thumb"] {
            let bones: Vec<String> = (1..=3).map(|i| n(&format!("{f}_0{i}"))).collect();
            r.chain(&n("hand"), &bones);
        }
        r.add(&n("lowerarm_twist_01"), Some(&n("lowerarm")));
        r.add(&n("upperarm_twist_01"), Some(&n("upperarm")));
    }
    r.chain("spine_03", &["neck_01", "head"].map(String::from));
    for s in ["l", "r"] {
        let n = |x: &str| format!("{x}_{s}");
        r.chain("pelvis", &[n("thigh"), n("calf")]);
        r.add(&n("calf_twist_01"), Some(&n("calf")));
        r.chain(&n("calf"), &[n("foot"), n("ball")]);
        r.add(&n("thigh_twist_01"), Some(&n("thigh")));
    }
    r.add("ik_foot_root", Some("root"));
    r.add("ik_foot_l", Some("ik_foot_root"));
    r.add("ik_foot_r", Some("ik_foot_root"));
    r.add("ik_hand_root", Some("root"));
    r.add("ik_hand_gun", Some("ik_hand_root"));
    r.add("ik_hand_l", Some("ik_hand_gun"));
    r.add("ik_hand_r", Some("ik_hand_gun"));
    set(&r.0)
}

#[test]
fn unreal_mannequin_is_fully_mapped() {
    let s = unreal();
    let m = guess(&s);
    assert_full(&s, &m, "unreal");
    expect(
        &s,
        &m,
        &[
            (h::ROOT, "root"),
            (h::HIPS, "pelvis"),
            (h::SPINE, "spine_01"),
            (h::CHEST, "spine_02"),
            (h::UPPER_CHEST, "spine_03"),
            (h::NECK, "neck_01"),
            (h::HEAD, "head"),
            (h::LEFT_SHOULDER, "clavicle_l"),
            (h::LEFT_UPPER_ARM, "upperarm_l"),
            (h::LEFT_LOWER_ARM, "lowerarm_l"),
            (h::LEFT_HAND, "hand_l"),
            (h::RIGHT_UPPER_ARM_TWIST, "upperarm_twist_01_r"),
            (h::LEFT_LOWER_ARM_TWIST, "lowerarm_twist_01_l"),
            (h::LEFT_UPPER_LEG, "thigh_l"),
            (h::LEFT_LOWER_LEG, "calf_l"),
            (h::LEFT_FOOT, "foot_l"),
            (h::LEFT_TOES, "ball_l"),
            (h::LEFT_UPPER_LEG_TWIST, "thigh_twist_01_l"),
            (h::RIGHT_LOWER_LEG_TWIST, "calf_twist_01_r"),
            (h::LEFT_FINGERS, "thumb_01_l"),
            (h::LEFT_FINGERS + 3, "index_01_l"),
            (h::RIGHT_FINGERS + 12, "pinky_01_r"),
        ],
    );
}

fn rigify() -> Set {
    let mut r = Rows(Vec::new());
    r.add("DEF-spine", None);
    let spine: Vec<String> = (1..=6).map(|i| format!("DEF-spine.00{i}")).collect();
    r.chain("DEF-spine", &spine[..3]);
    for s in ["L", "R"] {
        let n = |x: &str| format!("DEF-{x}.{s}");
        r.chain(
            "DEF-spine.003",
            &[n("shoulder"), n("upper_arm"), format!("{}.001", n("upper_arm")), n("forearm"), format!("{}.001", n("forearm")), n("hand")],
        );
        // Palms 1-4 under the hand carry index..pinky; the thumb hangs off palm 1.
        for (k, f) in ["f_index", "f_middle", "f_ring", "f_pinky"].iter().enumerate() {
            let palm = format!("DEF-palm.0{}.{s}", k + 1);
            r.add(&palm, Some(&n("hand")));
            let bones: Vec<String> = (1..=3).map(|i| format!("DEF-{f}.0{i}.{s}")).collect();
            r.chain(&palm, &bones);
        }
        let thumb: Vec<String> = (1..=3).map(|i| format!("DEF-thumb.0{i}.{s}")).collect();
        r.chain(&format!("DEF-palm.01.{s}"), &thumb);
        r.add(&n("breast"), Some("DEF-spine.003"));
    }
    r.chain("DEF-spine.003", &spine[3..]);
    for s in ["L", "R"] {
        let n = |x: &str| format!("DEF-{x}.{s}");
        r.add(&n("pelvis"), Some("DEF-spine"));
        r.chain(
            "DEF-spine",
            &[n("thigh"), format!("{}.001", n("thigh")), n("shin"), format!("{}.001", n("shin")), n("foot"), n("toe")],
        );
    }
    set(&r.0)
}

#[test]
fn rigify_def_bones_are_fully_mapped() {
    let s = rigify();
    let m = guess(&s);
    assert_full(&s, &m, "rigify");
    expect(
        &s,
        &m,
        &[
            (h::HIPS, "DEF-spine"),
            (h::SPINE, "DEF-spine.001"),
            (h::CHEST, "DEF-spine.002"),
            (h::UPPER_CHEST, "DEF-spine.003"),
            (h::NECK, "DEF-spine.004"),
            (h::HEAD, "DEF-spine.006"),
            (h::LEFT_SHOULDER, "DEF-shoulder.L"),
            (h::LEFT_UPPER_ARM, "DEF-upper_arm.L"),
            (h::LEFT_UPPER_ARM_TWIST, "DEF-upper_arm.L.001"),
            (h::LEFT_LOWER_ARM, "DEF-forearm.L"),
            (h::LEFT_LOWER_ARM_TWIST, "DEF-forearm.L.001"),
            (h::RIGHT_HAND, "DEF-hand.R"),
            (h::LEFT_UPPER_LEG, "DEF-thigh.L"),
            (h::LEFT_UPPER_LEG_TWIST, "DEF-thigh.L.001"),
            (h::LEFT_LOWER_LEG, "DEF-shin.L"),
            (h::RIGHT_LOWER_LEG_TWIST, "DEF-shin.R.001"),
            (h::LEFT_FOOT, "DEF-foot.L"),
            (h::LEFT_TOES, "DEF-toe.L"),
            (h::LEFT_FINGERS, "DEF-thumb.01.L"),
            (h::LEFT_FINGERS + 5, "DEF-f_index.03.L"),
        ],
    );
    // The neck has no name to go by, so it is a topology guess.
    assert!(m.confidence[h::NECK as usize] < 1.0);
}

fn vrm() -> Set {
    let mut r = Rows(Vec::new());
    let c = |x: &str| format!("J_Bip_C_{x}");
    r.add("Root", None);
    r.add(&c("Hips"), Some("Root"));
    r.chain(&c("Hips"), &[c("Spine"), c("Chest"), c("UpperChest"), c("Neck"), c("Head")]);
    r.add("J_Adj_L_FaceEye", Some(&c("Head")));
    r.add("J_Adj_R_FaceEye", Some(&c("Head")));
    r.add("J_Sec_Hair1_01", Some(&c("Head")));
    for s in ["L", "R"] {
        let n = |x: &str| format!("J_Bip_{s}_{x}");
        r.chain(&c("UpperChest"), &[n("Shoulder"), n("UpperArm"), n("LowerArm"), n("Hand")]);
        for f in ["Thumb", "Index", "Middle", "Ring", "Little"] {
            let bones: Vec<String> = (1..=3).map(|i| n(&format!("{f}{i}"))).collect();
            r.chain(&n("Hand"), &bones);
        }
    }
    for s in ["L", "R"] {
        let n = |x: &str| format!("J_Bip_{s}_{x}");
        r.chain(&c("Hips"), &[n("UpperLeg"), n("LowerLeg"), n("Foot"), n("ToeBase")]);
    }
    set(&r.0)
}

#[test]
fn vrm_j_bip_is_fully_mapped() {
    let s = vrm();
    let m = guess(&s);
    assert_full(&s, &m, "vrm");
    expect(
        &s,
        &m,
        &[
            (h::ROOT, "Root"),
            (h::HIPS, "J_Bip_C_Hips"),
            (h::SPINE, "J_Bip_C_Spine"),
            (h::CHEST, "J_Bip_C_Chest"),
            (h::UPPER_CHEST, "J_Bip_C_UpperChest"),
            (h::NECK, "J_Bip_C_Neck"),
            (h::HEAD, "J_Bip_C_Head"),
            (h::LEFT_EYE, "J_Adj_L_FaceEye"),
            (h::RIGHT_EYE, "J_Adj_R_FaceEye"),
            (h::LEFT_UPPER_ARM, "J_Bip_L_UpperArm"),
            (h::RIGHT_LOWER_LEG, "J_Bip_R_LowerLeg"),
            (h::LEFT_TOES, "J_Bip_L_ToeBase"),
            (h::RIGHT_FINGERS + 14, "J_Bip_R_Little3"),
        ],
    );
}

fn biped() -> Set {
    let mut r = Rows(Vec::new());
    let b = |x: &str| format!("Bip01 {x}");
    r.add("Bip01", None);
    r.add(&b("Pelvis"), Some("Bip01"));
    r.add(&b("Spine"), Some(&b("Pelvis")));
    for s in ["L", "R"] {
        let n = |x: &str| b(&format!("{s} {x}"));
        r.chain(&b("Spine"), &[n("Thigh"), n("Calf"), n("Foot"), n("Toe0"), n("Toe0Nub")]);
    }
    r.chain(&b("Spine"), &[b("Spine1"), b("Spine2"), b("Neck")]);
    for s in ["L", "R"] {
        let n = |x: &str| b(&format!("{s} {x}"));
        r.chain(&b("Neck"), &[n("Clavicle"), n("UpperArm"), n("Forearm"), n("Hand")]);
        for f in 0..5 {
            let bones = [n(&format!("Finger{f}")), n(&format!("Finger{f}1")), n(&format!("Finger{f}2")), n(&format!("Finger{f}Nub"))];
            r.chain(&n("Hand"), &bones);
        }
    }
    r.chain(&b("Neck"), &[b("Head"), b("HeadNub")]);
    r.add(&b("Footsteps"), Some("Bip01"));
    set(&r.0)
}

#[test]
fn biped_is_fully_mapped() {
    let s = biped();
    let m = guess(&s);
    assert_full(&s, &m, "biped");
    expect(
        &s,
        &m,
        &[
            (h::ROOT, "Bip01"),
            (h::HIPS, "Bip01 Pelvis"),
            (h::SPINE, "Bip01 Spine"),
            (h::CHEST, "Bip01 Spine1"),
            (h::UPPER_CHEST, "Bip01 Spine2"),
            (h::NECK, "Bip01 Neck"),
            (h::HEAD, "Bip01 Head"),
            (h::LEFT_SHOULDER, "Bip01 L Clavicle"),
            (h::LEFT_LOWER_ARM, "Bip01 L Forearm"),
            (h::RIGHT_UPPER_LEG, "Bip01 R Thigh"),
            (h::RIGHT_LOWER_LEG, "Bip01 R Calf"),
            (h::LEFT_TOES, "Bip01 L Toe0"),
            (h::LEFT_FINGERS, "Bip01 L Finger0"),
            (h::LEFT_FINGERS + 2, "Bip01 L Finger02"),
            (h::LEFT_FINGERS + 12, "Bip01 L Finger4"),
        ],
    );
    // The root has no telling name: a topology guess.
    assert!(m.confidence[h::ROOT as usize] < 1.0);
}

#[test]
fn custom_profile_roles_match_by_name() {
    // A custom profile: two Humanoid roles (by name) and a tail chain matched by normalised name.
    let role = |name: &str, mirror: u16| Role {
        name: name.to_string(),
        mirror,
        flip: None,
        range: None,
        required: false,
    };
    let p = Profile {
        name: "Creature".to_string(),
        roles: vec![role("Hips", 0), role("Head", 1), role("Tail1", 2), role("Tail2", 3), role("LeftWing", 5), role("RightWing", 4)],
        chains: vec![Chain {
            name: "Tail".to_string(),
            kind: ChainKind::Custom,
            roles: vec![2, 3],
            ik: false,
        }],
        root: 0xFFFF,
        hips: 0,
    };
    p.validate().unwrap();
    let mut s = mixamo();
    let n = s.names.len() as u16;
    let hips = s.names.iter().position(|x| x == "mixamorig:Hips").unwrap() as u16;
    s.names.extend(["DEF-tail_1", "DEF-tail_2", "wing.L", "wing.R"].map(String::from));
    s.parents.extend([hips, n, hips, hips]);
    let names: Vec<&str> = s.names.iter().map(String::as_str).collect();
    let m = guess_bone_map(&names, &s.parents, &p);
    let got: Vec<Option<&str>> = (0..6).map(|r| m.bone(r).map(|b| s.names[b as usize].as_str())).collect();
    assert_eq!(
        got,
        [
            Some("mixamorig:Hips"),
            Some("mixamorig:Head"),
            Some("DEF-tail_1"),
            Some("DEF-tail_2"),
            Some("wing.L"),
            Some("wing.R")
        ]
    );
    assert_eq!(m.confidence[2], 0.8);
}

#[test]
fn degenerate_input_never_panics() {
    let p = Profile::humanoid();
    assert!(guess_bone_map(&[], &[], &p).bones.iter().all(|&b| b == 0xFFFF));
    // Parents that break the order count as roots; mismatched lengths use the shorter.
    let m = guess_bone_map(&["Hips", "LeftFoot", "x"], &[5, 0], &p);
    assert_eq!(m.bones.len(), p.roles.len());
}
