//! Spring bones: Verlet chains (hair, tails, cloth strips, antennae) with sphere and capsule
//! colliders bound to bones.

use crate::geom::{clamp_cone, exp_neg, from_to, normalize_or, unit_clamp, DEGENERATE_SQ};
use crate::pose::RigPose;
use anim_math::{AosQuat, AosTransform, AosVec3};

/// The most bones in one spring chain (the anchor included).
pub const MAX_SPRING_BONES: usize = 16;
/// The most colliders one chain tests.
pub const MAX_SPRING_COLLIDERS: usize = 16;

/// A collider shape in its bone's local space.
#[derive(Clone, Copy, Debug)]
pub enum ColliderShape {
    Sphere {
        center: AosVec3,
        radius: f32,
    },
    /// The swept sphere along the segment `a`–`b`.
    Capsule {
        a: AosVec3,
        b: AosVec3,
        radius: f32,
    },
}

/// A collider bound to a bone (it moves with the animated bone).
#[derive(Clone, Copy, Debug)]
pub struct SpringCollider {
    pub bone: u16,
    pub shape: ColliderShape,
}

/// Spring-bone settings for one chain.
#[derive(Clone, Copy, Debug)]
pub struct SpringSettings {
    /// Pull toward the animated shape, 1/s² (the spring constant per unit mass).
    pub stiffness: f32,
    /// Damping of motion *relative to the parent particle*, 1/s (kills wobble).
    pub damping: f32,
    /// Damping of motion *relative to the world*, 1/s (air drag; makes the chain trail).
    pub drag: f32,
    /// World-space gravity, m/s².
    pub gravity: AosVec3,
    /// The most a bone may swing away from its animated direction, radians (π: free).
    pub max_angle: f32,
    /// Particle radius for collisions.
    pub radius: f32,
    /// The longest simulation substep, seconds.
    pub max_step: f32,
    /// The most substeps per update (beyond it the substeps get longer; the integration stays
    /// stable, see [`spring`]).
    pub max_substeps: u32,
    /// An anchor jump larger than this (world units, in one update) resets the chain: a teleport.
    pub teleport_distance: f32,
    /// The entry weight in `[0, 1]`.
    pub weight: f32,
}

impl Default for SpringSettings {
    fn default() -> Self {
        Self {
            stiffness: 60.0,
            damping: 6.0,
            drag: 0.5,
            gravity: AosVec3::new(0.0, -9.81, 0.0),
            max_angle: core::f32::consts::PI,
            radius: 0.0,
            max_step: 1.0 / 120.0,
            max_substeps: 8,
            teleport_distance: 2.0,
            weight: 1.0,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Particle {
    /// World position now.
    pos: AosVec3,
    /// World position one substep ago.
    prev: AosVec3,
    /// The animated world position at the end of the previous update.
    anim: AosVec3,
}

/// One chain's simulation state (fixed size).
#[derive(Clone, Copy, Debug)]
pub struct SpringChainState {
    particles: [Particle; MAX_SPRING_BONES],
    /// The previous substep's length (0: no velocity history).
    prev_h: f32,
    initialized: bool,
}

impl SpringChainState {
    pub const fn new() -> Self {
        let z = AosVec3 {
            x: 0.0,
            y: 0.0,
            z: 0.0,
        };
        Self {
            particles: [Particle {
                pos: z,
                prev: z,
                anim: z,
            }; MAX_SPRING_BONES],
            prev_h: 0.0,
            initialized: false,
        }
    }

    /// Forgets the simulation: the next update starts at rest on the animated pose.
    pub fn reset(&mut self) {
        self.initialized = false;
    }

    /// The simulated world position of chain bone `j` (after the last update).
    pub fn position(&self, j: usize) -> AosVec3 {
        self.particles[j].pos
    }
}

impl Default for SpringChainState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy, Debug)]
enum WorldShape {
    Sphere(AosVec3, f32),
    Capsule(AosVec3, AosVec3, f32),
}

fn push_out(p: AosVec3, shape: WorldShape, extra: f32) -> AosVec3 {
    let (c, r) = match shape {
        WorldShape::Sphere(c, r) => (c, r),
        WorldShape::Capsule(a, b, r) => {
            let ab = b - a;
            let l2 = ab.length_squared();
            let t = if l2 > DEGENERATE_SQ {
                unit_clamp((p - a).dot(ab) / l2)
            } else {
                0.0
            };
            (a + ab.scale(t), r)
        }
    };
    let r = r + extra;
    let d = p - c;
    let l2 = d.length_squared();
    if l2 >= r * r {
        return p;
    }
    c + normalize_or(d, AosVec3::new(0.0, 1.0, 0.0)).scale(r)
}

/// Advances one spring chain by `dt` and writes its bones' rotations.
///
/// `chain` lists bones from the anchor (which follows the animation) to the tip; each is a
/// descendant of the one before. `character` is the model-to-world transform this frame: the
/// simulation runs in world space so the chain reacts to the character's own movement.
///
/// # Integration
///
/// Particles sit at the chain bones' world positions (particle 0 is pinned to the animated
/// anchor). An update splits `dt` into `n = clamp(⌈dt / max_step⌉, 1, max_substeps)` equal
/// substeps `h`, and interpolates the animated positions linearly from the previous update's
/// to this one's across them. Per substep, for particle `j` with parent particle `p`:
///
/// 1. Velocity by time-corrected Verlet: `v = (x − x_prev)/h_prev` (zero after a reset).
/// 2. `v ← v_p + (v − v_p)·e^(−damping·h)`, then `v ← v·e^(−drag·h)` ([`exp_neg`]).
/// 3. The animated target `a = p + (animⱼ − anim_p)` (the animated offset hung from the
///    simulated parent). Gravity and the spring are integrated **implicitly**:
///    `x' = (x + v·h + g·h² + k·h²·a) / (1 + k·h²)`, stable for any stiffness and step.
/// 4. Length: `x' ← p + normalize(x' − p)·|animⱼ − anim_p|`; then the direction is clamped to
///    `max_angle` around `a − p`.
/// 5. Colliders push `x'` out of every sphere and capsule (radius + particle radius). This
///    runs last, so a particle never ends a substep inside a collider; pressed against one, a
///    bone may stretch slightly until it slides free.
///
/// At rest with no gravity the target is the particle itself and nothing moves (no drift).
/// The first update, and any update whose anchor jumps more than `teleport_distance`, resets the
/// chain onto the animated pose. `dt ≤ 0` re-applies the current state without stepping.
///
/// # Output
///
/// Each bone but the last turns by the shortest arc from its inherited direction to its
/// simulated child direction (in model space), against its solved parent, so twist follows the
/// animation. Locals are blended by `settings.weight`. Never allocates.
pub fn spring(
    pose: &mut RigPose,
    chain: &[u16],
    colliders: &[SpringCollider],
    character: AosTransform,
    settings: &SpringSettings,
    state: &mut SpringChainState,
    dt: f32,
) {
    let n = chain.len();
    assert!(
        (2..=MAX_SPRING_BONES).contains(&n),
        "2 to {MAX_SPRING_BONES} spring bones"
    );
    assert!(
        colliders.len() <= MAX_SPRING_COLLIDERS,
        "at most {MAX_SPRING_COLLIDERS} colliders"
    );

    // Animated world positions and the chain's model data.
    let mut anim = [AosVec3::zero(); MAX_SPRING_BONES];
    let mut model_rot = [AosQuat::identity(); MAX_SPRING_BONES];
    let mut model_pos = [AosVec3::zero(); MAX_SPRING_BONES];
    let mut parent_rot = [AosQuat::identity(); MAX_SPRING_BONES];
    let mut local_rot = [AosQuat::identity(); MAX_SPRING_BONES];
    for j in 0..n {
        let b = chain[j] as usize;
        let m = pose.model(b);
        model_rot[j] = m.rotation;
        model_pos[j] = m.translation;
        parent_rot[j] = pose.parent_model(b).rotation;
        local_rot[j] = pose.local(b).rotation;
        anim[j] = character.transform_point(m.translation);
    }
    let mut shapes = [WorldShape::Sphere(AosVec3::zero(), 0.0); MAX_SPRING_COLLIDERS];
    for (k, c) in colliders.iter().enumerate() {
        let to_world = character.compose(pose.model(c.bone as usize));
        let s = to_world
            .scale
            .x
            .abs()
            .max(to_world.scale.y.abs())
            .max(to_world.scale.z.abs());
        shapes[k] = match c.shape {
            ColliderShape::Sphere { center, radius } => {
                WorldShape::Sphere(to_world.transform_point(center), radius * s)
            }
            ColliderShape::Capsule { a, b, radius } => WorldShape::Capsule(
                to_world.transform_point(a),
                to_world.transform_point(b),
                radius * s,
            ),
        };
    }
    let shapes = &shapes[..colliders.len()];

    let teleported = state.initialized
        && (anim[0] - state.particles[0].anim).length() > settings.teleport_distance;
    if !state.initialized || teleported {
        for j in 0..n {
            state.particles[j] = Particle {
                pos: anim[j],
                prev: anim[j],
                anim: anim[j],
            };
        }
        state.prev_h = 0.0;
        state.initialized = true;
    } else if dt > 0.0 {
        let max_step = settings.max_step.max(1e-4);
        let steps = ((dt / max_step).ceil() as u32).clamp(1, settings.max_substeps.max(1));
        let h = dt / steps as f32;
        let k = settings.stiffness.max(0.0);
        let kh2 = k * h * h;
        let damp = exp_neg(settings.damping.max(0.0) * h);
        let drag = exp_neg(settings.drag.max(0.0) * h);
        let g = settings.gravity;
        let mut sub_anim = [AosVec3::zero(); MAX_SPRING_BONES];
        for s in 1..=steps {
            let u = s as f32 / steps as f32;
            for j in 0..n {
                sub_anim[j] = state.particles[j].anim.lerp(anim[j], u);
            }
            let ps = &mut state.particles;
            // The anchor follows the animation.
            let v_anchor = if state.prev_h > 0.0 {
                (sub_anim[0] - ps[0].pos).scale(1.0 / h)
            } else {
                AosVec3::zero()
            };
            ps[0].prev = ps[0].pos;
            ps[0].pos = sub_anim[0];
            let mut v_parent = v_anchor;
            for j in 1..n {
                let x = ps[j].pos;
                let mut v = if state.prev_h > 0.0 {
                    (x - ps[j].prev).scale(1.0 / state.prev_h)
                } else {
                    AosVec3::zero()
                };
                v = v_parent + (v - v_parent).scale(damp);
                v = v.scale(drag);
                let p = ps[j - 1].pos;
                let rest = sub_anim[j] - sub_anim[j - 1];
                let a = p + rest;
                let mut xn =
                    (x + v.scale(h) + g.scale(h * h) + a.scale(kh2)).scale(1.0 / (1.0 + kh2));
                let len = rest.length();
                let rest_dir = normalize_or(rest, AosVec3::new(0.0, -1.0, 0.0));
                let dir = normalize_or(xn - p, rest_dir);
                let dir = clamp_cone(dir, rest_dir, settings.max_angle);
                xn = p + dir.scale(len);
                for &shape in shapes {
                    xn = push_out(xn, shape, settings.radius);
                }
                ps[j].prev = x;
                ps[j].pos = xn;
                v_parent = (xn - x).scale(1.0 / h);
            }
            state.prev_h = h;
        }
        for j in 0..n {
            state.particles[j].anim = anim[j];
        }
    }

    // Write rotations.
    let inv_char = character.rotation.conjugate();
    let mut solved_parent = parent_rot[0];
    for j in 0..n - 1 {
        // The rotation of the bones between chain joints j−1 and j (unchanged) carried by the
        // solved joint j−1.
        let pr = if j == 0 {
            solved_parent
        } else {
            let between = (model_rot[j - 1].conjugate() * parent_rot[j]).normalize_or_identity();
            (solved_parent * between).normalize_or_identity()
        };
        let r_inh = (pr * local_rot[j]).normalize_or_identity();
        let offset = model_rot[j]
            .conjugate()
            .rotate(model_pos[j + 1] - model_pos[j]);
        let from = normalize_or(r_inh.rotate(offset), AosVec3::new(0.0, -1.0, 0.0));
        let sim = inv_char.rotate(state.particles[j + 1].pos - state.particles[j].pos);
        let to = normalize_or(sim, from);
        let r = (from_to(from, to) * r_inh).normalize_or_identity();
        let local = (pr.conjugate() * r).normalize_or_identity();
        pose.blend_local_rotation(chain[j] as usize, local, settings.weight);
        solved_parent = r;
    }
}
