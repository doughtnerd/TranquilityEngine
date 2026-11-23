//! `evaluate`, `physics_read` and `physics_drive` never allocate with the retarget and physics
//! node families (T41, T44r): a counting global allocator sees nothing across frames that run a
//! `RETARGET` node with pinning (its source graph on another skeleton) and a ragdoll instance
//! (`PHYSICAL_POSE`, `PHYSICS_BLEND`, drives, facing), after setup.

mod common;
mod rigs;

use anim_format::graph::{family, ParamValue};
use anim_format::NONE;
use anim_graph::physics as nodes;
use anim_graph::retarget::{kind, RetargetParams, MAX_GOALS};
use anim_retarget::RootAxis;
use common::graph::*;
use common::*;
use rigs::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Counting;
static ALLOCS: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::SeqCst);
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

#[test]
fn retarget_and_physics_frames_do_not_allocate() {
    let src = humanoid(Build {
        axes: Axes::YAlong,
        ..Build::default()
    });
    let tgt = humanoid(Build {
        axes: Axes::XAlong,
        arm_drop: 0.5,
        leg: 0.9,
        ..Build::default()
    });
    let (src_model, src_file) = skeleton_file(&src, true, false);
    let (tgt_model, tgt_file) = skeleton_file(&tgt, true, false);
    let mut core = core(8, 64);
    let ss = core.load_skeleton(&src_file);
    let ts = core.load_skeleton(&tgt_file);
    let map = core.retarget_map_create(ss, 0, &src.map.bones, ts, 0, &tgt.map.bones, 1);
    let clip = core.load_clip(&raw_clip(&src_model, &ClipSpec::new(1.0, true, 3)));
    let mut b = Builder::new();
    let p = b.player("clip");
    let g = core.load_graph(&b.build(p));
    core.graph_bind(g, b.s("clip"), clip);

    // The retarget instance, pinning every goal.
    let mut goals = [(0.0, NONE); MAX_GOALS];
    let n = core.retarget_goal_count(map) as usize;
    goals[..n].fill((1.0, NONE));
    let rp = RetargetParams {
        map: 0,
        graph: 1,
        state_capacity: 4096,
        depth_capacity: 2,
        param_capacity: 4,
        root_axes: [RootAxis::Scaled, RootAxis::Scaled, RootAxis::Locked],
        goals,
        goal_count: n,
    };
    let mut rb = Builder::new();
    let (m, sg) = (rb.s("map"), rb.s("src"));
    let node = rb.node(family::RETARGET, kind::RETARGET, &[], &rp.words());
    instance(&mut core, &rb.build(node), ts, &[(m, map), (sg, g)]);

    // The ragdoll instance.
    let tclip = core.load_clip(&raw_clip(&tgt_model, &ClipSpec::new(1.0, true, 4)));
    let mut pb = Builder::new();
    let w = pb.param("w", ParamValue::Float(0.5));
    let player = pb.player("clip");
    let phys = pb.node(family::PHYSICS, nodes::kind::PHYSICAL_POSE, &[player], &[]);
    let blend = pb.node(
        family::PHYSICS,
        nodes::kind::PHYSICS_BLEND,
        &[player, phys],
        &[1.0f32.to_bits(), w, NONE],
    );
    let (_, h) = instance(&mut core, &pb.build(blend), ts, &[(pb.s("clip"), tclip)]);
    let desc = core.ragdoll_build(&tgt_file, 0);
    let rd = core.ragdoll_create(ts, &desc);
    core.physics_configure(4);
    assert_eq!(core.physics_attach(h, rd), 0);

    let step = |core: &mut anim_wasm::init::Core| {
        core.physics_read(0);
        frame(core, 1.0 / 60.0);
        core.physics_drive(0);
    };
    for _ in 0..3 {
        step(&mut core);
    }
    // Simulated bodies from the drive's own output, so the physical pose and facing run.
    let out: Vec<u32> = core.physics_output().to_vec();
    let (row_out_w, drive_w) = (
        anim_wire::physics::RowOut::STRIDE as usize / 4,
        anim_wire::physics::DriveOut::STRIDE as usize / 4,
    );
    let (ctl_w, body_w) = (
        anim_wire::physics::RowControl::STRIDE as usize / 4,
        anim_wire::physics::BodyIn::STRIDE as usize / 4,
    );
    let input = core.physics_input_mut();
    for bone in 0..tgt.n() {
        let d = &out[row_out_w + bone * drive_w..][..drive_w];
        let i = &mut input[ctl_w + bone * body_w..][..body_w];
        i[1] = anim_wire::physics::BODY_SIMULATED;
        // DriveOut position and rotation words (after the header): 14..21.
        i[2..9].copy_from_slice(&d[14..21]);
    }
    for _ in 0..3 {
        step(&mut core);
    }
    let before = ALLOCS.load(Ordering::SeqCst);
    for _ in 0..30 {
        step(&mut core);
    }
    assert_eq!(ALLOCS.load(Ordering::SeqCst), before);
}
