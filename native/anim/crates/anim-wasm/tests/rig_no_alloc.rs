//! `write_inputs`, `evaluate` and `debug_write` never allocate with rig nodes (ADR 0340, T40): a
//! counting global allocator sees no allocation across frames that run every rig kind (IK of
//! every flavour, look-at and aim, the grounder with fed hits, a spring chain with a collider,
//! copy, limit and damp constraints, stride and orientation warping, a motion warp through its
//! window and distance matching), with target, hit and LOD changes, warp-target and reset
//! commands, and debug reports, after setup.

mod common;

use anim_format::graph::ParamValue;
use anim_format::NONE;
use anim_graph::rig::{self as rg, kind};
use anim_retarget::profile::humanoid as role;
use anim_wire::core::PASS_NORMAL;
use common::graph::*;
use common::rig::*;
use common::*;
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

const MB: usize = 32;

fn ids(list: &[u16]) -> Vec<u32> {
    list.iter().map(|&x| x as u32).collect()
}

#[test]
fn rig_frames_do_not_allocate() {
    let (model, skel_bytes) = rig_skeleton();
    let mut core = core(8, MB as u32);
    let s = core.load_skeleton(&skel_bytes);
    let clip = core.load_clip(&still_clip(&model, 2.0, true, 1.0, &[("vault", 0.3), ("vault.end", 1.2)]));
    let mut bld = Builder::new();
    let player = bld.player("walk");
    let speed = bld.param("speed", ParamValue::Float(1.3));
    let dm = rig_node(&mut bld, kind::DISTANCE_MATCH, player, &block_with(1.0, 5, |v| {
        v[rg::distance::MODE] = rg::distance::MODE_SPEED;
        v[rg::distance::PARAM] = speed;
        v[rg::distance::MIN_RATE] = fb(0.5);
        v[rg::distance::MAX_RATE] = fb(2.0);
        v[rg::distance::MARKER] = NONE;
    }));
    let (vs, ve) = (bld.s("vault"), bld.s("vault.end"));
    let mw = rig_node(&mut bld, kind::MOTION_WARP, dm, &block_with(1.0, 6, |v| {
        v[rg::motion_warp::START] = vs;
        v[rg::motion_warp::END] = ve;
        v[rg::motion_warp::UP + 1] = fb(1.0);
    }));
    let mut n = mw;
    // Two-bone on the left leg, CCD on the left arm, FABRIK on the right arm.
    n = rig_node(&mut bld, kind::TWO_BONE_IK, n, &block_with(1.0, 8, |v| {
        use rg::two_bone::*;
        v[ROOT] = r(role::LEFT_UPPER_LEG);
        v[MID] = r(role::LEFT_LOWER_LEG);
        v[TIP] = r(role::LEFT_FOOT);
        v[TARGET] = 0;
        v[POLE] = 1;
        v[TIP_MODE] = TIP_TARGET;
        v[SOFT] = fb(0.05);
        v[MAX_STRETCH] = fb(1.1);
    }));
    for (k, arm, slot) in [
        (kind::CCD, [b::L_SHOULDER, b::L_UPPER_ARM, b::L_LOWER_ARM, b::L_HAND], 2u32),
        (kind::FABRIK, [b::R_SHOULDER, b::R_UPPER_ARM, b::R_LOWER_ARM, b::R_HAND], 3),
    ] {
        let mut v = block_with(1.0, 5, |v| {
            use rg::chain::*;
            v[TARGET] = slot;
            v[ITERATIONS] = 8;
            v[TOLERANCE] = fb(1e-3);
            v[LIMITS] = 1;
            v[COUNT] = 4;
        });
        v.extend(ids(&arm));
        n = rig_node(&mut bld, k, n, &v);
    }
    let mut fbv = block_with(0.7, 11, |v| {
        use rg::full_body::*;
        v[ITERATIONS] = 4;
        v[BODY_PULL] = fb(0.3);
        v[ROOT_SLOT] = 4;
        v[COM_SLOT] = 5;
        v[COM_UP + 1] = fb(1.0);
        v[MODE] = MODE_HUMANOID;
    });
    fbv.extend([NONE, 6, 7, NONE, 2, 3]);
    n = rig_node(&mut bld, kind::FULL_BODY_IK, n, &fbv);
    let mut look = block_with(1.0, 12, |v| {
        use rg::aim::*;
        v[TARGET] = 8;
        v[UP_WEIGHT] = fb(0.5);
        v[MAX_ANGLE] = fb(1.2);
        v[FORWARD + 2] = fb(1.0);
        v[UP + 1] = fb(1.0);
        v[GOAL_UP + 1] = fb(1.0);
    });
    look.extend([2, b::NECK as u32, fb(0.5), fb(0.8), b::HEAD as u32, fb(1.0), fb(1.0)]);
    n = rig_node(&mut bld, kind::LOOK_AT, n, &look);
    let mut aimv = block_with(1.0, 12, |v| {
        use rg::aim::*;
        v[TARGET] = 9;
        v[FORWARD] = fb(1.0);
        v[UP + 1] = fb(1.0);
    });
    aimv.extend([b::L_HAND as u32, 4, 2]);
    aimv.extend([b::L_UPPER_ARM as u32, fb(0.5), fb(0.0), b::L_LOWER_ARM as u32, fb(1.0), fb(0.0)]);
    n = rig_node(&mut bld, kind::AIM, n, &aimv);
    let mut gv = block_with(1.0, 15, |v| {
        use rg::grounder::*;
        v[PELVIS] = b::HIPS as u32;
        v[RAY_BASE] = 2;
        v[UP + 1] = fb(1.0);
        v[RAY_HEIGHT] = fb(0.5);
        v[RAY_DEPTH] = fb(0.5);
        v[MAX_STEP] = fb(0.4);
        v[MAX_FOOT_ANGLE] = fb(0.7);
        v[FOOT_ROTATION_WEIGHT] = fb(1.0);
        v[FOOT_HALF_LIFE] = fb(0.05);
        v[PELVIS_HALF_LIFE] = fb(0.1);
        v[MAX_PELVIS_DOWN] = fb(0.4);
        v[COUNT] = 2;
    });
    gv.extend(ids(&[b::L_THIGH, b::L_SHIN, b::L_FOOT, b::R_THIGH, b::R_SHIN, b::R_FOOT]));
    n = rig_node(&mut bld, kind::GROUNDER, n, &gv);
    let mut sv = block_with(1.0, 13, |v| {
        use rg::spring::*;
        v[STIFFNESS] = fb(50.0);
        v[DAMPING] = fb(5.0);
        v[DRAG] = fb(0.5);
        v[GRAVITY + 1] = fb(-9.81);
        v[MAX_ANGLE] = fb(1.0);
        v[RADIUS] = fb(0.02);
        v[MAX_STEP] = fb(1.0 / 120.0);
        v[MAX_SUBSTEPS] = 4;
        v[TELEPORT] = fb(1.0);
        v[COUNT] = 4;
        v[COLLIDERS] = 1;
    });
    sv[rg::head::LOD_SKIP] = 2;
    sv.extend(ids(&b::TAIL));
    sv.extend([b::HIPS as u32, rg::spring::SHAPE_CAPSULE]);
    sv.extend([0.0f32, -0.3, -0.1, 0.0, -0.3, -0.5, 0.1].map(fb));
    n = rig_node(&mut bld, kind::SPRING_CHAIN, n, &sv);
    n = rig_node(&mut bld, kind::COPY, n, &block_with(1.0, 16, |v| {
        use rg::copy::*;
        v[SOURCE] = b::L_HAND as u32;
        v[TARGET] = b::R_HAND as u32;
        v[SPACE] = 1;
        v[POSITION_WEIGHT] = fb(0.5);
        v[ROTATION_WEIGHT] = fb(0.5);
        v[ROTATION_OFFSET + 3] = fb(1.0);
        v[SCALE_OFFSET] = fb(1.0);
        v[SCALE_OFFSET + 1] = fb(1.0);
        v[SCALE_OFFSET + 2] = fb(1.0);
    }));
    let mut lr = block_with(1.0, 6, |v| {
        v[rg::limit_rotation::SOURCE] = rg::limit_rotation::SOURCE_SKELETON;
        v[rg::limit_rotation::COUNT] = 2;
    });
    lr.extend(ids(&[b::L_SHIN, b::R_SHIN]));
    n = rig_node(&mut bld, kind::LIMIT_ROTATION, n, &lr);
    n = rig_node(&mut bld, kind::LIMIT_POSITION, n, &block_with(1.0, 10, |v| {
        use rg::limit_position::*;
        v[BONE] = b::HEAD as u32;
        v[SPACE] = 1;
        v[SHAPE] = SHAPE_SPHERE;
        v[A + 1] = fb(1.6);
        v[RADIUS] = fb(0.3);
    }));
    n = rig_node(&mut bld, kind::DAMP, n, &block_with(1.0, 3, |v| {
        v[rg::damp::BONE] = b::HEAD as u32;
        v[rg::damp::POSITION_HALF_LIFE] = fb(0.1);
        v[rg::damp::ROTATION_HALF_LIFE] = fb(0.1);
    }));
    let mut st = block_with(1.0, 15, |v| {
        use rg::stride::*;
        v[PELVIS] = b::HIPS as u32;
        v[SCALE] = fb(1.0);
        v[SCALE_PARAM] = NONE;
        v[SPEED_PARAM] = speed;
        v[DIRECTION + 2] = fb(1.0);
        v[DIRECTION_PARAM] = NONE;
        v[UP + 1] = fb(1.0);
        v[PELVIS_WEIGHT] = fb(1.0);
        v[MAX_PELVIS_DROP] = fb(0.1);
        v[MAX_REACH] = fb(0.995);
        v[COUNT] = 2;
    });
    st.extend(ids(&[b::L_THIGH, b::L_SHIN, b::L_FOOT, b::R_THIGH, b::R_SHIN, b::R_FOOT]));
    n = rig_node(&mut bld, kind::STRIDE_WARP, n, &st);
    let dir = bld.param("move", ParamValue::Vec3([0.3, 0.0, 1.0]));
    let mut ow = block_with(1.0, 9, |v| {
        use rg::orientation::*;
        v[PELVIS] = b::HIPS as u32;
        v[ANGLE_PARAM] = NONE;
        v[DIRECTION_PARAM] = dir;
        v[MAX_ANGLE] = fb(1.0);
        v[UP + 1] = fb(1.0);
        v[COUNT] = 2;
    });
    ow.extend(ids(&[b::SPINE, b::CHEST]));
    ow.extend([fb(0.4), fb(0.6)]);
    n = rig_node(&mut bld, kind::ORIENTATION_WARP, n, &ow);
    let bytes = bld.build(n);
    let walk = bld.s("walk");
    let (g, h0) = instance(&mut core, &bytes, s, &[(walk, clip)]);
    assert_eq!(core.last_status(), 0, "every rig node is known");
    let hs: Vec<u32> = std::iter::once(h0)
        .chain((0..3).map(|_| core.create_instance(0, s, g)))
        .collect();
    let scripts: Vec<Vec<u8>> = (0..120)
        .map(|f| {
            let mut buf = Vec::new();
            for &h in &hs {
                match f % 40 {
                    1 => buf.extend(warp(h, mw, [0.4, 0.0, 1.5], 0.3)),
                    20 => buf.extend(reset(h, anim_wire::rig::NODE_ALL)),
                    _ => {}
                }
            }
            if f == 2 {
                buf.extend(debug_on(hs[0]));
            }
            buf
        })
        .collect();

    let before = ALLOCS.load(Ordering::SeqCst);
    let mut debug = 0;
    for (f, script) in scripts.iter().enumerate() {
        let t = f as f32 / 60.0;
        for (k, &h) in hs.iter().enumerate() {
            set_character(&mut core, h, [0.2 * (t + k as f32).sin(), 0.0, t], [0.0, 0.0, 0.0, 1.0]);
            for slot in 0..10 {
                let a = t + slot as f32;
                set_target(
                    &mut core,
                    h,
                    slot,
                    [0.3 * a.sin(), 0.8 + 0.3 * a.cos(), 0.3],
                    [0.0, 0.0, 0.0, 1.0],
                    1.0,
                    0.5,
                    slot % 2 == 1,
                );
            }
            for i in 0..8 {
                let x = if i % 2 == 0 { 0.1 } else { -0.1 };
                set_hit(&mut core, h, i, [x, 0.05 * (3.0 * t).sin(), 0.0], [0.0, 1.0, 0.0], f % 5 != 0);
            }
            set_rig_lod(&mut core, h, ((f / 30) % 3) as u32);
        }
        core.commands_mut()[..script.len()].copy_from_slice(script);
        core.write_inputs(script.len() as u32);
        core.evaluate(0, PASS_NORMAL, 1.0 / 60.0, 1.0 / 60.0);
        debug += core.debug_write(hs[0]) as usize;
    }
    assert_eq!(ALLOCS.load(Ordering::SeqCst), before);
    assert!(debug > 0, "debug reports were written");
    assert!(rays(&core, hs[0]).iter().any(|q| q.valid), "the grounder asked for rays");
}
