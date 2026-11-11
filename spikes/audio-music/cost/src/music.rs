//! S4: the music scenes (this spike's additions to the bench) and the microbenchmarks (`mode=micro`, `mode=check`).
//!
//! Scenes (`name=`):
//! - `mus-typ`, `mus-trans`, `mus-worst` and their twins `<name>-base`: the twin removes exactly the music voices (stems and
//!   stingers) from the scene, keeping the same virtual voices, buses and clip set, so `scene - twin` is what music adds.
//!   Music displaces nothing but ring slots here: the twin has `mixed - music` voices, the scene `mixed` (256). That is the
//!   honest shape of the high preset: stems take mixed slots and stream rings from the same 256/16 pools (README).
//! - `mus-worst-split`: `mus-worst` plus a stamped gain record at sample 64 of every quantum (every quantum split in two).
//! - `iso-*`: 16 (or 64) looping voices alone on one bus, for the stream-vs-decoded and 44.1 kHz comparisons (Q4).

use super::{platform, Scene, BATCH_EVERY, RATE};
use audio_dsp::ramp::Ramp;
use core::hint::black_box;

pub fn scene(name: &str) -> Option<Scene> {
    let high = |n: &str| Scene::preset(n, 8_192, 256, 32, 16);
    let worst_high = |n: &str| Scene::worst(n, Scene::preset(n, 8_192, 256, 32, 16), 8, 4, 2, 1, 256, 32, 3, 4);
    // (a) typical: 4 stereo stems at 44.1 kHz on the Music bus, one fading by automation.
    let typ = |n: &str| Scene { music_stems: 4, music_fades: 1, ..high(n) };
    // (b) transition: 2 segments x 6 stems (12 streams, all fading both ways) and 2 stingers.
    let trans = |n: &str| Scene { music_stems: 12, music_stingers: 2, music_fades: 14, music_ramp: true, ..high(n) };
    // (c) worst: 2 x 8 stems (all 16 rings) and 4 stingers, every voice fading, on M3's worst-high content.
    let worst = |n: &str| Scene { music_stems: 16, music_stingers: 4, music_fades: 20, music_ramp: true, ..worst_high(n) };
    let s = match name {
        "mus-typ" => typ(name),
        "mus-trans" => trans(name),
        "mus-worst" => worst(name),
        "mus-typ-nofade" => Scene { music_fades: 0, ..typ(name) },
        "mus-typ-fades4" => Scene { music_fades: 4, ..typ(name) },
        "mus-typ-ramp" => Scene { music_ramp: true, ..Scene { music_fades: 0, ..typ(name) } },
        "mus-trans-nofade" => Scene { music_fades: 0, music_ramp: false, ..trans(name) },
        "mus-worst-nofade" => Scene { music_fades: 0, music_ramp: false, ..worst(name) },
        "mus-worst-split" => Scene { splits: BATCH_EVERY as u32, ..worst(name) },
        "mus-typ-base" => twin(typ(name), name),
        "mus-trans-base" => twin(trans(name), name),
        "mus-worst-base" => twin(worst(name), name),
        "mus-typ-nofade-base" | "mus-typ-fades4-base" | "mus-typ-ramp-base" => twin(typ(name), name),
        "mus-trans-nofade-base" => twin(trans(name), name),
        "mus-worst-nofade-base" => twin(worst(name), name),
        "mus-worst-split-base" => twin(worst(name), name),
        // Q4 (isolated; one bus; non-spatial unless `-sp`): 16 voices, decoded or streamed, 48 or 44.1 kHz.
        "iso-empty" => Scene::looping(name, 0),
        "iso-clip48" => iso(name, 16, 0, RATE, false),
        "iso-clip441" => iso(name, 16, 0, 44_100.0, false),
        "iso-stream48" => iso(name, 16, 16, RATE, false),
        "iso-stream441" => iso(name, 16, 16, 44_100.0, false),
        "iso-clip441-sp" => iso(name, 16, 0, 44_100.0, true),
        "iso-clip48-sp" => iso(name, 16, 0, RATE, true),
        "iso-clip48-64" => iso(name, 64, 0, RATE, false),
        "iso-clip441-64" => iso(name, 64, 0, 44_100.0, false),
        _ => return None,
    };
    Some(s)
}

fn iso(name: &str, n: u32, streams: u32, rate: f32, spatial: bool) -> Scene {
    Scene { streams, src_rate: rate, spatial, ..Scene::looping(name, n) }
}

/// The scene without its music voices.
fn twin(m: Scene, name: &str) -> Scene {
    let music = m.music_stems + m.music_stingers;
    Scene {
        name: format!("{name}-base").replace("-base-base", "-base"),
        mixed: m.mixed - music,
        streams: m.streams - m.music_stems,
        ref_mixed: m.mixed,
        music_stems: 0,
        music_stingers: 0,
        music_fades: 0,
        music_ramp: false,
        splits: 0,
        ..m
    }
}

// --- Microbenchmarks ------------------------------------------------------------------------

/// Block length of every micro: one quantum.
const N: usize = 128;

struct Rng(u32);
impl Rng {
    fn unit(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (self.0 >> 8) as f32 / (1u32 << 24) as f32 - 0.5
    }
}

fn pct(sorted: &[f64], p: f64) -> f64 {
    sorted[(((sorted.len() - 1) as f64) * p).round() as usize]
}

/// Times `f` in blocks of `reps` calls, `blocks` times; prints ns per call (p50, p99, min over blocks).
fn time(target: &str, group: &str, name: &str, reps: usize, blocks: usize, per: f64, mut f: impl FnMut()) -> f64 {
    for _ in 0..reps.min(2_000) {
        f();
    }
    let mut v = Vec::with_capacity(blocks);
    for _ in 0..blocks {
        let t0 = platform::now_us();
        for _ in 0..reps {
            f();
        }
        v.push((platform::now_us() - t0) * 1000.0 / reps as f64 / per);
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    platform::print(&format!(
        "{{\"target\":\"{target}\",\"micro\":\"{group}\",\"case\":\"{name}\",\"unit\":\"ns per {}\",\"p50\":{:.1},\"p99\":{:.1},\"min\":{:.1}}}",
        if per == 1.0 { "call" } else { "call/item" },
        pct(&v, 0.5),
        pct(&v, 0.99),
        v[0]
    ));
    pct(&v, 0.5)
}

// ---- Q2: per-voice gain shapes ----

/// The core's own path (`voices.rs` `voice_chain`): `g = gain.next() * fade.next()`, applied to both channels.
fn core_path(gain: &mut Ramp, fade: &mut Ramp, l: &mut [f32], r: &mut [f32]) {
    for i in 0..l.len() {
        let g = gain.next() * fade.next();
        l[i] *= g;
        r[i] *= g;
    }
}

/// Fade shapes over t in (0, 1], t from a linear `Ramp`; `kind` 0 = linear (the core), 1 = sin (equal-power in), 2 = sqrt
/// (equal-power in, a cheap form), 3 = smoothstep (S-curve), 4 = table (1,025 points, linear interpolation, equal-power).
#[derive(Clone, Copy)]
enum Shape {
    Sin,
    Sqrt,
    Smooth,
    Lut,
}

fn shaped(shape: Shape, lut: &[f32], t: &mut Ramp, from: usize, l: &mut [f32], r: &mut [f32]) {
    for i in from..l.len() {
        let x = t.next();
        let g = match shape {
            Shape::Sin => libm::sinf(core::f32::consts::FRAC_PI_2 * x),
            Shape::Sqrt => libm::sqrtf(x),
            Shape::Smooth => x * x * (3.0 - 2.0 * x),
            Shape::Lut => {
                let p = x * 1024.0;
                let k = p as usize;
                let f = p - k as f32;
                lut[k] + (lut[k + 1.min(1024 - k)] - lut[k]) * f
            }
        };
        l[i] *= g;
        r[i] *= g;
    }
}

/// Block form: the gain curve into an array first (auto-vectorisable multiply after).
fn shaped_block(shape: Shape, lut: &[f32], t: &mut Ramp, from: usize, l: &mut [f32], r: &mut [f32]) {
    let mut g = [0.0f32; N];
    for i in from..l.len() {
        let x = t.next();
        g[i] = match shape {
            Shape::Sin => libm::sinf(core::f32::consts::FRAC_PI_2 * x),
            Shape::Sqrt => libm::sqrtf(x),
            Shape::Smooth => x * x * (3.0 - 2.0 * x),
            Shape::Lut => {
                let p = x * 1024.0;
                let k = p as usize;
                let f = p - k as f32;
                lut[k] + (lut[k + 1.min(1024 - k)] - lut[k]) * f
            }
        };
    }
    for i in from..l.len() {
        l[i] *= g[i];
        r[i] *= g[i];
    }
}

fn lut() -> Vec<f32> {
    (0..=1024).map(|i| libm::sinf(core::f32::consts::FRAC_PI_2 * i as f32 / 1024.0)).collect()
}

fn micro_ramp(target: &str, reps: usize, blocks: usize) {
    let mut rng = Rng(7);
    let src_l: Vec<f32> = (0..N).map(|_| rng.unit()).collect();
    let src_r: Vec<f32> = (0..N).map(|_| rng.unit()).collect();
    let (mut l, mut r) = (src_l.clone(), src_r.clone());
    let table = lut();
    let g = "gain_ramp";
    // Baseline: the core's path with both ramps settled (a voice with no fade running).
    let (mut gain, mut fade) = (Ramp::at(0.3), Ramp::at(1.0));
    let settled = time(target, g, "core_settled (g=gain.next()*fade.next())", reps, blocks, 1.0, || {
        l.copy_from_slice(&src_l);
        r.copy_from_slice(&src_r);
        core_path(&mut gain, &mut fade, &mut l, &mut r);
        black_box((&l, &r));
    });
    // The two copies are in every case: measure them alone and subtract.
    let copy = time(target, g, "copy_only (the two 128-frame copies)", reps, blocks, 1.0, || {
        l.copy_from_slice(&src_l);
        r.copy_from_slice(&src_r);
        black_box((&l, &r));
    });
    // Linear: a fade running the whole quantum (what SET_PARAMS/FADE do today), and from sample 37 (stamped record: two ranges).
    let lin_full = time(target, g, "linear_full (fade ramp running, 128 frames)", reps, blocks, 1.0, || {
        l.copy_from_slice(&src_l);
        r.copy_from_slice(&src_r);
        let (mut gain, mut fade) = (Ramp::at(0.3), Ramp::at(1.0));
        fade.set_target(0.0, 4_096);
        core_path(&mut gain, &mut fade, &mut l, &mut r);
        black_box((&l, &r));
    });
    let lin_off = time(target, g, "linear_from_sample_37 (two ranges: settled, then ramp)", reps, blocks, 1.0, || {
        l.copy_from_slice(&src_l);
        r.copy_from_slice(&src_r);
        let (mut gain, mut fade) = (Ramp::at(0.3), Ramp::at(1.0));
        let (a, b) = l.split_at_mut(37);
        let (c, d) = r.split_at_mut(37);
        core_path(&mut gain, &mut fade, a, c);
        fade.set_target(0.0, 4_096);
        core_path(&mut gain, &mut fade, b, d);
        black_box((&l, &r));
    });
    let mut results = Vec::new();
    for (name, shape) in [("sin (equal-power, libm sinf per sample)", Shape::Sin), ("sqrt (equal-power law g=sqrt(t))", Shape::Sqrt), ("smoothstep (S-curve, polynomial)", Shape::Smooth), ("lut1024 (equal-power table, lerp)", Shape::Lut)] {
        for (form, offset) in [("full", 0usize), ("from_37", 37)] {
            let c = format!("{name}, {form}, per-sample");
            let v = time(target, g, &c, reps, blocks, 1.0, || {
                l.copy_from_slice(&src_l);
                r.copy_from_slice(&src_r);
                let mut t = Ramp::at(0.0);
                t.set_target(1.0, 4_096);
                // Settled gain on the held part (the core would run it as a plain range), then the shaped part.
                for i in 0..offset {
                    l[i] *= 0.3;
                    r[i] *= 0.3;
                }
                shaped(shape, &table, &mut t, offset, &mut l, &mut r);
                black_box((&l, &r));
            });
            results.push((c, v));
        }
        let c = format!("{name}, full, block (curve array then multiply)");
        let v = time(target, g, &c, reps, blocks, 1.0, || {
            l.copy_from_slice(&src_l);
            r.copy_from_slice(&src_r);
            let mut t = Ramp::at(0.0);
            t.set_target(1.0, 4_096);
            shaped_block(shape, &table, &mut t, 0, &mut l, &mut r);
            black_box((&l, &r));
        });
        results.push((c, v));
    }
    platform::print(&format!(
        "{{\"target\":\"{target}\",\"summary\":\"gain_ramp (ns per voice per quantum, copies subtracted)\",\"core_settled\":{:.1},\"linear_full\":{:.1},\"linear_from_37\":{:.1},\"shapes\":[{}]}}",
        settled - copy,
        lin_full - copy,
        lin_off - copy,
        results.iter().map(|(c, v)| format!("[\"{c}\",{:.1}]", v - copy)).collect::<Vec<_>>().join(",")
    ));
}

/// Correctness: a ramp starting at sample k holds the old gain for 0..k, then moves linearly; sin/sqrt shapes are equal-power
/// complements; smoothstep is amplitude-complementary; the table is within 1e-6 of sin. Prints PASS or the failure.
fn check_ramp() -> bool {
    let mut ok = true;
    let mut gain = Ramp::at(0.5);
    let mut fade = Ramp::at(1.0);
    let mut l = [1.0f32; N];
    let mut r = [1.0f32; N];
    let k = 37;
    {
        let (a, b) = l.split_at_mut(k);
        let (c, d) = r.split_at_mut(k);
        core_path(&mut gain, &mut fade, a, c);
        fade.set_target(0.0, 80);
        core_path(&mut gain, &mut fade, b, d);
    }
    for i in 0..k {
        ok &= l[i] == 0.5;
    }
    for i in k..N {
        // Frame j (0-based) of an M-frame ramp: 1 - (j+1)/M, times the 0.5 gain; after M=80 frames it holds 0.
        let j = i - k;
        let want = 0.5 * (1.0 - ((j + 1) as f64 / 80.0).min(1.0));
        ok &= (l[i] as f64 - want).abs() < 1e-5;
    }
    ok &= l[k + 79] == 0.0 && l[N - 1] == 0.0;
    let table = lut();
    let mut worst_p = 0.0f64;
    let mut worst_lut = 0.0f64;
    let mut worst_s = 0.0f64;
    for i in 0..=4096 {
        let t = i as f32 / 4096.0;
        let (a, b) = (libm::sinf(core::f32::consts::FRAC_PI_2 * t), libm::sinf(core::f32::consts::FRAC_PI_2 * (1.0 - t)));
        worst_p = worst_p.max(((a * a + b * b) as f64 - 1.0).abs());
        let (a, b) = (libm::sqrtf(t), libm::sqrtf(1.0 - t));
        worst_p = worst_p.max(((a * a + b * b) as f64 - 1.0).abs());
        let sm = |x: f32| x * x * (3.0 - 2.0 * x);
        worst_s = worst_s.max((sm(t) + sm(1.0 - t) - 1.0).abs() as f64);
        let p = t * 1024.0;
        let kk = (p as usize).min(1023);
        let f = p - kk as f32;
        let v = table[kk] + (table[kk + 1] - table[kk]) * f;
        worst_lut = worst_lut.max((v - libm::sinf(core::f32::consts::FRAC_PI_2 * t)).abs() as f64);
    }
    ok &= worst_p < 1e-5 && worst_s < 1e-6 && worst_lut < 1e-6;
    platform::print(&format!("{{\"check\":\"gain_ramp\",\"pass\":{ok},\"equalPowerErr\":{worst_p:.2e},\"smoothstepComplementErr\":{worst_s:.2e},\"lutErr\":{worst_lut:.2e}}}"));
    ok
}

// ---- Q3: the music clock ----

/// A tempo-map entry: a segment of constant tempo and metre.
#[derive(Clone, Copy)]
struct Seg {
    /// Frame (from the piece's start) and beat where the segment starts.
    frame0: u64,
    beat0: f64,
    /// Beats per frame at this tempo (bpm / 60 / rate).
    bpf: f64,
    /// Beats per bar (numerator * 4 / denominator).
    bar_beats: f64,
}

/// One playing music instance's clock on the audio thread (a design sketch, not core code). The wanted boundary is armed as an
/// absolute frame (integer), computed from the tempo map when armed (once per boundary), so the per-quantum check is an integer
/// compare and the hit is sample-exact.
struct Clock {
    frame: u64,
    seg: usize,
    /// The next boundary: its beat (a multiple of `step`), and the absolute frame it falls on.
    next_beat: f64,
    next_frame: u64,
    /// Published position (what STATUS would carry): (frame, beat).
    out: [f64; 2],
}

fn tempo_map(n: usize) -> Vec<Seg> {
    let mut v: Vec<Seg> = Vec::new();
    let (mut frame0, mut beat0) = (0u64, 0.0f64);
    for i in 0..n {
        let bpm = [96.0, 120.0, 140.0, 105.0, 128.0, 90.0, 150.0, 110.0][i % 8];
        let bpf = bpm / 60.0 / RATE as f64;
        let bar_beats = [4.0, 3.0, 4.0, 3.0, 3.5][i % 5];
        v.push(Seg { frame0, beat0, bpf, bar_beats });
        let beats = 8.0 * bar_beats;
        frame0 += (beats / bpf).ceil() as u64;
        beat0 += beats;
    }
    v
}

/// The first frame at or after which `beat` has been reached, by the segment that contains it (`from` = a segment at or before it).
fn frame_of(map: &[Seg], mut from: usize, beat: f64) -> (u64, usize) {
    while from + 1 < map.len() && map[from + 1].beat0 <= beat {
        from += 1;
    }
    let s = &map[from];
    (s.frame0 + libm::ceil((beat - s.beat0) / s.bpf - 1e-9).max(0.0) as u64, from)
}

impl Clock {
    fn new(map: &[Seg], first_beat: f64) -> Clock {
        let (next_frame, _) = frame_of(map, 0, first_beat);
        Clock { frame: 0, seg: 0, next_beat: first_beat, next_frame, out: [0.0; 2] }
    }

    /// One quantum: finds the segment (the cached one, stepping on when the position crossed its end; or, with `search`, a binary
    /// search over the map every quantum), computes the beat at the quantum's end, checks whether the armed boundary falls inside
    /// the quantum (an integer compare) and returns its sample offset, re-arming for the next multiple of `step_beats`. Publishes
    /// (frame, beat).
    #[inline]
    fn quantum(&mut self, map: &[Seg], search: bool, step_beats: f64) -> Option<u32> {
        let end = self.frame + super::QUANTUM as u64;
        if search {
            self.seg = map.partition_point(|s| s.frame0 <= self.frame).saturating_sub(1);
        } else {
            while self.seg + 1 < map.len() && map[self.seg + 1].frame0 <= self.frame {
                self.seg += 1;
            }
        }
        let s = &map[self.seg];
        let beat_end = s.beat0 + (end - s.frame0) as f64 * s.bpf;
        let mut hit = None;
        if self.next_frame < end {
            hit = Some(self.next_frame.saturating_sub(self.frame) as u32);
            self.next_beat = (libm::floor(self.next_beat / step_beats + 1e-9) + 1.0) * step_beats;
            self.next_frame = frame_of(map, self.seg, self.next_beat).0;
        }
        self.out = [end as f64, beat_end];
        self.frame = end;
        if self.seg + 1 == map.len() && self.frame > s.frame0 + 4_000_000 {
            *self = Clock::new(map, step_beats);
        }
        hit
    }
}

fn micro_clock(target: &str, reps: usize, blocks: usize) {
    for (maps, search) in [(1usize, false), (8, false), (64, false), (8, true), (64, true)] {
        let map = tempo_map(maps);
        for inst in [1usize, 8] {
            let mut clocks: Vec<Clock> = (0..inst).map(|i| Clock::new(&map, if i % 2 == 0 { 0.0 } else { map[0].bar_beats })).collect();
            let name = format!("{inst} instance(s), {maps} tempo segment(s), {}", if search { "binary search every quantum" } else { "cached segment" });
            time(target, "music_clock", &name, reps, blocks, 1.0, || {
                let mut hits = 0u32;
                for c in clocks.iter_mut() {
                    if let Some(o) = c.quantum(black_box(&map), search, 1.0) {
                        hits += o;
                    }
                }
                black_box(hits);
            });
        }
    }
}

/// Correctness: with a constant tempo whose beat is a whole number of frames (120 bpm: 24,000 frames), every beat boundary is
/// reported at exactly beat * 24,000; at 130 bpm (22,153.85 frames/beat) at the ceil of the exact frame, and across a tempo
/// change the first boundary after it matches the exact frame position computed in f64 with the segment maths.
fn check_clock() -> bool {
    let mut ok = true;
    for (bpm, label) in [(120.0f64, "120"), (130.0, "130")] {
        let bpf = bpm / 60.0 / RATE as f64;
        let map = [Seg { frame0: 0, beat0: 0.0, bpf, bar_beats: 4.0 }];
        let mut c = Clock::new(&map, 0.0);
                let mut beat_no = 0u64;
        let mut worst = 0i64;
        for q in 0..20_000u64 {
            if let Some(off) = c.quantum(&map, false, 1.0) {
                let frame = q * 128 + off as u64;
                let exact = (beat_no as f64 / bpf).ceil() as u64;
                worst = worst.max((frame as i64 - exact as i64).abs());
                beat_no += 1;
            }
        }
        ok &= worst == 0 && beat_no > 100;
        platform::print(&format!("{{\"check\":\"clock_{label}bpm\",\"beats\":{beat_no},\"worstErrFrames\":{worst}}}"));
    }
    // A tempo change at beat 8 (frame 192,000 at 120 bpm), then 90 bpm.
    let (b1, b2) = (120.0 / 60.0 / RATE as f64, 90.0 / 60.0 / RATE as f64);
    let map = [Seg { frame0: 0, beat0: 0.0, bpf: b1, bar_beats: 4.0 }, Seg { frame0: 192_000, beat0: 8.0, bpf: b2, bar_beats: 3.0 }];
    let mut c = Clock::new(&map, 0.0);
        let mut worst = 0i64;
    let mut n = 0u64;
    for q in 0..8_000u64 {
        if let Some(off) = c.quantum(&map, false, 1.0) {
            let frame = q * 128 + off as u64;
            let b = n as f64;
            let exact = if b <= 8.0 { (b / b1).ceil() } else { 192_000.0 + ((b - 8.0) / b2).ceil() } as u64;
            worst = worst.max((frame as i64 - exact as i64).abs());
            n += 1;
        }
    }
    ok &= worst == 0;
    platform::print(&format!("{{\"check\":\"clock_tempo_change\",\"beats\":{n},\"worstErrFrames\":{worst},\"note\":\"boundaries are armed through the tempo map: exact across the change\"}}"));
    ok
}

/// `mode=micro [reps=20000] [blocks=50] [group=gain_ramp,music_clock]` and `mode=check`.
pub fn main(args: &str, mode: &str) {
    let num = |k: &str, d: f64| super::num(args, k, d);
    let reps = num("reps", 20_000.0) as usize;
    let blocks = num("blocks", 50.0) as usize;
    let group = super::arg(args, "group").unwrap_or("gain_ramp,music_clock");
    let target = super::TARGET;
    if mode == "check" {
        let ok = check_ramp() & check_clock();
        platform::print(&format!("{{\"check\":\"all\",\"pass\":{ok}}}"));
        return;
    }
    if group.split(',').any(|g| g == "gain_ramp") {
        micro_ramp(target, reps, blocks);
    }
    if group.split(',').any(|g| g == "music_clock") {
        micro_clock(target, reps, blocks);
    }
}
