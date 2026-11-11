//! The measured cases. Each is a `Case`: one `step()` is one 128-frame quantum of the audio
//! thread's work for that scene (or, for `prep_atonce`, one whole IR preparation).

use crate::conv::{plan_stagger, Prep, Scratch, Sched, Zone, M1_SCHED};
use crate::util::*;
use audio_dsp::biquad::Biquad;
use audio_dsp::convolver as m1;

pub const Q: usize = 128;

pub trait Case {
    /// Untimed work before a `step` (allocation, loading an IR): not part of the audio thread.
    fn prepare(&mut self) {}
    /// One timed unit; returns a value that depends on the output (so nothing is optimised away).
    fn step(&mut self) -> f32;
    /// Bytes of partition and history buffers per zone (0 where not meaningful).
    fn mem_bytes(&self) -> usize {
        0
    }
    /// Timed samples for a run asked to cover `quanta` quanta.
    fn samples(&self, quanta: usize) -> usize {
        quanta
    }
    /// Deterministic extra facts (printed in the table's notes column).
    fn note(&self) -> String {
        String::new()
    }
}

#[derive(Clone, Debug)]
pub enum Kind {
    Single { secs: u32, shape: Shape },
    M1Real,
    Zones { n: usize, secs: u32, staggered: bool },
    Blend { secs: u32, staggered: bool },
    PrepAtOnce { secs: u32 },
    PrepSpread { secs: u32, units: usize },
    Event { n: usize, mode: EventMode },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EventMode {
    /// Voices summed straight into the bus (what M1 does): the baseline.
    RouteOnly,
    /// Voices summed into an instance buffer, one low-pass biquad, added to the bus.
    Filter,
    /// Filter plus a send level into the reverb input.
    FilterSend,
    /// FilterSend with the cutoff changing every quantum (coefficients recomputed).
    FilterSendAuto,
}

#[derive(Clone, Debug)]
pub struct Spec {
    pub name: String,
    pub group: &'static str,
    /// Zones or instances in the scene (divisor for per-unit figures).
    pub units: usize,
    pub kind: Kind,
}

pub const VOICES_PER_INSTANCE: usize = 4;

pub fn specs() -> Vec<Spec> {
    let mut v = Vec::new();
    let mut add = |name: String, group, units, kind| v.push(Spec { name, group, units, kind });
    for secs in [1u32, 2, 4] {
        for (shape, tag) in [(Shape::Noise, "noise"), (Shape::Room, "room")] {
            add(format!("single_{secs}s_{tag}"), "single", 1, Kind::Single { secs, shape });
        }
    }
    add("m1_real_1.8s".into(), "single", 1, Kind::M1Real);
    for secs in [2u32, 4] {
        for n in [1usize, 2, 4, 8] {
            for staggered in [false, true] {
                let tag = if staggered { "staggered" } else { "unstaggered" };
                add(format!("zones_{n}x{secs}s_{tag}"), "zones", n, Kind::Zones { n, secs, staggered });
            }
        }
    }
    for secs in [2u32, 4] {
        for staggered in [false, true] {
            let tag = if staggered { "staggered" } else { "unstaggered" };
            add(format!("blend_2x{secs}s_{tag}"), "blend", 2, Kind::Blend { secs, staggered });
        }
    }
    for secs in [1u32, 2, 4] {
        add(format!("prep_atonce_{secs}s"), "switch", 1, Kind::PrepAtOnce { secs });
    }
    for secs in [1u32, 2, 4] {
        for units in [1usize, 2, 4] {
            add(format!("prep_spread_{secs}s_u{units}"), "switch", 1, Kind::PrepSpread { secs, units });
        }
    }
    for n in [16usize, 64, 256] {
        for (mode, tag) in [
            (EventMode::RouteOnly, "route_only"),
            (EventMode::Filter, "filter"),
            (EventMode::FilterSend, "filter_send"),
            (EventMode::FilterSendAuto, "filter_send_auto"),
        ] {
            add(format!("event_{n}_{tag}"), "event", n, Kind::Event { n, mode });
        }
    }
    v
}

pub fn make(spec: &Spec, run: u32) -> Box<dyn Case> {
    let r = run as u64 * 1000;
    match spec.kind.clone() {
        Kind::Single { secs, shape } => Box::new(ZonesCase::new(1, secs, false, false, r, Some(shape))),
        Kind::M1Real => Box::new(M1RealCase::new(r)),
        Kind::Zones { n, secs, staggered } => Box::new(ZonesCase::new(n, secs, staggered, false, r, None)),
        Kind::Blend { secs, staggered } => Box::new(ZonesCase::new(2, secs, staggered, true, r, None)),
        Kind::PrepAtOnce { secs } => Box::new(PrepAtOnce::new(secs, r)),
        Kind::PrepSpread { secs, units } => Box::new(PrepSpread::new(secs, units, r)),
        Kind::Event { n, mode } => Box::new(EventCase::new(n, mode, r)),
    }
}

/// A looping stereo source, read a quantum at a time from any position.
pub struct Source {
    l: Vec<f32>,
    r: Vec<f32>,
}
impl Source {
    pub fn new(seed: u64, frames: usize) -> Self {
        let [l, r] = make_input(seed, frames);
        Source { l, r }
    }
    pub fn block(&self, q: u64, offset: usize) -> (&[f32], &[f32]) {
        let n = self.l.len() / Q;
        let b = ((q as usize + offset) % n) * Q;
        (&self.l[b..b + Q], &self.r[b..b + Q])
    }
}

/// Crossfade gains at quantum `q` for the blend case: hold A, ramp A to B over `XF` quanta, hold
/// B, ramp back; equal-power. Returns (gain A, gain B) at the start of the quantum.
pub const XF: u64 = 375; // 1 s
pub const HOLD: u64 = 100;
pub fn blend_gains(q: u64) -> (f32, f32) {
    let period = 2 * (XF + HOLD);
    let p = q % period;
    let x = if p < HOLD {
        0.0
    } else if p < HOLD + XF {
        (p - HOLD) as f64 / XF as f64
    } else if p < 2 * HOLD + XF {
        1.0
    } else {
        1.0 - (p - 2 * HOLD - XF) as f64 / XF as f64
    };
    let a = x * std::f64::consts::FRAC_PI_2;
    (a.cos() as f32, a.sin() as f32)
}

// ----------------------------------------------------------------------------------------------

pub struct ZonesCase {
    zones: Vec<Zone>,
    sources: Vec<Source>,
    sc: Scratch,
    q: u64,
    blend: bool,
    in_l: [f32; Q],
    in_r: [f32; Q],
    out_l: [f32; Q],
    out_r: [f32; Q],
    scheds: Vec<Sched>,
    peak_tail_ffts: u32,
}

impl ZonesCase {
    pub fn new(n: usize, secs: u32, staggered: bool, blend: bool, seed: u64, shape: Option<Shape>) -> Self {
        let mut sc = Scratch::new();
        let frames = (SR as usize) * secs as usize;
        let parts: Vec<usize> = vec![audio_dsp::convolver::tail_partitions(frames); n];
        let scheds = if staggered { plan_stagger(&parts) } else { vec![M1_SCHED; n] };
        let mut zones = Vec::new();
        let mut sources = Vec::new();
        for z in 0..n {
            let shape = shape.unwrap_or(if z % 2 == 0 { Shape::Noise } else { Shape::Room });
            let ir = make_ir(shape, secs as f64, seed + z as u64 + 1);
            zones.push(Prep::new(ir, scheds[z]).finish(&mut sc));
            sources.push(Source::new(seed + 50 + z as u64, 1 << 17));
        }
        ZonesCase { zones, sources, sc, q: 0, blend, in_l: [0.0; Q], in_r: [0.0; Q], out_l: [0.0; Q], out_r: [0.0; Q], scheds, peak_tail_ffts: 0 }
    }
}

impl Case for ZonesCase {
    fn step(&mut self) -> f32 {
        self.out_l = [0.0; Q];
        self.out_r = [0.0; Q];
        let (ga, gb) = blend_gains(self.q);
        let (ga1, gb1) = blend_gains(self.q + 1);
        let mut ffts = 0;
        for z in 0..self.zones.len() {
            let (sl, sr) = self.sources[z].block(self.q, z * 977);
            if self.blend {
                // Send level ramps linearly across the quantum from this quantum's gain to the next.
                let (g0, g1) = if z == 0 { (ga, ga1) } else { (gb, gb1) };
                let d = (g1 - g0) / Q as f32;
                for i in 0..Q {
                    let g = g0 + d * i as f32;
                    self.in_l[i] = sl[i] * g;
                    self.in_r[i] = sr[i] * g;
                }
            } else {
                self.in_l.copy_from_slice(sl);
                self.in_r.copy_from_slice(sr);
            }
            self.zones[z].process(&mut self.sc, &self.in_l, &self.in_r, &mut self.out_l, &mut self.out_r);
            ffts += self.zones[z].last_tail_ffts;
        }
        self.peak_tail_ffts = self.peak_tail_ffts.max(ffts);
        self.q += 1;
        self.out_l[17] + self.out_r[93]
    }
    fn mem_bytes(&self) -> usize {
        self.zones[0].bytes()
    }
    fn note(&self) -> String {
        let t = crate::conv::transforms_per_slot(&self.scheds);
        format!("tail FFTs in busiest quantum {}", t.iter().max().unwrap())
    }
}

// ----------------------------------------------------------------------------------------------

/// M1's `audio_dsp::convolver::{init, process}` unchanged, on its own 1.8 s generated response.
pub struct M1RealCase {
    region: Vec<u64>,
    src: Source,
    q: u64,
    out_l: [f32; Q],
    out_r: [f32; Q],
}
impl M1RealCase {
    pub fn new(seed: u64) -> Self {
        let mut region = vec![0u64; m1::region_bytes(SR).div_ceil(8)];
        let bytes = unsafe { core::slice::from_raw_parts_mut(region.as_mut_ptr() as *mut u8, region.len() * 8) };
        m1::init(bytes, SR);
        M1RealCase { region, src: Source::new(seed + 50, 1 << 17), q: 0, out_l: [0.0; Q], out_r: [0.0; Q] }
    }
}
impl Case for M1RealCase {
    fn step(&mut self) -> f32 {
        self.out_l = [0.0; Q];
        self.out_r = [0.0; Q];
        let (l, r) = self.src.block(self.q, 0);
        let bytes = unsafe { core::slice::from_raw_parts_mut(self.region.as_mut_ptr() as *mut u8, self.region.len() * 8) };
        m1::process(bytes, l, r, &mut self.out_l, &mut self.out_r);
        self.q += 1;
        self.out_l[17] + self.out_r[93]
    }
    fn mem_bytes(&self) -> usize {
        self.region.len() * 8
    }
}

// ----------------------------------------------------------------------------------------------

pub struct PrepAtOnce {
    sc: Scratch,
    irs: Vec<[Vec<f32>; 2]>,
    n: usize,
    prep: Option<Prep>,
}
impl PrepAtOnce {
    pub fn new(secs: u32, seed: u64) -> Self {
        let irs = (0..4).map(|i| make_ir(if i % 2 == 0 { Shape::Noise } else { Shape::Room }, secs as f64, seed + 700 + i)).collect();
        PrepAtOnce { sc: Scratch::new(), irs, n: 0, prep: None }
    }
}
impl Case for PrepAtOnce {
    fn prepare(&mut self) {
        let ir = self.irs[self.n % 4].clone();
        self.n += 1;
        self.prep = Some(Prep::new(ir, M1_SCHED));
    }
    fn step(&mut self) -> f32 {
        let mut p = self.prep.take().unwrap();
        p.tick(&mut self.sc, usize::MAX);
        let v = p.zone.kernel_bytes() as f32;
        self.prep = Some(p);
        v
    }
    fn mem_bytes(&self) -> usize {
        self.prep.as_ref().map_or(0, |p| p.zone.kernel_bytes())
    }
    fn samples(&self, quanta: usize) -> usize {
        (quanta / 20).max(100)
    }
}

/// The audio thread's quantum while a zone switch prepares the next IR `units` units at a time:
/// the playing zone's `process` plus `Prep::tick`.
pub struct PrepSpread {
    sc: Scratch,
    zone: Zone,
    src: Source,
    irs: Vec<[Vec<f32>; 2]>,
    prep: Option<Prep>,
    units: usize,
    n: usize,
    q: u64,
    out_l: [f32; Q],
    out_r: [f32; Q],
    total_units: usize,
}
impl PrepSpread {
    pub fn new(secs: u32, units: usize, seed: u64) -> Self {
        let mut sc = Scratch::new();
        let zone = Prep::new(make_ir(Shape::Noise, secs as f64, seed + 1), M1_SCHED).finish(&mut sc);
        let irs = (0..4).map(|i| make_ir(if i % 2 == 0 { Shape::Room } else { Shape::Noise }, secs as f64, seed + 800 + i)).collect();
        PrepSpread { sc, zone, src: Source::new(seed + 50, 1 << 17), irs, prep: None, units, n: 0, q: 0, out_l: [0.0; Q], out_r: [0.0; Q], total_units: 0 }
    }
}
impl Case for PrepSpread {
    fn prepare(&mut self) {
        if self.prep.as_ref().map_or(true, |p| p.done) {
            let p = Prep::new(self.irs[self.n % 4].clone(), M1_SCHED);
            self.total_units = p.total_units();
            self.n += 1;
            self.prep = Some(p);
        }
    }
    fn step(&mut self) -> f32 {
        self.out_l = [0.0; Q];
        self.out_r = [0.0; Q];
        let (l, r) = self.src.block(self.q, 0);
        self.zone.process(&mut self.sc, l, r, &mut self.out_l, &mut self.out_r);
        self.prep.as_mut().unwrap().tick(&mut self.sc, self.units);
        self.q += 1;
        self.out_l[17] + self.out_r[93]
    }
    fn mem_bytes(&self) -> usize {
        self.zone.bytes()
    }
    fn note(&self) -> String {
        format!("{} units, {} quanta to prepare", self.total_units, self.total_units.div_ceil(self.units))
    }
}

// ----------------------------------------------------------------------------------------------

/// Per-event (per-`group`) effects. `n` instances of `VOICES_PER_INSTANCE` voices each. A voice's
/// mixed stereo block (read from a 4 MB noise table at its own offset) is added to its
/// instance's buffer; the instance's filter and sends then run.
pub struct EventCase {
    n: usize,
    mode: EventMode,
    table_l: Vec<f32>,
    table_r: Vec<f32>,
    filters: Vec<Biquad>,
    sends: Vec<f32>,
    inst_l: [f32; Q],
    inst_r: [f32; Q],
    pub bus_l: [f32; Q],
    pub bus_r: [f32; Q],
    pub rev_l: [f32; Q],
    pub rev_r: [f32; Q],
    q: u64,
}
impl EventCase {
    pub fn new(n: usize, mode: EventMode, seed: u64) -> Self {
        let mut rng = Rng::new(seed + 3);
        let len = 1 << 20;
        let table_l = (0..len).map(|_| 0.1 * rng.signed()).collect();
        let table_r = (0..len).map(|_| 0.1 * rng.signed()).collect();
        let mut filters = vec![Biquad::default(); n];
        for (i, f) in filters.iter_mut().enumerate() {
            f.set_lowpass(SR, Self::cutoff(i, 0), 1.0);
        }
        let sends = (0..n).map(|i| 0.05 + 0.4 * ((i * 37 % 101) as f32 / 101.0)).collect();
        EventCase { n, mode, table_l, table_r, filters, sends, inst_l: [0.0; Q], inst_r: [0.0; Q], bus_l: [0.0; Q], bus_r: [0.0; Q], rev_l: [0.0; Q], rev_r: [0.0; Q], q: 0 }
    }
    fn cutoff(i: usize, q: u64) -> f32 {
        let ph = (q as f64 * 0.013 + i as f64 * 0.7).sin();
        (1_500.0 + 1_300.0 * ph + 20.0 * (i % 7) as f64) as f32
    }
    pub fn voice_block(&self, inst: usize, v: usize) -> (&[f32], &[f32]) {
        let len = self.table_l.len() - Q;
        let off = ((inst * VOICES_PER_INSTANCE + v) * 4099 + self.q as usize * Q) % len;
        (&self.table_l[off..off + Q], &self.table_r[off..off + Q])
    }
    pub fn quantum(&mut self) {
        self.bus_l = [0.0; Q];
        self.bus_r = [0.0; Q];
        self.rev_l = [0.0; Q];
        self.rev_r = [0.0; Q];
        for i in 0..self.n {
            if self.mode == EventMode::RouteOnly {
                for v in 0..VOICES_PER_INSTANCE {
                    let len = self.table_l.len() - Q;
                    let off = ((i * VOICES_PER_INSTANCE + v) * 4099 + self.q as usize * Q) % len;
                    for k in 0..Q {
                        self.bus_l[k] += self.table_l[off + k];
                        self.bus_r[k] += self.table_r[off + k];
                    }
                }
                continue;
            }
            self.inst_l = [0.0; Q];
            self.inst_r = [0.0; Q];
            for v in 0..VOICES_PER_INSTANCE {
                let len = self.table_l.len() - Q;
                let off = ((i * VOICES_PER_INSTANCE + v) * 4099 + self.q as usize * Q) % len;
                for k in 0..Q {
                    self.inst_l[k] += self.table_l[off + k];
                    self.inst_r[k] += self.table_r[off + k];
                }
            }
            if self.mode == EventMode::FilterSendAuto {
                self.filters[i].set_lowpass(SR, Self::cutoff(i, self.q), 1.0);
            }
            self.filters[i].process(&mut self.inst_l, &mut self.inst_r);
            for k in 0..Q {
                self.bus_l[k] += self.inst_l[k];
                self.bus_r[k] += self.inst_r[k];
            }
            if self.mode != EventMode::Filter {
                let s = self.sends[i];
                for k in 0..Q {
                    self.rev_l[k] += s * self.inst_l[k];
                    self.rev_r[k] += s * self.inst_r[k];
                }
            }
        }
        self.q += 1;
    }
    pub fn send(&self, i: usize) -> f32 {
        self.sends[i]
    }
    pub fn coefficients(&self, i: usize) -> [f64; 5] {
        self.filters[i].coefficients
    }
}
impl Case for EventCase {
    fn step(&mut self) -> f32 {
        self.quantum();
        self.bus_l[17] + self.rev_r[93]
    }
}
