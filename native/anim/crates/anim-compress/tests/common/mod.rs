//! Synthetic skeletons and clips for the compressor's and sampler's tests (shared by
//! `anim-sample`'s tests through `#[path]`).
#![allow(dead_code)]

use anim_format::clip::{Binding, Clip, Track, TrackKind, CLIP_LOOP};
use anim_format::skeleton::{Bone, Skeleton, NO_PARENT};
use anim_format::NONE;
use anim_offline::math::{local_to_model, Quat, Transform, Vec3};
use anim_offline::sample::vertex_error;

/// xorshift64*: deterministic, seedable.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    /// In `[0, n)`.
    pub fn below(&mut self, n: u32) -> u32 {
        (self.next() % n as u64) as u32
    }
    /// In `[lo, hi)`.
    pub fn f64(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (self.next() >> 11) as f64 / (1u64 << 53) as f64 * (hi - lo)
    }
    pub fn unit(&mut self) -> Vec3 {
        loop {
            let v = Vec3::new(
                self.f64(-1.0, 1.0),
                self.f64(-1.0, 1.0),
                self.f64(-1.0, 1.0),
            );
            let l = v.length();
            if l > 0.1 && l <= 1.0 {
                return v.scale(1.0 / l);
            }
        }
    }
}

/// Skeleton shapes.
#[derive(Clone, Copy, Debug)]
pub enum Shape {
    /// One bone.
    Single,
    /// A straight chain of n bones.
    Chain(usize),
    /// A 60-bone humanoid (root, hips, spine, neck, head, arms with fingers, legs).
    Humanoid,
    /// An 80-bone humanoid (T82r, ADR 0350's budget skeleton): [`Shape::Humanoid`]'s 60 bones in the
    /// same order, then 20 leaf bones (spine, neck and limb twists, face and two prop sockets).
    Humanoid80,
    /// A random tree of n bones.
    Tree(usize),
}

fn parents_of(shape: Shape, rng: &mut Rng) -> Vec<u16> {
    match shape {
        Shape::Single => vec![NO_PARENT],
        Shape::Chain(n) => (0..n)
            .map(|i| if i == 0 { NO_PARENT } else { (i - 1) as u16 })
            .collect(),
        Shape::Tree(n) => (0..n)
            .map(|i| {
                if i == 0 {
                    NO_PARENT
                } else {
                    // Mostly extend recent bones, so depth grows to ~10-20.
                    let lo = i.saturating_sub(4) as u32;
                    (lo + rng.below(i as u32 - lo)) as u16
                }
            })
            .collect(),
        Shape::Humanoid80 => {
            let mut p = parents_of(Shape::Humanoid, rng);
            // Leaves on the hips, spine, neck and head, the upper arms, forearms, thighs, shins and hands.
            for parent in [
                1u16, 2, 3, 4, 5, 6, 6, 6, 6, 6, 11, 13, 32, 34, 52, 53, 56, 57, 15, 36,
            ] {
                p.push(parent);
            }
            assert_eq!(p.len(), 80);
            p
        }
        Shape::Humanoid => {
            let mut p: Vec<u16> = Vec::new();
            let mut add = |parent: Option<usize>| {
                p.push(parent.map_or(NO_PARENT, |x| x as u16));
                p.len() - 1
            };
            let root = add(None);
            let hips = add(Some(root));
            let s1 = add(Some(hips));
            let s2 = add(Some(s1));
            let s3 = add(Some(s2));
            let neck = add(Some(s3));
            let head = add(Some(neck));
            add(Some(head)); // jaw
            add(Some(head)); // eye
            add(Some(head)); // eye
            for _ in 0..2 {
                let clav = add(Some(s3));
                let up = add(Some(clav));
                add(Some(up)); // twist
                let low = add(Some(up));
                add(Some(low)); // twist
                let hand = add(Some(low));
                for _ in 0..5 {
                    let a = add(Some(hand));
                    let b = add(Some(a));
                    add(Some(b));
                }
            }
            for _ in 0..2 {
                let up = add(Some(hips));
                let low = add(Some(up));
                let foot = add(Some(low));
                add(Some(foot));
            }
            assert_eq!(p.len(), 60);
            p
        }
    }
}

/// A skeleton of `shape` with random rest offsets (5–35 cm) and rotations.
pub fn skeleton(shape: Shape, rng: &mut Rng) -> Skeleton {
    let parents = parents_of(shape, rng);
    let bones = parents
        .iter()
        .enumerate()
        .map(|(i, &parent)| {
            let dir = rng.unit();
            let len = if parent == NO_PARENT {
                0.0
            } else {
                rng.f64(0.05, 0.35)
            };
            let q = Quat::from_axis_angle(rng.unit(), rng.f64(-0.5, 0.5));
            Bone {
                name: i as u32,
                parent,
                translation: [
                    (dir.x * len) as f32,
                    (dir.y * len) as f32,
                    (dir.z * len) as f32,
                ],
                rotation: [q.x as f32, q.y as f32, q.z as f32, q.w as f32],
                scale: [1.0, 1.0, 1.0],
                inverse_bind: [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            }
        })
        .collect::<Vec<_>>();
    Skeleton {
        name: NONE,
        profile: NONE,
        mirror_axis: 0,
        strings: (0..parents.len()).map(|i| format!("bone{i}")).collect(),
        bones,
        roles: None,
        joint_ranges: None,
        mirror: None,
    }
}

/// How one channel moves.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Motion {
    /// Equal to the rest pose.
    Default,
    /// Constant, away from the rest pose.
    Constant,
    /// A slow sine (0.5 Hz).
    Slow,
    /// A fast sine (4 Hz).
    Fast,
    /// A sine plus per-frame noise.
    Noisy,
}

/// A channel's motion as a function of time: an offset vector or angle per frame.
struct Wave {
    motion: Motion,
    amp: f64,
    freq: f64,
    phase: f64,
    axis: Vec3,
    offset: Vec3,
}

impl Wave {
    fn new(motion: Motion, amp: f64, rng: &mut Rng) -> Self {
        let freq = match motion {
            Motion::Fast => 4.0,
            _ => 0.5,
        };
        Wave {
            motion,
            amp,
            freq,
            phase: rng.f64(0.0, std::f64::consts::TAU),
            axis: rng.unit(),
            offset: rng.unit().scale(amp),
        }
    }
    fn at(&self, t: f64, rng: &mut Rng) -> f64 {
        let s = (std::f64::consts::TAU * self.freq * t + self.phase).sin() * self.amp;
        match self.motion {
            Motion::Default => 0.0,
            Motion::Constant => self.amp,
            Motion::Slow | Motion::Fast => s,
            Motion::Noisy => s + rng.f64(-0.03, 0.03) * self.amp,
        }
    }
}

/// Picks a motion: mostly animated, some constant and default.
pub fn pick_motion(rng: &mut Rng) -> Motion {
    match rng.below(10) {
        0 | 1 => Motion::Default,
        2 => Motion::Constant,
        3..=5 => Motion::Slow,
        6 | 7 => Motion::Fast,
        _ => Motion::Noisy,
    }
}

/// A clip at 30 Hz over `skel` with every bone animated by random motions per channel; the root
/// bone also walks forward 1.2 m/s and turns.
pub fn clip(skel: &Skeleton, seconds: f64, looping: bool, rng: &mut Rng) -> Clip {
    let rate = 30.0;
    let frames = (seconds * rate).round() as u32 + 1;
    let tracks = skel
        .bones
        .iter()
        .enumerate()
        .map(|(i, b)| {
            let rot = Wave::new(pick_motion(rng), rng.f64(0.1, 1.0), rng);
            let tr = Wave::new(pick_motion(rng), rng.f64(0.01, 0.1), rng);
            let sc = Wave::new(
                if rng.below(5) == 0 {
                    pick_motion(rng)
                } else {
                    Motion::Default
                },
                rng.f64(0.05, 0.2),
                rng,
            );
            let rest_q = Quat::new(
                b.rotation[0] as f64,
                b.rotation[1] as f64,
                b.rotation[2] as f64,
                b.rotation[3] as f64,
            );
            let rest_t = Vec3::new(
                b.translation[0] as f64,
                b.translation[1] as f64,
                b.translation[2] as f64,
            );
            let mut raw = Vec::with_capacity(frames as usize * 10);
            for f in 0..frames {
                let t = f as f64 / rate;
                let mut q = rest_q * Quat::from_axis_angle(rot.axis, rot.at(t, rng));
                let mut p = rest_t + tr.offset.scale(tr.at(t, rng) / tr.amp.max(1e-9));
                if i == 0 {
                    p = p + Vec3::new(0.0, 0.0, 1.2 * t);
                    q = Quat::from_axis_angle(Vec3::new(0.0, 1.0, 0.0), 0.4 * t) * q;
                }
                let s = 1.0 + sc.at(t, rng);
                raw.extend_from_slice(&[
                    p.x as f32, p.y as f32, p.z as f32, q.x as f32, q.y as f32, q.z as f32,
                    q.w as f32, s as f32, s as f32, s as f32,
                ]);
            }
            Track {
                kind: TrackKind::Bone,
                flags: 0,
                subtype: 0,
                binding: Binding::bone(i as u32),
                raw,
                keys: Vec::new(),
            }
        })
        .collect();
    Clip {
        flags: if looping { CLIP_LOOP } else { 0 },
        name: NONE,
        duration: ((frames - 1) as f64 / rate) as f32,
        sample_rate: rate as f32,
        frame_count: frames,
        bone_count: skel.bones.len() as u32,
        root_bone: NONE,
        strings: Vec::new(),
        tracks,
        has_raw: true,
        root_curve: None,
        compressed: None,
    }
}

/// The skeleton's rest pose and parents, f64.
pub fn rest_and_parents(skel: &Skeleton) -> (Vec<Transform>, Vec<u16>) {
    let rest = skel
        .bones
        .iter()
        .map(|b| {
            anim_offline::sample::transform_from(&[
                b.translation[0],
                b.translation[1],
                b.translation[2],
                b.rotation[0],
                b.rotation[1],
                b.rotation[2],
                b.rotation[3],
                b.scale[0],
                b.scale[1],
                b.scale[2],
            ])
        })
        .collect();
    (rest, skel.bones.iter().map(|b| b.parent).collect())
}

/// Shell distance per bone: max(3 cm, longest child offset).
pub fn shells(skel: &Skeleton) -> Vec<f64> {
    let mut s = vec![0.03f64; skel.bones.len()];
    for b in &skel.bones {
        if b.parent != NO_PARENT {
            let t = b.translation;
            let len =
                ((t[0] as f64).powi(2) + (t[1] as f64).powi(2) + (t[2] as f64).powi(2)).sqrt();
            let p = &mut s[b.parent as usize];
            *p = p.max(len);
        }
    }
    s
}

/// The largest virtual-vertex error between two local poses, in model space.
pub fn pose_error(parents: &[u16], shells: &[f64], a: &[Transform], b: &[Transform]) -> f64 {
    let ma = local_to_model(parents, a);
    let mb = local_to_model(parents, b);
    ma.iter()
        .zip(&mb)
        .zip(shells)
        .map(|((x, y), &s)| vertex_error(*x, *y, s))
        .fold(0.0, f64::max)
}
