//! Root-curve extraction: the root bone's model-space translation (relative to frame 0) and yaw
//! (about +Y, relative to frame 0, unwrapped) per frame, from the raw pose.

use crate::settings::{RootMotion, ROOT_X, ROOT_Y, ROOT_YAW, ROOT_Z};
use anim_math::trig::atan2;
use anim_offline::math::Transform;

/// The yaw of a rotation: the angle of its twist about +Y, `2·atan2(y, w)` with `w ≥ 0`, in
/// (−π, π]. Uses `anim-math`'s deterministic `atan2` (no libm), so every target gives the same
/// bits.
fn yaw(t: &Transform) -> f32 {
    let q = t.rotation;
    let (y, w) = if q.w < 0.0 { (-q.y, -q.w) } else { (q.y, q.w) };
    if y == 0.0 && w == 0.0 {
        return 0.0;
    }
    2.0 * atan2(y as f32, w as f32)
}

/// The root curve over `model` (the root bone's model-space transform per frame).
pub(crate) fn extract(model: &[Transform], motion: RootMotion) -> Vec<[f32; 4]> {
    let Some(first) = model.first() else {
        return Vec::new();
    };
    let tau = core::f32::consts::TAU;
    let pi = core::f32::consts::PI;
    let yaw0 = yaw(first);
    let mut prev = 0.0f32;
    let mut out = Vec::with_capacity(model.len());
    for m in model {
        let d = m.translation - first.translation;
        // Unwrap: keep each frame within π of the previous one.
        let mut y = yaw(m) - yaw0;
        while y - prev > pi {
            y -= tau;
        }
        while y - prev < -pi {
            y += tau;
        }
        prev = y;
        let keep = |flag: u8, v: f64| if motion.axes & flag != 0 { v as f32 } else { 0.0 };
        out.push([
            keep(ROOT_X, d.x),
            keep(ROOT_Y, d.y),
            keep(ROOT_Z, d.z),
            if motion.axes & ROOT_YAW != 0 { y } else { 0.0 },
        ]);
    }
    out
}
