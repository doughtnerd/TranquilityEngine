//! 3rd-order encode of mono voices into a shared bed (16 x 128, channel-major).
use crate::sh::*;

pub struct Bed {
    pub ch: [[f32; Q]; 16],
}
impl Bed {
    pub fn new() -> Self { Bed { ch: [[0.0; Q]; 16] } }
    #[inline]
    pub fn clear(&mut self) { self.ch = [[0.0; Q]; 16]; }
}

/// Adds `x` to the bed with a per-channel linear coefficient ramp from `c0` (just before frame 0)
/// to `c1` (frame 127), frame `i` getting `c0 + (c1 - c0)(i + 1)/128`, as `Ramp` does.
/// With a direction held across the quantum pass `c0 = g0 * sh_new`; with the direction
/// interpolated pass `c0 = g0 * sh_prev`. Either way it is one pass of two products per channel-frame.
#[inline]
pub fn encode(bed: &mut Bed, x: &[f32], c0: &[f32; 16], c1: &[f32; 16]) {
    let mut v = [0.0f32; Q];
    for i in 0..Q {
        v[i] = x[i] * ((i + 1) as f32 * (1.0 / Q as f32));
    }
    for c in 0..16 {
        let a = c0[c];
        let s = c1[c] - c0[c];
        let o = &mut bed.ch[c];
        for i in 0..Q {
            o[i] += x[i] * a + v[i] * s;
        }
    }
}

/// Voice kinematics and state for the bed cases: directions rotate at a per-voice rate about a
/// per-voice axis (so every voice's coefficients change every quantum), gains random-walk.
pub struct BedVoices {
    pub n: usize,
    pub buf: Vec<f32>,
    pub frames: usize,
    pub step: usize,
    dirs: Vec<[f32; 3]>,
    rot: Vec<[f32; 9]>,
    sh_prev: Vec<[f32; 16]>,
    g_prev: Vec<f32>,
    rng: Vec<u32>,
    pub interp: bool,
    seed: u32,
}

impl BedVoices {
    pub const FRAMES: usize = 8192;
    pub fn new(n: usize, seed: u32, interp: bool) -> Self {
        let frames = Self::FRAMES;
        let mut buf = vec![0.0f32; n * frames];
        for v in 0..n {
            crate::content::music(seed + v as u32, frames, 48000.0, &mut buf[v * frames..(v + 1) * frames]);
        }
        let mut s = BedVoices { n, buf, frames, step: 0, dirs: vec![], rot: vec![], sh_prev: vec![], g_prev: vec![], rng: vec![], interp, seed };
        s.reset();
        s
    }
    pub fn reset(&mut self) {
        self.step = 0;
        self.dirs.clear();
        self.rot.clear();
        self.sh_prev.clear();
        self.g_prev.clear();
        self.rng.clear();
        let mut r = crate::content::Rng(self.seed ^ 0x9e3779b9);
        for _ in 0..self.n {
            let d = unit(&mut r);
            let ax = unit(&mut r);
            let ang = (10.0 + 80.0 * r.f()).to_radians() * 128.0 / 48000.0; // 10..90 deg/s
            self.dirs.push(d);
            self.rot.push(axis_angle(ax, ang));
            self.sh_prev.push(sh16(d[0], d[1], d[2]));
            self.g_prev.push(0.3 + 0.7 * r.f());
            self.rng.push(r.next() | 1);
        }
    }
    /// Direction of voice `v` after the next step (also advances it).
    #[inline]
    pub fn advance(&mut self, v: usize) -> ([f32; 3], f32) {
        let m = &self.rot[v];
        let d = self.dirs[v];
        let mut n = [m[0] * d[0] + m[1] * d[1] + m[2] * d[2], m[3] * d[0] + m[4] * d[1] + m[5] * d[2], m[6] * d[0] + m[7] * d[1] + m[8] * d[2]];
        let inv = 1.0 / (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        n = [n[0] * inv, n[1] * inv, n[2] * inv];
        self.dirs[v] = n;
        let mut s = self.rng[v];
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        self.rng[v] = s;
        let g = (self.g_prev[v] + ((s >> 8) as f32 * (1.0 / 16777216.0) - 0.5) * 0.1).clamp(0.2, 1.0);
        (n, g)
    }
    pub fn g_prev_of(&self, v: usize) -> f32 { self.g_prev[v] }
    pub fn sh_prev_of(&self, v: usize) -> [f32; 16] { self.sh_prev[v] }
    pub fn commit(&mut self, v: usize, sh: [f32; 16], g: f32) {
        self.sh_prev[v] = sh;
        self.g_prev[v] = g;
    }
    pub fn input(&self, v: usize) -> &[f32] {
        let off = (self.step * Q) % self.frames;
        &self.buf[v * self.frames + off..v * self.frames + off + Q]
    }
    /// Encodes every voice into `bed` for this quantum, then steps the quantum counter.
    pub fn encode_all(&mut self, bed: &mut Bed) {
        for v in 0..self.n {
            let (d, g1) = self.advance(v);
            let sh = sh16(d[0], d[1], d[2]);
            let g0 = self.g_prev[v];
            let base = if self.interp { self.sh_prev[v] } else { sh };
            let mut c0 = [0.0f32; 16];
            let mut c1 = [0.0f32; 16];
            for c in 0..16 {
                c0[c] = base[c] * g0;
                c1[c] = sh[c] * g1;
            }
            let off = (self.step * Q) % self.frames;
            let x = &self.buf[v * self.frames + off..v * self.frames + off + Q];
            encode(bed, x, &c0, &c1);
            self.sh_prev[v] = sh;
            self.g_prev[v] = g1;
        }
        self.step += 1;
    }
}

pub fn unit(r: &mut crate::content::Rng) -> [f32; 3] {
    loop {
        let v = [r.sym(), r.sym(), r.sym()];
        let l = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
        if l > 0.01 && l <= 1.0 {
            let i = 1.0 / l.sqrt();
            return [v[0] * i, v[1] * i, v[2] * i];
        }
    }
}

pub fn axis_angle(a: [f32; 3], t: f32) -> [f32; 9] {
    let (c, s) = (t.cos(), t.sin());
    let k = 1.0 - c;
    [
        c + a[0] * a[0] * k, a[0] * a[1] * k - a[2] * s, a[0] * a[2] * k + a[1] * s,
        a[1] * a[0] * k + a[2] * s, c + a[1] * a[1] * k, a[1] * a[2] * k - a[0] * s,
        a[2] * a[0] * k - a[1] * s, a[2] * a[1] * k + a[0] * s, c + a[2] * a[2] * k,
    ]
}
