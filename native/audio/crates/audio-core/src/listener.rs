//! The listener's orientation in the core (ADR 0162, api-and-models §4.2, contract C4 LISTENER;
//! architecture §3.5): the world-to-listener rotation applied to ambisonic voices, slerped per
//! quantum over `rampFrames` (or jumped to on a snap). Axis map: `(X, Y, Z)_ambix = (-z, -x, +y)_engine`.
//!
//! **State** ([`ListenerState`], kept in the `Beds` region's header: only ambisonic voices read it,
//! and they need a bed or a private decoder, so a core without that region drops LISTENER):
//! the rotation at the start of the quantum being rendered (`start`), at its end (`cur`), the
//! target (`to`) and the frames of the ramp left. Before any LISTENER (and after RESET) the
//! rotation is the identity.
//!
//! **Ramp.** LISTENER sets the target. With `snap` (a camera cut) the rotation jumps: this quantum's
//! start and end are both the target. Otherwise it travels the great arc from where it is to the
//! target at a constant speed over `max(rampFrames, 128)` frames: each quantum ([`begin_quantum`],
//! before the voices) moves `cur` by `slerp(cur, to, 128 / left)`, so a quantum covers 128 frames of
//! the arc; inside the quantum, the voices ramp their rotation matrices per sample from the start's
//! to the end's (`ambisonic::rotate_ramp_add`). A quaternion that isn't finite or is zero is
//! ignored (the rotation stays); the rest are normalised.

use audio_dsp::ambisonic::{quat_to_ambix, Mat3, MAT3_IDENTITY};
use audio_wire::generated::{Listener, LISTENER_FLAGS_SNAP};

use crate::core::Core;
use crate::QUANTUM;

/// The identity quaternion `(x, y, z, w)`.
const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];

/// The listener's rotation and its ramp. All-zero is "never set" (the identity).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ListenerState {
    /// 1 once a LISTENER (or a reset) wrote the quaternions.
    ready: u32,
    /// Frames of the ramp left (0: at the target).
    left: u32,
    /// The rotation at the start and at the end of the current quantum, and the target (unit).
    start: [f32; 4],
    cur: [f32; 4],
    to: [f32; 4],
}

impl ListenerState {
    /// LISTENER's quaternion `q` (world to listener, engine axes), its ramp and its snap flag.
    pub fn set(&mut self, q: [f32; 4], ramp_frames: u32, snap: bool) {
        let n2 = q.iter().map(|v| v * v).sum::<f32>();
        if !(n2 > 1e-12 && n2.is_finite()) {
            return;
        }
        let inv = 1.0 / libm::sqrtf(n2);
        let q = q.map(|v| v * inv);
        if self.ready == 0 {
            *self = ListenerState { ready: 1, left: 0, start: IDENTITY, cur: IDENTITY, to: IDENTITY };
        }
        self.to = q;
        if snap {
            self.start = q;
            self.cur = q;
            self.left = 0;
        } else {
            self.left = ramp_frames.max(QUANTUM as u32);
        }
    }

    /// Moves the ramp on by one quantum: `start` becomes the last end, `cur` the next point on the arc.
    pub fn step(&mut self) {
        if self.ready == 0 {
            return;
        }
        self.start = self.cur;
        if self.left > 0 {
            let t = (QUANTUM as f32 / self.left as f32).min(1.0);
            self.cur = if t >= 1.0 { self.to } else { slerp(self.cur, self.to, t) };
            self.left = self.left.saturating_sub(QUANTUM as u32);
        }
    }

    /// The rotation at the start and at the end of the current quantum as AmbiX matrices.
    pub fn ends(&self) -> [Mat3; 2] {
        if self.ready == 0 {
            return [MAT3_IDENTITY; 2];
        }
        [quat_to_ambix(self.start).unwrap_or(MAT3_IDENTITY), quat_to_ambix(self.cur).unwrap_or(MAT3_IDENTITY)]
    }

    /// The rotation at the end of the current quantum (unit, `(x, y, z, w)`).
    pub fn current(&self) -> [f32; 4] {
        if self.ready == 0 {
            IDENTITY
        } else {
            self.cur
        }
    }
}

/// The spherical interpolation from unit `a` to unit `b` at `t` (0..1), the short way round (f64,
/// so the constant-speed steps don't drift). Normalised linear interpolation when they are nearly
/// the same rotation.
pub fn slerp(a: [f32; 4], b: [f32; 4], t: f32) -> [f32; 4] {
    let (a, mut b) = (a.map(f64::from), b.map(f64::from));
    let mut dot: f64 = (0..4).map(|i| a[i] * b[i]).sum();
    if dot < 0.0 {
        b = b.map(|v| -v);
        dot = -dot;
    }
    let t = t as f64;
    let (wa, wb) = if dot > 0.9995 {
        (1.0 - t, t)
    } else {
        let s = libm::sqrt((1.0 - dot * dot).max(0.0));
        let theta = libm::atan2(s, dot);
        (libm::sin((1.0 - t) * theta) / s, libm::sin(t * theta) / s)
    };
    let mut r = [0.0f64; 4];
    for i in 0..4 {
        r[i] = wa * a[i] + wb * b[i];
    }
    let n = libm::sqrt(r.iter().map(|v| v * v).sum::<f64>());
    if n > 0.0 {
        r.map(|v| (v / n) as f32)
    } else {
        IDENTITY
    }
}

/// LISTENER (C4, asap): normalises the quaternion (ignoring a non-finite or zero one) and ramps to
/// it, or jumps on a snap. Dropped by a core without a `Beds` region.
pub fn set(core: &mut Core, l: &Listener) {
    if let Some(s) = crate::bed::listener_mut(core) {
        s.set([l.qx, l.qy, l.qz, l.qw], l.ramp_frames, l.flags & LISTENER_FLAGS_SNAP != 0);
    }
}

/// Once per quantum, before any voice renders (`voices::render`): moves the ramp on.
pub fn begin_quantum(core: &mut Core) {
    if let Some(s) = crate::bed::listener_mut(core) {
        s.step();
    }
}

/// RESET (§4.2: "RESET clears … the listener"): the identity, no ramp.
pub fn reset(core: &mut Core) {
    if let Some(s) = crate::bed::listener_mut(core) {
        *s = ListenerState::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn angle(a: [f32; 4], b: [f32; 4]) -> f64 {
        let d: f64 = (0..4).map(|i| a[i] as f64 * b[i] as f64).sum();
        2.0 * d.abs().min(1.0).acos()
    }

    /// The same rotation within 1e-6 per component (either sign).
    fn same(a: [f32; 4], b: [f32; 4]) -> bool {
        let d = (0..4).map(|i| (a[i] - b[i]).abs()).fold(0.0, f32::max);
        let e = (0..4).map(|i| (a[i] + b[i]).abs()).fold(0.0, f32::max);
        d.min(e) < 1e-6
    }

    fn yaw_q(rad: f32) -> [f32; 4] {
        [0.0, (rad / 2.0).sin(), 0.0, (rad / 2.0).cos()]
    }

    #[test]
    fn never_set_is_the_identity() {
        let mut s = ListenerState::default();
        s.step();
        assert_eq!(s.ends(), [MAT3_IDENTITY; 2]);
        assert_eq!(s.current(), IDENTITY);
    }

    #[test]
    fn non_finite_or_zero_is_ignored_and_the_rest_normalised() {
        let mut s = ListenerState::default();
        s.set([0.0, 0.0, 0.0, 2.0], 0, true);
        assert_eq!(s.current(), IDENTITY);
        let before = s;
        s.set([0.0; 4], 0, true);
        s.set([f32::NAN, 0.0, 0.0, 1.0], 0, true);
        s.set([0.0, f32::INFINITY, 0.0, 1.0], 512, false);
        assert_eq!(s, before);
    }

    #[test]
    fn snap_jumps_and_a_ramp_moves_at_constant_speed() {
        let mut s = ListenerState::default();
        s.set(yaw_q(1.0), 0, true);
        s.step();
        assert_eq!(s.start, s.cur);
        assert!(same(s.cur, yaw_q(1.0)));
        // 90 degrees over 1,024 frames: 8 quanta of 11.25 degrees each.
        s.set(yaw_q(1.0 + core::f32::consts::FRAC_PI_2), 1_024, false);
        for k in 1..=8 {
            s.step();
            let step = angle(s.start, s.cur);
            assert!((step - core::f64::consts::FRAC_PI_2 / 8.0).abs() < 1e-5, "quantum {k}: {step}");
        }
        assert!(same(s.cur, yaw_q(1.0 + core::f32::consts::FRAC_PI_2)));
        s.step();
        assert_eq!(s.start, s.cur, "at rest after the ramp");
    }

    #[test]
    fn a_ramp_of_zero_takes_one_quantum_and_the_short_way() {
        let mut s = ListenerState::default();
        s.set(yaw_q(0.2), 0, false);
        s.step();
        assert!(same(s.start, IDENTITY));
        assert!(same(s.cur, yaw_q(0.2)));
        // The same rotation with the other sign: no movement.
        let q = yaw_q(0.2).map(|v| -v);
        s.set(q, 256, false);
        s.step();
        assert!(same(s.start, s.cur));
    }
}
