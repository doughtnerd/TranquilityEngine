//! Motion matching through the core (T42 node half): a `POSE_DATABASE` node over a small synthetic
//! database (anim-match's procedural idle and walk clips, tagged `idle` and `walk`), driven by
//! graph parameters like a character controller. Covered: a switch inertializes through the
//! ancestor `INERTIALIZE` node (and cuts without one); tag filters from the node's masks, an int
//! parameter and a chooser row; the search interval times the LOD multiplier; root motion from the
//! matched clip's root curve; snapshot and restore; no allocation per frame; the `match` family's
//! debug records and the database's clip table.

mod common;
#[path = "../../anim-match/tests/common/mod.rs"]
mod mcommon;

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use anim_format::clip::ClipView;
use anim_format::graph::{family, CmpOp, CondNode, Operand, ParamValue};
use anim_format::posedb::PoseDbView;
use anim_format::NONE;
use anim_graph::matching::{self, word};
use anim_graph::{logic, mixing};
use anim_match::{tag_index, BakeSettings};
use anim_wasm::init::Core;
use anim_wire::core::{STATUS_MISMATCH, STATUS_OK, STATUS_WRONG_KIND};
use anim_wire::graph as wg;
use anim_wire::r#match::{MatchHeader, MatchNode, MATCH_SEARCHED, MATCH_SWITCHED};
use anim_wire::WireRecord;
use common::graph::*;
use common::*;

const DT: f32 = 1.0 / 30.0;
const MAX_BONES: u32 = 16;

// Only the measuring thread counts (the other tests run in parallel).
std::thread_local! {
    static COUNTING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
struct Counting;
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        if COUNTING.with(|c| c.get()) {
            ALLOCS.fetch_add(1, Ordering::SeqCst);
        }
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
}
#[global_allocator]
static GLOBAL: Counting = Counting;

/// A clip with its root curve (x, y, z, yaw of the hips per frame), as the importer extracts it.
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

/// The database: idle and walk, tagged by name.
struct Fixture {
    skel: Vec<u8>,
    idle: Vec<u8>,
    walk: Vec<u8>,
    db: Vec<u8>,
    idle_tag: usize,
    walk_tag: usize,
}

fn fixture() -> Fixture {
    let fx = mcommon::fixture();
    let keep = ["idle.anim", "walk.anim"];
    let pick = |name: &str| fx.names.iter().position(|n| *n == name).unwrap();
    let small = mcommon::Fixture {
        skel: fx.skel.clone(),
        clips: keep.iter().map(|n| fx.clips[pick(n)].clone()).collect(),
        names: keep.to_vec(),
        ranges: keep.iter().map(|n| fx.ranges[pick(n)].clone()).collect(),
        durations: keep.iter().map(|n| fx.durations[pick(n)]).collect(),
    };
    // Holden's per-feature deviations: with no turning clip, the sideways trajectory dims vary
    // only by the hips' sway, and per-dimension deviations (floored at 0.01) would weigh that
    // noise far above everything else.
    let settings = BakeSettings {
        normalization: anim_match::Normalization::PerFeature,
        ..BakeSettings::default()
    };
    let baked = small.bake(&mcommon::schema(), &settings);
    let view = PoseDbView::parse(&baked.bytes).unwrap();
    Fixture {
        idle_tag: tag_index(&view, "idle").unwrap(),
        walk_tag: tag_index(&view, "walk").unwrap(),
        skel: fx.skel,
        idle: clip_with_curve(mcommon::idle()),
        walk: clip_with_curve(mcommon::walk()),
        db: baked.bytes,
    }
}

/// The graph's parameter indices.
struct Params {
    position: u32,
    yaw: u32,
    velocity: u32,
    desired: u32,
    lod: u32,
    tags: u32,
    mode: u32,
}

#[derive(Clone, Copy)]
struct Options {
    inertialize: bool,
    interval: u32,
    force: f32,
    required: u32,
    tag_param: bool,
    chooser: Option<(u32, u32)>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            inertialize: true,
            interval: 6,
            force: 2.0,
            required: 0,
            tag_param: false,
            chooser: None,
        }
    }
}

/// `INERTIALIZE(POSE_DATABASE)` (or the database node alone); returns the graph, the database
/// node and the database's string id.
fn graph(o: Options) -> (Vec<u8>, u32, u32, Params) {
    let mut b = Builder::new();
    let p = Params {
        position: b.param("position", ParamValue::Vec2([0.0; 2])),
        yaw: b.param("yaw", ParamValue::Float(0.0)),
        velocity: b.param("velocity", ParamValue::Vec2([0.0; 2])),
        desired: b.param("desired", ParamValue::Vec2([0.0; 2])),
        lod: b.param("lod", ParamValue::Int(1)),
        tags: b.param("tags", ParamValue::Int(0)),
        mode: b.param("mode", ParamValue::Int(0)),
    };
    let db = b.s("db");
    let mut w = vec![0u32; word::WORDS];
    w[word::DATABASE] = db;
    w[word::INTERVAL] = o.interval;
    w[word::FORCE] = o.force.to_bits();
    w[word::BIAS] = 0.1f32.to_bits();
    w[word::MIN_SWITCH] = 0.2f32.to_bits();
    w[word::NEIGHBOURS] = 6;
    w[word::VELOCITY_HALF_LIFE] = 0.3f32.to_bits();
    w[word::FACING_HALF_LIFE] = 0.2f32.to_bits();
    w[word::BLEND] = 0.2f32.to_bits();
    w[word::POSITION] = p.position;
    w[word::YAW] = p.yaw;
    w[word::VELOCITY] = p.velocity;
    w[word::DESIRED_VELOCITY] = p.desired;
    w[word::DESIRED_YAW] = NONE;
    w[word::LOD] = p.lod;
    w[word::TAGS] = o.required;
    for k in 0..12 {
        w[word::TAG_PARAMS + k] = NONE;
    }
    if o.tag_param {
        w[word::TAG_PARAMS] = p.tags;
    }
    let inputs: Vec<u32> = match o.chooser {
        Some((when_one, otherwise)) => {
            let tags = |b: &mut Builder, bit: u32| {
                let mut m = [0u32; 12];
                m[0] = bit;
                b.node(family::MATCHING, matching::kind::MATCH_TAGS, &[], &m)
            };
            let one = tags(&mut b, when_one);
            let other = tags(&mut b, otherwise);
            let cond = b.cond(&[CondNode::Compare {
                operand: Operand::Param(p.mode),
                op: CmpOp::Eq,
                value: 1,
            }]);
            vec![b.chooser(&[(cond, one)], other, logic::CHOOSER_EVERY_UPDATE, 0.0)]
        }
        None => Vec::new(),
    };
    let m = b.node(family::MATCHING, matching::kind::POSE_DATABASE, &inputs, &w);
    let out = if o.inertialize {
        b.node(family::MIXING, mixing::kind::INERTIALIZE, &[m], &[])
    } else {
        m
    };
    (b.build(out), m, db, p)
}

fn set_vec2(instance: u32, param: u32, v: [f32; 2]) -> Vec<u8> {
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

/// A core with the fixture loaded and an instance of `graph`.
struct Sim {
    core: Core,
    h: u32,
    clips: [u32; 2],
    db: u32,
    p: Params,
    node: u32,
    /// The simulated character controller: position, velocity.
    pos: [f32; 2],
    vel: [f32; 2],
}

impl Sim {
    fn new(fx: &Fixture, o: Options) -> Sim {
        let mut core = core(4, MAX_BONES);
        let s = core.load_skeleton(&fx.skel);
        let idle = core.load_clip(&fx.idle);
        let walk = core.load_clip(&fx.walk);
        let db = core.posedb_load(&fx.db);
        assert_ne!(db, 0, "the database loads (status {})", core.last_status());
        for i in 0..2 {
            let name = core.posedb_clip(db, i);
            let clip = if name == "idle.anim" { idle } else { walk };
            assert_eq!(core.posedb_bind(db, i, clip), STATUS_OK);
        }
        let (g, node, db_sid, p) = graph(o);
        let (_, h) = instance(&mut core, &g, s, &[(db_sid, db)]);
        Sim {
            core,
            h,
            clips: [idle, walk],
            db,
            p,
            node,
            pos: [0.0; 2],
            vel: [0.0; 2],
        }
    }

    /// One frame toward desired velocity `desired` (world, facing +Z), plus `extra` commands.
    fn step(&mut self, desired: [f32; 2], extra: &[Vec<u8>]) -> MatchNode {
        let k = (DT * 4.0).min(1.0);
        for ((v, p), d) in self.vel.iter_mut().zip(&mut self.pos).zip(desired) {
            *v += (d - *v) * k;
            *p += *v * DT;
        }
        let mut cmds = vec![
            set_vec2(self.h, self.p.position, self.pos),
            set_vec2(self.h, self.p.velocity, self.vel),
            set_vec2(self.h, self.p.desired, desired),
            set_float(self.h, self.p.yaw, 0.0),
        ];
        cmds.extend_from_slice(extra);
        command_frame(&mut self.core, &cmds, DT);
        self.report()
    }

    fn report(&mut self) -> MatchNode {
        let n = self.core.match_debug_write(self.h) as usize;
        let bytes = &self.core.match_debug()[..n];
        let header = MatchHeader::decode(bytes).unwrap();
        assert_eq!(
            (header.instance, header.nodes, header.dropped),
            (self.h, 1, 0)
        );
        let node = MatchNode::decode(&bytes[MatchHeader::STRIDE as usize..]).unwrap();
        assert_eq!(node.node, self.node);
        assert_eq!(node.database, self.db);
        node
    }

    fn matrices(&self) -> Vec<f32> {
        matrices(&self.core, self.h, MAX_BONES as usize, 8)
    }
}

/// The clip's pose at `t` (the f64 reference sampler), as bone matrices.
fn reference(fx: &Fixture, clip: &[u8], t: f32) -> Vec<f64> {
    let r = Reference::new(&fx.skel);
    let view = ClipView::parse(clip).unwrap();
    let local = anim_offline::sample::sample_raw_pose(&view, &r.rest, t as f64);
    r.matrices(&local)
}

#[test]
fn the_database_loads_and_binds_its_clips() {
    let fx = fixture();
    let mut core = core(4, MAX_BONES);
    let db = core.posedb_load(&fx.db);
    assert_eq!(core.posedb_clip(db, 0), "idle.anim");
    assert_eq!(core.posedb_clip(db, 1), "walk.anim");
    assert_eq!(core.posedb_clip(db, 2), "");
    let clip = core.load_clip(&fx.idle);
    assert_eq!(core.posedb_bind(db, 2, clip), STATUS_MISMATCH);
    assert_eq!(core.posedb_bind(db, 0, db), STATUS_WRONG_KIND);
    assert_eq!(core.posedb_bind(clip, 0, clip), STATUS_WRONG_KIND);
    assert_eq!(core.posedb_load(&fx.db[..fx.db.len() - 8]), 0);
    assert_eq!(core.last_status(), anim_wire::core::STATUS_BAD_ASSET);
}

/// T70: each node's report carries the trajectory it predicted (one sample per database offset)
/// and the playing frame's trajectory features, de-normalised; within 1e-5 of the baked values
/// (the core keeps rows times √weight in f32, so dividing back costs an ulp or two).
#[test]
fn the_report_carries_the_predicted_and_matched_trajectories() {
    use anim_wire::r#match::{MatchSample, SAMPLE_MATCHED, SAMPLE_PREDICTED};
    let fx = fixture();
    let mut sim = Sim::new(&fx, Options::default());
    let mut last = sim.step([0.0; 2], &[]);
    for _ in 0..40 {
        last = sim.step([0.0, 1.4], &[]);
    }
    let n = sim.core.match_debug_write(sim.h) as usize;
    let bytes = sim.core.match_debug()[..n].to_vec();
    let header = MatchHeader::decode(&bytes).unwrap();
    assert_eq!((header.nodes, header.dropped), (1, 0));
    let mut at = (MatchHeader::STRIDE + MatchNode::STRIDE) as usize;
    let mut samples = Vec::new();
    while at < n {
        samples.push(MatchSample::decode(&bytes[at..]).unwrap());
        at += MatchSample::STRIDE as usize;
    }
    let view = PoseDbView::parse(&fx.db).unwrap();
    assert_eq!(last.db_clip, view.frame(last.frame as usize).unwrap().clip);
    assert_eq!(last.flags & anim_wire::r#match::MATCH_MIRRORED, 0);
    let mut offsets: Vec<f32> = (0..view.feature_count())
        .filter_map(|i| view.feature(i))
        .filter(|f| f.bone == NONE)
        .map(|f| f.time_offset)
        .collect();
    offsets.sort_by(f32::total_cmp);
    offsets.dedup();
    let predicted: Vec<_> = samples
        .iter()
        .filter(|s| s.kind == SAMPLE_PREDICTED)
        .collect();
    let matched: Vec<_> = samples
        .iter()
        .filter(|s| s.kind == SAMPLE_MATCHED)
        .collect();
    assert_eq!(predicted.len(), offsets.len());
    assert_eq!(matched.len(), offsets.len());
    assert!(samples.iter().all(|s| s.node == sim.node));
    // Walking ahead (+Z, facing +Z): the future samples lie ahead, further for later times.
    let future: Vec<_> = predicted.iter().filter(|s| s.time > 0.0).collect();
    assert!(!future.is_empty());
    assert!(future.windows(2).all(|w| w[1].z > w[0].z && w[0].z > 0.0));
    assert!(future.iter().all(|s| (s.dx.hypot(s.dz) - 1.0).abs() < 1e-4));
    // The matched samples are the playing frame's baked features.
    let (mean, std, matrix) = (view.mean(), view.std(), view.matrix());
    let stride = view.row_stride();
    for i in 0..view.feature_count() {
        let f = view.feature(i).unwrap();
        if f.bone != NONE {
            continue;
        }
        let s = matched.iter().find(|s| s.time == f.time_offset).unwrap();
        let got = if f.kind == anim_format::posedb::FeatureKind::TrajectoryPosition {
            [s.x, s.z]
        } else {
            [s.dx, s.dz]
        };
        for k in 0..2 {
            let d = f.first_dim as usize + k;
            let raw = matrix.get(last.frame as usize * stride + d).unwrap() * std.get(d).unwrap()
                + mean.get(d).unwrap();
            assert!((got[k] - raw).abs() < 1e-5, "{} vs {raw}", got[k]);
        }
    }
}

/// T70: a mirrored copy plays mirrored. The database keeps idle and only walk's mirrored copy
/// (the original's frames are taken out), so walking can only match the copy; once settled the
/// pose is the clip's mirrored through the table (the f64 reference mirror, 1e-4 as above).
#[test]
fn a_mirrored_copy_plays_mirrored() {
    use anim_offline::pose::{mirror, Axis as RefAxis};
    let mut fx = fixture();
    let m = mcommon::fixture();
    let keep = ["idle.anim", "walk.anim"];
    let pick = |name: &str| m.names.iter().position(|n| *n == name).unwrap();
    let small = mcommon::Fixture {
        skel: m.skel.clone(),
        clips: keep.iter().map(|n| m.clips[pick(n)].clone()).collect(),
        names: keep.to_vec(),
        ranges: keep.iter().map(|n| m.ranges[pick(n)].clone()).collect(),
        durations: keep.iter().map(|n| m.durations[pick(n)]).collect(),
    };
    let (skel, views) = small.views();
    let bones = skel.bone_count();
    let table: Vec<u32> = std::iter::once(0).chain(0..bones as u32).collect();
    let ranges: Vec<Vec<anim_match::TaggedRange<'_>>> = small
        .ranges
        .iter()
        .map(|rs| {
            rs.iter()
                .map(|&(start, end, tags)| anim_match::TaggedRange { start, end, tags })
                .collect()
        })
        .collect();
    let clips: Vec<anim_match::BakeClip<'_>> = views
        .iter()
        .zip(&small.names)
        .zip(&ranges)
        .map(|((v, n), r)| anim_match::BakeClip {
            view: *v,
            form: anim_sample::Form::Raw,
            asset: n,
            ranges: r,
            mirror: *n == "walk.anim",
        })
        .collect();
    let settings = BakeSettings {
        normalization: anim_match::Normalization::PerFeature,
        mirror: &table,
        ..BakeSettings::default()
    };
    let mut db = anim_match::bake(&skel, &clips, &mcommon::schema(), &settings)
        .unwrap()
        .db;
    assert_eq!(
        db.clip_flags,
        vec![0, 0, anim_format::posedb::CLIP_MIRRORED]
    );
    // Take walk's original frames (entry 1) out.
    let dims = db.dims as usize;
    let wpf = anim_format::posedb::words_per_frame(db.tag_names.len());
    let keep: Vec<usize> = (0..db.frames.len())
        .filter(|&i| db.frames[i].clip != 1)
        .collect();
    db.matrix = keep
        .iter()
        .flat_map(|&i| db.matrix[i * dims..(i + 1) * dims].to_vec())
        .collect();
    db.tags = keep
        .iter()
        .flat_map(|&i| db.tags[i * wpf..(i + 1) * wpf].to_vec())
        .collect();
    db.frames = keep.iter().map(|&i| db.frames[i]).collect();
    db.kd_tree = None;
    fx.db = db.write().unwrap();

    let mut sim = Sim::new(&fx, Options::default());
    assert_eq!(sim.core.posedb_clip(sim.db, 2), "walk.anim");
    assert_eq!(sim.core.posedb_bind(sim.db, 2, sim.clips[1]), STATUS_OK);
    for _ in 0..20 {
        sim.step([0.0; 2], &[]);
    }
    let partner: Vec<u16> = (0..bones as u16).collect();
    let r = Reference::new(&fx.skel);
    let view = ClipView::parse(&fx.walk).unwrap();
    let mut quiet = 0;
    let mut checked = false;
    for _ in 0..90 {
        let rep = sim.step([0.0, 1.4], &[]);
        quiet = if rep.flags & MATCH_SWITCHED != 0 {
            0
        } else {
            quiet + 1
        };
        if rep.clip != sim.clips[1] || quiet < 8 {
            continue;
        }
        let local = anim_offline::sample::sample_raw_pose(&view, &r.rest, rep.time as f64);
        let mirrored = r.matrices(&mirror(&local, &partner, RefAxis::X));
        let plain = r.matrices(&local);
        let got = sim.matrices();
        assert!(
            max_diff(&got, &mirrored) < 1e-4,
            "{}",
            max_diff(&got, &mirrored)
        );
        assert!(max_diff(&got, &plain) > 1e-3, "not the clip as it is");
        assert_eq!(
            rep.flags & anim_wire::r#match::MATCH_MIRRORED,
            anim_wire::r#match::MATCH_MIRRORED
        );
        assert_eq!(rep.db_clip, 2);
        checked = true;
        break;
    }
    assert!(checked, "walk settled on its mirrored copy");
}

#[test]
fn idle_then_walk_switches_through_inertialization() {
    let fx = fixture();
    for inertialize in [true, false] {
        let mut sim = Sim::new(
            &fx,
            Options {
                inertialize,
                ..Options::default()
            },
        );
        let first = sim.step([0.0; 2], &[]);
        assert_eq!(
            first.flags & MATCH_SWITCHED,
            MATCH_SWITCHED,
            "the first update starts a clip"
        );
        for _ in 0..30 {
            let r = sim.step([0.0; 2], &[]);
            assert_eq!(r.clip, sim.clips[0], "standing still plays idle");
        }
        let mut prev = sim.matrices();
        let mut prev_clip = sim.clips[0];
        let mut switched = None;
        let mut log = Vec::new();
        for f in 0..60 {
            let r = sim.step([0.0, 1.4], &[]);
            let m = sim.matrices();
            log.push((r, m.clone()));
            let to_walk = r.clip == sim.clips[1] && prev_clip == sim.clips[0];
            prev_clip = r.clip;
            if switched.is_none() && r.flags & MATCH_SWITCHED != 0 && to_walk {
                let raw = reference(&fx, &fx.walk, r.time);
                let off = max_diff(&m, &raw);
                let jump = max_diff(&m, &prev.iter().map(|v| *v as f64).collect::<Vec<_>>());
                let raw_jump = max_diff(&prev, &raw);
                if inertialize {
                    assert!(
                        off > 1e-2,
                        "the switch frame shows the decaying offset ({off})"
                    );
                    assert!(
                        jump < raw_jump,
                        "inertialization softens the jump ({jump} vs {raw_jump})"
                    );
                } else {
                    assert!(
                        off < 1e-4,
                        "without an inertialization node it is a cut ({off})"
                    );
                }
                switched = Some(f);
            }
            prev = m;
        }
        let s = switched.expect("a switch to walk");
        // After the blend time with no further switch, the output is the matched clip.
        let settled = (s + 1..log.len())
            .find(|&f| {
                f >= s + 8
                    && log[s + 1..=f]
                        .iter()
                        .all(|(r, _)| r.flags & MATCH_SWITCHED == 0)
            })
            .expect("a quiet stretch after the switch");
        let (r, m) = &log[settled];
        assert_eq!(r.clip, sim.clips[1]);
        let off = max_diff(m, &reference(&fx, &fx.walk, r.time));
        assert!(off < 1e-4, "settled onto the clip ({off})");
    }
}

#[test]
fn root_motion_comes_from_the_matched_clip() {
    let fx = fixture();
    let mut sim = Sim::new(&fx, Options::default());
    for _ in 0..20 {
        sim.step([0.0; 2], &[]);
    }
    let mut walked = 0;
    for _ in 0..90 {
        let r = sim.step([0.0, 1.4], &[]);
        let root = root(&sim.core, sim.h);
        if r.clip == sim.clips[1] && r.flags & MATCH_SWITCHED == 0 {
            // The walk clip's root curve: 1.4 m/s along +Z (one frame of it, in the step's frame).
            assert!((root[2] - 1.4 * DT).abs() < 2e-3, "walk root step {root:?}");
            assert!(
                root[0].abs() < 5e-3,
                "only the hips' sway sideways {root:?}"
            );
            walked += 1;
        }
        if r.clip == sim.clips[0] && r.flags & MATCH_SWITCHED == 0 {
            assert!(root[2].abs() < 1e-4, "idle has no root motion");
        }
    }
    assert!(walked > 30);
}

#[test]
fn tags_gate_the_search() {
    let fx = fixture();
    let idle_bit = 1u32 << fx.idle_tag;
    let walk_bit = 1u32 << fx.walk_tag;

    // A static `required: idle` mask: wanting to walk still plays idle.
    let mut sim = Sim::new(
        &fx,
        Options {
            required: idle_bit,
            ..Options::default()
        },
    );
    for _ in 0..60 {
        assert_eq!(sim.step([0.0, 1.4], &[]).clip, sim.clips[0]);
    }

    // An int parameter: idle while it says idle, walk at once when it says walk (a filtered-out
    // continuation switches immediately, D59).
    let mut sim = Sim::new(
        &fx,
        Options {
            tag_param: true,
            ..Options::default()
        },
    );
    let (h, tags) = (sim.h, sim.p.tags);
    for _ in 0..30 {
        let r = sim.step([0.0, 1.4], &[set_int(h, tags, idle_bit as i32)]);
        assert_eq!(r.clip, sim.clips[0]);
    }
    let r = sim.step([0.0, 1.4], &[set_int(h, tags, walk_bit as i32)]);
    assert_eq!(
        (r.clip, r.flags & MATCH_SWITCHED),
        (sim.clips[1], MATCH_SWITCHED)
    );
    let r = sim.step([0.0; 2], &[set_int(h, tags, walk_bit as i32)]);
    assert_eq!(
        r.clip, sim.clips[1],
        "the walk-only filter keeps walking while standing still"
    );

    // A chooser row: `mode == 1` picks a walk-only MATCH_TAGS row, else idle-only.
    let mut sim = Sim::new(
        &fx,
        Options {
            chooser: Some((walk_bit, idle_bit)),
            ..Options::default()
        },
    );
    let (h, mode) = (sim.h, sim.p.mode);
    for _ in 0..20 {
        assert_eq!(
            sim.step([0.0; 2], &[set_int(h, mode, 1)]).clip,
            sim.clips[1]
        );
    }
    let r = sim.step([0.0; 2], &[set_int(h, mode, 0)]);
    assert_eq!(
        (r.clip, r.flags & MATCH_SWITCHED),
        (sim.clips[0], MATCH_SWITCHED)
    );
}

#[test]
fn searches_run_every_interval_times_lod_updates() {
    let fx = fixture();
    let mut sim = Sim::new(
        &fx,
        Options {
            interval: 4,
            force: 1e9,
            ..Options::default()
        },
    );
    let (h, lod) = (sim.h, sim.p.lod);
    let mut searched = Vec::new();
    for _ in 0..40 {
        let r = sim.step([0.0; 2], &[set_int(h, lod, 2)]);
        if r.flags & MATCH_SEARCHED != 0 {
            assert_eq!(r.last_search, r.updates);
            searched.push(r.updates);
        }
    }
    assert_eq!(searched, vec![1, 9, 17, 25, 33], "every 4 × 2 updates");
    searched.clear();
    for _ in 0..16 {
        let r = sim.step([0.0; 2], &[set_int(h, lod, 1)]);
        if r.flags & MATCH_SEARCHED != 0 {
            searched.push(r.updates);
        }
    }
    assert_eq!(
        searched,
        vec![41, 45, 49, 53],
        "every 4 updates at LOD 1 (the last search was at 33)"
    );
}

#[test]
fn snapshot_and_restore_are_exact() {
    let fx = fixture();
    let mut sim = Sim::new(&fx, Options::default());
    for f in 0..40 {
        sim.step(if f < 15 { [0.0; 2] } else { [0.0, 1.4] }, &[]);
    }
    let n = sim.core.snapshot_bytes(sim.h) as usize;
    let mut snap = vec![0u8; n];
    assert_eq!(sim.core.snapshot(sim.h, &mut snap), STATUS_OK);
    let (pos, vel) = (sim.pos, sim.vel);
    let run = |sim: &mut Sim| -> Vec<(Vec<u32>, [u32; 7], [u32; 4])> {
        (0..45)
            .map(|f| {
                let d = if f < 20 { [0.3, 1.4] } else { [0.0; 2] };
                let r = sim.step(d, &[]);
                let m = sim.matrices().iter().map(|v| v.to_bits()).collect();
                let root = root(&sim.core, sim.h).map(f32::to_bits);
                (m, root, [r.clip, r.time.to_bits(), r.frame, r.flags])
            })
            .collect()
    };
    let a = run(&mut sim);
    assert_eq!(sim.core.restore(sim.h, &snap), STATUS_OK);
    sim.pos = pos;
    sim.vel = vel;
    let b = run(&mut sim);
    assert!(a == b, "the restored instance repeats every bit");
}

#[test]
fn frames_never_allocate() {
    let fx = fixture();
    let mut sim = Sim::new(
        &fx,
        Options {
            chooser: Some((1, 2)),
            tag_param: true,
            ..Options::default()
        },
    );
    let cmds: Vec<Vec<u8>> = vec![
        set_vec2(sim.h, sim.p.position, [0.1, 0.2]),
        set_vec2(sim.h, sim.p.velocity, [0.0, 1.0]),
        set_vec2(sim.h, sim.p.desired, [0.0, 1.4]),
        set_int(sim.h, sim.p.mode, 1),
    ];
    for _ in 0..10 {
        command_frame(&mut sim.core, &cmds, DT);
    }
    let flips = [
        vec![set_int(sim.h, sim.p.mode, 0)],
        vec![set_int(sim.h, sim.p.mode, 1)],
    ];
    COUNTING.with(|c| c.set(true));
    for f in 0..60 {
        send(&mut sim.core, &flips[(f / 20) % 2]);
        sim.core.evaluate(0, anim_wire::core::PASS_NORMAL, DT, DT);
        sim.core.match_debug_write(sim.h);
    }
    COUNTING.with(|c| c.set(false));
    assert_eq!(ALLOCS.load(Ordering::SeqCst), 0);
}
