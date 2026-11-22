//! The character frame: where features are measured.
//!
//! Up is +Y; the character stands on the XZ plane and faces `forward`, a unit vector in XZ. Yaw
//! `θ` (radians, about +Y) faces `(sin θ, cos θ)` in `(x, z)`, so yaw 0 faces +Z. Character
//! space has its origin under the character, +Z forward, +X to the right of forward rotated
//! about +Y (`right = (fz, −fx)`), and +Y up: a point's character-space coordinates are
//! `(d·right, d.y, d·forward)` for its offset `d` from the origin.
//!
//! A clip's character frame at a time is the ground projection of its root-motion bone's
//! model-space transform ([`CharacterFrame::from_root`]): its `(x, z)` translation and the twist
//! about +Y of its rotation relative to the rest pose's (decision D35: a clip's frame-0 heading
//! is the rest heading).

use anim_math::{AosQuat, AosTransform, AosVec3, Lane};

/// A rigid transform of the ground plane: a position `(x, z)` and a unit facing `(x, z)`. Applied
/// to 3D points it rotates about +Y and translates in XZ (Y is untouched).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CharacterFrame {
    /// Origin `(x, z)`.
    pub position: [f32; 2],
    /// Unit forward `(x, z)`.
    pub forward: [f32; 2],
}

impl Default for CharacterFrame {
    fn default() -> Self {
        Self::IDENTITY
    }
}

impl CharacterFrame {
    /// At the origin, facing +Z.
    pub const IDENTITY: Self = Self {
        position: [0.0, 0.0],
        forward: [0.0, 1.0],
    };

    /// The frame of a root bone whose model-space transform is `root` and whose rest model-space
    /// rotation is `rest`: position `(root.t.x, root.t.z)`; forward the +Z axis turned by the
    /// twist about +Y of `root.r · rest.r⁻¹`. A twist that can't be found (a half turn about a
    /// horizontal axis) faces +Z. No trigonometry.
    pub fn from_root(root: AosTransform, rest: AosQuat) -> Self {
        let q = root.rotation * rest.conjugate();
        // Twist about +Y: normalize(0, q.y, 0, q.w) = (0, s, 0, c); it turns +Z to (2sc, c² − s²).
        let n2 = q.y * q.y + q.w * q.w;
        let forward = if n2 > 1e-12 {
            let inv = 1.0 / n2.sqrt();
            let (s, c) = (q.y * inv, q.w * inv);
            [2.0 * s * c, c * c - s * s]
        } else {
            [0.0, 1.0]
        };
        Self {
            position: [root.translation.x, root.translation.z],
            forward,
        }
    }

    /// At `position`, facing yaw `forward` (any non-zero vector; normalised, +Z if zero).
    pub fn new(position: [f32; 2], forward: [f32; 2]) -> Self {
        Self {
            position,
            forward: normalize2(forward),
        }
    }

    /// The right axis `(fz, −fx)`.
    #[inline]
    pub fn right(&self) -> [f32; 2] {
        [self.forward[1], -self.forward[0]]
    }

    /// A ground vector `(x, z)` from world into this frame.
    #[inline]
    pub fn vector_to_local(&self, v: [f32; 2]) -> [f32; 2] {
        let r = self.right();
        let f = self.forward;
        [v[0] * r[0] + v[1] * r[1], v[0] * f[0] + v[1] * f[1]]
    }

    /// A ground vector `(x, z)` from this frame into world.
    #[inline]
    pub fn vector_to_world(&self, v: [f32; 2]) -> [f32; 2] {
        let r = self.right();
        let f = self.forward;
        [v[0] * r[0] + v[1] * f[0], v[0] * r[1] + v[1] * f[1]]
    }

    /// A ground point `(x, z)` from world into this frame.
    #[inline]
    pub fn point_to_local(&self, p: [f32; 2]) -> [f32; 2] {
        self.vector_to_local([p[0] - self.position[0], p[1] - self.position[1]])
    }

    /// A ground point `(x, z)` from this frame into world.
    #[inline]
    pub fn point_to_world(&self, p: [f32; 2]) -> [f32; 2] {
        let w = self.vector_to_world(p);
        [w[0] + self.position[0], w[1] + self.position[1]]
    }

    /// A 3D point from world into this frame.
    #[inline]
    pub fn point3_to_local(&self, p: AosVec3) -> AosVec3 {
        let g = self.point_to_local([p.x, p.z]);
        AosVec3::new(g[0], p.y, g[1])
    }

    /// A 3D point from this frame into world.
    #[inline]
    pub fn point3_to_world(&self, p: AosVec3) -> AosVec3 {
        let g = self.point_to_world([p.x, p.z]);
        AosVec3::new(g[0], p.y, g[1])
    }

    /// A 3D vector from world into this frame.
    #[inline]
    pub fn vector3_to_local(&self, v: AosVec3) -> AosVec3 {
        let g = self.vector_to_local([v.x, v.z]);
        AosVec3::new(g[0], v.y, g[1])
    }

    /// `self ∘ child`: `child` is expressed in this frame; the result is in this frame's parent.
    pub fn compose(&self, child: &Self) -> Self {
        Self {
            position: self.point_to_world(child.position),
            forward: normalize2(self.vector_to_world(child.forward)),
        }
    }

    /// The inverse transform.
    pub fn inverse(&self) -> Self {
        let f = self.forward;
        // Rotation by −θ: forward (−fx, fz) in the parent's coordinates.
        let inv = Self {
            position: [0.0, 0.0],
            forward: [-f[0], f[1]],
        };
        Self {
            position: inv.vector_to_world([-self.position[0], -self.position[1]]),
            forward: inv.forward,
        }
    }

    /// The facing as a yaw-only rotation quaternion `(0, sin θ/2, 0, cos θ/2)` (no trigonometry:
    /// half-angle formulas from `forward`).
    pub fn rotation(&self) -> AosQuat {
        // forward = (sin θ, cos θ). cos θ/2 = sqrt((1 + cos θ)/2), sin θ/2 = sin θ / (2 cos θ/2).
        let (s, c) = (self.forward[0], self.forward[1]);
        let ch = Lane::max((1.0 + c) * 0.5, 0.0).sqrt();
        if ch > 1e-4 {
            AosQuat::new(0.0, s / (2.0 * ch), 0.0, ch)
        } else {
            AosQuat::new(0.0, 1.0, 0.0, 0.0)
        }
    }
}

/// `v / |v|`, or +Z for a (near) zero vector.
#[inline]
pub fn normalize2(v: [f32; 2]) -> [f32; 2] {
    let n2 = v[0] * v[0] + v[1] * v[1];
    if n2 > 1e-24 {
        let inv = 1.0 / n2.sqrt();
        [v[0] * inv, v[1] * inv]
    } else {
        [0.0, 1.0]
    }
}
