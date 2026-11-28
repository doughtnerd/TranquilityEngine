//! Small vector maths for the core (no_std: sqrt comes from libm, floor and ceil from casts).

pub type V3 = [f32; 3];

#[inline(always)]
pub fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline(always)]
pub fn dot(a: V3, b: V3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
/// The outward normal of triangle (a, b, c) in the engine's winding, the one convention every engine mesh and native
/// core uses (ADR 0450, `src/engine/scene/winding.ts`): a front face's right-hand normal (b - a) x (c - a) points inward,
/// so the outward normal is (c - a) x (b - a). Unnormalised.
#[inline(always)]
pub fn front_normal(a: V3, b: V3, c: V3) -> V3 {
    cross(sub(c, a), sub(b, a))
}

#[inline(always)]
pub fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
#[inline(always)]
pub fn sqrt(x: f32) -> f32 {
    libm::sqrtf(x)
}

/// `floor` for screen-space values (|x| far below 2^31; a NaN gives 0, larger values saturate).
#[inline(always)]
pub fn floor(x: f32) -> f32 {
    let t = x as i32 as f32;
    if t > x {
        t - 1.0
    } else {
        t
    }
}

/// `ceil` for screen-space values (same range as [`floor`]).
#[inline(always)]
pub fn ceil(x: f32) -> f32 {
    let t = x as i32 as f32;
    if t < x {
        t + 1.0
    } else {
        t
    }
}

/// Squared distance from point `p` to triangle `abc` (Ericson, Real-Time Collision Detection 5.1.5).
pub fn tri_distance_sq(p: V3, a: V3, b: V3, c: V3) -> f32 {
    let (ab, ac, ap) = (sub(b, a), sub(c, a), sub(p, a));
    let (d1, d2) = (dot(ab, ap), dot(ac, ap));
    let at = |t: f32, from: V3, dir: V3| {
        let q = [
            from[0] + dir[0] * t,
            from[1] + dir[1] * t,
            from[2] + dir[2] * t,
        ];
        let d = sub(p, q);
        dot(d, d)
    };
    let cp = |q: V3| {
        let d = sub(p, q);
        dot(d, d)
    };
    if d1 <= 0.0 && d2 <= 0.0 {
        return cp(a);
    }
    let bp = sub(p, b);
    let (d3, d4) = (dot(ab, bp), dot(ac, bp));
    if d3 >= 0.0 && d4 <= d3 {
        return cp(b);
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        return at(d1 / (d1 - d3), a, ab);
    }
    let cpv = sub(p, c);
    let (d5, d6) = (dot(ab, cpv), dot(ac, cpv));
    if d6 >= 0.0 && d5 <= d6 {
        return cp(c);
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        return at(d2 / (d2 - d6), a, ac);
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return at(w, b, sub(c, b));
    }
    let n = cross(ab, ac);
    let nn = dot(n, n);
    if nn <= 0.0 {
        // a degenerate triangle: the nearest of its vertices
        return cp(a).min(cp(b)).min(cp(c));
    }
    let h = dot(n, ap);
    h * h / nn
}
