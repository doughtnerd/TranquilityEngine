//! Reads out/scenes.bin (an f32 stream written by build-scenes.mjs).
use std::collections::HashMap;

pub const N_TYPES: usize = 4; // orig, simp12, simp5, sloppy5

pub struct Standin {
    pub tris: Vec<[u32; 3]>,
    /// Sampled two-way Hausdorff error of the whole stand-in, world units.
    pub err: f32,
    /// Sampled forward (stand-in to original) error per triangle, world units.
    pub tri_err: Vec<f32>,
    /// Per triangle edge i (v[i] to v[i+1]): number of triangles sharing it (including this one) and up to two others.
    pub edge_cnt: Vec<[u8; 3]>,
    pub edge_adj: Vec<[[u32; 2]; 3]>,
}

pub struct Occluder {
    pub diag: f32,
    pub bmin: [f32; 3],
    pub bmax: [f32; 3],
    pub verts: Vec<[f32; 3]>,
    pub types: Vec<Standin>,
}

pub struct Frame {
    pub eye: [f32; 3],
    pub target: [f32; 3],
}

pub struct Scene {
    pub occluders: Vec<Occluder>,
    pub aabbs: Vec<f32>,
    pub paths: Vec<Vec<Frame>>,
}

struct Rd<'a> {
    w: &'a [f32],
    p: usize,
}
impl<'a> Rd<'a> {
    fn f(&mut self) -> f32 {
        let v = self.w[self.p];
        self.p += 1;
        v
    }
    fn u(&mut self) -> usize {
        self.f() as usize
    }
    fn v3(&mut self) -> [f32; 3] {
        [self.f(), self.f(), self.f()]
    }
}

pub fn adjacency(tris: &[[u32; 3]]) -> (Vec<[u8; 3]>, Vec<[[u32; 2]; 3]>) {
    let mut m: HashMap<(u32, u32), Vec<u32>> = HashMap::new();
    for (t, tr) in tris.iter().enumerate() {
        for e in 0..3 {
            let (a, b) = (tr[e], tr[(e + 1) % 3]);
            m.entry((a.min(b), a.max(b))).or_default().push(t as u32);
        }
    }
    let mut cnt = vec![[0u8; 3]; tris.len()];
    let mut adj = vec![[[u32::MAX; 2]; 3]; tris.len()];
    for (t, tr) in tris.iter().enumerate() {
        for e in 0..3 {
            let (a, b) = (tr[e], tr[(e + 1) % 3]);
            let l = &m[&(a.min(b), a.max(b))];
            cnt[t][e] = l.len().min(255) as u8;
            let mut k = 0;
            for &o in l {
                if o as usize != t && k < 2 {
                    adj[t][e][k] = o;
                    k += 1;
                }
            }
        }
    }
    (cnt, adj)
}

pub fn read(bytes: &[u8]) -> Vec<Scene> {
    let words: Vec<f32> = bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    let mut r = Rd { w: &words, p: 0 };
    let ns = r.u();
    let mut scenes = vec![];
    for _ in 0..ns {
        let (no, nb, np) = (r.u(), r.u(), r.u());
        let mut occluders = vec![];
        for _ in 0..no {
            let nv = r.u();
            let diag = r.f();
            let bmin = r.v3();
            let bmax = r.v3();
            let verts: Vec<[f32; 3]> = (0..nv).map(|_| r.v3()).collect();
            let mut types = vec![];
            for _ in 0..N_TYPES {
                let nt = r.u();
                let err = r.f();
                let tris: Vec<[u32; 3]> = (0..nt).map(|_| [r.f() as u32, r.f() as u32, r.f() as u32]).collect();
                let tri_err: Vec<f32> = (0..nt).map(|_| r.f()).collect();
                let (edge_cnt, edge_adj) = adjacency(&tris);
                types.push(Standin { tris, err, tri_err, edge_cnt, edge_adj });
            }
            occluders.push(Occluder { diag, bmin, bmax, verts, types });
        }
        let aabbs: Vec<f32> = (0..nb * 6).map(|_| r.f()).collect();
        let mut paths = vec![];
        for _ in 0..np {
            let nf = r.u();
            paths.push((0..nf).map(|_| Frame { eye: r.v3(), target: r.v3() }).collect());
        }
        scenes.push(Scene { occluders, aabbs, paths });
    }
    scenes
}
