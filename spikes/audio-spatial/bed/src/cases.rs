//! The measured cases. Each is one core-thread quantum: `quantum()` renders 128 frames into its
//! stereo output and returns a checksum (so nothing is optimised away).
use audio_dsp::hrtf::angles::azimuth_elevation;
use audio_dsp::hrtf::database::HrirDatabase;
use audio_dsp::hrtf::{HrtfPannerN, HrtfScratch};
use audio_dsp::ramp::Ramp;
use audio_dsp::resample::{lagrange, Samples, Source};

use crate::content::{music, Rng};
use crate::decoder::{build_filters, Decoder, Filters, Kind};
use crate::encoder::*;
use crate::sh::*;

pub struct Shared {
    pub db: HrirDatabase<'static>,
    pub speakers: Filters,
    pub sh_quad: Filters,
    pub sh_ls: Filters,
    pub sh_mag: Filters,
}

/// Which SH filter set the bed cases decode with.
pub const DEFAULT_SH: Kind = Kind::ShMagLs;

impl Shared {
    pub fn new(asset: &[u8]) -> Shared {
        let bytes: &'static [u8] = Box::leak(crate::hrir::build_table(asset, crate::hrir::RATE).into_boxed_slice());
        let db = HrirDatabase::parse(bytes).unwrap();
        Shared { speakers: build_filters(&db, Kind::Speakers), sh_quad: build_filters(&db, Kind::ShQuad), sh_ls: build_filters(&db, Kind::ShLs), sh_mag: build_filters(&db, Kind::ShMagLs), db }
    }
    pub fn filters(&self, k: Kind) -> Filters {
        match k {
            Kind::Speakers => self.speakers.clone(),
            Kind::ShQuad => self.sh_quad.clone(),
            Kind::ShLs => self.sh_ls.clone(),
            Kind::ShMagLs => self.sh_mag.clone(),
        }
    }
}

pub trait Case {
    fn quantum(&mut self) -> f32;
    fn reset(&mut self);
    fn out(&self) -> (&[f32; Q], &[f32; Q]);
}

pub const NAMES: &[&str] = &[
    "bed64", "bed256", "bed1024", "bed256_spk", "decode_sh", "decode_spk",
    "clip_foa_rot", "clip_foa_dec", "clip_o3_rot", "clip_o3_dec",
    "dop256_const", "dop256_pitch", "dop256_full",
    "hrtf16", "bed16", "xfade16",
];

pub fn make(name: &str, sh: &Shared) -> Option<Box<dyn Case>> {
    let dec = |k| Decoder::new(sh.filters(k));
    Some(match name {
        "bed64" => Box::new(BedCase::new(64, dec(DEFAULT_SH))),
        "bed256" => Box::new(BedCase::new(256, dec(DEFAULT_SH))),
        "bed1024" => Box::new(BedCase::new(1024, dec(DEFAULT_SH))),
        "bed256_spk" => Box::new(BedCase::new(256, dec(Kind::Speakers))),
        "decode_sh" => Box::new(DecodeCase::new(dec(DEFAULT_SH))),
        "decode_spk" => Box::new(DecodeCase::new(dec(Kind::Speakers))),
        "clip_foa_rot" => Box::new(ClipCase::new(4, false, dec(DEFAULT_SH))),
        "clip_foa_dec" => Box::new(ClipCase::new(4, true, dec(DEFAULT_SH))),
        "clip_o3_rot" => Box::new(ClipCase::new(16, false, dec(DEFAULT_SH))),
        "clip_o3_dec" => Box::new(ClipCase::new(16, true, dec(DEFAULT_SH))),
        "dop256_const" => Box::new(DopplerCase::new(256, DopMode::Const)),
        "dop256_pitch" => Box::new(DopplerCase::new(256, DopMode::Pitch)),
        "dop256_full" => Box::new(DopplerCase::new(256, DopMode::Full)),
        "hrtf16" => Box::new(XfadeCase::new(XMode::Hrtf, sh)),
        "bed16" => Box::new(XfadeCase::new(XMode::Bed, sh)),
        "xfade16" => Box::new(XfadeCase::new(XMode::Xfade, sh)),
        _ => return None,
    })
}

#[inline]
fn checksum(l: &[f32; Q], r: &[f32; Q]) -> f32 {
    l[0] + l[Q - 1] + r[1] + r[Q - 2]
}

// ---------------------------------------------------------------- bed
pub struct BedCase {
    pub voices: BedVoices,
    pub bed: Bed,
    pub dec: Decoder,
    l: [f32; Q],
    r: [f32; Q],
}
impl BedCase {
    pub fn new(n: usize, dec: Decoder) -> Self {
        BedCase { voices: BedVoices::new(n, 1000, true), bed: Bed::new(), dec, l: [0.0; Q], r: [0.0; Q] }
    }
}
impl Case for BedCase {
    fn quantum(&mut self) -> f32 {
        self.bed.clear();
        self.voices.encode_all(&mut self.bed);
        self.dec.process(&self.bed, 16, &mut self.l, &mut self.r);
        checksum(&self.l, &self.r)
    }
    fn reset(&mut self) {
        self.voices.reset();
        self.dec.reset();
    }
    fn out(&self) -> (&[f32; Q], &[f32; Q]) { (&self.l, &self.r) }
}

/// Decode alone: a 16-channel bed from distinct per-channel content.
pub struct DecodeCase {
    dec: Decoder,
    src: Vec<f32>,
    step: usize,
    bed: Bed,
    l: [f32; Q],
    r: [f32; Q],
}
impl DecodeCase {
    pub fn new(dec: Decoder) -> Self {
        let frames = 16384;
        let mut src = vec![0.0; 16 * frames];
        for c in 0..16 {
            music(7000 + c as u32, frames, 48000.0, &mut src[c * frames..(c + 1) * frames]);
        }
        DecodeCase { dec, src, step: 0, bed: Bed::new(), l: [0.0; Q], r: [0.0; Q] }
    }
}
impl Case for DecodeCase {
    fn quantum(&mut self) -> f32 {
        let off = (self.step * Q) % 16384;
        for c in 0..16 {
            self.bed.ch[c].copy_from_slice(&self.src[c * 16384 + off..c * 16384 + off + Q]);
        }
        self.step += 1;
        self.dec.process(&self.bed, 16, &mut self.l, &mut self.r);
        checksum(&self.l, &self.r)
    }
    fn reset(&mut self) { self.step = 0; self.dec.reset(); }
    fn out(&self) -> (&[f32; Q], &[f32; Q]) { (&self.l, &self.r) }
}

// ---------------------------------------------------------------- ambisonic clips
pub struct ClipCase {
    n_ch: usize,
    direct: bool,
    frames: usize,
    buf: Vec<f32>, // planar
    step: usize,
    rb: RotBuilder,
    prev: Rot,
    yaw: f64,
    rot_out: Vec<[f32; Q]>,
    bed: Bed,
    dec: Decoder,
    l: [f32; Q],
    r: [f32; Q],
}
impl ClipCase {
    pub fn new(n_ch: usize, direct: bool, dec: Decoder) -> Self {
        let frames = 48000 * 4; // 4 s, a multiple of 128
        let mut buf = vec![0.0; n_ch * frames];
        for c in 0..n_ch {
            music(9000 + c as u32, frames, 48000.0, &mut buf[c * frames..(c + 1) * frames]);
        }
        let mut s = ClipCase { n_ch, direct, frames, buf, step: 0, rb: RotBuilder::new(), prev: Rot::IDENTITY, yaw: 0.0, rot_out: vec![[0.0; Q]; 16], bed: Bed::new(), dec, l: [0.0; Q], r: [0.0; Q] };
        s.reset();
        s
    }
    /// Listener orientation at quantum `q`: yaw 90 deg/s, pitch and roll wobbling.
    fn orientation(q: usize) -> Mat3 {
        let t = q as f64 * 128.0 / 48000.0;
        let m = euler(t * 1.5708, 0.3 * (t * 0.7).sin(), 0.2 * (t * 1.1).cos());
        mat3_t(&m) // the field turns opposite to the head
    }
}
impl Case for ClipCase {
    fn quantum(&mut self) -> f32 {
        let off = (self.step * Q) % self.frames;
        let mut inp: [&[f32]; 16] = [&[]; 16];
        for c in 0..self.n_ch {
            inp[c] = &self.buf[c * self.frames + off..c * self.frames + off + Q];
        }
        let next = self.rb.build(&Self::orientation(self.step + 1));
        apply_rot_ramp(&inp[..self.n_ch], &mut self.rot_out, self.n_ch, &self.prev, &next);
        self.prev = next;
        self.step += 1;
        if self.direct {
            for c in 0..self.n_ch { self.bed.ch[c] = self.rot_out[c]; }
            self.dec.process(&self.bed, self.n_ch, &mut self.l, &mut self.r);
        } else {
            self.bed.clear();
            for c in 0..self.n_ch {
                for i in 0..Q { self.bed.ch[c][i] += self.rot_out[c][i]; }
            }
            self.l[0] = self.bed.ch[1][5];
            self.r[1] = self.bed.ch[self.n_ch - 1][9];
        }
        checksum(&self.l, &self.r)
    }
    fn reset(&mut self) {
        self.step = 0;
        self.yaw = 0.0;
        self.prev = self.rb.build(&Self::orientation(0));
        self.dec.reset();
    }
    fn out(&self) -> (&[f32; Q], &[f32; Q]) { (&self.l, &self.r) }
}

// ---------------------------------------------------------------- Doppler
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DopMode {
    /// Constant rate 1.0 through the same ramp fill and resampler.
    Const,
    /// The rate for each quantum is given (main computed it): ramp fill only.
    Pitch,
    /// The core derives it: position integration, distance, radial velocity, rate, ramp.
    Full,
}

pub const SPEED_OF_SOUND: f32 = 343.0;
pub const DOP_FRAMES: usize = 32768;

pub struct DopplerVoice {
    pub pos: f64,
    pub p: [f32; 3],
    pub v: [f32; 3],
    pub r_prev: f32,
    pub ramp: Ramp,
}

impl DopplerVoice {
    /// The in-core derivation: advance the source, return the rate for the quantum.
    #[inline]
    pub fn rate_from_motion(&mut self, dt: f32) -> f32 {
        for k in 0..3 { self.p[k] += self.v[k] * dt; }
        let r = (self.p[0] * self.p[0] + self.p[1] * self.p[1] + self.p[2] * self.p[2]).sqrt().max(1.0);
        let vr = (r - self.r_prev) / dt;
        self.r_prev = r;
        (SPEED_OF_SOUND / (SPEED_OF_SOUND + vr)).clamp(0.5, 2.0)
    }
}

pub struct DopplerCase {
    mode: DopMode,
    n: usize,
    clips: Vec<i16>,
    voices: Vec<DopplerVoice>,
    tab: Vec<f32>, // 64 rates per voice
    step: usize,
    gains: Vec<(f32, f32)>,
    l: [f32; Q],
    r: [f32; Q],
    seed: u32,
}
impl DopplerCase {
    pub fn new(n: usize, mode: DopMode) -> Self {
        let mut clips = vec![0i16; n * DOP_FRAMES];
        let mut tmp = vec![0.0f32; DOP_FRAMES];
        for v in 0..n {
            music(3000 + v as u32, DOP_FRAMES, 48000.0, &mut tmp);
            for (d, s) in clips[v * DOP_FRAMES..(v + 1) * DOP_FRAMES].iter_mut().zip(&tmp) {
                *d = (s * 32000.0) as i16;
            }
        }
        let mut s = DopplerCase { mode, n, clips, voices: vec![], tab: vec![1.0; n * 64], step: 0, gains: vec![], l: [0.0; Q], r: [0.0; Q], seed: 77 };
        s.reset();
        s
    }
}
impl Case for DopplerCase {
    fn quantum(&mut self) -> f32 {
        let dt = Q as f32 / 48000.0;
        let mut bus_l = [0.0f32; Q];
        let mut bus_r = [0.0f32; Q];
        let mut steps = [0.0f32; Q];
        let (mut ol, mut or) = ([0.0f32; Q], [0.0f32; Q]);
        for v in 0..self.n {
            let vo = &mut self.voices[v];
            let rate = match self.mode {
                DopMode::Const => 1.0,
                DopMode::Pitch => self.tab[v * 64 + (self.step & 63)],
                DopMode::Full => vo.rate_from_motion(dt),
            };
            if rate != vo.ramp.value || vo.ramp.remaining > 0 {
                vo.ramp.set_target(rate, Q as u32);
            }
            vo.ramp.fill(&mut steps);
            let src = Source { samples: Samples::I16(&self.clips[v * DOP_FRAMES..(v + 1) * DOP_FRAMES]), channels: 1, frames: DOP_FRAMES as u32 };
            lagrange(&src, &mut vo.pos, &steps, true, &mut ol, &mut or);
            let (gl, gr) = self.gains[v];
            for i in 0..Q {
                bus_l[i] += ol[i] * gl;
                bus_r[i] += or[i] * gr;
            }
        }
        self.step += 1;
        self.l = bus_l;
        self.r = bus_r;
        checksum(&self.l, &self.r)
    }
    fn reset(&mut self) {
        let mut r = Rng(self.seed);
        self.step = 0;
        self.voices.clear();
        self.gains.clear();
        for v in 0..self.n {
            let d = unit(&mut r);
            let dist = 50.0 + 100.0 * r.f();
            let sp = 10.0 + 20.0 * r.f();
            let dir = unit(&mut r);
            let p = [d[0] * dist, d[1] * dist, d[2] * dist];
            let vel = [dir[0] * sp, dir[1] * sp, dir[2] * sp];
            self.voices.push(DopplerVoice { pos: (r.next() % DOP_FRAMES as u32) as f64, p, v: vel, r_prev: dist, ramp: Ramp::at(1.0) });
            self.gains.push((0.05 * (0.5 + r.f()), 0.05 * (0.5 + r.f())));
            // a plausible rate track for Pitch mode: random walk 0.92..1.09
            let mut x = 1.0f32;
            for k in 0..64 {
                x = (x + r.sym() * 0.02).clamp(0.92, 1.09);
                self.tab[v * 64 + k] = x;
            }
        }
    }
    fn out(&self) -> (&[f32; Q], &[f32; Q]) { (&self.l, &self.r) }
}

// ---------------------------------------------------------------- kind 1 -> kind 2 crossfade
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum XMode {
    /// 16 voices on the per-voice HRTF only (kind 1).
    Hrtf,
    /// 16 voices on the bed only (kind 2: encode and decode).
    Bed,
    /// All 16 in their crossfade quantum: both paths, kind 1 ramping out, kind 2 ramping in.
    Xfade,
}

pub struct XfadeCase {
    mode: XMode,
    voices: BedVoices,
    panners: Vec<HrtfPannerN<2>>,
    db: HrirDatabase<'static>,
    scratch: HrtfScratch,
    bed: Bed,
    dec: Decoder,
    l: [f32; Q],
    r: [f32; Q],
}
impl XfadeCase {
    pub fn new(mode: XMode, sh: &Shared) -> Self {
        XfadeCase {
            mode,
            voices: BedVoices::new(16, 5000, true),
            panners: (0..16).map(|_| HrtfPannerN::<2>::new(48000.0).unwrap()).collect(),
            db: sh.db,
            scratch: HrtfScratch::new(),
            bed: Bed::new(),
            dec: Decoder::new(sh.filters(DEFAULT_SH)),
            l: [0.0; Q],
            r: [0.0; Q],
        }
    }
}
impl Case for XfadeCase {
    fn quantum(&mut self) -> f32 {
        let (mut ol, mut orr) = ([0.0f32; Q], [0.0f32; Q]);
        self.bed.clear();
        let off = (self.voices.step * Q) % self.voices.frames;
        let mut budget = 2u32; // the core's KERNEL_BUDGET per quantum
        for v in 0..16 {
            let (d, g1) = self.voices.advance(v);
            let g0 = self.voices.g_prev_of(v);
            let x: &[f32; Q] = self.voices.buf[v * self.voices.frames + off..][..Q].try_into().unwrap();
            let sh = sh16(d[0], d[1], d[2]);
            if self.mode != XMode::Bed {
                let (az, el) = azimuth_elevation(to_engine(d));
                let (mut dl, mut dr) = ([0.0f32; Q], [0.0f32; Q]);
                let p = &mut self.panners[v];
                if p.kernels_needed(az, el) <= budget {
                    p.pan(&self.db, &mut self.scratch, az, el, x, None, &mut dl, &mut dr);
                    budget = budget.saturating_sub(p.kernels_computed_last());
                } else {
                    p.pan_held(&self.db, &mut self.scratch, az, el, x, None, &mut dl, &mut dr);
                }
                if self.mode == XMode::Xfade {
                    for i in 0..Q {
                        let t = (i + 1) as f32 * (1.0 / Q as f32);
                        ol[i] += dl[i] * g1 * (1.0 - t);
                        orr[i] += dr[i] * g1 * (1.0 - t);
                    }
                } else {
                    for i in 0..Q {
                        ol[i] += dl[i] * g1;
                        orr[i] += dr[i] * g1;
                    }
                }
            }
            if self.mode != XMode::Hrtf {
                let mut c0 = [0.0f32; 16];
                let mut c1 = [0.0f32; 16];
                let start = if self.mode == XMode::Xfade { 0.0 } else { g0 };
                let prev = self.voices.sh_prev_of(v);
                for c in 0..16 {
                    c0[c] = prev[c] * start;
                    c1[c] = sh[c] * g1;
                }
                encode(&mut self.bed, x, &c0, &c1);
            }
            self.voices.commit(v, sh, g1);
        }
        self.voices.step += 1;
        if self.mode != XMode::Hrtf {
            let (mut bl, mut br) = ([0.0f32; Q], [0.0f32; Q]);
            self.dec.process(&self.bed, 16, &mut bl, &mut br);
            for i in 0..Q {
                ol[i] += bl[i];
                orr[i] += br[i];
            }
        }
        self.l = ol;
        self.r = orr;
        checksum(&self.l, &self.r)
    }
    fn reset(&mut self) {
        self.voices.reset();
        self.dec.reset();
        for p in self.panners.iter_mut() { p.restart(); }
    }
    fn out(&self) -> (&[f32; Q], &[f32; Q]) { (&self.l, &self.r) }
}
