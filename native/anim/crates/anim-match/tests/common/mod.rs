//! Shared fixtures: a small biped skeleton and procedural locomotion clips (idle, walk, run,
//! turn, start, stop), generated here so no database or clip file is committed.
#![allow(dead_code)]

use anim_format::clip::{Binding, Clip, ClipView, Track, TrackKind, CLIP_LOOP};
use anim_format::skeleton::{Bone, Skeleton, SkeletonView};
use anim_format::NONE;
use anim_match::{BakeClip, BakeSettings, Baked, FeatureSpec, TaggedRange};
use anim_math::layout::NO_PARENT;
use anim_sample::Form;

pub const HIPS: u32 = 0;
pub const LEFT_FOOT: u32 = 4;
pub const RIGHT_FOOT: u32 = 7;
pub const RATE: f32 = 30.0;

/// xorshift64*.
pub struct Rng(u64);
impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    pub fn f32(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * ((self.next() >> 40) as f32 / (1u64 << 24) as f32)
    }
    pub fn below(&mut self, n: u32) -> u32 {
        (self.next() % n as u64) as u32
    }
}

/// hips → spine; hips → left upper leg → shin → foot; the same on the right.
pub fn skeleton() -> Skeleton {
    let bone = |name: u32, parent: u16, t: [f32; 3]| Bone {
        name,
        parent,
        translation: t,
        rotation: [0.0, 0.0, 0.0, 1.0],
        scale: [1.0; 3],
        inverse_bind: [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
    };
    let names = ["hips", "spine", "l_thigh", "l_shin", "l_foot", "r_thigh", "r_shin", "r_foot"];
    Skeleton {
        name: NONE,
        profile: NONE,
        mirror_axis: 0,
        strings: names.iter().map(|s| s.to_string()).collect(),
        bones: vec![
            bone(0, NO_PARENT, [0.0, 1.0, 0.0]),
            bone(1, 0, [0.0, 0.3, 0.0]),
            bone(2, 0, [0.1, 0.0, 0.0]),
            bone(3, 2, [0.0, -0.45, 0.0]),
            bone(4, 3, [0.0, -0.45, 0.0]),
            bone(5, 0, [-0.1, 0.0, 0.0]),
            bone(6, 5, [0.0, -0.45, 0.0]),
            bone(7, 6, [0.0, -0.45, 0.0]),
        ],
        roles: None,
        joint_ranges: None,
        mirror: None,
    }
}

/// How a procedural clip moves.
#[derive(Clone, Copy, Debug)]
pub struct Gait {
    /// Ground speed (m/s).
    pub speed: Speed,
    /// Yaw rate (rad/s).
    pub yaw_rate: f32,
    /// Seconds per stride cycle (two steps).
    pub cycle: f32,
    pub duration: f32,
    pub looping: bool,
}

/// `from`, ramping linearly to `to` over the first `ramp` seconds.
#[derive(Clone, Copy, Debug)]
pub struct Speed {
    pub from: f32,
    pub to: f32,
    pub ramp: f32,
}

impl Speed {
    pub fn constant(v: f32) -> Self {
        Speed {
            from: v,
            to: v,
            ramp: 1.0,
        }
    }
    pub fn at(&self, t: f32) -> f32 {
        self.from + (self.to - self.from) * (t / self.ramp).clamp(0.0, 1.0)
    }
}

fn gait(speed: Speed, yaw_rate: f32, cycle: f32, duration: f32, looping: bool) -> Gait {
    Gait {
        speed,
        yaw_rate,
        cycle,
        duration,
        looping,
    }
}

pub fn idle() -> Gait {
    gait(Speed::constant(0.0), 0.0, 2.0, 2.0, true)
}
pub fn walk() -> Gait {
    gait(Speed::constant(1.4), 0.0, 1.0, 2.0, true)
}
pub fn run() -> Gait {
    gait(Speed::constant(3.5), 0.0, 0.7, 2.1, true)
}
pub fn turn() -> Gait {
    gait(Speed::constant(1.4), 1.2, 1.0, 2.0, true)
}
pub fn start() -> Gait {
    let s = Speed {
        from: 0.0,
        to: 1.4,
        ramp: 1.0,
    };
    gait(s, 0.0, 1.0, 2.5, false)
}
pub fn stop() -> Gait {
    let s = Speed {
        from: 1.4,
        to: 0.0,
        ramp: 1.0,
    };
    gait(s, 0.0, 1.0, 2.5, false)
}

fn quat_x(a: f32) -> [f32; 4] {
    let (s, c) = (a * 0.5).sin_cos();
    [s, 0.0, 0.0, c]
}
fn quat_y(a: f32) -> [f32; 4] {
    let (s, c) = (a * 0.5).sin_cos();
    [0.0, s, 0.0, c]
}

/// A clip of `gait` at 30 Hz, raw form, root motion in the hips (root bone 0).
pub fn clip(gait: Gait) -> Clip {
    let skel = skeleton();
    let frames = (gait.duration * RATE).round() as u32 + 1;
    let n = skel.bones.len();
    let mut raw = vec![Vec::with_capacity(frames as usize * 10); n];
    // Integrate the path finely.
    let sub = 20;
    let (mut x, mut z, mut yaw, mut phase) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let h = 1.0 / (RATE as f64 * sub as f64);
    for f in 0..frames {
        if f > 0 {
            for s in 0..sub {
                let t = (f - 1) as f64 / RATE as f64 + (s as f64 + 0.5) * h;
                let v = gait.speed.at(t as f32) as f64;
                let y = yaw + gait.yaw_rate as f64 * h * 0.5;
                x += v * y.sin() * h;
                z += v * y.cos() * h;
                yaw += gait.yaw_rate as f64 * h;
                phase += h / gait.cycle as f64;
            }
        }
        let t = f as f32 / RATE;
        let v = gait.speed.at(t);
        let amp = 0.12 + 0.18 * (v / 3.5).min(1.0);
        let swing = (phase as f32 * std::f32::consts::TAU).sin() * amp * (v.min(1.0) + 0.1);
        let bob = 0.02 * (phase as f32 * std::f32::consts::TAU * 2.0).cos() * (v.min(1.0) + 0.2);
        let sway = 0.01 * (phase as f32 * std::f32::consts::TAU).sin();
        let local: Vec<([f32; 3], [f32; 4])> = skel
            .bones
            .iter()
            .enumerate()
            .map(|(i, b)| match i {
                0 => ([x as f32 + sway, 1.0 + bob, z as f32], quat_y(yaw as f32)),
                2 => (b.translation, quat_x(swing)),
                5 => (b.translation, quat_x(-swing)),
                3 => (b.translation, quat_x(-(swing.max(0.0)) * 1.2 - 0.05)),
                6 => (b.translation, quat_x(-((-swing).max(0.0)) * 1.2 - 0.05)),
                _ => (b.translation, b.rotation),
            })
            .collect();
        for (i, (t, q)) in local.iter().enumerate() {
            raw[i].extend_from_slice(&[t[0], t[1], t[2], q[0], q[1], q[2], q[3], 1.0, 1.0, 1.0]);
        }
    }
    Clip {
        flags: if gait.looping { CLIP_LOOP } else { 0 },
        name: NONE,
        duration: (frames - 1) as f32 / RATE,
        sample_rate: RATE,
        frame_count: frames,
        bone_count: n as u32,
        root_bone: 0,
        strings: Vec::new(),
        tracks: raw
            .into_iter()
            .enumerate()
            .map(|(i, raw)| Track {
                kind: TrackKind::Bone,
                flags: 0,
                subtype: 0,
                binding: Binding::bone(i as u32),
                raw,
                keys: Vec::new(),
            })
            .collect(),
        has_raw: true,
        root_curve: None,
        compressed: None,
    }
}

/// A tagged range: (start, end, tags).
pub type Range = (f32, f32, &'static [&'static str]);

/// The locomotion set: (asset name, gait, tagged ranges). The stop clip's tail, standing still,
/// is tagged idle as well as its deceleration is tagged stop.
pub fn locomotion() -> Vec<(&'static str, Gait, Vec<Range>)> {
    vec![
        ("idle.anim", idle(), vec![(0.0, 2.0, &["idle"])]),
        ("walk.anim", walk(), vec![(0.0, 2.0, &["walk"])]),
        ("run.anim", run(), vec![(0.0, 2.1, &["run"])]),
        ("turn.anim", turn(), vec![(0.0, 2.0, &["turn"])]),
        ("start.anim", start(), vec![(0.0, 2.5, &["start"])]),
        (
            "stop.anim",
            stop(),
            vec![(0.0, 1.0, &["stop"]), (1.0, 2.5, &["idle"])],
        ),
    ]
}

/// Serialised fixtures: the skeleton and every clip.
pub struct Fixture {
    pub skel: Vec<u8>,
    pub clips: Vec<Vec<u8>>,
    pub names: Vec<&'static str>,
    pub ranges: Vec<Vec<Range>>,
    pub durations: Vec<f32>,
}

pub fn fixture() -> Fixture {
    let set = locomotion();
    Fixture {
        skel: skeleton().write().unwrap(),
        clips: set.iter().map(|(_, g, _)| clip(*g).write().unwrap()).collect(),
        names: set.iter().map(|(n, _, _)| *n).collect(),
        ranges: set.iter().map(|(_, _, r)| r.clone()).collect(),
        durations: set.iter().map(|(_, g, _)| g.duration).collect(),
    }
}

/// The default schema (with the past sample).
pub fn schema() -> Vec<FeatureSpec> {
    anim_match::default_schema(LEFT_FOOT, RIGHT_FOOT, HIPS, true)
}

impl Fixture {
    pub fn views(&self) -> (SkeletonView<'_>, Vec<ClipView<'_>>) {
        (
            SkeletonView::parse(&self.skel).unwrap(),
            self.clips
                .iter()
                .map(|c| ClipView::parse(c).unwrap())
                .collect(),
        )
    }

    /// Bakes every clip with its tagged ranges.
    pub fn bake(&self, schema: &[FeatureSpec], settings: &BakeSettings<'_>) -> Baked {
        let (skel, views) = self.views();
        let ranges: Vec<Vec<TaggedRange<'_>>> = self
            .ranges
            .iter()
            .map(|rs| {
                rs.iter()
                    .map(|&(start, end, tags)| TaggedRange { start, end, tags })
                    .collect()
            })
            .collect();
        let clips: Vec<BakeClip<'_>> = views
            .iter()
            .zip(&self.names)
            .zip(&ranges)
            .map(|((v, n), r)| BakeClip {
                view: *v,
                form: Form::Raw,
                asset: n,
                ranges: r,
            })
            .collect();
        anim_match::bake(&skel, &clips, schema, settings).unwrap()
    }
}
