//! The safety spike's adversarial scenes, ported as a reduced deterministic subset (`spikes/occlusion-safety/lib/`):
//! welded procedural meshes (hollow buildings with windows and doorways, thin walls, a heightfield), their stand-ins, the
//! occludees scattered around every silhouette, camera paths, and the 1080p reference.
//!
//! The spike's stand-ins came from meshoptimizer; here they are built directly (a facade grid that closes every opening,
//! a coarse sampling of the heightfield, optionally jittered), then measured and trimmed by `vis-trim` exactly as an
//! import would.
#![allow(dead_code)]
use std::collections::HashMap;
use vis_raster::buffer::{raster_simd, DepthBuf, Tri};
use vis_raster::setup::{setup_poly, xform, EXACT};
use vis_raster::View;

mod run;
pub use run::*;

pub type V3 = [f32; 3];

pub fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
pub fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
pub fn mul(a: V3, s: f32) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
pub fn dot(a: V3, b: V3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
pub fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// SplitMix64.
pub struct Rng(pub u64);
impl Rng {
    pub fn f(&mut self) -> f32 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        ((z ^ (z >> 31)) >> 40) as f32 / (1u64 << 24) as f32
    }
}
fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

// ------------------------------------------------------------------------------------------------------------ meshes

#[derive(Clone, Default)]
pub struct MeshData {
    pub positions: Vec<f32>,
    pub indices: Vec<u32>,
}

/// A welded mesh builder; `solids` are the boxes the geometry fills (occludees are kept out of them).
#[derive(Default)]
pub struct MeshBuilder {
    pos: Vec<f32>,
    idx: Vec<u32>,
    map: HashMap<(i32, i32, i32), u32>,
    pub solids: Vec<[f32; 6]>,
}

impl MeshBuilder {
    fn v(&mut self, p: V3) -> u32 {
        let key = (
            (p[0] * 1e4).round() as i32,
            (p[1] * 1e4).round() as i32,
            (p[2] * 1e4).round() as i32,
        );
        if let Some(&i) = self.map.get(&key) {
            return i;
        }
        let i = (self.pos.len() / 3) as u32;
        self.pos.extend_from_slice(&p);
        self.map.insert(key, i);
        i
    }
    fn tri(&mut self, a: V3, b: V3, c: V3) {
        let (ia, ib, ic) = (self.v(a), self.v(b), self.v(c));
        if ia != ib && ib != ic && ia != ic {
            self.idx.extend_from_slice(&[ia, ib, ic]);
        }
    }
    /// A quad p0..p3 (cyclic), wound so its normal points along `n`.
    fn quad(&mut self, p0: V3, p1: V3, p2: V3, p3: V3, n: V3) {
        if dot(vis_raster::geom::front_normal(p0, p1, p2), n) < 0.0 {
            self.tri(p0, p2, p1);
            self.tri(p0, p3, p2);
        } else {
            self.tri(p0, p1, p2);
            self.tri(p0, p2, p3);
        }
    }
    fn box_(&mut self, mn: V3, mx: V3) {
        let p = |x: bool, y: bool, z: bool| {
            [
                if x { mx[0] } else { mn[0] },
                if y { mx[1] } else { mn[1] },
                if z { mx[2] } else { mn[2] },
            ]
        };
        self.quad(
            p(false, false, false),
            p(false, true, false),
            p(false, true, true),
            p(false, false, true),
            [-1.0, 0.0, 0.0],
        );
        self.quad(
            p(true, false, false),
            p(true, true, false),
            p(true, true, true),
            p(true, false, true),
            [1.0, 0.0, 0.0],
        );
        self.quad(
            p(false, false, false),
            p(true, false, false),
            p(true, false, true),
            p(false, false, true),
            [0.0, -1.0, 0.0],
        );
        self.quad(
            p(false, true, false),
            p(true, true, false),
            p(true, true, true),
            p(false, true, true),
            [0.0, 1.0, 0.0],
        );
        self.quad(
            p(false, false, false),
            p(true, false, false),
            p(true, true, false),
            p(false, true, false),
            [0.0, 0.0, -1.0],
        );
        self.quad(
            p(false, false, true),
            p(true, false, true),
            p(true, true, true),
            p(false, true, true),
            [0.0, 0.0, 1.0],
        );
        self.solids.push([mn[0], mn[1], mn[2], mx[0], mx[1], mx[2]]);
    }
    pub fn finish(self) -> (MeshData, Vec<[f32; 6]>) {
        (
            MeshData {
                positions: self.pos,
                indices: self.idx,
            },
            self.solids,
        )
    }
}

fn uniq(mut a: Vec<f32>) -> Vec<f32> {
    a.sort_by(|x, y| x.total_cmp(y));
    let mut o: Vec<f32> = vec![];
    for x in a {
        if o.last().is_none_or(|l| x - l > 1e-4) {
            o.push(x);
        }
    }
    o
}
fn grid(a: f32, b: f32, step: f32, extra: &[f32]) -> Vec<f32> {
    let mut s = vec![a, b];
    s.extend(
        extra
            .iter()
            .copied()
            .filter(|&x| x > a + 1e-4 && x < b - 1e-4),
    );
    if step > 0.0 {
        let mut x = a + step;
        while x < b - 1e-4 {
            s.push(x);
            x += step;
        }
    }
    uniq(s)
}

#[derive(Clone, Copy)]
pub struct Opening {
    pub x0: f32,
    pub x1: f32,
    pub y0: f32,
    pub y1: f32,
    pub through: bool,
    pub depth: f32,
}

/// A wall slab as a closed, welded, tessellated mesh (the spike's `wallSlab`). Local frame: origin `o` (bottom corner of
/// the front face), `u` along the wall, `n` the outward normal, thickness `t` extends along -n. `fill` makes the openings
/// only grid lines (a stand-in that closes them).
pub struct Slab {
    pub o: V3,
    pub u: V3,
    pub n: V3,
    pub l: f32,
    pub h: f32,
    pub t: f32,
    pub openings: Vec<Opening>,
    pub sub: f32,
    pub fill: bool,
}

pub fn wall_slab(mb: &mut MeshBuilder, s: &Slab) {
    let up = [0.0, 1.0, 0.0];
    let p = |x: f32, y: f32, d: f32| add(add(add(s.o, mul(s.u, x)), mul(up, y)), mul(s.n, -d));
    let xs = grid(
        0.0,
        s.l,
        s.sub,
        &s.openings
            .iter()
            .flat_map(|q| [q.x0, q.x1])
            .collect::<Vec<_>>(),
    );
    let ys = grid(
        0.0,
        s.h,
        s.sub,
        &s.openings
            .iter()
            .flat_map(|q| [q.y0, q.y1])
            .collect::<Vec<_>>(),
    );
    let open_at = |cx: f32, cy: f32| {
        if s.fill {
            None
        } else {
            s.openings
                .iter()
                .find(|q| cx > q.x0 && cx < q.x1 && cy > q.y0 && cy < q.y1)
        }
    };
    let (nu, nn) = (mul(s.u, -1.0), mul(s.n, -1.0));
    let aabb = |pts: [V3; 2]| {
        let mut b = [f32::MAX, f32::MAX, f32::MAX, f32::MIN, f32::MIN, f32::MIN];
        for q in pts {
            for k in 0..3 {
                b[k] = b[k].min(q[k]);
                b[k + 3] = b[k + 3].max(q[k]);
            }
        }
        b
    };
    for i in 0..xs.len() - 1 {
        for j in 0..ys.len() - 1 {
            let (xa, xb, ya, yb) = (xs[i], xs[i + 1], ys[j], ys[j + 1]);
            match open_at((xa + xb) / 2.0, (ya + yb) / 2.0) {
                None => {
                    mb.quad(
                        p(xa, ya, 0.0),
                        p(xb, ya, 0.0),
                        p(xb, yb, 0.0),
                        p(xa, yb, 0.0),
                        s.n,
                    );
                    mb.quad(
                        p(xa, ya, s.t),
                        p(xb, ya, s.t),
                        p(xb, yb, s.t),
                        p(xa, yb, s.t),
                        nn,
                    );
                    mb.solids.push(aabb([p(xa, ya, 0.0), p(xb, yb, s.t)]));
                }
                Some(q) if !q.through => {
                    mb.quad(
                        p(xa, ya, s.t),
                        p(xb, ya, s.t),
                        p(xb, yb, s.t),
                        p(xa, yb, s.t),
                        nn,
                    );
                    mb.quad(
                        p(xa, ya, q.depth),
                        p(xb, ya, q.depth),
                        p(xb, yb, q.depth),
                        p(xa, yb, q.depth),
                        s.n,
                    );
                    mb.solids.push(aabb([p(xa, ya, q.depth), p(xb, yb, s.t)]));
                }
                Some(_) => {}
            }
        }
    }
    if !s.fill {
        for q in &s.openings {
            let dep = if q.through { s.t } else { q.depth };
            for i in 0..xs.len() - 1 {
                let (xa, xb) = (xs[i], xs[i + 1]);
                if xa < q.x0 - 1e-4 || xb > q.x1 + 1e-4 {
                    continue;
                }
                mb.quad(
                    p(xa, q.y0, 0.0),
                    p(xb, q.y0, 0.0),
                    p(xb, q.y0, dep),
                    p(xa, q.y0, dep),
                    up,
                );
                mb.quad(
                    p(xa, q.y1, 0.0),
                    p(xb, q.y1, 0.0),
                    p(xb, q.y1, dep),
                    p(xa, q.y1, dep),
                    [0.0, -1.0, 0.0],
                );
            }
            for j in 0..ys.len() - 1 {
                let (ya, yb) = (ys[j], ys[j + 1]);
                if ya < q.y0 - 1e-4 || yb > q.y1 + 1e-4 {
                    continue;
                }
                mb.quad(
                    p(q.x0, ya, 0.0),
                    p(q.x0, yb, 0.0),
                    p(q.x0, yb, dep),
                    p(q.x0, ya, dep),
                    s.u,
                );
                mb.quad(
                    p(q.x1, ya, 0.0),
                    p(q.x1, yb, 0.0),
                    p(q.x1, yb, dep),
                    p(q.x1, ya, dep),
                    nu,
                );
            }
        }
    }
    for i in 0..xs.len() - 1 {
        mb.quad(
            p(xs[i], s.h, 0.0),
            p(xs[i + 1], s.h, 0.0),
            p(xs[i + 1], s.h, s.t),
            p(xs[i], s.h, s.t),
            up,
        );
        mb.quad(
            p(xs[i], 0.0, 0.0),
            p(xs[i + 1], 0.0, 0.0),
            p(xs[i + 1], 0.0, s.t),
            p(xs[i], 0.0, s.t),
            [0.0, -1.0, 0.0],
        );
    }
    for j in 0..ys.len() - 1 {
        mb.quad(
            p(0.0, ys[j], 0.0),
            p(0.0, ys[j + 1], 0.0),
            p(0.0, ys[j + 1], s.t),
            p(0.0, ys[j], s.t),
            nu,
        );
        mb.quad(
            p(s.l, ys[j], 0.0),
            p(s.l, ys[j + 1], 0.0),
            p(s.l, ys[j + 1], s.t),
            p(s.l, ys[j], s.t),
            s.u,
        );
    }
}

#[derive(Clone, Copy, PartialEq)]
pub enum Face {
    Front,
    Back,
    Left,
    Right,
}
#[derive(Clone, Copy)]
pub struct Door {
    pub face: Face,
    pub u: f32,
    pub w: f32,
    pub h: f32,
}
pub struct Building {
    pub cx: f32,
    pub cz: f32,
    pub w: f32,
    pub d: f32,
    pub h: f32,
    pub doors: Vec<Door>,
}
pub struct Bounds {
    pub xmin: f32,
    pub xmax: f32,
    pub zmin: f32,
    pub zmax: f32,
    pub t: f32,
}

/// A hollow building (4 walls, floor, roof; the spike's `building`). `fill` closes every opening (the stand-in).
pub fn building(mb: &mut MeshBuilder, b: &Building, fill: bool) -> Bounds {
    let t = 0.4;
    let (xmin, xmax, zmin, zmax) = (
        b.cx - b.w / 2.0,
        b.cx + b.w / 2.0,
        b.cz - b.d / 2.0,
        b.cz + b.d / 2.0,
    );
    let walls = [
        (
            Face::Front,
            [xmin, 0.0, zmin],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, -1.0],
            b.w,
        ),
        (
            Face::Back,
            [xmax, 0.0, zmax],
            [-1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            b.w,
        ),
        (
            Face::Left,
            [xmin, 0.0, zmax - t],
            [0.0, 0.0, -1.0],
            [-1.0, 0.0, 0.0],
            b.d - 2.0 * t,
        ),
        (
            Face::Right,
            [xmax, 0.0, zmin + t],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 0.0],
            b.d - 2.0 * t,
        ),
    ];
    for (face, o, u, n, l) in walls {
        let mut openings = vec![];
        let door = b.doors.iter().find(|d| d.face == face);
        if let Some(d) = door {
            openings.push(Opening {
                x0: d.u - d.w / 2.0,
                x1: d.u + d.w / 2.0,
                y0: 0.0,
                y1: d.h,
                through: true,
                depth: 0.0,
            });
        }
        let cols = ((l / 3.5).floor() as usize).max(1);
        let pitch = l / cols as f32;
        for c in 0..cols {
            let uc = pitch * (c as f32 + 0.5);
            let clash = door.is_some_and(|d| (uc - d.u).abs() < d.w / 2.0 + 0.9);
            if !clash {
                openings.push(Opening {
                    x0: uc - 0.6,
                    x1: uc + 0.6,
                    y0: 0.9,
                    y1: 2.2,
                    through: true,
                    depth: 0.0,
                });
            }
            for (y0, y1) in [(3.6, 5.0), (6.6, 8.0)] {
                if y1 < b.h - 0.5 {
                    openings.push(Opening {
                        x0: uc - 0.7,
                        x1: uc + 0.7,
                        y0,
                        y1,
                        through: false,
                        depth: 0.18,
                    });
                }
            }
        }
        wall_slab(
            mb,
            &Slab {
                o,
                u,
                n,
                l,
                h: b.h,
                t,
                openings,
                sub: 1.0,
                fill,
            },
        );
    }
    mb.box_([xmin, -0.3, zmin], [xmax, 0.0, zmax]);
    mb.box_([xmin, b.h, zmin], [xmax, b.h + 0.4, zmax]);
    Bounds {
        xmin,
        xmax,
        zmin,
        zmax,
        t,
    }
}

/// A one-sided heightfield patch (normals up): `nx` x `nz` cells of `cell` metres, heights from `height`.
pub fn terrain(
    mb: &mut MeshBuilder,
    x0: f32,
    z0: f32,
    nx: usize,
    nz: usize,
    cell: f32,
    height: &dyn Fn(f32, f32) -> f32,
) {
    let p = |i: usize, j: usize| {
        [
            x0 + i as f32 * cell,
            height(x0 + i as f32 * cell, z0 + j as f32 * cell),
            z0 + j as f32 * cell,
        ]
    };
    for i in 0..nx {
        for j in 0..nz {
            mb.quad(
                p(i, j),
                p(i + 1, j),
                p(i + 1, j + 1),
                p(i, j + 1),
                [0.0, 1.0, 0.0],
            );
        }
    }
}

/// Moves the stand-in's vertices along `dir` by up to +-`amount` (deterministic per position): a rough, bulging stand-in.
pub fn jitter(m: &mut MeshData, dir: V3, amount: f32, seed: u64) {
    for v in m.positions.chunks_exact_mut(3) {
        let key = ((v[0] * 100.0).round() as i64).wrapping_mul(73856093)
            ^ ((v[1] * 100.0).round() as i64).wrapping_mul(19349663)
            ^ ((v[2] * 100.0).round() as i64).wrapping_mul(83492791);
        let mut r = Rng((key as u64) ^ seed);
        let k = (r.f() * 2.0 - 1.0) * amount;
        for c in 0..3 {
            v[c] += dir[c] * k;
        }
    }
}

// --------------------------------------------------------------------------------------------------------- occludees

/// Collects occludee boxes: a candidate is kept when it does not touch a solid (with a margin).
pub struct Occludees<'a> {
    solids: &'a [[f32; 6]],
    r: Rng,
    pub boxes: Vec<f32>,
}

impl<'a> Occludees<'a> {
    pub fn new(solids: &'a [[f32; 6]], seed: u64) -> Occludees<'a> {
        Occludees {
            solids,
            r: Rng(seed),
            boxes: vec![],
        }
    }
    fn free(&self, mn: V3, mx: V3) -> bool {
        let m = 0.06;
        !self.solids.iter().any(|s| {
            mn[0] < s[3] + m
                && mx[0] > s[0] - m
                && mn[1] < s[4] + m
                && mx[1] > s[1] - m
                && mn[2] < s[5] + m
                && mx[2] > s[2] - m
        })
    }
    /// `n` boxes with centre in [lo, hi] (y is the box BOTTOM range), half extents in [hmin, hmax]. `ground` lifts the
    /// bottom onto a terrain.
    pub fn scatter(
        &mut self,
        n: usize,
        lo: V3,
        hi: V3,
        hmin: f32,
        hmax: f32,
        ground: Option<&dyn Fn(f32, f32) -> f32>,
    ) {
        let (mut tries, mut added) = (0, 0);
        while added < n && tries < n * 60 {
            tries += 1;
            let h = [
                lerp(hmin, hmax, self.r.f()),
                lerp(hmin, hmax, self.r.f()),
                lerp(hmin, hmax, self.r.f()),
            ];
            let c = [
                lerp(lo[0], hi[0], self.r.f()),
                0.0,
                lerp(lo[2], hi[2], self.r.f()),
            ];
            let mut bottom = lerp(lo[1], hi[1], self.r.f());
            if let Some(g) = ground {
                bottom += g(c[0] - h[0], c[2] - h[2])
                    .max(g(c[0] + h[0], c[2] - h[2]))
                    .max(g(c[0] - h[0], c[2] + h[2]))
                    .max(g(c[0] + h[0], c[2] + h[2]))
                    .max(g(c[0], c[2]))
                    + 0.03;
            }
            let mn = [c[0] - h[0], bottom, c[2] - h[2]];
            let mx = [c[0] + h[0], bottom + 2.0 * h[1], c[2] + h[2]];
            if mn[1] < 0.0 && ground.is_none() {
                continue;
            }
            if !self.free(mn, mx) {
                continue;
            }
            self.boxes
                .extend_from_slice(&[mn[0], mn[1], mn[2], mx[0], mx[1], mx[2]]);
            added += 1;
        }
    }
}

// ------------------------------------------------------------------------------------------------------------ scenes

pub struct Occluder {
    pub original: MeshData,
    pub standin: MeshData,
    pub bmin: V3,
    pub bmax: V3,
}

pub struct Scene {
    pub name: &'static str,
    pub occluders: Vec<Occluder>,
    pub boxes: Vec<f32>,
    pub paths: Vec<(&'static str, Vec<(V3, V3)>)>,
}

fn bounds_of(m: &MeshData) -> (V3, V3) {
    let (mut mn, mut mx) = ([f32::MAX; 3], [f32::MIN; 3]);
    for &i in &m.indices {
        for k in 0..3 {
            let v = m.positions[i as usize * 3 + k];
            mn[k] = mn[k].min(v);
            mx[k] = mx[k].max(v);
        }
    }
    (mn, mx)
}

fn occluder(original: MeshData, standin: MeshData) -> Occluder {
    let (bmin, bmax) = bounds_of(&original);
    Occluder {
        original,
        standin,
        bmin,
        bmax,
    }
}

fn path(frames: usize, f: impl Fn(f32) -> (V3, V3)) -> Vec<(V3, V3)> {
    (0..frames)
        .map(|i| f(i as f32 / (frames - 1) as f32))
        .collect()
}

/// `frames` camera frames per path (the spike used 30; a subset keeps the test quick).
pub fn scenes(frames: usize) -> Vec<Scene> {
    vec![bldg(frames), beside(frames), walls(frames), hill(frames)]
}

fn bldg_spec(cx: f32, h: f32, doors: Vec<Door>) -> Building {
    Building {
        cx,
        cz: 0.0,
        w: 14.0,
        d: 8.0,
        h,
        doors,
    }
}

fn door(face: Face, u: f32) -> Door {
    Door {
        face,
        u,
        w: 1.1,
        h: 2.2,
    }
}

fn bldg(frames: usize) -> Scene {
    let specs = [
        bldg_spec(-20.0, 9.0, vec![door(Face::Front, 4.0)]),
        bldg_spec(0.0, 12.0, vec![door(Face::Front, 7.0)]),
        bldg_spec(
            20.0,
            7.0,
            vec![door(Face::Front, 10.0), door(Face::Back, 4.0)],
        ),
    ];
    let mut occluders = vec![];
    let (mut solids, mut bounds) = (vec![], vec![]);
    for (i, s) in specs.iter().enumerate() {
        let mut mb = MeshBuilder::default();
        bounds.push(building(&mut mb, s, false));
        let (orig, sol) = mb.finish();
        solids.extend(sol);
        let mut sb = MeshBuilder::default();
        building(&mut sb, s, true);
        let mut standin = sb.finish().0;
        // a rough stand-in: every vertex off the facade by up to 5 cm (inside the trim threshold of 0.5 % of the diagonal)
        jitter(&mut standin, [0.0, 0.0, 1.0], 0.05, 11 + i as u64);
        occluders.push(occluder(orig, standin));
    }
    let mut oc = Occludees::new(&solids, 0xb1d);
    for (s, b) in specs.iter().zip(&bounds) {
        oc.scatter(
            60,
            [b.xmin + b.t + 0.3, 0.0, b.zmin + b.t + 0.3],
            [b.xmax - b.t - 0.3, 3.0, b.zmax - b.t - 0.3],
            0.1,
            0.45,
            None,
        );
        let dx = s.cx - s.w / 2.0 + s.doors[0].u;
        oc.scatter(
            25,
            [dx - 0.9, 0.0, b.zmin + b.t + 0.3],
            [dx + 0.9, 1.6, b.zmax - b.t - 0.3],
            0.08,
            0.3,
            None,
        );
    }
    oc.scatter(260, [-45.0, 0.0, -26.0], [45.0, 1.5, -4.8], 0.12, 0.8, None);
    oc.scatter(220, [-45.0, 0.0, 4.8], [45.0, 1.5, 26.0], 0.12, 0.8, None);
    oc.scatter(120, [-13.0, 0.0, -5.0], [13.0, 1.5, 5.0], 0.1, 0.6, None);
    oc.scatter(100, [-30.0, 7.0, -8.0], [30.0, 11.0, 22.0], 0.1, 0.6, None);
    let door_x = |i: usize| specs[i].cx - specs[i].w / 2.0 + specs[i].doors[0].u;
    let paths = vec![
        (
            "street",
            path(frames, |t| {
                let x = lerp(-34.0, 34.0, t);
                ([x, 1.7, -9.0], [x + 7.0, 2.0, 4.0])
            }),
        ),
        (
            "door",
            path(frames, |t| {
                let x = door_x(1) + 0.25 * (t * 6.0).sin();
                ([x, 1.7, lerp(-16.0, -4.7, t)], [door_x(1), 1.3, 4.0])
            }),
        ),
        (
            "door-oblique",
            path(frames, |t| {
                let x = lerp(-9.0, door_x(1) - 0.4, t);
                ([x, 1.7, lerp(-14.0, -4.7, t)], [door_x(1) + 2.0, 1.3, 4.0])
            }),
        ),
        (
            "low",
            path(frames, |t| {
                let x = lerp(-34.0, 34.0, t);
                ([x, 0.4, -8.0], [x + 6.0, 0.8, 4.0])
            }),
        ),
        (
            "far",
            path(frames, |t| {
                let x = lerp(-30.0, 30.0, t);
                ([x, 1.7, -75.0], [x * 0.5, 3.0, 5.0])
            }),
        ),
    ];
    Scene {
        name: "bldg",
        occluders,
        boxes: oc.boxes,
        paths,
    }
}

fn beside(frames: usize) -> Scene {
    let spec = Building {
        cx: 0.0,
        cz: 0.0,
        w: 14.0,
        d: 8.0,
        h: 8.0,
        doors: vec![
            door(Face::Front, 4.5),
            Door {
                face: Face::Right,
                u: 3.6,
                w: 1.0,
                h: 2.1,
            },
        ],
    };
    let mut mb = MeshBuilder::default();
    let b = building(&mut mb, &spec, false);
    let (orig, solids) = mb.finish();
    let mut sb = MeshBuilder::default();
    building(&mut sb, &spec, true);
    let mut standin = sb.finish().0;
    jitter(&mut standin, [0.0, 0.0, 1.0], 0.05, 77);
    let door_x = -7.0 + 4.5;
    let mut oc = Occludees::new(&solids, 0xbe51);
    oc.scatter(
        90,
        [b.xmin + b.t + 0.3, 0.0, b.zmin + b.t + 0.3],
        [b.xmax - b.t - 0.3, 3.0, b.zmax - b.t - 0.3],
        0.1,
        0.45,
        None,
    );
    oc.scatter(
        25,
        [door_x - 0.8, 0.0, b.zmin + b.t + 0.3],
        [door_x + 0.8, 1.6, b.zmax - b.t - 0.3],
        0.08,
        0.3,
        None,
    );
    oc.scatter(180, [-20.0, 0.0, -20.0], [20.0, 1.5, -4.6], 0.1, 0.7, None);
    oc.scatter(140, [-20.0, 0.0, 4.6], [20.0, 1.5, 20.0], 0.1, 0.7, None);
    oc.scatter(70, [7.6, 0.0, -4.6], [20.0, 1.5, 4.6], 0.1, 0.7, None);
    oc.scatter(120, [-7.4, 0.0, -4.6], [7.4, 0.4, -4.05], 0.03, 0.15, None); // hugging the facade
    let paths = vec![
        (
            "beside-into",
            path(frames, |t| {
                let x = lerp(-10.0, 6.0, t);
                ([x, 1.7, -4.5], [x + 7.0, 1.7, 1.5])
            }),
        ),
        (
            "beside-close",
            path(frames, |t| {
                let x = lerp(-9.0, 9.0, t);
                ([x, 1.7, -4.12], [x + 5.0, 1.5, -8.0])
            }),
        ),
        (
            "threshold-in",
            path(frames, |t| {
                (
                    [door_x + 0.2 * (t * 5.0).sin(), 1.7, lerp(-6.5, 0.5, t)],
                    [door_x, 1.4, 4.0],
                )
            }),
        ),
        (
            "inside-sweep",
            path(frames, |t| {
                let a = t * 2.0 * std::f32::consts::PI;
                (
                    [-1.5, 1.7, 0.5],
                    [-1.5 + 10.0 * a.cos(), 1.5, 0.5 + 10.0 * a.sin()],
                )
            }),
        ),
    ];
    Scene {
        name: "beside",
        occluders: vec![occluder(orig, standin)],
        boxes: oc.boxes,
        paths,
    }
}

fn walls(frames: usize) -> Scene {
    let mk = |slabs: Vec<Slab>| {
        let mut mb = MeshBuilder::default();
        for s in &slabs {
            wall_slab(&mut mb, s);
        }
        mb.finish()
    };
    let slab = |o: V3, u: V3, n: V3, l: f32, h: f32, t: f32, sub: f32| Slab {
        o,
        u,
        n,
        l,
        h,
        t,
        openings: vec![],
        sub,
        fill: false,
    };
    // the stand-ins are the walls themselves (exact: error 0, nothing trimmed): the spike's "exact box stand-in" case
    let (thin, s1) = mk(vec![slab(
        [-5.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 0.0, -1.0],
        10.0,
        3.0,
        0.2,
        0.5,
    )]);
    let (lw, s2) = mk(vec![
        slab(
            [20.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, -1.0],
            8.0,
            3.0,
            0.2,
            0.5,
        ),
        slab(
            [28.0, 0.0, 0.2],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 0.0],
            6.0,
            3.0,
            0.2,
            0.5,
        ),
    ]);
    let (low, s3) = mk(vec![slab(
        [-40.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 0.0, -1.0],
        8.0,
        0.9,
        0.3,
        0.2,
    )]);
    let solids: Vec<[f32; 6]> = [s1, s2, s3].concat();
    let mut oc = Occludees::new(&solids, 0x7a11);
    oc.scatter(220, [-12.0, 0.0, 0.5], [12.0, 2.5, 14.0], 0.1, 0.5, None);
    oc.scatter(50, [-6.0, 0.0, -3.0], [6.0, 0.0, -0.3], 0.05, 0.3, None);
    oc.scatter(160, [17.0, 0.0, -3.0], [31.0, 2.5, 9.0], 0.1, 0.5, None);
    oc.scatter(200, [-44.0, 0.0, 0.6], [-28.0, 1.8, 12.0], 0.1, 0.6, None);
    oc.scatter(40, [-44.0, 0.0, -4.0], [-28.0, 0.7, -0.4], 0.05, 0.3, None);
    let paths = vec![
        (
            "thin-graze",
            path(frames, |t| {
                let x = lerp(-22.0, -9.0, t);
                ([x, 1.7, -1.5], [x + 20.0, 1.5, 0.1])
            }),
        ),
        (
            "thin-low",
            path(frames, |t| {
                let x = lerp(-10.0, 10.0, t);
                ([x, 0.4, -9.0], [0.0, 0.8, 6.0])
            }),
        ),
        (
            "L-inside",
            path(frames, |t| {
                let x = lerp(22.0, 26.0, t);
                ([x, 1.7, lerp(-6.0, 4.0, t)], [28.0, 1.2, 12.0])
            }),
        ),
        (
            "low-over",
            path(frames, |t| {
                let x = lerp(-42.0, -30.0, t);
                ([x, 1.7, -6.0], [x + 3.0, 1.0, 10.0])
            }),
        ),
        (
            "low-crouch",
            path(frames, |t| {
                let x = lerp(-42.0, -30.0, t);
                ([x, 0.5, -3.0], [x + 3.0, 0.7, 10.0])
            }),
        ),
    ];
    let occs = vec![
        occluder(thin.clone(), thin),
        occluder(lw.clone(), lw),
        occluder(low.clone(), low),
    ];
    Scene {
        name: "walls",
        occluders: occs,
        boxes: oc.boxes,
        paths,
    }
}

pub fn hill_height(x: f32, z: f32) -> f32 {
    3.0 * (x * 0.09 + 0.6).sin() * (z * 0.07).cos()
        + 5.0 * (-((z - 30.0) * (z - 30.0)) / 150.0).exp()
        + 0.9 * (x * 0.31 + z * 0.23).sin()
}

fn hill(frames: usize) -> Scene {
    let mut mb = MeshBuilder::default();
    terrain(&mut mb, -40.0, -10.0, 80, 80, 1.0, &hill_height);
    let orig = mb.finish().0;
    // the stand-in: the heightfield sampled every 4 m (20 x 20 cells), 800 triangles
    let mut sb = MeshBuilder::default();
    terrain(&mut sb, -40.0, -10.0, 20, 20, 4.0, &hill_height);
    let standin = sb.finish().0;
    let mut oc = Occludees::new(&[], 0x4111);
    oc.scatter(
        250,
        [-38.0, 0.0, 32.0],
        [38.0, 0.3, 66.0],
        0.1,
        0.5,
        Some(&hill_height),
    );
    oc.scatter(
        180,
        [-38.0, 0.0, 8.0],
        [38.0, 0.3, 29.0],
        0.1,
        0.5,
        Some(&hill_height),
    );
    oc.scatter(
        120,
        [-38.0, 0.0, 33.0],
        [38.0, 1.5, 66.0],
        0.1,
        0.5,
        Some(&hill_height),
    );
    let g = |x: f32, z: f32, h: f32| hill_height(x, z) + h;
    let paths = vec![
        (
            "walk-up",
            path(frames, |t| {
                let (z, x) = (lerp(-5.0, 22.0, t), 3.0 * (t * 5.0).sin());
                (
                    [x, g(x, z, 1.7), z],
                    [x + 6.0, g(x, z + 40.0, 0.0), z + 40.0],
                )
            }),
        ),
        (
            "low",
            path(frames, |t| {
                let (z, x) = (lerp(-5.0, 22.0, t), -8.0 + 6.0 * (t * 4.0).sin());
                (
                    [x, g(x, z, 0.4), z],
                    [x + 4.0, g(x, z + 40.0, 0.5), z + 40.0],
                )
            }),
        ),
        (
            "crest",
            path(frames, |t| {
                let z = lerp(18.0, 31.0, t);
                (
                    [0.0, g(0.0, z, 1.7), z],
                    [4.0, g(4.0, z + 30.0, 0.0), z + 30.0],
                )
            }),
        ),
    ];
    Scene {
        name: "hill",
        occluders: vec![occluder(orig, standin)],
        boxes: oc.boxes,
        paths,
    }
}

// ------------------------------------------------------------------------------------------------------------ camera

/// The view of a camera at `eye` looking at `target` (60 degrees, 16:9, near 0.1, far 400; the spike's).
pub fn look_at(eye: V3, target: V3) -> View {
    let (near, far) = (0.1f32, 400.0f32);
    let norm = |a: V3| {
        let l = dot(a, a).sqrt();
        [a[0] / l, a[1] / l, a[2] / l]
    };
    let fwd = norm(sub(target, eye));
    let right = norm(cross([0.0, 1.0, 0.0], fwd));
    let up = cross(fwd, right);
    let t = (60f32.to_radians() * 0.5).tan();
    let (sx, sy) = (1.0 / (t * 16.0 / 9.0), 1.0 / t);
    let (a, b) = (far / (far - near), -near * far / (far - near));
    let v = [
        [right[0], right[1], right[2], -dot(right, eye)],
        [up[0], up[1], up[2], -dot(up, eye)],
        [fwd[0], fwd[1], fwd[2], -dot(fwd, eye)],
        [0.0, 0.0, 0.0, 1.0],
    ];
    let p = [
        [sx, 0.0, 0.0, 0.0],
        [0.0, sy, 0.0, 0.0],
        [0.0, 0.0, a, b],
        [0.0, 0.0, 1.0, 0.0],
    ];
    let mut m = [0f32; 16];
    for i in 0..4 {
        for j in 0..4 {
            m[j * 4 + i] = (0..4).map(|k| p[i][k] * v[k][j]).sum();
        }
    }
    View::perspective(&m, eye, near, far, sx, sy).unwrap()
}

// ------------------------------------------------------------------------------------------------------------ oracle

pub const OW: usize = 1920;
pub const OH: usize = 1080;

/// Is the triangle `abc` facing the eye?
pub fn faces(eye: V3, a: V3, b: V3, c: V3) -> bool {
    dot(vis_raster::geom::front_normal(a, b, c), sub(eye, a)) > 0.0
}

pub fn tri_at(m: &MeshData, t: usize) -> [V3; 3] {
    let p = |k: usize| {
        let v = m.indices[t * 3 + k] as usize * 3;
        [m.positions[v], m.positions[v + 1], m.positions[v + 2]]
    };
    [p(0), p(1), p(2)]
}

pub fn clip_tri(view: &View, w: usize, h: usize, t: [V3; 3], out: &mut Vec<Tri>) {
    let v = [
        xform(&view.cols, t[0]),
        xform(&view.cols, t[1]),
        xform(&view.cols, t[2]),
    ];
    let first = out.len();
    setup_poly(view, w, h, v, &EXACT, out);
    // Triangles that share an edge compute it from different vertices, and in f32 a pixel centre on that edge can fall in
    // neither: a one-pixel crack the real surface does not have. The reference closes such cracks by growing every triangle
    // by 0.002 pixel (nothing visible depends on a growth that small).
    for tr in &mut out[first..] {
        for e in &mut tr.e {
            e[2] += 0.002 * (e[0].abs() + e[1].abs());
        }
    }
}

/// The reference: the ORIGINAL meshes rasterised exactly at 1920x1080, then each occludee box's own front faces tested
/// against that buffer pixel by pixel. Returns, per box, the number of its silhouette pixels that are visible, `u32::MAX` for
/// boxes crossing the near plane and `None` for boxes outside the frustum.
pub fn oracle(
    view: &View,
    occluders: &[&MeshData],
    boxes: &[f32],
    buf: &mut DepthBuf,
) -> Vec<Option<u32>> {
    buf.clear();
    let mut tris: Vec<Tri> = vec![];
    for m in occluders {
        for t in 0..m.indices.len() / 3 {
            let [a, b, c] = tri_at(m, t);
            if !faces(view.eye, a, b, c) {
                continue;
            }
            tris.clear();
            clip_tri(view, OW, OH, [a, b, c], &mut tris);
            for tr in &tris {
                raster_simd(buf, tr);
            }
        }
    }
    let mut out = vec![];
    let mut bt: Vec<Tri> = vec![];
    for b in boxes.chunks_exact(6) {
        let corner = |k: usize| {
            [
                if k & 1 == 0 { b[0] } else { b[3] },
                if k & 2 == 0 { b[1] } else { b[4] },
                if k & 4 == 0 { b[2] } else { b[5] },
            ]
        };
        let cl: Vec<[f32; 4]> = (0..8).map(|k| xform(&view.cols, corner(k))).collect();
        let (mut all, mut near) = (0xffu8, false);
        for v in &cl {
            let mut o = 0u8;
            if v[3] - view.near < 0.0 {
                o |= 1;
                near = true;
            }
            if v[0] < -v[3] {
                o |= 2;
            }
            if v[0] > v[3] {
                o |= 4;
            }
            if v[1] < -v[3] {
                o |= 8;
            }
            if v[1] > v[3] {
                o |= 16;
            }
            if v[3] > view.far {
                o |= 32;
            }
            all &= o;
        }
        if all != 0 {
            out.push(None);
            continue;
        }
        if near {
            out.push(Some(u32::MAX));
            continue;
        }
        bt.clear();
        let cen = [
            (b[0] + b[3]) * 0.5,
            (b[1] + b[4]) * 0.5,
            (b[2] + b[5]) * 0.5,
        ];
        for f in [
            [0, 2, 6, 4],
            [1, 3, 7, 5],
            [0, 1, 5, 4],
            [2, 3, 7, 6],
            [0, 1, 3, 2],
            [4, 5, 7, 6],
        ] {
            let (p0, p1, p2) = (corner(f[0]), corner(f[1]), corner(f[2]));
            let n = vis_raster::geom::front_normal(p0, p1, p2);
            let q = if dot(n, sub(p0, cen)) < 0.0 {
                [f[0], f[3], f[2], f[1]]
            } else {
                f
            };
            clip_tri(
                view,
                OW,
                OH,
                [corner(q[0]), corner(q[1]), corner(q[2])],
                &mut bt,
            );
            clip_tri(
                view,
                OW,
                OH,
                [corner(q[0]), corner(q[2]), corner(q[3])],
                &mut bt,
            );
        }
        out.push(Some(bt.iter().map(|t| visible_px(buf, t)).sum()));
    }
    out
}

fn visible_px(buf: &DepthBuf, t: &Tri) -> u32 {
    let mut n = 0;
    for y in t.y0..=t.y1 {
        let py = y as f32 + 0.5;
        let r0 = t.e[0][1] * py + t.e[0][2];
        let r1 = t.e[1][1] * py + t.e[1][2];
        let r2 = t.e[2][1] * py + t.e[2][2];
        let rd = t.d[1] * py + t.d[2];
        for x in t.x0..=t.x1 {
            let px = x as f32 + 0.5;
            if t.e[0][0] * px + r0 >= 0.0
                && t.e[1][0] * px + r1 >= 0.0
                && t.e[2][0] * px + r2 >= 0.0
                && t.d[0] * px + rd > buf.fine[y as usize * OW + x as usize]
            {
                n += 1;
            }
        }
    }
    n
}

/// The width test the engine's selection step applies (ADR 0460 section 3): the occluder's projected minimum width, in
/// buffer pixels (a corner behind the near plane counts as wide).
pub fn projected_min_width(view: &View, w: usize, h: usize, mn: V3, mx: V3) -> f32 {
    let (mut x0, mut x1, mut y0, mut y1) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
    for k in 0..8 {
        let p = [
            if k & 1 == 0 { mn[0] } else { mx[0] },
            if k & 2 == 0 { mn[1] } else { mx[1] },
            if k & 4 == 0 { mn[2] } else { mx[2] },
        ];
        let c = xform(&view.cols, p);
        if c[3] < view.near {
            return f32::MAX;
        }
        let rw = 1.0 / c[3];
        let (sx, sy) = (
            (c[0] * rw * 0.5 + 0.5) * w as f32,
            (c[1] * rw * 0.5 + 0.5) * h as f32,
        );
        x0 = x0.min(sx);
        x1 = x1.max(sx);
        y0 = y0.min(sy);
        y1 = y1.max(sy);
    }
    (x1 - x0).min(y1 - y0)
}
