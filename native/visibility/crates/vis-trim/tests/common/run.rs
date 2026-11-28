//! Running scenes through the core and against the reference.
use super::*;
use vis_raster::buffer::DepthBuf as Buf;
use vis_raster::{test_occludees, Config, Occluders, Occlusion, Stats};

/// An occluder as the engine would hold it after import: the stand-in's kept triangles in world space, their errors
/// (doubled, as ADR 0460 stores them) and their edge neighbours.
pub struct Prepared {
    pub tris: Vec<f32>,
    pub errors: Vec<f32>,
    pub neighbors: Vec<u32>,
    pub dropped: u32,
    pub total: usize,
}

/// Import: measure and trim the stand-in against the original. `trimmed` false keeps every triangle with error 0.
pub fn prepare(o: &Occluder, trimmed: bool) -> Prepared {
    let orig = vis_trim::Mesh {
        positions: &o.original.positions,
        indices: &o.original.indices,
    };
    let st = vis_trim::Mesh {
        positions: &o.standin.positions,
        indices: &o.standin.indices,
    };
    let total = o.standin.indices.len() / 3;
    let (indices, errors, neighbors, dropped) = if trimmed {
        let t = vis_trim::trim(&orig, &st, &vis_trim::Options::default()).unwrap();
        (
            t.indices,
            t.errors.iter().map(|e| e * 2.0).collect::<Vec<_>>(),
            t.neighbors,
            t.dropped,
        )
    } else {
        (
            o.standin.indices.clone(),
            vec![0.0; total],
            vis_trim::neighbors(&o.standin.positions, &o.standin.indices),
            0,
        )
    };
    let mut tris = vec![];
    for &i in &indices {
        let v = i as usize * 3;
        tris.extend_from_slice(&o.standin.positions[v..v + 3]);
    }
    Prepared {
        tris,
        errors,
        neighbors,
        dropped,
        total,
    }
}

/// What the engine's selection step hands the core for one view: the prepared occluders that pass the width test, with
/// their neighbour tables rebased onto the concatenated list.
pub fn select(view: &View, w: usize, h: usize, scene: &Scene, prepared: &[Prepared]) -> Prepared {
    let mut out = Prepared {
        tris: vec![],
        errors: vec![],
        neighbors: vec![],
        dropped: 0,
        total: 0,
    };
    for (o, p) in scene.occluders.iter().zip(prepared) {
        if projected_min_width(view, w, h, o.bmin, o.bmax) < 2.0 {
            continue;
        }
        let base = out.errors.len() as u32;
        out.tris.extend_from_slice(&p.tris);
        out.errors.extend_from_slice(&p.errors);
        out.neighbors.extend(p.neighbors.iter().map(|&n| {
            if n == vis_trim::NONE {
                n
            } else {
                n + base
            }
        }));
    }
    out
}

/// Counts over a set of views.
#[derive(Default, Clone, Copy, Debug)]
pub struct Tally {
    pub in_frustum: u32,
    pub oracle_hidden: u32,
    /// Hidden by the core and by the oracle.
    pub agreed: u32,
    /// Hidden by the core while the oracle sees at least one pixel.
    pub false_any: u32,
    /// ...and at least 16 pixels.
    pub false_ge16: u32,
}

impl Tally {
    pub fn add(&mut self, o: Tally) {
        self.in_frustum += o.in_frustum;
        self.oracle_hidden += o.oracle_hidden;
        self.agreed += o.agreed;
        self.false_any += o.false_any;
        self.false_ge16 += o.false_ge16;
    }
    /// The share of the oracle's culls the core also made.
    pub fn kept(&self) -> f64 {
        self.agreed as f64 / self.oracle_hidden.max(1) as f64
    }
}

pub fn compare(reference: &[Option<u32>], hidden: &[u8]) -> Tally {
    let mut t = Tally::default();
    for (r, &h) in reference.iter().zip(hidden) {
        let Some(px) = *r else { continue };
        t.in_frustum += 1;
        t.oracle_hidden += (px == 0) as u32;
        if h == 1 {
            if px == 0 {
                t.agreed += 1;
            } else {
                t.false_any += 1;
                t.false_ge16 += (px >= 16) as u32;
            }
        }
    }
    t
}

/// Runs every frame of every path of `scene` at `w` x `h` under the decided rules and tallies against the reference.
pub fn run_scene(
    scene: &Scene,
    prepared: &[Prepared],
    w: usize,
    h: usize,
    oracle_buf: &mut Buf,
) -> Tally {
    let mut occ = Occlusion::new(w, h, Config::default());
    let originals: Vec<&MeshData> = scene.occluders.iter().map(|o| &o.original).collect();
    let mut total = Tally::default();
    for (pname, frames) in &scene.paths {
        for (fi, &(eye, target)) in frames.iter().enumerate() {
            let view = look_at(eye, target);
            let reference = oracle(&view, &originals, &scene.boxes, oracle_buf);
            let sel = select(&view, w, h, scene, prepared);
            let mut hidden = vec![0u8; scene.boxes.len() / 6];
            let o = Occluders {
                triangles: &sel.tris,
                errors: &sel.errors,
                neighbors: &sel.neighbors,
            };
            occ.occlude(&view, &o, &scene.boxes, &mut hidden).unwrap();
            let t = compare(&reference, &hidden);
            if t.false_any > 0 && std::env::var("VIS_DEBUG").is_ok() {
                for (i, (r, h)) in reference.iter().zip(&hidden).enumerate() {
                    if *h == 1 && matches!(r, Some(px) if *px > 0) {
                        eprintln!("false: {} {pname} frame {fi} box {i} px {:?} eye {eye:?} target {target:?} box {:?}", scene.name, r, &scene.boxes[i * 6..i * 6 + 6]);
                    }
                }
            }
            total.add(t);
        }
    }
    total
}

/// The same views with every rule off: exact stand-in triangles (no push, no shrink, no near rule), the dilated test only.
/// What the rules are for.
pub fn run_scene_unsafe(
    scene: &Scene,
    prepared: &[Prepared],
    w: usize,
    h: usize,
    oracle_buf: &mut Buf,
) -> Tally {
    let originals: Vec<&MeshData> = scene.occluders.iter().map(|o| &o.original).collect();
    let mut buf = Buf::new(w, h);
    let mut total = Tally::default();
    let mut tris: Vec<Tri> = vec![];
    for (_, frames) in &scene.paths {
        for &(eye, target) in frames {
            let view = look_at(eye, target);
            let reference = oracle(&view, &originals, &scene.boxes, oracle_buf);
            buf.clear();
            let sel = select(&view, w, h, scene, prepared);
            for t in sel.tris.chunks_exact(9) {
                let (a, b, c) = ([t[0], t[1], t[2]], [t[3], t[4], t[5]], [t[6], t[7], t[8]]);
                if !faces(view.eye, a, b, c) {
                    continue;
                }
                tris.clear();
                clip_tri(&view, w, h, [a, b, c], &mut tris);
                for tr in &tris {
                    raster_simd(&mut buf, tr);
                }
            }
            buf.build_mip(true);
            let mut hidden = vec![0u8; scene.boxes.len() / 6];
            test_occludees(
                &view,
                &buf,
                &scene.boxes,
                &mut hidden,
                true,
                &mut Stats::default(),
            );
            total.add(compare(&reference, &hidden));
        }
    }
    total
}
