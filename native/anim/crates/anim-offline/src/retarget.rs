//! Reference area `retarget`: f64 chain retargeting with rest-pose compensation and root
//! scaling, the reference for `anim-retarget`'s runtime path.
//!
//! The caller gives the resolved chains (bone paths on each skeleton, start to end) and the
//! retarget-root bone pairs; this module does the maths textbook-style and by its own route where
//! it can: resampling by searching the target parameter's bracket afresh, shortest arcs through
//! axis-angle (`acos`), rotation as `q·v·q*` (the `math` module).
//!
//! For each target bone of a chain: `G_tgt = nlerp(Δa, Δb, t) · A · R_tgt`, with
//! `Δ = G_src · R_src⁻¹` (model space), `(a, b, t)` the source bracket at the bone's normalised
//! rest length (equal bone counts pair by index) and `A` the shortest arc from the target's rest
//! chain direction to the source's (identity when alignment is off or a path has one bone). Root
//! pairs take `Δ · R_tgt` and the translation `tgt_rest + (src − src_rest)·ratio` per axis.
//! Driven bones keep their rest local translation and scale; other bones keep their rest local.

use crate::math::{local_to_model, Quat, Transform, Vec3};

/// How one axis of the root translation follows the source (as `anim-retarget::RootAxis`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RootAxis {
    Scaled,
    Unscaled,
    Locked,
}

/// One chain: bone paths, start to end.
#[derive(Clone, Debug, PartialEq)]
pub struct ChainPair {
    pub source: Vec<u16>,
    pub target: Vec<u16>,
}

/// A resolved retarget setup.
#[derive(Clone, Debug)]
pub struct Setup {
    pub source_parents: Vec<u16>,
    pub source_rest: Vec<Transform>,
    pub target_parents: Vec<u16>,
    pub target_rest: Vec<Transform>,
    /// Retarget-root pairs (source bone, target bone), driven before the chains.
    pub roots: Vec<(u16, u16)>,
    /// Chains, in order; a target bone already driven is skipped.
    pub chains: Vec<ChainPair>,
    pub align: bool,
    /// The leg-length ratio.
    pub ratio: f64,
}

/// The length of a limb (root → mid → tip) in a rest pose.
pub fn limb_length(parents: &[u16], rest: &[Transform], limb: [u16; 3]) -> f64 {
    let m = local_to_model(parents, rest);
    let p = |b: u16| m[b as usize].translation;
    (p(limb[1]) - p(limb[0])).length() + (p(limb[2]) - p(limb[1])).length()
}

/// The shortest-arc rotation from unit `u` to unit `v`, through axis and angle.
pub fn shortest_arc(u: Vec3, v: Vec3) -> Quat {
    let d = u.dot(v).clamp(-1.0, 1.0);
    let axis = u.cross(v);
    if axis.length() < 1e-12 {
        if d > 0.0 {
            return Quat::IDENTITY;
        }
        let o = if u.x.abs() < 0.577_35 { Vec3::X } else { Vec3::new(0.0, 1.0, 0.0) };
        return Quat::from_axis_angle(u.cross(o).normalize_or(Vec3::new(0.0, 0.0, 1.0)), std::f64::consts::PI);
    }
    Quat::from_axis_angle(axis.normalize_or(Vec3::X), d.acos())
}

fn params(path: &[u16], model: &[Transform]) -> Vec<f64> {
    let mut acc = vec![0.0];
    for w in path.windows(2) {
        let d = (model[w[1] as usize].translation - model[w[0] as usize].translation).length();
        acc.push(acc.last().unwrap() + d);
    }
    let total = *acc.last().unwrap();
    let m = path.len();
    if total > 1e-6 {
        acc.into_iter().map(|a| a / total).collect()
    } else if m > 1 {
        (0..m).map(|k| k as f64 / (m - 1) as f64).collect()
    } else {
        vec![0.0]
    }
}

fn direction(path: &[u16], model: &[Transform], k: usize) -> Option<Vec3> {
    if path.len() < 2 {
        return None;
    }
    let (i, j) = if k + 1 < path.len() { (k, k + 1) } else { (k - 1, k) };
    let d = model[path[j] as usize].translation - model[path[i] as usize].translation;
    (d.length() > 1e-6).then(|| d.normalize_or(d))
}

/// The source bracket `(a, b, t)` (indices into the source path) for target joint `k`.
pub fn bracket(source: &[f64], target: &[f64], k: usize) -> (usize, usize, f64) {
    if source.len() == target.len() {
        return (k, k, 0.0);
    }
    if source.len() == 1 {
        return (0, 0, 0.0);
    }
    let u = target[k];
    // The last segment whose start is at or before u.
    let j = (0..source.len() - 1)
        .rev()
        .find(|&j| source[j] <= u)
        .unwrap_or(0);
    let span = source[j + 1] - source[j];
    let t = if span > 1e-9 { ((u - source[j]) / span).clamp(0.0, 1.0) } else { 0.0 };
    (j, j + 1, t)
}

/// Retargets one source local pose to the target's local pose.
pub fn retarget(s: &Setup, axes: [RootAxis; 3], source_local: &[Transform]) -> Vec<Transform> {
    let sm_rest = local_to_model(&s.source_parents, &s.source_rest);
    let tm_rest = local_to_model(&s.target_parents, &s.target_rest);
    let sm = local_to_model(&s.source_parents, source_local);
    let delta = |b: u16| (sm[b as usize].rotation * sm_rest[b as usize].rotation.conjugate()).normalize_or_identity();
    let nt = s.target_rest.len();
    // Desired model rotation per driven target bone, and translation for roots.
    let mut rot: Vec<Option<Quat>> = vec![None; nt];
    let mut pos: Vec<Option<Vec3>> = vec![None; nt];
    for &(sb, tb) in &s.roots {
        if rot[tb as usize].is_some() {
            continue;
        }
        rot[tb as usize] = Some(delta(sb) * tm_rest[tb as usize].rotation);
        let m = sm[sb as usize].translation - sm_rest[sb as usize].translation;
        let r = tm_rest[tb as usize].translation;
        let f = |m: f64, r: f64, a: RootAxis| match a {
            RootAxis::Scaled => r + m * s.ratio,
            RootAxis::Unscaled => r + m,
            RootAxis::Locked => r,
        };
        pos[tb as usize] = Some(Vec3::new(f(m.x, r.x, axes[0]), f(m.y, r.y, axes[1]), f(m.z, r.z, axes[2])));
    }
    for c in &s.chains {
        let su = params(&c.source, &sm_rest);
        let tu = params(&c.target, &tm_rest);
        for (k, &tb) in c.target.iter().enumerate() {
            if rot[tb as usize].is_some() {
                continue;
            }
            let (a, b, t) = bracket(&su, &tu, k);
            let d = delta(c.source[a]).nlerp(delta(c.source[b]), t);
            let align = if s.align {
                let sd = match (direction(&c.source, &sm_rest, a), direction(&c.source, &sm_rest, b)) {
                    (Some(da), Some(db)) => Some(da.lerp(db, t).normalize_or(da)),
                    _ => None,
                };
                match (direction(&c.target, &tm_rest, k), sd) {
                    (Some(td), Some(sd)) => shortest_arc(td, sd),
                    _ => Quat::IDENTITY,
                }
            } else {
                Quat::IDENTITY
            };
            rot[tb as usize] = Some(d * align * tm_rest[tb as usize].rotation);
        }
    }
    // Locals against the retargeted parents.
    let mut model: Vec<Transform> = Vec::with_capacity(nt);
    let mut out = Vec::with_capacity(nt);
    for i in 0..nt {
        let p = s.target_parents[i];
        let parent = if p == 0xFFFF { Transform::IDENTITY } else { model[p as usize] };
        let rest = s.target_rest[i];
        let mut local = rest;
        if let Some(r) = rot[i] {
            local.rotation = (parent.rotation.conjugate() * r).normalize_or_identity();
        }
        if let Some(pp) = pos[i] {
            local.translation = parent.inverse().transform_point(pp);
        }
        model.push(parent.compose(local));
        out.push(local);
    }
    out
}

/// The IK goal of a limb: `target_root + (source_tip − source_root)·ratio` (model space).
pub fn goal(source_root: Vec3, source_tip: Vec3, target_root: Vec3, ratio: f64) -> Vec3 {
    target_root + (source_tip - source_root).scale(ratio)
}
