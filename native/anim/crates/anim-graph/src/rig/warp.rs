//! The two rig kinds that act on time and root motion rather than the pose: motion warping (Root
//! phase: the root delta bent so the character lands on a target at a window's end) and distance
//! matching (Update phase: the input advances at the rate that matches the character's travel).
//! Never allocates.

use anim_format::frames::FrameClock;
use anim_format::NONE;
use anim_math::trig::sin_cos;
use anim_math::{AosQuat, AosTransform, AosVec3};
use anim_pose::root::RootDelta;
use anim_rig::warp::{motion_warp_delta, DistanceCurve, MotionWarp, RootCurve};

use super::{distance, lod_skipped, motion_warp, state, weight};
use crate::eval::{mix_roots, ClipRef, EvalContext, NodeData};

/// The most root-curve frames one warp step reads (a window of 8.5 s at 30 Hz); a longer window
/// passes root motion through.
pub const MAX_WARP_SAMPLES: usize = 256;

const Y: AosVec3 = AosVec3 {
    x: 0.0,
    y: 1.0,
    z: 0.0,
};

/// Frame `f`'s root (translation, yaw about +Y) as a transform, or `None` past the curve.
fn root_frame(clip: &ClipRef<'_>, f: usize) -> Option<AosTransform> {
    let c = clip.root_curve?;
    let v = |k: usize| c.get(4 * f + k);
    let (x, y, z, yaw) = (v(0)?, v(1)?, v(2)?, v(3)?);
    let (s, co) = sin_cos(0.5 * yaw);
    Some(AosTransform::new(
        AosVec3::new(x, y, z),
        AosQuat::new(0.0, s, 0.0, co),
        AosVec3::one(),
    ))
}

/// The root at clip time `t` (frames lerped, rotations nlerped, clamped to the curve).
fn root_at(clip: &ClipRef<'_>, t: f32) -> Option<AosTransform> {
    clip.frame_count.checked_sub(1)?;
    let p = clip.frame_clock().pos(t);
    let a = root_frame(clip, p.f0 as usize)?;
    let b = root_frame(clip, p.f1 as usize)?;
    let u = p.alpha;
    Some(AosTransform::new(
        a.translation.lerp(b.translation, u),
        a.rotation.nlerp(b.rotation, u),
        AosVec3::one(),
    ))
}

/// The time of the first cue marker named `id` (a graph string id) at or after `from`.
fn cue_time(cx: &EvalContext<'_>, clip: &ClipRef<'_>, id: u32, from: f32) -> Option<f32> {
    if id == NONE {
        return None;
    }
    let hash = cx.program().string_hash(id);
    clip.cues
        .iter()
        .find(|m| m.id == hash && m.time >= from)
        .map(|m| m.time)
}

/// The window `[t0, t1]` of a motion-warp node on `clip`.
fn window(cx: &EvalContext<'_>, node: &NodeData<'_>, clip: &ClipRef<'_>) -> Option<(f32, f32)> {
    use motion_warp::*;
    let (t0, t1) = if node.word(WINDOW) == WINDOW_TIMES {
        (node.f32_or(START, 0.0), node.f32_or(END, 0.0))
    } else {
        let t0 = cue_time(cx, clip, node.word_or_none(START), 0.0)?;
        (t0, cue_time(cx, clip, node.word_or_none(END), t0)?)
    };
    (t1 > t0).then_some((t0, t1))
}

fn read_transform(w: &[u32]) -> AosTransform {
    let f = |i: usize| f32::from_bits(w[i]);
    AosTransform::new(
        AosVec3::new(f(0), f(1), f(2)),
        AosQuat::new(f(3), f(4), f(5), f(6)).normalize_or_identity(),
        AosVec3::one(),
    )
}

fn write_transform(t: AosTransform, w: &mut [u32]) {
    let v = [
        t.translation.x,
        t.translation.y,
        t.translation.z,
        t.rotation.x,
        t.rotation.y,
        t.rotation.z,
        t.rotation.w,
    ];
    for (o, x) in w.iter_mut().zip(v) {
        *o = x.to_bits();
    }
}

/// The Root phase of [`super::kind::MOTION_WARP`] (`super::motion_warp` documents it).
pub(super) fn motion_root(cx: &mut EvalContext<'_>, node: &NodeData<'_>, input: u32) {
    use motion_warp::*;
    let through = cx.eval_root(input);
    cx.set_root(through);
    if lod_skipped(cx, node) {
        return;
    }
    let w = weight(cx, node, input);
    if !(w > 0.0) {
        return;
    }
    let timing = cx.eval_timing(input);
    if timing.clip == 0 {
        return;
    }
    let assets = cx.assets();
    let Some(clip) = assets.clip(timing.clip) else {
        return;
    };
    if clip.root_curve.is_none() || clip.frame_count < 2 || !(clip.sample_rate > 0.0) {
        return;
    }
    let Some((t0, t1)) = window(cx, node, &clip) else {
        return;
    };
    let (tp, t) = (timing.prev, timing.time);
    let character = cx.rig().character;
    let up = {
        let v = AosVec3::new(
            node.f32_or(UP, 0.0),
            node.f32_or(UP + 1, 0.0),
            node.f32_or(UP + 2, 0.0),
        );
        anim_rig::geom::normalize_or(v, Y)
    };
    let s = cx.state();
    if s.len() < state::WORDS + S_WORDS {
        return;
    }
    let st = &mut s[state::WORDS..];
    if st[S_ACTIVE] != 0 && st[S_CLIP] != timing.clip {
        st[S_ACTIVE] = 0;
    }
    // Backwards, or a step across a loop seam: no warp (a window never spans a seam).
    let forward = t >= tp && (timing.delta - (t - tp)).abs() <= 1e-4 * (1.0 + t.abs());
    if !forward {
        st[S_ACTIVE] = 0;
        return;
    }
    if st[S_HAS_TARGET] == 0 || t <= t0 || tp >= t1 {
        if tp >= t1 && st[S_ACTIVE] != 0 {
            st[S_ACTIVE] = 0;
            st[S_HAS_TARGET] = 0;
        }
        return;
    }
    let me = AosTransform::new(character.translation, character.rotation, AosVec3::one());
    if st[S_ACTIVE] == 0 || st[S_HAS_TARGET] == 2 {
        let (start, w0) = if tp <= t0 && st[S_ACTIVE] == 0 {
            // From the frame whose step crosses t0: where the character would be at t0.
            match (root_at(&clip, tp), root_at(&clip, t0)) {
                (Some(rp), Some(r0)) => (me.compose(rp.inverse()).compose(r0), t0),
                _ => return,
            }
        } else {
            // A target that arrived (or moved) mid-window: re-plan from now.
            (me, tp)
        };
        write_transform(start, &mut st[S_START..S_START + 7]);
        st[S_T0] = w0.to_bits();
        st[S_T1] = t1.to_bits();
        st[S_CLIP] = timing.clip;
        st[S_ACTIVE] = 1;
        st[S_HAS_TARGET] = 1;
    }
    let start = read_transform(&st[S_START..S_START + 7]);
    let target = read_transform(&st[S_TARGET..S_TARGET + 7]);
    let w0 = f32::from_bits(st[S_T0]);
    let w1 = f32::from_bits(st[S_T1]);
    if t >= w1 {
        // The window ends this step: the target is consumed.
        st[S_ACTIVE] = 0;
        st[S_HAS_TARGET] = 0;
    }
    // The root-curve frames this step reads, shifted so the slice starts at frame 0.
    let rate = clip.sample_rate;
    let last = clip.frame_count as usize - 1;
    let first = ((tp.min(w0) * rate).floor().max(0.0) as usize).min(last);
    let end = (((t.max(w1) * rate).ceil().max(0.0) as usize) + 1).min(last);
    if end < first || end - first + 1 > MAX_WARP_SAMPLES {
        return;
    }
    let mut samples = [AosTransform::identity(); MAX_WARP_SAMPLES];
    for (k, out) in samples.iter_mut().enumerate().take(end - first + 1) {
        match root_frame(&clip, first + k) {
            Some(x) => *out = x,
            None => return,
        }
    }
    let clock = clip.frame_clock();
    let shift = clock.time(first as f32);
    let n = (end - first + 1) as u32;
    let curve = RootCurve {
        samples: &samples[..end - first + 1],
        // The slice ends on the clip's last frame only when `end` is it.
        clock: if end < last {
            FrameClock::uniform(rate, n)
        } else {
            FrameClock::new(clip.duration - shift, rate, n)
        },
    };
    let mw = MotionWarp {
        t0: w0 - shift,
        t1: w1 - shift,
        start,
        target,
        up,
    };
    let d = motion_warp_delta(&curve, &mw, tp - shift, t - shift);
    let warped = RootDelta {
        translation: d.translation,
        rotation: d.rotation,
    };
    let out = if w >= 1.0 {
        warped
    } else {
        mix_roots(through, warped, w)
    };
    cx.set_root(out);
}

/// The playback rate of a [`super::kind::DISTANCE_MATCH`] node's input for a step of `dt`.
fn rate(cx: &mut EvalContext<'_>, node: &NodeData<'_>, input: u32, dt: f32) -> f32 {
    use distance::*;
    if !(dt > 0.0) {
        return 1.0;
    }
    let timing = cx.eval_timing(input);
    if timing.clip == 0 {
        return 1.0;
    }
    let assets = cx.assets();
    let Some(clip) = assets.clip(timing.clip) else {
        return 1.0;
    };
    if clip.distance.len() < 2 || !(clip.sample_rate > 0.0) {
        return 1.0;
    }
    let curve = DistanceCurve {
        distance: clip.distance,
        clock: clip.frame_clock(),
    };
    let p = node.word_or_none(PARAM);
    let v = if p != NONE { cx.param_f32(p) } else { 0.0 };
    let t = timing.time;
    let stop = node.word(MODE) == MODE_STOP;
    let min = node.f32_or(MIN_RATE, if stop { 0.0 } else { 0.5 });
    let max = node.f32_or(MAX_RATE, 2.0);
    let goal = if stop {
        let marker =
            cue_time(cx, &clip, node.word_or_none(MARKER), 0.0).unwrap_or(curve.duration());
        curve.time_before(marker, v)
    } else {
        let travel = if v > 0.0 { v * dt } else { 0.0 };
        let total = curve.distance_at(curve.duration());
        let d = curve.distance_at(t) + travel;
        if timing.looping && total > 0.0 && d > total {
            // Across the loop seam: the rest of this cycle, then into the next.
            curve.duration() + curve.time_at(d - total)
        } else {
            curve.time_at(d)
        }
    };
    let r = (goal - t) / dt;
    if r.is_finite() {
        r.clamp(min.min(max), max)
    } else {
        1.0
    }
}

/// The Update phase of [`super::kind::DISTANCE_MATCH`]: runs the input's update context at the
/// matched rate (blended toward 1 by the node's weight; 1 when skipped by LOD).
pub(super) fn distance_update(cx: &mut EvalContext<'_>, node: &NodeData<'_>, input: u32) {
    let dt = cx.dt();
    let r = if lod_skipped(cx, node) {
        1.0
    } else {
        let w = weight(cx, node, input);
        if w > 0.0 {
            1.0 + (rate(cx, node, input, dt) - 1.0) * w
        } else {
            1.0
        }
    };
    let ctx = cx.input_context(node, 0);
    cx.update_context(ctx, dt * r);
}
