//! Reference area `match` (module `matching`; `match` is a Rust keyword): f64 feature extraction,
//! normalisation and brute-force nearest-pose search, the reference for `anim-match`.
//!
//! Written for clarity and by a different route than `anim-match`: poses come from
//! [`crate::sample::sample_raw_pose`] (raw form, f64), the character frame is a yaw angle from
//! `atan2` (libm) rather than a facing vector, and frames are rotated with `sin`/`cos`.
//!
//! The rules (the same as `anim-match`'s bake docs):
//!
//! - **Character frame** `C(t)`: the root-motion bone's model transform projected to the ground,
//!   position `(x, z)` and yaw `2·atan2(q.y, q.w)` of `q = root.r · rest_root.r⁻¹` (the twist
//!   about +Y). Yaw `θ` faces `(sin θ, cos θ)`; character space has +Z forward and +X right.
//! - **Loops:** a looping clip at time `t = k·duration + u` is `L^k ∘ C(u)` with
//!   `L = C(duration) ∘ C(0)⁻¹` (bones the same way); a one-shot clip clamps `t` into its range.
//! - **Features** at `t`, `h = 1 / sample_rate`: bone position `C(t)⁻¹·P(t)`; bone velocity the
//!   world difference `(P(t) − P(t − h)) / h` rotated by `C(t)`'s inverse (forward difference at
//!   a one-shot clip's first frame); trajectory position `(x, z)` of `C(t)⁻¹·C(t + o)`'s origin;
//!   trajectory direction `(sin, cos)` of the yaw difference.
//! - **Normalisation:** population mean and deviation per dim (or the mean of a feature's dims'
//!   deviations, per feature), floored.
//! - **Cost:** `Σ weight · (q − r)²` over normalised dims.

use crate::math::{local_to_model, Quat, Transform, Vec3, NO_PARENT};
use crate::sample::{parents, rest_pose, sample_raw_pose};
use anim_format::clip::{ClipView, CLIP_LOOP};
use anim_format::posedb::{Feature, FeatureKind};
use anim_format::skeleton::SkeletonView;
use anim_format::NONE;

/// A ground frame: position `(x, z)` and yaw.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Ground {
    pub x: f64,
    pub z: f64,
    pub yaw: f64,
}

impl Ground {
    pub const IDENTITY: Ground = Ground {
        x: 0.0,
        z: 0.0,
        yaw: 0.0,
    };

    /// Rotates `(x, z)` by the yaw: `(x cos θ + z sin θ, −x sin θ + z cos θ)`.
    fn rotate(&self, x: f64, z: f64) -> (f64, f64) {
        let (s, c) = self.yaw.sin_cos();
        (x * c + z * s, -x * s + z * c)
    }

    /// A local point into the parent frame.
    pub fn apply(&self, p: Vec3) -> Vec3 {
        let (x, z) = self.rotate(p.x, p.z);
        Vec3::new(x + self.x, p.y, z + self.z)
    }

    /// `self ∘ child`.
    pub fn compose(&self, child: &Ground) -> Ground {
        let (x, z) = self.rotate(child.x, child.z);
        Ground {
            x: x + self.x,
            z: z + self.z,
            yaw: self.yaw + child.yaw,
        }
    }

    /// The inverse.
    pub fn inverse(&self) -> Ground {
        let inv = Ground {
            x: 0.0,
            z: 0.0,
            yaw: -self.yaw,
        };
        let (x, z) = inv.rotate(-self.x, -self.z);
        Ground {
            x,
            z,
            yaw: -self.yaw,
        }
    }

    /// A world point into this frame.
    pub fn to_local(&self, p: Vec3) -> Vec3 {
        self.inverse().apply(p)
    }

    /// A world vector into this frame.
    pub fn vector_to_local(&self, v: Vec3) -> Vec3 {
        let inv = Ground {
            x: 0.0,
            z: 0.0,
            yaw: -self.yaw,
        };
        let (x, z) = inv.rotate(v.x, v.z);
        Vec3::new(x, v.y, z)
    }

    /// The character frame of a root bone (see the module docs).
    pub fn from_root(root: Transform, rest: Quat) -> Ground {
        let q = root.rotation * rest.conjugate();
        Ground {
            x: root.translation.x,
            z: root.translation.z,
            yaw: 2.0 * q.y.atan2(q.w),
        }
    }
}

/// One clip, ready to sample (raw form).
pub struct RefClip<'a> {
    pub view: ClipView<'a>,
    pub rest: Vec<Transform>,
    pub parents: Vec<u16>,
    pub root: usize,
    pub rest_root: Quat,
    pub duration: f64,
    pub looping: bool,
    pub lap: Ground,
}

impl<'a> RefClip<'a> {
    /// `root_bone` overrides the clip's root bone (else bone 0).
    pub fn new(skel: &SkeletonView<'_>, view: ClipView<'a>, root_bone: Option<u32>) -> Self {
        let rest = rest_pose(skel);
        let parents = parents(skel);
        let root = root_bone
            .or((view.root_bone() != NONE).then_some(view.root_bone()))
            .unwrap_or(0) as usize;
        let mut chain = rest[root];
        let mut p = parents[root];
        while p != NO_PARENT {
            chain = rest[p as usize].compose(chain);
            p = parents[p as usize];
        }
        let mut c = RefClip {
            view,
            rest,
            parents,
            root,
            rest_root: chain.rotation,
            duration: view.duration() as f64,
            looping: view.flags() & CLIP_LOOP != 0,
            lap: Ground::IDENTITY,
        };
        if c.looping && c.duration > 0.0 {
            let (_, c0) = c.local(0.0);
            let (_, c1) = c.local(c.duration);
            c.lap = c1.compose(&c0.inverse());
        }
        c
    }

    /// The model pose and character frame at clip time `t` (no wrapping).
    fn local(&self, t: f64) -> (Vec<Transform>, Ground) {
        let model = local_to_model(&self.parents, &sample_raw_pose(&self.view, &self.rest, t));
        let g = Ground::from_root(model[self.root], self.rest_root);
        (model, g)
    }

    /// The unwrapped world positions of every bone and the character frame at any time `t`.
    pub fn at(&self, t: f64) -> (Vec<Vec3>, Ground) {
        let (u, k) = if self.looping && self.duration > 0.0 {
            let k = (t / self.duration).floor();
            (t - k * self.duration, k as i64)
        } else {
            (t.clamp(0.0, self.duration), 0)
        };
        let (model, g) = self.local(u);
        let mut lap = Ground::IDENTITY;
        let step = if k >= 0 { self.lap } else { self.lap.inverse() };
        for _ in 0..k.unsigned_abs() {
            lap = step.compose(&lap);
        }
        let positions = model.iter().map(|m| lap.apply(m.translation)).collect();
        (positions, lap.compose(&g))
    }
}

/// The features of `clip` at time `t` with database sample rate `rate`, in schema order.
pub fn frame_features(clip: &RefClip<'_>, features: &[Feature], t: f64, rate: f64) -> Vec<f64> {
    let h = 1.0 / rate;
    let (now, c) = clip.at(t);
    let mut out = Vec::new();
    for f in features {
        match f.kind {
            FeatureKind::BonePosition => {
                let p = c.to_local(now[f.bone as usize]);
                out.extend([p.x, p.y, p.z]);
            }
            FeatureKind::BoneVelocity => {
                let forward = !clip.looping && t - h < 0.0;
                let v = if forward && t + h > clip.duration {
                    Vec3::ZERO
                } else if forward {
                    let (next, _) = clip.at(t + h);
                    (next[f.bone as usize] - now[f.bone as usize]).scale(1.0 / h)
                } else {
                    let (prev, _) = clip.at(t - h);
                    (now[f.bone as usize] - prev[f.bone as usize]).scale(1.0 / h)
                };
                let v = c.vector_to_local(v);
                out.extend([v.x, v.y, v.z]);
            }
            FeatureKind::TrajectoryPosition => {
                let (_, there) = clip.at(t + f.time_offset as f64);
                let p = c.to_local(Vec3::new(there.x, 0.0, there.z));
                out.extend([p.x, p.z]);
            }
            FeatureKind::TrajectoryDirection => {
                let (_, there) = clip.at(t + f.time_offset as f64);
                let d = there.yaw - c.yaw;
                out.extend([d.sin(), d.cos()]);
            }
            FeatureKind::Custom => out.extend(std::iter::repeat_n(0.0, f.dims as usize)),
        }
    }
    out
}

/// Per-dim population means and deviations of `rows`, each deviation floored at `floor`; with
/// `per_feature` every dim of a feature takes the mean of its dims' deviations first.
pub fn normalization(
    rows: &[Vec<f64>],
    features: &[Feature],
    per_feature: bool,
    floor: f64,
) -> (Vec<f64>, Vec<f64>) {
    let dims = rows.first().map_or(0, |r| r.len());
    let n = rows.len() as f64;
    let mean: Vec<f64> = (0..dims)
        .map(|d| rows.iter().map(|r| r[d]).sum::<f64>() / n)
        .collect();
    let mut std: Vec<f64> = (0..dims)
        .map(|d| (rows.iter().map(|r| (r[d] - mean[d]).powi(2)).sum::<f64>() / n).sqrt())
        .collect();
    if per_feature {
        for f in features {
            let r = f.first_dim as usize..f.first_dim as usize + f.dims as usize;
            let avg = std[r.clone()].iter().sum::<f64>() / f.dims as f64;
            for s in &mut std[r] {
                *s = avg;
            }
        }
    }
    (mean, std.into_iter().map(|s| s.max(floor)).collect())
}

/// `(row − mean) / std`.
pub fn normalize(row: &[f64], mean: &[f64], std: &[f64]) -> Vec<f64> {
    row.iter()
        .zip(mean)
        .zip(std)
        .map(|((v, m), s)| (v - m) / s)
        .collect()
}

/// Each dim's weight (its feature's).
pub fn dim_weights(features: &[Feature]) -> Vec<f64> {
    features
        .iter()
        .flat_map(|f| std::iter::repeat_n(f.weight as f64, f.dims as usize))
        .collect()
}

/// `Σ weight · (a − b)²`.
pub fn cost(a: &[f64], b: &[f64], weights: &[f64]) -> f64 {
    a.iter()
        .zip(b)
        .zip(weights)
        .map(|((x, y), w)| w * (x - y) * (x - y))
        .sum()
}

/// The row of least cost against `query` among those `allowed` keeps (ties: the lowest index),
/// and its cost; `None` if none is allowed.
pub fn nearest(
    rows: &[Vec<f64>],
    weights: &[f64],
    query: &[f64],
    allowed: impl Fn(usize) -> bool,
) -> Option<(usize, f64)> {
    let mut best: Option<(usize, f64)> = None;
    for (i, r) in rows.iter().enumerate() {
        if !allowed(i) {
            continue;
        }
        let c = cost(query, r, weights);
        if best.is_none_or(|(_, b)| c < b) {
            best = Some((i, c));
        }
    }
    best
}
