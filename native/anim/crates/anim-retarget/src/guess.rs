//! [`guess_bone_map`]: fills a profile's roles from a skeleton's bone names and parents (Godot's
//! bone-map guessing, ADR 0341's import-time `boneMap`), in Rust so TypeScript only calls it.
//!
//! # How
//!
//! 1. **Names to labels.** Each name is cut to its last namespace (`mixamorig:Hips` → `Hips`), split
//!    into lower-case tokens at separators, camel-case humps and letter/digit edges, and cleared of
//!    rig prefixes (`DEF`, `ORG`, `MCH`, `J`, `Bip`/`Bip01`, `mixamorig`, `Adj`, `Sec`, `C` for
//!    centre). A side comes from `left`/`l` or `right`/`r` tokens, so `_l`, `.L`, `Left…`,
//!    `left_`, `_L_` and `Bip01 L` all work. The rest maps to a label through synonyms (thigh,
//!    upLeg, upperleg → upper leg; calf, shin, knee, lowerleg and a bare `leg` → lower leg;
//!    clavicle, collar → shoulder; forearm, lowerarm, elbow → lower arm; a bare `arm` → upper
//!    arm; toe, ball → toes; pelvis, hips → hips; `fingerN…` digits → Biped fingers…). End,
//!    nub, tip, IK, pole and control bones are ignored.
//! 2. **Topology.** Hands and feet are found by label; each limb is walked up from them (a run of
//!    same-labelled bones is one segment plus in-line twist bones); the hips is the labelled hips
//!    above both legs, else their nearest common ancestor; the spine is the path from the hips to
//!    the common ancestor of both arms; the neck and head continue above it; fingers, toes, eyes,
//!    jaw and off-path twist bones are looked for under their parent bone. A role found by label
//!    and topology has confidence 1, by topology alone 0.6; a left/right pair at different depths
//!    gets 0.9 of that.
//! 3. Roles of other profiles whose names are Humanoid role names take the Humanoid result; any
//!    other role matches a bone whose normalised name equals the role's (confidence 0.8).
//!
//! Ties always go to the shallower bone, then the lower index, so the guess is deterministic.

use crate::profile::{humanoid as h, BoneMap, Profile, NO_BONE};
use anim_format::skeleton::NO_PARENT;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Side {
    Centre,
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Label {
    Unknown,
    Ignore,
    Root,
    Hips,
    Spine,
    Chest,
    UpperChest,
    Neck,
    Head,
    Eye,
    Jaw,
    Shoulder,
    UpperArm,
    LowerArm,
    Hand,
    UpperLeg,
    LowerLeg,
    Foot,
    Toes,
    /// A finger bone: 0 thumb, 1 index, 2 middle, 3 ring, 4 little; whether it's a metacarpal.
    Finger(u8, bool),
    /// A twist bone of the segment with this label.
    Twist(Seg),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Seg {
    UpperArm,
    LowerArm,
    UpperLeg,
    LowerLeg,
    Unknown,
}

const TOPOLOGY: f32 = 0.6;
const NAMED: f32 = 1.0;

/// Splits a bone name into lower-case tokens (see the module docs).
fn tokens(name: &str) -> Vec<String> {
    let base = name.rsplit([':', '|']).next().unwrap_or(name);
    let chars: Vec<char> = base.chars().collect();
    let mut out = Vec::new();
    let mut cur = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if !c.is_alphanumeric() {
            if !cur.is_empty() {
                out.push(core::mem::take(&mut cur));
            }
            continue;
        }
        if let Some(&p) = cur.chars().last().as_ref() {
            let next_lower = chars.get(i + 1).is_some_and(|n| n.is_lowercase());
            let split = (p.is_lowercase() && c.is_uppercase())
                || (p.is_alphabetic() != c.is_alphabetic())
                || (p.is_uppercase() && c.is_uppercase() && next_lower);
            if split {
                out.push(core::mem::take(&mut cur));
            }
        }
        cur.push(c);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out.iter().map(|t| t.to_lowercase()).collect()
}

fn is_number(t: &str) -> bool {
    !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit())
}

/// A bone name's side and label.
fn classify(name: &str) -> (Side, Label) {
    let mut t = tokens(name);
    // Rig prefixes. `bip` (and `bip01`'s number) only at the front.
    let mut i = 0;
    while i < t.len() {
        let drop = match t[i].as_str() {
            "mixamorig" | "def" | "org" | "mch" | "j" | "adj" | "sec" | "c" | "jnt" | "bn"
            | "bone" | "b" => true,
            "bip" => {
                if t.get(i + 1).is_some_and(|n| is_number(n)) {
                    t.remove(i + 1);
                }
                true
            }
            _ => false,
        };
        if drop {
            t.remove(i);
        } else {
            i += 1;
        }
    }
    let mut side = Side::Centre;
    t.retain(|x| match x.as_str() {
        "l" | "left" | "lft" => {
            side = Side::Left;
            false
        }
        "r" | "right" | "rgt" => {
            side = Side::Right;
            false
        }
        _ => true,
    });
    (side, label(&t, side))
}

fn label(t: &[String], side: Side) -> Label {
    let has = |w: &str| t.iter().any(|x| x == w);
    let any = |ws: &[&str]| ws.iter().any(|w| has(w));
    if t.is_empty() {
        return Label::Unknown;
    }
    if any(&[
        "end", "nub", "tip", "top", "null", "ik", "pole", "ctrl", "ctl", "helper", "dummy",
        "socket", "attach", "prop", "weapon", "target", "footsteps", "ref",
    ]) {
        return Label::Ignore;
    }
    let lower_arm = any(&["forearm", "lowerarm", "elbow", "fore"]) || (has("lower") && has("arm"));
    let upper_arm = any(&["upperarm", "uparm", "humerus"])
        || (has("arm") && (has("upper") || has("up")))
        || (has("arm") && !lower_arm);
    let lower_leg = any(&["calf", "shin", "knee", "lowerleg", "crus"]) || (has("lower") && has("leg"));
    let upper_leg = any(&["thigh", "upleg", "upperleg", "femur"])
        || (has("leg") && (has("upper") || has("up")));
    if any(&["twist", "roll"]) {
        let seg = if lower_arm {
            Seg::LowerArm
        } else if upper_arm {
            Seg::UpperArm
        } else if lower_leg {
            Seg::LowerLeg
        } else if upper_leg {
            Seg::UpperLeg
        } else {
            Seg::Unknown
        };
        return Label::Twist(seg);
    }
    let meta = any(&["metacarpal", "meta", "carpal"]);
    for (k, names) in [
        (0u8, &["thumb"][..]),
        (1, &["index", "pointer"][..]),
        (2, &["middle", "mid"][..]),
        (3, &["ring"][..]),
        (4, &["little", "pinky", "pinkie", "small"][..]),
    ] {
        if any(names) {
            return Label::Finger(k, meta);
        }
    }
    if let Some(p) = t.iter().position(|x| x == "finger" || x == "fingers") {
        if let Some(d) = t.get(p + 1).and_then(|n| n.bytes().next()) {
            if d.is_ascii_digit() && d <= b'4' {
                return Label::Finger(d - b'0', meta);
            }
        }
        return Label::Unknown;
    }
    if has("eye") {
        return Label::Eye;
    }
    if has("jaw") {
        return Label::Jaw;
    }
    if any(&["hand", "wrist"]) {
        return Label::Hand;
    }
    if lower_arm {
        return Label::LowerArm;
    }
    if upper_arm {
        return Label::UpperArm;
    }
    if any(&["shoulder", "clavicle", "collar", "clav"]) {
        return Label::Shoulder;
    }
    if any(&["foot", "ankle"]) {
        return Label::Foot;
    }
    if any(&["toe", "toes", "ball", "toebase"]) {
        return Label::Toes;
    }
    if lower_leg {
        return Label::LowerLeg;
    }
    if upper_leg {
        return Label::UpperLeg;
    }
    if has("leg") {
        return Label::LowerLeg;
    }
    if has("head") {
        return Label::Head;
    }
    if has("neck") {
        return Label::Neck;
    }
    if side == Side::Centre && any(&["hips", "hip", "pelvis"]) {
        return Label::Hips;
    }
    if has("upperchest") || (has("upper") && has("chest")) {
        return Label::UpperChest;
    }
    if any(&["chest", "ribcage", "thorax"]) {
        return Label::Chest;
    }
    if any(&["spine", "abdomen", "torso", "waist"]) {
        return Label::Spine;
    }
    if side == Side::Centre && any(&["root", "armature"]) {
        return Label::Root;
    }
    Label::Unknown
}

struct Tree<'a> {
    parents: &'a [u16],
    depth: Vec<u32>,
    children: Vec<Vec<u16>>,
    side: Vec<Side>,
    label: Vec<Label>,
}

impl Tree<'_> {
    fn parent(&self, b: u16) -> Option<u16> {
        let p = self.parents[b as usize];
        (p != NO_PARENT && (p as usize) < self.parents.len()).then_some(p)
    }

    /// Whether `a` is a proper ancestor of `b`.
    fn is_ancestor(&self, a: u16, b: u16) -> bool {
        let mut c = self.parent(b);
        while let Some(p) = c {
            if p == a {
                return true;
            }
            c = self.parent(p);
        }
        false
    }

    fn common_ancestor(&self, a: u16, b: u16) -> Option<u16> {
        let mut c = Some(a);
        while let Some(x) = c {
            if x == b || self.is_ancestor(x, b) {
                return Some(x);
            }
            c = self.parent(x);
        }
        None
    }

    /// The best bone among `cands`: shallowest, then lowest index.
    fn best(&self, cands: impl Iterator<Item = u16>) -> Option<u16> {
        cands.min_by_key(|&b| (self.depth[b as usize], b))
    }

    fn with_label(&self, l: Label, side: Side) -> Option<u16> {
        self.best((0..self.parents.len() as u16).filter(|&b| {
            self.label[b as usize] == l && self.side[b as usize] == side
        }))
    }

    /// Descendants of `root` (not `root`), in index order (parents first means a descendant has
    /// a larger index).
    fn descendants(&self, root: u16) -> impl Iterator<Item = u16> + '_ {
        (root + 1..self.parents.len() as u16).filter(move |&b| self.is_ancestor(root, b))
    }

    /// The height of `b`'s subtree, ignoring Ignore-labelled bones.
    fn height(&self, b: u16) -> u32 {
        self.children[b as usize]
            .iter()
            .filter(|&&c| self.label[c as usize] != Label::Ignore)
            .map(|&c| 1 + self.height(c))
            .max()
            .unwrap_or(0)
    }

    /// Walks up from `from` (exclusive) for the first run of bones labelled `l`. Returns the run's
    /// top bone and the one below it (an in-line twist segment), or `None`.
    fn run_above(&self, from: u16, l: Label) -> Option<(u16, Option<u16>)> {
        let mut c = self.parent(from);
        let mut run: Vec<u16> = Vec::new();
        while let Some(p) = c {
            if self.label[p as usize] == l {
                run.push(p);
            } else if !run.is_empty() {
                break;
            }
            c = self.parent(p);
        }
        let top = *run.last()?;
        let below = run.len().checked_sub(2).map(|i| run[i]);
        Some((top, below))
    }
}

struct Guess {
    bones: Vec<u16>,
    conf: Vec<f32>,
}

impl Guess {
    fn set(&mut self, role: u16, bone: u16, conf: f32) {
        if self.bones.contains(&bone) {
            return;
        }
        self.bones[role as usize] = bone;
        self.conf[role as usize] = conf;
    }
    fn get(&self, role: u16) -> Option<u16> {
        let b = self.bones[role as usize];
        (b != NO_BONE).then_some(b)
    }
}

/// Guesses the Humanoid roles (indices of [`h`]).
fn guess_humanoid(t: &Tree<'_>) -> Guess {
    let mut g = Guess {
        bones: vec![NO_BONE; h::COUNT],
        conf: vec![0.0; h::COUNT],
    };
    let conf = |b: u16, l: Label| if t.label[b as usize] == l { NAMED } else { TOPOLOGY };
    struct Limb {
        hand: u16,
        lower: u16,
        upper: u16,
        lower_twist: u16,
        upper_twist: u16,
    }
    // Limbs, walked up from the hand or foot.
    let limb = |side: Side, tip_l: Label, lower_l: Label, upper_l: Label| {
        let tip = t.with_label(tip_l, side)?;
        let (lower, lower_twist) = match t.run_above(tip, lower_l) {
            Some((top, below)) => (top, below),
            None => (t.parent(tip)?, None),
        };
        let (upper, upper_twist) = match t.run_above(lower, upper_l) {
            Some((top, below)) => (top, below),
            None => (t.parent(lower)?, None),
        };
        Some(Limb {
            hand: tip,
            lower,
            upper,
            lower_twist: lower_twist.unwrap_or(NO_BONE),
            upper_twist: upper_twist.unwrap_or(NO_BONE),
        })
    };
    let sides = [(Side::Left, 0usize), (Side::Right, 1usize)];
    let mut legs: [Option<Limb>; 2] = [None, None];
    let mut arms: [Option<Limb>; 2] = [None, None];
    for (side, k) in sides {
        legs[k] = limb(side, Label::Foot, Label::LowerLeg, Label::UpperLeg);
        arms[k] = limb(side, Label::Hand, Label::LowerArm, Label::UpperArm);
    }
    let leg_roles = [
        [h::LEFT_FOOT, h::LEFT_LOWER_LEG, h::LEFT_UPPER_LEG, h::LEFT_LOWER_LEG_TWIST, h::LEFT_UPPER_LEG_TWIST],
        [h::RIGHT_FOOT, h::RIGHT_LOWER_LEG, h::RIGHT_UPPER_LEG, h::RIGHT_LOWER_LEG_TWIST, h::RIGHT_UPPER_LEG_TWIST],
    ];
    let arm_roles = [
        [h::LEFT_HAND, h::LEFT_LOWER_ARM, h::LEFT_UPPER_ARM, h::LEFT_LOWER_ARM_TWIST, h::LEFT_UPPER_ARM_TWIST],
        [h::RIGHT_HAND, h::RIGHT_LOWER_ARM, h::RIGHT_UPPER_ARM, h::RIGHT_LOWER_ARM_TWIST, h::RIGHT_UPPER_ARM_TWIST],
    ];
    let labels_leg = [Label::Foot, Label::LowerLeg, Label::UpperLeg];
    let labels_arm = [Label::Hand, Label::LowerArm, Label::UpperArm];
    for (k, l) in legs.iter().enumerate() {
        if let Some(l) = l {
            for (i, &b) in [l.hand, l.lower, l.upper].iter().enumerate() {
                g.set(leg_roles[k][i], b, conf(b, labels_leg[i]));
            }
        }
    }
    for (k, l) in arms.iter().enumerate() {
        if let Some(l) = l {
            for (i, &b) in [l.hand, l.lower, l.upper].iter().enumerate() {
                g.set(arm_roles[k][i], b, conf(b, labels_arm[i]));
            }
        }
    }
    // Twist bones: in-line segments first, then off-path bones labelled twist under the segment.
    let twist = |g: &mut Guess, role: u16, inline: u16, seg_bone: u16, seg: Seg| {
        if inline != NO_BONE {
            g.set(role, inline, NAMED);
            return;
        }
        let c = t.best(t.descendants(seg_bone).filter(|&b| match t.label[b as usize] {
            Label::Twist(s) => s == seg || (s == Seg::Unknown && t.parent(b) == Some(seg_bone)),
            _ => false,
        }));
        if let Some(b) = c {
            g.set(role, b, NAMED);
        }
    };
    for k in 0..2 {
        if let Some(l) = &legs[k] {
            twist(&mut g, leg_roles[k][3], l.lower_twist, l.lower, Seg::LowerLeg);
            twist(&mut g, leg_roles[k][4], l.upper_twist, l.upper, Seg::UpperLeg);
        }
        if let Some(l) = &arms[k] {
            twist(&mut g, arm_roles[k][3], l.lower_twist, l.lower, Seg::LowerArm);
            twist(&mut g, arm_roles[k][4], l.upper_twist, l.upper, Seg::UpperArm);
        }
    }
    // Shoulders: the upper arm's parent when labelled, else when it isn't shared by both arms.
    let upper_arms = [g.get(h::LEFT_UPPER_ARM), g.get(h::RIGHT_UPPER_ARM)];
    for (k, role) in [(0usize, h::LEFT_SHOULDER), (1, h::RIGHT_SHOULDER)] {
        let Some(ua) = upper_arms[k] else { continue };
        let Some(p) = t.parent(ua) else { continue };
        let other = upper_arms[1 - k];
        let shared = other.is_some_and(|o| t.is_ancestor(p, o));
        if t.label[p as usize] == Label::Shoulder {
            g.set(role, p, NAMED);
        } else if !shared
            && !matches!(
                t.label[p as usize],
                Label::Spine | Label::Chest | Label::UpperChest | Label::Neck | Label::Hips
            )
        {
            g.set(role, p, TOPOLOGY);
        }
    }
    // Hips.
    let upper_legs = [g.get(h::LEFT_UPPER_LEG), g.get(h::RIGHT_UPPER_LEG)];
    let arm_tops: Vec<u16> = [h::LEFT_SHOULDER, h::RIGHT_SHOULDER]
        .iter()
        .zip(upper_arms.iter())
        .filter_map(|(&s, &ua)| g.get(s).or(ua))
        .collect();
    let chest_top = match arm_tops.as_slice() {
        [a, b] => t.common_ancestor(*a, *b),
        [a] => t.parent(*a),
        _ => None,
    };
    let above_all = |b: u16| {
        upper_legs.iter().flatten().all(|&l| t.is_ancestor(b, l))
            && chest_top.is_none_or(|c| c == b || t.is_ancestor(b, c))
    };
    let named_hips = t.best(
        (0..t.parents.len() as u16).filter(|&b| t.label[b as usize] == Label::Hips && above_all(b)),
    );
    let hips = named_hips.or_else(|| {
        let mut c = match upper_legs {
            [Some(a), Some(b)] => t.common_ancestor(a, b),
            [Some(a), None] | [None, Some(a)] => t.parent(a),
            _ => None,
        }?;
        // The nearest common ancestor that is also above the chest.
        while !above_all(c) {
            c = t.parent(c)?;
        }
        Some(c)
    });
    if let Some(hb) = hips {
        g.set(h::HIPS, hb, conf(hb, Label::Hips));
        // Root: a labelled root above the hips, else the hips' topmost ancestor.
        let named = t.best(
            (0..t.parents.len() as u16)
                .filter(|&b| t.label[b as usize] == Label::Root && t.is_ancestor(b, hb)),
        );
        let top = {
            let mut c = hb;
            while let Some(p) = t.parent(c) {
                c = p;
            }
            (c != hb).then_some(c)
        };
        if let Some(r) = named {
            g.set(h::ROOT, r, NAMED);
        } else if let Some(r) = top {
            g.set(h::ROOT, r, TOPOLOGY);
        }
    }
    // Spine: hips (exclusive) to the chest top (inclusive); a neck-labelled bone ends it.
    let mut neck = None;
    if let (Some(hb), Some(ct)) = (hips, chest_top) {
        let mut path = Vec::new();
        let mut c = Some(ct);
        while let Some(x) = c {
            if x == hb {
                break;
            }
            path.push(x);
            c = t.parent(x);
        }
        if c == Some(hb) {
            path.reverse();
            let cut = path
                .iter()
                .position(|&b| t.label[b as usize] == Label::Neck)
                .unwrap_or(path.len());
            if cut < path.len() {
                neck = Some(path[cut]);
            }
            let s = &path[..cut];
            let spine_conf = |b: u16| {
                if matches!(t.label[b as usize], Label::Spine | Label::Chest | Label::UpperChest) {
                    NAMED
                } else {
                    TOPOLOGY
                }
            };
            match s.len() {
                0 => {}
                1 => g.set(h::SPINE, s[0], spine_conf(s[0])),
                2 => {
                    g.set(h::SPINE, s[0], spine_conf(s[0]));
                    g.set(h::CHEST, s[1], spine_conf(s[1]));
                }
                n => {
                    g.set(h::SPINE, s[0], spine_conf(s[0]));
                    g.set(h::CHEST, s[n - 2], spine_conf(s[n - 2]));
                    g.set(h::UPPER_CHEST, s[n - 1], spine_conf(s[n - 1]));
                }
            }
        }
    }
    // Neck and head, continuing above the chest top away from the arms.
    let not_arm = |b: u16| arm_tops.iter().all(|&a| a != b && !t.is_ancestor(b, a));
    let usable = |b: u16| {
        !matches!(t.label[b as usize], Label::Ignore | Label::Eye | Label::Jaw) && not_arm(b)
    };
    if neck.is_none() {
        if let Some(ct) = chest_top {
            let kids: Vec<u16> = t.children[ct as usize]
                .iter()
                .copied()
                .filter(|&c| usable(c))
                .collect();
            neck = kids
                .iter()
                .copied()
                .find(|&c| t.label[c as usize] == Label::Neck)
                .or_else(|| kids.iter().copied().find(|&c| t.label[c as usize] == Label::Head))
                .or_else(|| kids.iter().copied().max_by_key(|&c| (t.height(c), u16::MAX - c)));
        }
    }
    if let Some(n) = neck {
        let head = if t.label[n as usize] == Label::Head {
            Some(n)
        } else {
            t.best(t.descendants(n).filter(|&b| t.label[b as usize] == Label::Head)).or_else(|| {
                let mut c = n;
                loop {
                    let next = t.children[c as usize]
                        .iter()
                        .copied()
                        .filter(|&k| usable(k))
                        .max_by_key(|&k| (t.height(k), u16::MAX - k));
                    match next {
                        Some(k) => c = k,
                        None => break,
                    }
                }
                (c != n).then_some(c)
            })
        };
        if head != Some(n) {
            g.set(h::NECK, n, conf(n, Label::Neck));
        }
        if let Some(hd) = head {
            g.set(h::HEAD, hd, conf(hd, Label::Head));
            for (side, role) in [(Side::Left, h::LEFT_EYE), (Side::Right, h::RIGHT_EYE)] {
                let e = t.best(t.descendants(hd).filter(|&b| {
                    t.label[b as usize] == Label::Eye && t.side[b as usize] == side
                }));
                if let Some(e) = e {
                    g.set(role, e, NAMED);
                }
            }
            if let Some(j) = t.best(t.descendants(hd).filter(|&b| t.label[b as usize] == Label::Jaw)) {
                g.set(h::JAW, j, NAMED);
            }
        }
    }
    // Toes.
    for (foot, role) in [(h::LEFT_FOOT, h::LEFT_TOES), (h::RIGHT_FOOT, h::RIGHT_TOES)] {
        let Some(f) = g.get(foot) else { continue };
        let named = t.best(t.descendants(f).filter(|&b| t.label[b as usize] == Label::Toes));
        if let Some(b) = named {
            g.set(role, b, NAMED);
        } else {
            let kids: Vec<u16> = t.children[f as usize]
                .iter()
                .copied()
                .filter(|&c| t.label[c as usize] != Label::Ignore)
                .collect();
            if let [only] = kids.as_slice() {
                g.set(role, *only, TOPOLOGY);
            }
        }
    }
    // Fingers: per kind, the first three bones under the hand by depth (metacarpals skipped,
    // except the thumb's, whose first role is its metacarpal).
    for (hand, first) in [(h::LEFT_HAND, h::LEFT_FINGERS), (h::RIGHT_HAND, h::RIGHT_FINGERS)] {
        let Some(hb) = g.get(hand) else { continue };
        for k in 0..5u8 {
            let mut bones: Vec<u16> = t
                .descendants(hb)
                .filter(|&b| match t.label[b as usize] {
                    Label::Finger(kind, meta) => kind == k && (k == 0 || !meta),
                    _ => false,
                })
                .collect();
            bones.sort_by_key(|&b| (t.depth[b as usize], b));
            for (i, &b) in bones.iter().take(3).enumerate() {
                g.set(first + 3 * k as u16 + i as u16, b, NAMED);
            }
        }
    }
    // Pairs at different depths are less certain.
    let profile = Profile::humanoid();
    for r in 0..h::COUNT {
        let m = profile.roles[r].mirror as usize;
        if m == r {
            continue;
        }
        if let (Some(a), Some(b)) = (g.get(r as u16), g.get(m as u16)) {
            if t.depth[a as usize] != t.depth[b as usize] {
                g.conf[r] *= 0.9;
            }
        }
    }
    g
}

/// The normalised form of a name for plain matching: side and tokens.
fn normal(name: &str) -> (Side, String) {
    let (side, _) = classify(name);
    let t: Vec<String> = tokens(name)
        .into_iter()
        .filter(|x| {
            !matches!(
                x.as_str(),
                "l" | "left" | "r" | "right" | "mixamorig" | "def" | "org" | "mch" | "j" | "c"
            )
        })
        .collect();
    (side, t.concat())
}

/// Guesses the bone of each of `profile`'s roles for a skeleton given by bone `names` and
/// `parents` (parents first, `0xFFFF` for a root; one entry per bone). See the module docs.
/// Never fails: roles it can't place stay unmapped (confidence 0). Deterministic.
pub fn guess_bone_map(names: &[&str], parents: &[u16], profile: &Profile) -> BoneMap {
    let n = names.len().min(parents.len()).min(NO_BONE as usize);
    let parents = &parents[..n];
    // Parents must come first; a bad parent counts as a root.
    let parents: Vec<u16> = parents
        .iter()
        .enumerate()
        .map(|(i, &p)| if (p as usize) < i { p } else { NO_PARENT })
        .collect();
    let mut depth = vec![0u32; n];
    let mut children = vec![Vec::new(); n];
    for i in 0..n {
        if parents[i] != NO_PARENT {
            depth[i] = depth[parents[i] as usize] + 1;
            children[parents[i] as usize].push(i as u16);
        }
    }
    let (side, label): (Vec<Side>, Vec<Label>) = names[..n].iter().map(|s| classify(s)).unzip();
    let tree = Tree {
        parents: &parents,
        depth,
        children,
        side,
        label,
    };
    let hum = guess_humanoid(&tree);
    let names_h = Profile::humanoid();
    let mut map = BoneMap::new(profile.roles.len());
    let mut used = vec![false; n];
    for (r, role) in profile.roles.iter().enumerate() {
        if let Some(hr) = names_h.role(&role.name) {
            let b = hum.bones[hr as usize];
            if b != NO_BONE && !used[b as usize] {
                map.bones[r] = b;
                map.confidence[r] = hum.conf[hr as usize];
                used[b as usize] = true;
            }
        }
    }
    let norms: Vec<(Side, String)> = names[..n].iter().map(|s| normal(s)).collect();
    for (r, role) in profile.roles.iter().enumerate() {
        if map.bones[r] != NO_BONE || names_h.role(&role.name).is_some() {
            continue;
        }
        let want = normal(&role.name);
        if want.1.is_empty() {
            continue;
        }
        let found = tree.best((0..n as u16).filter(|&b| !used[b as usize] && norms[b as usize] == want));
        if let Some(b) = found {
            map.bones[r] = b;
            map.confidence[r] = 0.8;
            used[b as usize] = true;
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_split_conventions() {
        assert_eq!(tokens("mixamorig:LeftUpLeg"), ["left", "up", "leg"]);
        assert_eq!(tokens("DEF-upper_arm.L.001"), ["def", "upper", "arm", "l", "001"]);
        assert_eq!(tokens("J_Bip_L_UpperArm"), ["j", "bip", "l", "upper", "arm"]);
        assert_eq!(tokens("Bip01 L Finger01"), ["bip", "01", "l", "finger", "01"]);
        assert_eq!(tokens("thigh_twist_01_l"), ["thigh", "twist", "01", "l"]);
        assert_eq!(tokens("HeadTop_End"), ["head", "top", "end"]);
    }

    #[test]
    fn labels_cover_synonyms() {
        let c = |s: &str| classify(s);
        assert_eq!(c("mixamorig:LeftArm"), (Side::Left, Label::UpperArm));
        assert_eq!(c("mixamorig:LeftLeg"), (Side::Left, Label::LowerLeg));
        assert_eq!(c("mixamorig:LeftUpLeg"), (Side::Left, Label::UpperLeg));
        assert_eq!(c("calf_r"), (Side::Right, Label::LowerLeg));
        assert_eq!(c("Bip01 L Clavicle"), (Side::Left, Label::Shoulder));
        assert_eq!(c("Bip01 R Forearm"), (Side::Right, Label::LowerArm));
        assert_eq!(c("Bip01 L Finger0"), (Side::Left, Label::Finger(0, false)));
        assert_eq!(c("Bip01 L Finger42"), (Side::Left, Label::Finger(4, false)));
        assert_eq!(c("Bip01 Pelvis"), (Side::Centre, Label::Hips));
        assert_eq!(c("Bip01 HeadNub"), (Side::Centre, Label::Ignore));
        assert_eq!(c("DEF-shin.L"), (Side::Left, Label::LowerLeg));
        assert_eq!(c("DEF-f_pinky.02.R"), (Side::Right, Label::Finger(4, false)));
        assert_eq!(c("index_metacarpal_l"), (Side::Left, Label::Finger(1, true)));
        assert_eq!(c("upperarm_twist_01_l"), (Side::Left, Label::Twist(Seg::UpperArm)));
        assert_eq!(c("J_Bip_C_UpperChest"), (Side::Centre, Label::UpperChest));
        assert_eq!(c("left_foot"), (Side::Left, Label::Foot));
        assert_eq!(c("Hand_L_"), (Side::Left, Label::Hand));
        assert_eq!(c("ik_foot_l"), (Side::Left, Label::Ignore));
        assert_eq!(c("Bip01 Footsteps"), (Side::Centre, Label::Ignore));
    }
}
