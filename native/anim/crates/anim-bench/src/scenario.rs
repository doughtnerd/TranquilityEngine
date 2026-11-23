//! The budget scenarios (ADR 0370), built once and stepped per frame through the core's calls, as a
//! host would: commands into the command buffer, rig hits into the rig input view, `write_inputs`,
//! `evaluate`. The Node benchmark (`anim-wasm/bench_budgets.mjs`) runs the same scenarios on the
//! built wasm from the files [`write_fixtures`] writes.

use std::fmt::Write as _;
use std::path::Path;

use anim_format::clip::ClipView;
use anim_format::graph::ParamValue;
use anim_format::posedb::PoseDbView;
use anim_format::NONE;
use anim_graph::matching::{self, word, FLAG_BRUTE_FORCE};
use anim_graph::rig::{self as rg, kind};
use anim_match::{bake, BakeClip, BakeSettings, TaggedRange};
use anim_sample::Form;
use anim_wasm::init::Core;
use anim_wire::core::{Init, PASS_NORMAL, STATUS_OK};
use anim_wire::graph as wg;
use anim_wire::rig as wr;
use anim_wire::tween::TweenCreate;
use anim_wire::WireRecord;

use crate::common::graph::{locomotion, Builder, Loco};
use crate::common::rig::{block, fb, rig_node};
use crate::common::{self, Shape};
use crate::mcommon;

/// The frame step the scenarios run at (a 60 Hz display).
pub const DT: f32 = 1.0 / 60.0;
/// Instances in the character budget.
pub const CROWD: usize = 100;
/// Characters in the matching budget.
pub const MATCHERS: usize = 20;
/// Tweens in the tween budget.
pub const TWEENS: usize = 1000;
/// Frames between the matching characters' searches.
pub const SEARCH_INTERVAL: u32 = 6;

/// A synthetic humanoid and the three locomotion clips (compressed), as the Node fixtures:
/// 60 bones are `humanoid.skel` and `humanoid_{idle,walk,run}.anim` bit for bit; 80 bones are
/// [`Shape::Humanoid80`] with the same seeds.
pub struct Humanoid {
    pub bones: usize,
    pub skel: Vec<u8>,
    pub idle: Vec<u8>,
    pub walk: Vec<u8>,
    pub run: Vec<u8>,
}

/// The humanoid of `bones` (60 or 80) bones.
pub fn humanoid(bones: usize) -> Humanoid {
    let shape = if bones == 80 {
        Shape::Humanoid80
    } else {
        Shape::Humanoid
    };
    let (skel, skel_bytes) = common::skeleton(shape, 3);
    assert_eq!(skel.bones.len(), bones);
    Humanoid {
        bones,
        idle: common::clip(&skel, 1.0, true, 33),
        walk: common::clip(&skel, 1.0, true, 31),
        run: common::clip(&skel, 1.0, true, 32),
        skel: skel_bytes,
    }
}

/// The upper-body mask of the locomotion graph's slot (bones 3–32: chest up, both arms).
pub fn upper_mask(bones: usize) -> Vec<f32> {
    (0..bones)
        .map(|i| if (3..33).contains(&i) { 1.0 } else { 0.0 })
        .collect()
}

/// T31's locomotion graph (`loco.animgraph`), or with `rig` T40's budget graph
/// (`loco_rig.animgraph`: a two-foot grounder, rays 0 and 1, then a look-at on the neck and head
/// fed by target slot 0), over the humanoid's first 60 bones (hips 1, neck 5, head 6, legs 52–54
/// and 56–58). The same builder calls as `anim-wasm/tests/{graph,rig}_fixtures.rs`.
pub fn loco_graph(rig: bool) -> (Vec<u8>, Loco) {
    let mut b = Builder::new();
    let ids = locomotion(&mut b);
    if !rig {
        return (b.build(ids.output), ids);
    }
    let look = add_rig(&mut b, ids.output);
    (b.build(look), ids)
}

/// The rig stack alone: the reference pose under the budget graph's grounder and look-at.
pub fn rig_only_graph() -> Vec<u8> {
    let mut b = Builder::new();
    let src = crate::common::rig::rest_source(&mut b);
    let look = add_rig(&mut b, src);
    b.build(look)
}

/// The budget graph's rig stack over `input`: a two-foot grounder (rays 0 and 1, LOD skip 2) then a
/// look-at on the neck and head fed by target slot 0. Returns the look-at node.
fn add_rig(b: &mut Builder, input: u32) -> u32 {
    let mut g = block(1.0, NONE, 2, &[0; 15]);
    {
        use rg::grounder::*;
        g[PELVIS] = 1;
        g[RAY_BASE] = 0;
        g[UP + 1] = fb(1.0);
        let d = anim_rig::grounder::GrounderSettings::default();
        g[RAY_HEIGHT] = fb(d.ray_height);
        g[RAY_DEPTH] = fb(d.ray_depth);
        g[MAX_STEP] = fb(d.max_step);
        g[MAX_FOOT_ANGLE] = fb(d.max_foot_angle);
        g[FOOT_ROTATION_WEIGHT] = fb(d.foot_rotation_weight);
        g[FOOT_HALF_LIFE] = fb(d.foot_half_life);
        g[PELVIS_HALF_LIFE] = fb(d.pelvis_half_life);
        g[MAX_PELVIS_DOWN] = fb(d.max_pelvis_down);
        g[MAX_PELVIS_UP] = fb(d.max_pelvis_up);
        g[COUNT] = 2;
        g.extend([52, 53, 54, 56, 57, 58]);
    }
    let grounder = rig_node(b, kind::GROUNDER, input, &g);
    let mut l = block(1.0, NONE, 1, &[0; 12]);
    {
        use rg::aim::*;
        l[TARGET] = 0;
        l[UP_WEIGHT] = fb(0.0);
        l[MAX_ANGLE] = fb(1.2);
        l[FORWARD + 2] = fb(1.0);
        l[UP + 1] = fb(1.0);
        l.extend([2, 5, fb(0.4), fb(0.8), 6, fb(1.0), fb(1.0)]);
    }
    rig_node(b, kind::LOOK_AT, grounder, &l)
}

/// What every crowd instance runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Crowd {
    /// The implicit graph playing one clip (walk).
    OneClip,
    /// The implicit graph mid-crossfade from walk to run (a 1000 s fade).
    Crossfade,
    /// The locomotion graph.
    Loco,
    /// The locomotion graph, grounder and look-at: ADR 0370's character budget scenario.
    LocoRig,
    /// The reference pose under the grounder and look-at.
    RigOnly,
}

/// A started core with `n` instances of a crowd scenario.
pub struct Characters {
    pub core: Core,
    pub handles: Vec<u32>,
    pub bones: usize,
    rig: bool,
}

fn f32w(x: f32) -> u32 {
    x.to_bits()
}

/// Encodes `commands` into the command buffer and applies them.
fn send(core: &mut Core, commands: &[Vec<u8>]) -> u32 {
    let mut at = 0;
    for c in commands {
        core.commands_mut()[at..at + c.len()].copy_from_slice(c);
        at += c.len();
    }
    core.write_inputs(at as u32)
}

/// A started core for `max_instances` instances of `max_bones` bones.
pub fn start(max_instances: u32, max_bones: u32) -> Core {
    let mut core = Core::new();
    let reply = core.init(
        &Init {
            max_instances,
            max_bones,
            arena_initial_bytes: 1 << 22,
        }
        .encode(),
    );
    assert_eq!(reply.status, STATUS_OK);
    core
}

/// The locomotion graph's per-instance parameters (instance `i` of a crowd): moving, a spread of
/// blend-space positions and speeds; and the upper-body slot looping a section of run.
fn loco_commands(h: u32, i: usize, ids: &Loco, run: u32) -> Vec<Vec<u8>> {
    let set = |param: u32, param_type: u32, w0: u32| {
        wg::SetParam {
            instance: h,
            param,
            param_type,
            w0,
            ..Default::default()
        }
        .encode()
    };
    vec![
        set(ids.moving, 2, 1),
        set(ids.x, 0, f32w((i % 10) as f32 / 10.0)),
        set(ids.y, 0, f32w(0.5 + (i % 5) as f32 / 10.0)),
        set(ids.speed, 0, f32w(1.0 + (i % 3) as f32)),
        wg::SlotPlay {
            instance: h,
            slot: 0,
            clip: run,
            play_id: 0,
            blend_in: 0.1,
            blend_out: 0.1,
            speed: 1.0,
            start: 0.0,
            end: 0.5,
            flags: 1,
        }
        .encode(),
    ]
}

impl Characters {
    /// `n` instances of `crowd` on `h`, set up as `bench.mjs` sets them up.
    pub fn new(h: &Humanoid, crowd: Crowd, n: usize) -> Characters {
        let mut core = start(128, h.bones.max(64) as u32);
        let skel = core.load_skeleton(&h.skel);
        let idle = core.load_clip(&h.idle);
        let walk = core.load_clip(&h.walk);
        let run = core.load_clip(&h.run);
        let mask = core.load_mask(&upper_mask(h.bones));
        assert!(skel != 0 && idle != 0 && walk != 0 && run != 0 && mask != 0);
        let graph = match crowd {
            Crowd::OneClip | Crowd::Crossfade => 0,
            Crowd::Loco | Crowd::LocoRig => {
                let (bytes, ids) = loco_graph(crowd == Crowd::LocoRig);
                let g = core.load_graph(&bytes);
                assert_ne!(g, 0, "graph loads (status {})", core.last_status());
                for (id, asset) in [
                    (ids.idle, idle),
                    (ids.walk, walk),
                    (ids.run, run),
                    (ids.upper, mask),
                ] {
                    assert_eq!(core.graph_bind(g, id, asset), STATUS_OK);
                }
                g
            }
            Crowd::RigOnly => {
                let g = core.load_graph(&rig_only_graph());
                assert_ne!(g, 0, "graph loads (status {})", core.last_status());
                g
            }
        };
        let handles: Vec<u32> = (0..n)
            .map(|_| {
                let i = core.create_instance(0, skel, graph);
                assert_ne!(i, 0, "instance (status {})", core.last_status());
                i
            })
            .collect();
        let rig = matches!(crowd, Crowd::LocoRig | Crowd::RigOnly);
        match crowd {
            Crowd::OneClip | Crowd::Crossfade => {
                let play = |clip: u32, fade: f32| -> Vec<Vec<u8>> {
                    handles
                        .iter()
                        .map(|&h| common::play(h, clip, 0, fade, 0, 0))
                        .collect()
                };
                assert_eq!(send(&mut core, &play(walk, 0.0)) as usize, n);
                if crowd == Crowd::Crossfade {
                    for _ in 0..30 {
                        core.write_inputs(0);
                        core.evaluate(0, PASS_NORMAL, DT, DT);
                    }
                    assert_eq!(send(&mut core, &play(run, 1000.0)) as usize, n);
                }
            }
            Crowd::Loco | Crowd::LocoRig => {
                let (_, ids) = loco_graph(false);
                let cmds: Vec<Vec<u8>> = handles
                    .iter()
                    .enumerate()
                    .flat_map(|(i, &h)| loco_commands(h, i, &ids, run))
                    .collect();
                assert_eq!(send(&mut core, &cmds) as usize, n * 5);
            }
            Crowd::RigOnly => {}
        }
        if rig {
            for &h in &handles {
                let row = (h & 0xFFFF) as usize * (wr::RIG_INPUT_STRIDE / 4) as usize;
                let at = row + (wr::RIG_TARGETS / 4) as usize;
                let w = core.rig_inputs_mut();
                for (o, v) in [(0, 1.5f32), (4, 1.6), (8, 2.0), (28, 1.0), (32, 1.0)] {
                    w[at + o / 4] = v.to_bits();
                }
            }
        }
        let mut c = Characters {
            core,
            handles,
            bones: h.bones,
            rig,
        };
        for _ in 0..30 {
            c.frame();
        }
        c
    }

    /// Feeds last frame's foot rays their hits on flat ground at y = 0 (the host's round trip).
    fn feed_hits(&mut self) {
        let ray_words = (wr::RAY_ROW_STRIDE / 4) as usize;
        let input_words = (wr::RIG_INPUT_STRIDE / 4) as usize;
        for &h in &self.handles {
            let i = (h & 0xFFFF) as usize;
            let mut rays = [[0u32; 8]; 2];
            for (k, r) in rays.iter_mut().enumerate() {
                let at = i * ray_words + k * (wr::RAY_STRIDE / 4) as usize;
                r.copy_from_slice(&self.core.rig_rays()[at..at + 8]);
            }
            let w = self.core.rig_inputs_mut();
            for (k, r) in rays.iter().enumerate() {
                let at =
                    i * input_words + ((wr::RIG_HITS + k as u32 * wr::HIT_STRIDE) / 4) as usize;
                w[at] = r[0];
                w[at + 1] = 0;
                w[at + 2] = r[2];
                w[at + 4] = 1.0f32.to_bits();
                w[at + 6] = r[7] & 1;
            }
        }
    }

    /// One frame: hits (rig scenarios), `write_inputs(0)`, `evaluate`.
    pub fn frame(&mut self) {
        if self.rig {
            self.feed_hits();
        }
        self.core.write_inputs(0);
        self.core.evaluate(0, PASS_NORMAL, DT, DT);
    }
}

// -------------------------------------------------------------------------------------------------
// Motion matching
// -------------------------------------------------------------------------------------------------

/// The synthetic 30-minute pose database (`anim-match/tests/timings.rs`'s: 180 looping raw clips of
/// 10 s with random speeds, turn rates and strides, 54,000 frames at 30 Hz, tagged idle, walk, run
/// or turn; the default schema with the past sample, per-feature normalization) over anim-match's
/// 8-bone skeleton, each clip with its root curve.
pub struct MatchSet {
    pub skel: Vec<u8>,
    /// (asset name, clip file).
    pub clips: Vec<(String, Vec<u8>)>,
    pub db: Vec<u8>,
    /// The normalized feature matrix (frame-major, `dims` per frame), for search queries.
    pub matrix: Vec<f32>,
}

/// A raw clip of `gait` with its root curve (x, y, z, yaw of the hips per frame), as
/// `anim-wasm/tests/matching.rs` builds them.
fn clip_with_curve(gait: mcommon::Gait) -> Vec<u8> {
    let mut clip = mcommon::clip(gait);
    let hips = &clip.tracks[0].raw;
    let curve = hips
        .as_chunks::<10>()
        .0
        .iter()
        .map(|f| {
            let yaw = 2.0 * (f[4] as f64).atan2(f[6] as f64);
            [f[0], 0.0, f[2], yaw as f32]
        })
        .collect();
    clip.root_curve = Some(curve);
    clip.write().unwrap()
}

/// Builds and bakes the matching set (about a second natively).
pub fn match_set() -> MatchSet {
    let mut rng = mcommon::Rng::new(42);
    let tags: [&[&str]; 4] = [&["idle"], &["walk"], &["run"], &["turn"]];
    let mut clips = Vec::new();
    let mut kinds = Vec::new();
    for i in 0..180 {
        let kind = rng.below(4) as usize;
        let speed = match kind {
            0 => 0.0,
            1 => rng.f32(0.8, 1.8),
            2 => rng.f32(2.5, 4.5),
            _ => rng.f32(0.8, 2.0),
        };
        let yaw_rate = if kind == 3 { rng.f32(-1.5, 1.5) } else { 0.0 };
        let strides = 4 + rng.below(12);
        let g = mcommon::Gait {
            speed: mcommon::Speed::constant(speed),
            yaw_rate,
            cycle: 10.0 / strides as f32,
            duration: 10.0,
            looping: true,
        };
        clips.push((format!("clip{i}.anim"), clip_with_curve(g)));
        kinds.push(kind);
    }
    let skel = mcommon::skeleton().write().unwrap();
    let sview = anim_format::skeleton::SkeletonView::parse(&skel).unwrap();
    let views: Vec<ClipView<'_>> = clips
        .iter()
        .map(|(_, b)| ClipView::parse(b).unwrap())
        .collect();
    let ranges: Vec<[TaggedRange<'_>; 1]> = kinds
        .iter()
        .map(|&k| {
            [TaggedRange {
                start: 0.0,
                end: 10.0,
                tags: tags[k],
            }]
        })
        .collect();
    let bake_clips: Vec<BakeClip<'_>> = views
        .iter()
        .zip(&ranges)
        .zip(&clips)
        .map(|((v, r), (n, _))| BakeClip {
            view: *v,
            form: Form::Raw,
            asset: n,
            ranges: r,
        })
        .collect();
    let schema =
        anim_match::default_schema(mcommon::LEFT_FOOT, mcommon::RIGHT_FOOT, mcommon::HIPS, true);
    // Holden's per-feature deviations (as `anim-wasm/tests/matching.rs`): with only forward
    // clips, per-dimension deviations (floored at 0.01) weigh the sideways trajectory dims, which
    // vary only by the hips' sway and the turns, far above everything else, and a controller's
    // queries then cost hundreds against every frame (so nothing prunes).
    let settings = BakeSettings {
        normalization: anim_match::Normalization::PerFeature,
        ..BakeSettings::default()
    };
    let baked = bake(&sview, &bake_clips, &schema, &settings).unwrap();
    PoseDbView::parse(&baked.bytes).unwrap();
    MatchSet {
        skel,
        clips,
        matrix: baked.db.matrix,
        db: baked.bytes,
    }
}

/// The matching graph's parameter indices and the database's string id.
#[derive(Clone, Copy, Debug)]
pub struct MatchIds {
    pub db: u32,
    pub position: u32,
    pub yaw: u32,
    pub velocity: u32,
    pub desired: u32,
    pub desired_yaw: u32,
}

/// `INERTIALIZE(POSE_DATABASE)` searching every [`SEARCH_INTERVAL`] frames, by KD-tree or brute
/// force (`anim-wasm/tests/matching.rs`'s graph with its default options, except the force
/// threshold: 1e30, so searches come exactly every interval, the budget's definition; with the
/// default 2.0 this synthetic controller forces a search on about 45% of frames).
pub fn match_graph(brute_force: bool) -> (Vec<u8>, MatchIds) {
    let mut b = Builder::new();
    let ids = MatchIds {
        position: b.param("position", ParamValue::Vec2([0.0; 2])),
        yaw: b.param("yaw", ParamValue::Float(0.0)),
        velocity: b.param("velocity", ParamValue::Vec2([0.0; 2])),
        desired: b.param("desired", ParamValue::Vec2([0.0; 2])),
        desired_yaw: b.param("desired_yaw", ParamValue::Float(0.0)),
        db: b.s("db"),
    };
    let lod = b.param("lod", ParamValue::Int(1));
    let mut w = vec![0u32; word::WORDS];
    w[word::DATABASE] = ids.db;
    w[word::INTERVAL] = SEARCH_INTERVAL;
    w[word::FORCE] = 1.0e30f32.to_bits();
    w[word::BIAS] = 0.1f32.to_bits();
    w[word::MIN_SWITCH] = 0.2f32.to_bits();
    w[word::NEIGHBOURS] = 6;
    w[word::VELOCITY_HALF_LIFE] = 0.3f32.to_bits();
    w[word::FACING_HALF_LIFE] = 0.2f32.to_bits();
    w[word::BLEND] = 0.2f32.to_bits();
    w[word::POSITION] = ids.position;
    w[word::YAW] = ids.yaw;
    w[word::VELOCITY] = ids.velocity;
    w[word::DESIRED_VELOCITY] = ids.desired;
    w[word::DESIRED_YAW] = ids.desired_yaw;
    w[word::LOD] = lod;
    w[word::TAGS] = 0;
    for k in 0..12 {
        w[word::TAG_PARAMS + k] = NONE;
    }
    if brute_force {
        w[word::FLAGS] = FLAG_BRUTE_FORCE;
    }
    let m = b.node(
        anim_format::graph::family::MATCHING,
        matching::kind::POSE_DATABASE,
        &[],
        &w,
    );
    let out = b.node(
        anim_format::graph::family::MIXING,
        anim_graph::mixing::kind::INERTIALIZE,
        &[m],
        &[],
    );
    (b.build(out), ids)
}

/// Character `i`'s desired velocity at frame `f`: each character changes speed every two seconds
/// (idle, walk, run), out of step with the others, while its heading turns steadily at 0.4 rad/s
/// (alternate characters the other way), within the database's turn rates (so a search finds a
/// close frame, as with a database built for its game; an uncovered request makes every frame
/// cost hundreds and the KD-tree visit most leaves).
pub fn desired_velocity(i: usize, f: usize) -> [f32; 2] {
    let phase = (f / 120 + i) % 8;
    let speed = [0.0f32, 1.2, 3.5, 1.5, 0.0, 2.5, 4.0, 1.0][phase];
    let turn = if i.is_multiple_of(2) { 0.4 } else { -0.4 };
    let angle = i as f32 * 0.7 + f as f32 * DT * turn;
    [speed * angle.sin(), speed * angle.cos()]
}

/// [`MATCHERS`] characters on the matching database, each driven by a simulated controller.
pub struct Matchers {
    pub core: Core,
    pub handles: Vec<u32>,
    ids: MatchIds,
    pos: Vec<[f32; 2]>,
    vel: Vec<[f32; 2]>,
    yaw: Vec<f32>,
    desired_yaw: Vec<f32>,
    frame: usize,
    commands: Vec<Vec<u8>>,
}

fn vec2(instance: u32, param: u32, v: [f32; 2]) -> Vec<u8> {
    wg::SetParam {
        instance,
        param,
        param_type: 3,
        w0: v[0].to_bits(),
        w1: v[1].to_bits(),
        ..Default::default()
    }
    .encode()
}

impl Matchers {
    pub fn new(set: &MatchSet, brute_force: bool, n: usize) -> Matchers {
        let mut core = start(64, 16);
        let skel = core.load_skeleton(&set.skel);
        let handles: Vec<u32> = set.clips.iter().map(|(_, b)| core.load_clip(b)).collect();
        let db = core.posedb_load(&set.db);
        assert_ne!(db, 0, "the database loads (status {})", core.last_status());
        for (i, (name, _)) in set.clips.iter().enumerate() {
            assert_eq!(core.posedb_clip(db, i as u32), *name);
            assert_eq!(core.posedb_bind(db, i as u32, handles[i]), STATUS_OK);
        }
        let (graph, ids) = match_graph(brute_force);
        let g = core.load_graph(&graph);
        assert_ne!(g, 0, "graph loads (status {})", core.last_status());
        assert_eq!(core.graph_bind(g, ids.db, db), STATUS_OK);
        let handles: Vec<u32> = (0..n).map(|_| core.create_instance(0, skel, g)).collect();
        assert!(handles.iter().all(|&h| h != 0));
        let mut m = Matchers {
            core,
            handles,
            ids,
            pos: vec![[0.0; 2]; n],
            vel: vec![[0.0; 2]; n],
            yaw: vec![0.0; n],
            desired_yaw: vec![0.0; n],
            frame: 0,
            commands: Vec::with_capacity(4 * n),
        };
        for _ in 0..60 {
            m.frame();
        }
        m
    }

    /// One frame: the controllers step toward their desired velocities, turn to face where they
    /// move (at most 4 rad/s; yaw 0 faces +Z, as the clips' root curves) and write the graph
    /// parameters; then `write_inputs` and `evaluate`.
    pub fn frame(&mut self) {
        let k = (DT * 4.0).min(1.0);
        self.commands.clear();
        for (i, &h) in self.handles.iter().enumerate() {
            let desired = desired_velocity(i, self.frame);
            for ((v, p), d) in self.vel[i].iter_mut().zip(&mut self.pos[i]).zip(desired) {
                *v += (d - *v) * k;
                *p += *v * DT;
            }
            let [vx, vz] = self.vel[i];
            if vx * vx + vz * vz > 0.01 {
                let tau = std::f32::consts::TAU;
                let turn = (vx.atan2(vz) - self.yaw[i] + std::f32::consts::PI).rem_euclid(tau)
                    - std::f32::consts::PI;
                self.yaw[i] += turn.clamp(-4.0 * DT, 4.0 * DT);
            }
            self.commands.push(vec2(h, self.ids.position, self.pos[i]));
            self.commands.push(
                wg::SetParam {
                    instance: h,
                    param: self.ids.yaw,
                    param_type: 0,
                    w0: self.yaw[i].to_bits(),
                    ..Default::default()
                }
                .encode(),
            );
            self.commands.push(vec2(h, self.ids.velocity, self.vel[i]));
            self.commands.push(vec2(h, self.ids.desired, desired));
            if desired[0] != 0.0 || desired[1] != 0.0 {
                self.desired_yaw[i] = desired[0].atan2(desired[1]);
            }
            self.commands.push(
                wg::SetParam {
                    instance: h,
                    param: self.ids.desired_yaw,
                    param_type: 0,
                    w0: self.desired_yaw[i].to_bits(),
                    ..Default::default()
                }
                .encode(),
            );
        }
        let cmds = std::mem::take(&mut self.commands);
        send(&mut self.core, &cmds);
        self.commands = cmds;
        self.core.evaluate(0, PASS_NORMAL, DT, DT);
        self.frame += 1;
    }
}

// -------------------------------------------------------------------------------------------------
// Tweens
// -------------------------------------------------------------------------------------------------

/// Which tween mix.
#[derive(Clone, Copy, Debug)]
pub enum TweenMix {
    /// Endless linear float tweens.
    Linear,
    /// Float tweens over every easing id, half of them yoyo.
    Eased,
    /// Half vec3, half quaternion slerp.
    VecQuat,
}

/// A core with [`TWEENS`] endless tweens of `mix` (`bench_tweens.mjs`'s records).
pub fn tweens(mix: TweenMix) -> Core {
    let mut core = start(8, 64);
    core.tweens_configure(2048);
    for i in 0..TWEENS as u32 {
        let (kind, width, ease, flags) = match mix {
            TweenMix::Linear => (0, 1, 0, 0),
            TweenMix::Eased => (0, 1, i % 31, if i % 2 == 1 { 2 } else { 0 }),
            TweenMix::VecQuat => {
                if i % 2 == 1 {
                    (2, 4, 15, 0)
                } else {
                    (0, 3, 6, 0)
                }
            }
        };
        let r = TweenCreate {
            world: 0,
            host_id: i,
            column: i,
            value_kind: kind,
            width,
            ease,
            flags,
            time_mode: 0,
            loops: 0xffff_ffff,
            duration: 1.5,
            delay: 0.0,
            speed: 1.0,
            from0: 0.0,
            from1: 0.0,
            from2: 0.0,
            from3: 1.0,
            to0: 1.0,
            to1: 2.0,
            to2: 3.0,
            to3: 1.0,
        };
        assert_ne!(core.tween_create(&r.encode()), 0);
    }
    core
}

// -------------------------------------------------------------------------------------------------
// Node fixtures
// -------------------------------------------------------------------------------------------------

/// Writes the Node benchmark's files into `dir`: the 80-bone humanoid with its clips and graphs,
/// the matching set with its two graphs, and `bench.json` (string ids and parameter indices).
pub fn write_fixtures(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let h = humanoid(80);
    std::fs::write(dir.join("humanoid80.skel"), &h.skel)?;
    std::fs::write(dir.join("humanoid80_idle.anim"), &h.idle)?;
    std::fs::write(dir.join("humanoid80_walk.anim"), &h.walk)?;
    std::fs::write(dir.join("humanoid80_run.anim"), &h.run)?;
    let (loco, ids) = loco_graph(false);
    let (loco_rig, _) = loco_graph(true);
    std::fs::write(dir.join("loco.animgraph"), loco)?;
    std::fs::write(dir.join("loco_rig.animgraph"), loco_rig)?;
    let set = match_set();
    std::fs::write(dir.join("match.skel"), &set.skel)?;
    std::fs::write(dir.join("match.posedb"), &set.db)?;
    for (name, bytes) in &set.clips {
        std::fs::write(dir.join(name), bytes)?;
    }
    let (kd, m) = match_graph(false);
    let (bf, _) = match_graph(true);
    std::fs::write(dir.join("match_kd.animgraph"), kd)?;
    std::fs::write(dir.join("match_bf.animgraph"), bf)?;
    let mut json = String::from("{\n");
    let _ = writeln!(
        json,
        "  \"loco\": {{ \"x\": {}, \"y\": {}, \"speed\": {}, \"moving\": {}, \"idle\": {}, \"walk\": {}, \"run\": {}, \"upper\": {} }},",
        ids.x, ids.y, ids.speed, ids.moving, ids.idle, ids.walk, ids.run, ids.upper
    );
    let _ = writeln!(
        json,
        "  \"match\": {{ \"db\": {}, \"position\": {}, \"yaw\": {}, \"velocity\": {}, \"desired\": {}, \"desiredYaw\": {}, \"clips\": {}, \"frames\": {} }}",
        m.db,
        m.position,
        m.yaw,
        m.velocity,
        m.desired,
        m.desired_yaw,
        set.clips.len(),
        PoseDbView::parse(&set.db).map_or(0, |v| v.frame_count())
    );
    json.push_str("}\n");
    std::fs::write(dir.join("bench.json"), json)
}
