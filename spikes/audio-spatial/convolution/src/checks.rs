//! Correctness checks: every convolver variant against a direct (time-domain, f64) convolution of
//! the same input and IR; M1's own `process` against the owned-buffer copy; staggered against
//! unstaggered; the crossfade and the zone switch for discontinuities; the event effects against a
//! scalar reference.

use crate::cases::*;
use crate::conv::*;
use crate::util::*;
use audio_dsp::convolver as m1;

pub struct Report {
    pub lines: Vec<String>,
    pub fails: u32,
}
impl Report {
    fn new() -> Self {
        Report { lines: Vec::new(), fails: 0 }
    }
    fn check(&mut self, ok: bool, text: String) {
        if !ok {
            self.fails += 1;
        }
        self.lines.push(format!("{} {}", if ok { "PASS" } else { "FAIL" }, text));
    }
    fn info(&mut self, text: String) {
        self.lines.push(format!("     {text}"));
    }
}

/// Relative RMS error: sqrt(sum (a-b)^2 / sum b^2).
fn rel_rms(a: &[f64], b: &[f64]) -> f64 {
    let (mut e, mut s) = (0.0f64, 0.0f64);
    for (x, y) in a.iter().zip(b) {
        e += (x - y) * (x - y);
        s += y * y;
    }
    (e / s.max(1e-300)).sqrt()
}

fn dot(h: &[f64], x: &[f64]) -> f64 {
    let mut acc = [0.0f64; 4];
    let (hc, xc) = (h.chunks_exact(4), x.chunks_exact(4));
    let (hr, xr) = (hc.remainder(), xc.remainder());
    for (a, b) in hc.zip(xc) {
        for j in 0..4 {
            acc[j] += a[j] * b[j];
        }
    }
    let mut s = acc[0] + acc[1] + acc[2] + acc[3];
    for (a, b) in hr.iter().zip(xr) {
        s += a * b;
    }
    s
}

/// Direct convolution at the output indices `idx`: y[n] = sum_m (h[m] * scale) x[n - m], in f64,
/// with the IR scaled in f32 exactly as the convolver bakes the scale into its spectra.
pub fn direct(x: &[f32], h: &[f32], scale: f32, idx: &[usize]) -> Vec<f64> {
    let hd: Vec<f64> = h.iter().map(|v| (*v * scale) as f64).collect();
    let n = x.len();
    let xr: Vec<f64> = x.iter().rev().map(|v| *v as f64).collect(); // xr[j] = x[n-1-j]
    let one = |&i: &usize| -> f64 {
        let mmax = i.min(hd.len() - 1);
        // x[i-m] = xr[n-1-i+m]
        let base = n - 1 - i;
        dot(&hd[..=mmax], &xr[base..base + mmax + 1])
    };
    #[cfg(not(target_arch = "wasm32"))]
    {
        let threads = std::thread::available_parallelism().map_or(1, |n| n.get());
        let chunk = idx.len().div_ceil(threads).max(1);
        let mut out = vec![0.0f64; idx.len()];
        std::thread::scope(|s| {
            for (o, ix) in out.chunks_mut(chunk).zip(idx.chunks(chunk)) {
                let one = &one;
                s.spawn(move || {
                    for (d, i) in o.iter_mut().zip(ix) {
                        *d = one(i);
                    }
                });
            }
        });
        out
    }
    #[cfg(target_arch = "wasm32")]
    {
        idx.iter().map(one).collect()
    }
}

fn pad(x: &mut [Vec<f32>; 2]) {
    let n = x[0].len().div_ceil(Q) * Q;
    for c in x.iter_mut() {
        c.resize(n, 0.0);
    }
}

/// Runs one zone over `x` (a multiple of 128 frames) and returns its output.
fn render(zone: &mut Zone, sc: &mut Scratch, x: &[Vec<f32>; 2]) -> [Vec<f32>; 2] {
    let n = x[0].len();
    let mut out = [vec![0.0f32; n], vec![0.0f32; n]];
    for q in 0..n / Q {
        let r = q * Q..(q + 1) * Q;
        let (ol, or) = out.split_at_mut(1);
        zone.process(sc, &x[0][r.clone()], &x[1][r.clone()], &mut ol[0][r.clone()], &mut or[0][r]);
    }
    out
}

fn bits_equal(a: &[Vec<f32>; 2], b: &[Vec<f32>; 2]) -> bool {
    a[0].iter().zip(&b[0]).chain(a[1].iter().zip(&b[1])).all(|(p, q)| p.to_bits() == q.to_bits())
}

fn indices(n: usize, stride: usize) -> Vec<usize> {
    let mut v: Vec<usize> = (0..n).step_by(stride).collect();
    // Always include a dense early window (the head stage) and the last 2 quanta.
    v.extend(0..300.min(n));
    v.extend(n.saturating_sub(2 * Q)..n);
    v.sort();
    v.dedup();
    v
}

fn max_step(y: &[f64]) -> f64 {
    y.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f64::max)
}

pub fn m1_parity(r: &mut Report) {
    let mut region = vec![0u64; m1::region_bytes(SR).div_ceil(8)];
    let bytes = unsafe { core::slice::from_raw_parts_mut(region.as_mut_ptr() as *mut u8, region.len() * 8) };
    m1::init(bytes, SR);
    let frames = m1::ir::frames(SR);
    let (mut l, mut rr) = (vec![0.0f32; frames], vec![0.0f32; frames]);
    m1::ir::generate(SR, &mut l, &mut rr);
    let mut sc = Scratch::new();
    let mut zone = Prep::new([l, rr], M1_SCHED).finish(&mut sc);
    let mut x = make_input(11, 5 * 48_000);
    pad(&mut x);
    let mine = render(&mut zone, &mut sc, &x);
    let mut theirs = [vec![0.0f32; x[0].len()], vec![0.0f32; x[0].len()]];
    for q in 0..x[0].len() / Q {
        let s = q * Q..(q + 1) * Q;
        let (a, b) = theirs.split_at_mut(1);
        m1::process(bytes, &x[0][s.clone()], &x[1][s.clone()], &mut a[0][s.clone()], &mut b[0][s]);
    }
    r.check(bits_equal(&mine, &theirs), format!("owned-buffer zone == audio_dsp::convolver::process, bit-identical, M1's 1.8 s IR, {} quanta (5 s)", x[0].len() / Q));
    r.info(format!("memory: zone {} B + shared scratch {} B; M1 region_bytes = {} B", zone.bytes(), Scratch::bytes(), m1::region_bytes(SR)));
}

pub fn accuracy(r: &mut Report, stride: usize, secs_list: &[u32]) {
    let mut sc = Scratch::new();
    for &secs in secs_list {
        for (shape, tag) in [(Shape::Noise, "noise"), (Shape::Room, "room")] {
            let ir = make_ir(shape, secs as f64, 20 + secs as u64);
            let mut x = make_input(30 + secs as u64, (secs as usize + 1) * 48_000);
            pad(&mut x);
            let n = x[0].len();
            let idx = indices(n, stride);
            for (sched, stag) in [(M1_SCHED, "M1 schedule"), ([(5u32, 11u32), (7, 13)], "staggered (5,11),(7,13)")] {
                if secs == 4 && stag != "M1 schedule" {
                    continue; // direct convolution of 4 s is the slow one; staggering is covered at 1 and 2 s
                }
                let mut zone = Prep::new(ir.clone(), sched).finish(&mut sc);
                let y = render(&mut zone, &mut sc, &x);
                let mut worst = 0.0f64;
                let mut maxabs = 0.0f64;
                for c in 0..2 {
                    let want = direct(&x[c], &ir[c], zone.scale, &idx);
                    let got: Vec<f64> = idx.iter().map(|&i| y[c][i] as f64).collect();
                    worst = worst.max(rel_rms(&got, &want));
                    let peak = want.iter().fold(0.0f64, |a, b| a.max(b.abs()));
                    maxabs = maxabs.max(got.iter().zip(&want).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max) / peak);
                }
                r.check(
                    worst < 1e-4,
                    format!("{secs} s {tag} IR, {stag}: rel RMS {worst:.2e} (max abs / peak {maxabs:.2e}) vs direct f64; {} of {} output samples x 2 ch, {:.1} s of input", idx.len(), n, n as f64 / 48_000.0),
                );
            }
        }
    }
}

pub fn stagger(r: &mut Report) {
    let mut sc = Scratch::new();
    // N = 8 zones, 2 s, distinct IRs and inputs: unstaggered (M1) vs planned, bit for bit.
    let n = 8;
    let parts = vec![m1::tail_partitions(96_000); n];
    let plan = plan_stagger(&parts);
    let mut all_same = true;
    let (mut ffts_un, mut ffts_st) = (0u32, 0u32);
    let mut zs: Vec<(Zone, Zone, [Vec<f32>; 2])> = (0..n)
        .map(|z| {
            let ir = make_ir(if z % 2 == 0 { Shape::Noise } else { Shape::Room }, 2.0, 40 + z as u64);
            let a = Prep::new(ir.clone(), M1_SCHED).finish(&mut sc);
            let b = Prep::new(ir, plan[z]).finish(&mut sc);
            let mut x = make_input(60 + z as u64, 4 * 48_000);
            pad(&mut x);
            (a, b, x)
        })
        .collect();
    let nq = zs[0].2[0].len() / Q;
    for q in 0..nq {
        let (mut tu, mut ts) = (0, 0);
        for (a, b, x) in zs.iter_mut() {
            let s = q * Q..(q + 1) * Q;
            let (mut al, mut ar, mut bl, mut br) = ([0.0f32; Q], [0.0f32; Q], [0.0f32; Q], [0.0f32; Q]);
            a.process(&mut sc, &x[0][s.clone()], &x[1][s.clone()], &mut al, &mut ar);
            b.process(&mut sc, &x[0][s.clone()], &x[1][s.clone()], &mut bl, &mut br);
            all_same &= al.iter().zip(&bl).chain(ar.iter().zip(&br)).all(|(p, q)| p.to_bits() == q.to_bits());
            tu += a.last_tail_ffts;
            ts += b.last_tail_ffts;
        }
        ffts_un = ffts_un.max(tu);
        ffts_st = ffts_st.max(ts);
    }
    r.check(all_same, format!("8 zones x 2 s, staggered == unstaggered, bit-identical, {nq} quanta ({:.1} s)", nq as f64 * 128.0 / 48_000.0));
    r.info(format!("busiest quantum, measured tail FFTs (4,096-point, fwd+inv, both channels): unstaggered {ffts_un}, staggered {ffts_st}; floor for 8 zones is {}", (8 * 4usize).div_ceil(16)));
    for nz in [1usize, 2, 4, 8] {
        let p = plan_stagger(&vec![m1::tail_partitions(96_000); nz]);
        let t = transforms_per_slot(&p);
        let parts = vec![m1::tail_partitions(96_000); nz];
        let peak = |sc: &[Sched]| modelled_slot_load(sc, &parts).iter().cloned().fold(0.0, f64::max);
        let u = plan_unique(&parts);
        let tu = transforms_per_slot(&u);
        r.info(format!(
            "{nz} zone(s), 2 s: busiest quantum, tail FFTs / modelled FFT-equivalents: M1 schedule in all {} / {:.1}; load-balanced plan {} / {:.1}; transform-unique plan {} / {:.1}",
            transforms_per_slot(&vec![M1_SCHED; nz]).iter().max().unwrap(),
            peak(&vec![M1_SCHED; nz]),
            t.iter().max().unwrap(),
            peak(&p),
            tu.iter().max().unwrap(),
            peak(&u)
        ));
        r.info(format!("  load-balanced schedules {p:?}; unique {u:?}"));
    }
    // Extreme schedules reproduce M1's bits.
    let ir = make_ir(Shape::Room, 1.0, 77);
    let mut x = make_input(78, 3 * 48_000);
    pad(&mut x);
    let mut base = Prep::new(ir.clone(), M1_SCHED).finish(&mut sc);
    let yb = render(&mut base, &mut sc, &x);
    for sched in [[(0u32, 2u32), (13, 15)], [(13, 15), (0, 2)], [(7, 9), (2, 10)]] {
        let mut z = Prep::new(ir.clone(), sched).finish(&mut sc);
        let y = render(&mut z, &mut sc, &x);
        r.check(bits_equal(&y, &yb), format!("1 s IR, extreme schedule {sched:?} == M1 schedule, bit-identical"));
    }
}

type Gains<'a> = &'a dyn Fn(u64) -> (f32, f32);
type Hook<'a> = &'a mut dyn FnMut(u64, &mut Zone, &mut Scratch);

/// Two-zone mix driven by `gains(q) -> (gA, gB)` with a linear per-sample ramp across each quantum
/// to the next quantum's gain (the blend case's send levels). `hook` runs before each quantum
/// with zone B. Returns the mix and the gained inputs the zones saw.
fn mix_run(za: &mut Zone, zb: &mut Zone, sc: &mut Scratch, x: &[Vec<f32>; 2], gains: Gains, hook: Hook) -> ([Vec<f32>; 2], [[Vec<f32>; 2]; 2]) {
    let n = x[0].len();
    let mut out = [vec![0.0f32; n], vec![0.0f32; n]];
    let mut gi = [[vec![0.0f32; n], vec![0.0f32; n]], [vec![0.0f32; n], vec![0.0f32; n]]];
    for q in 0..n / Q {
        hook(q as u64, zb, sc);
        let (a0, b0) = gains(q as u64);
        let (a1, b1) = gains(q as u64 + 1);
        for (z, (g0, g1)) in [(0usize, (a0, a1)), (1, (b0, b1))] {
            let d = (g1 - g0) / Q as f32;
            for i in 0..Q {
                let g = g0 + d * i as f32;
                for c in 0..2 {
                    gi[z][c][q * Q + i] = x[c][q * Q + i] * g;
                }
            }
        }
        let s = q * Q..(q + 1) * Q;
        let (ol, or) = out.split_at_mut(1);
        let (mut al, mut ar, mut bl, mut br) = ([0.0f32; Q], [0.0f32; Q], [0.0f32; Q], [0.0f32; Q]);
        za.process(sc, &gi[0][0][s.clone()], &gi[0][1][s.clone()], &mut al, &mut ar);
        zb.process(sc, &gi[1][0][s.clone()], &gi[1][1][s.clone()], &mut bl, &mut br);
        for i in 0..Q {
            ol[0][q * Q + i] = al[i] + bl[i];
            or[0][q * Q + i] = ar[i] + br[i];
        }
    }
    (out, gi)
}

#[allow(clippy::too_many_arguments)]
fn mix_accuracy(r: &mut Report, label: &str, ir_a: &[Vec<f32>; 2], ir_b: &[Vec<f32>; 2], za: &Zone, zb: &Zone, y: &[Vec<f32>; 2], gi: &[[Vec<f32>; 2]; 2], stride: usize) {
    let n = y[0].len();
    let idx = indices(n, stride);
    let mut worst = 0.0f64;
    for c in 0..2 {
        let wa = direct(&gi[0][c], &ir_a[c], za.scale, &idx);
        let wb = direct(&gi[1][c], &ir_b[c], zb.scale, &idx);
        let want: Vec<f64> = wa.iter().zip(&wb).map(|(a, b)| a + b).collect();
        let got: Vec<f64> = idx.iter().map(|&i| y[c][i] as f64).collect();
        worst = worst.max(rel_rms(&got, &want));
    }
    r.check(worst < 1e-4, format!("{label}: rel RMS {worst:.2e} vs direct conv of the gained inputs (f64); {} of {n} samples x 2 ch", idx.len()));
}

fn tone_input(frames: usize) -> [Vec<f32>; 2] {
    let f = |hz: f64| -> Vec<f32> { (0..frames).map(|i| (0.5 * (2.0 * std::f64::consts::PI * hz * i as f64 / 48_000.0).sin()) as f32).collect() };
    [f(97.0), f(131.0)]
}

pub fn blend(r: &mut Report, stride: usize) {
    let mut sc = Scratch::new();
    let nq = (2 * (XF + HOLD) + 60) as usize;
    let ir_a = make_ir(Shape::Noise, 2.0, 91);
    let ir_b = make_ir(Shape::Room, 2.0, 92);
    let plan = plan_stagger(&[m1::tail_partitions(96_000); 2]);
    let mut za = Prep::new(ir_a.clone(), plan[0]).finish(&mut sc);
    let mut zb = Prep::new(ir_b.clone(), plan[1]).finish(&mut sc);
    let mut x = make_input(93, nq * Q);
    pad(&mut x);
    let (y, gi) = mix_run(&mut za, &mut zb, &mut sc, &x, &blend_gains, &mut |_, _, _| {});
    mix_accuracy(r, &format!("blend, staggered, 2 x 2 s, {nq} quanta ({:.1} s: one full A-B-A cycle)", nq as f64 * 128.0 / 48_000.0), &ir_a, &ir_b, &za, &zb, &y, &gi, stride);
    // Continuity with smooth (resonant) IRs and tone inputs.
    let ta = make_tone_ir(2.0, 220.0, 247.0, 0.5);
    let tb = make_tone_ir(2.0, 330.0, 370.0, 0.5);
    let tx = tone_input(nq * Q);
    let mut za = Prep::new(ta.clone(), plan[0]).finish(&mut sc);
    let mut zb = Prep::new(tb.clone(), plan[1]).finish(&mut sc);
    let (y, _) = mix_run(&mut za, &mut zb, &mut sc, &tx, &blend_gains, &mut |_, _, _| {});
    let mut za1 = Prep::new(ta, plan[0]).finish(&mut sc);
    let mut zb1 = Prep::new(tb, plan[1]).finish(&mut sc);
    let ya = render(&mut za1, &mut sc, &tx);
    let yb = render(&mut zb1, &mut sc, &tx);
    continuity(r, "blend", &y, &ya, &yb);
}

/// Max sample-to-sample step of the mix against the pure zones' own max step; plus a control (a
/// hard cut A to B at quantum boundaries, after the zones have rung up).
fn continuity(r: &mut Report, label: &str, y: &[Vec<f32>; 2], ya: &[Vec<f32>; 2], yb: &[Vec<f32>; 2]) {
    let (mut worst_ratio, mut mix_step, mut ref_step, mut cut_step) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    for c in 0..2 {
        let ymix: Vec<f64> = y[c].iter().map(|v| *v as f64).collect();
        let a: Vec<f64> = ya[c].iter().map(|v| *v as f64).collect();
        let b: Vec<f64> = yb[c].iter().map(|v| *v as f64).collect();
        let bound = max_step(&a).max(max_step(&b));
        let m = max_step(&ymix);
        worst_ratio = worst_ratio.max(m / bound);
        mix_step = mix_step.max(m);
        ref_step = ref_step.max(bound);
        let mut jump = 0.0;
        for t in 0..20 {
            let n0 = (40 + t * 17) * Q;
            jump += (b[n0] - a[n0 - 1]).abs();
        }
        cut_step = cut_step.max(jump / 20.0);
    }
    r.check(worst_ratio <= 1.5, format!("{label}: max sample step {mix_step:.4} = {worst_ratio:.2} x the pure zones' max step {ref_step:.4} (bound 1.5 x; smooth resonant IRs, tone inputs)"));
    r.check(cut_step > 2.0 * ref_step, format!("{label} control: a hard cut A to B steps {cut_step:.4} on average = {:.1} x the pure zones' max step, so the check can see a discontinuity", cut_step / ref_step));
}

pub fn switch(r: &mut Report, stride: usize) {
    let mut sc = Scratch::new();
    for units in [1usize, 4] {
        let secs = 2.0;
        let nq = 1500usize;
        let (ir_a, ir_b) = (make_ir(Shape::Noise, secs, 101), make_ir(Shape::Room, secs, 102));
        let total = Prep::new(ir_b.clone(), M1_SCHED).total_units();
        let ready_q = (total as u64).div_ceil(units as u64) - 1; // the quantum whose tick completes the prep
        let start = ready_q + 10;
        let g = move |q: u64| -> (f32, f32) {
            if q < start {
                (1.0, 0.0)
            } else if q < start + XF {
                let a = ((q - start) as f64 / XF as f64) * std::f64::consts::FRAC_PI_2;
                (a.cos() as f32, a.sin() as f32)
            } else {
                (0.0, 1.0)
            }
        };
        let mut za = Prep::new(ir_a.clone(), M1_SCHED).finish(&mut sc);
        let mut zb = Zone::alloc(ir_b[0].len(), M1_SCHED); // silent until the prep is done
        let mut prep = Some(Prep::new(ir_b.clone(), M1_SCHED));
        let mut finished_at = None;
        let mut x = make_input(103, nq * Q);
        pad(&mut x);
        let (y, gi) = mix_run(&mut za, &mut zb, &mut sc, &x, &g, &mut |q, zb, sc| {
            if let Some(p) = prep.as_mut() {
                if p.tick(sc, units) {
                    finished_at = Some(q);
                    *zb = prep.take().unwrap().zone;
                }
            }
        });
        r.check(finished_at == Some(ready_q), format!("switch (U={units}): prep of a 2 s IR took {total} units, finished at quantum {finished_at:?} ({:.0} ms of audio); zone B takes input from quantum {start}", (ready_q + 1) as f64 * 128.0 / 48.0));
        let atonce = Prep::new(ir_b.clone(), M1_SCHED).finish(&mut sc);
        r.check(zb.kernels_equal(&atonce), format!("switch (U={units}): spread-prepared spectra == at-once spectra, bit-identical"));
        mix_accuracy(r, &format!("switch (U={units}), spread prep then {XF}-quantum crossfade, {nq} quanta"), &ir_a, &ir_b, &za, &zb, &y, &gi, stride);
        let ta = make_tone_ir(secs, 220.0, 247.0, 0.5);
        let tb = make_tone_ir(secs, 330.0, 370.0, 0.5);
        let tx = tone_input(nq * Q);
        let mut za = Prep::new(ta.clone(), M1_SCHED).finish(&mut sc);
        let mut zb = Zone::alloc(tb[0].len(), M1_SCHED);
        let mut prep = Some(Prep::new(tb.clone(), M1_SCHED));
        let (y, _) = mix_run(&mut za, &mut zb, &mut sc, &tx, &g, &mut |_, zb, sc| {
            if let Some(p) = prep.as_mut() {
                if p.tick(sc, units) {
                    *zb = prep.take().unwrap().zone;
                }
            }
        });
        let mut za1 = Prep::new(ta, M1_SCHED).finish(&mut sc);
        let mut zb1 = Prep::new(tb, M1_SCHED).finish(&mut sc);
        let ya = render(&mut za1, &mut sc, &tx);
        let yb = render(&mut zb1, &mut sc, &tx);
        continuity(r, &format!("switch (U={units})"), &y, &ya, &yb);
    }
}

pub fn events(r: &mut Report) {
    let n = 16;
    let mut e = EventCase::new(n, EventMode::FilterSend, 5);
    let nq = 300;
    let mut st = vec![[[0.0f64; 4]; 2]; n]; // per instance, per channel: x1 x2 y1 y2
    let (mut got_bus, mut want_bus, mut got_rev, mut want_rev) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for _ in 0..nq {
        let mut refs = [[0.0f64; Q]; 4]; // bus l, r, rev l, r
        for i in 0..n {
            let co = e.coefficients(i);
            let s = e.send(i) as f64;
            let mut inst = [[0.0f32; Q]; 2];
            for v in 0..VOICES_PER_INSTANCE {
                let (l, rr) = e.voice_block(i, v);
                for k in 0..Q {
                    inst[0][k] += l[k];
                    inst[1][k] += rr[k];
                }
            }
            for c in 0..2 {
                let h = &mut st[i][c];
                for k in 0..Q {
                    let x = inst[c][k] as f64;
                    let y = co[0] * x + co[1] * h[0] + co[2] * h[1] - co[3] * h[2] - co[4] * h[3];
                    *h = [x, h[0], y, h[2]];
                    refs[c][k] += y;
                    refs[2 + c][k] += s * y;
                }
            }
        }
        e.quantum();
        for k in 0..Q {
            got_bus.extend([e.bus_l[k] as f64, e.bus_r[k] as f64]);
            got_rev.extend([e.rev_l[k] as f64, e.rev_r[k] as f64]);
            want_bus.extend([refs[0][k], refs[1][k]]);
            want_rev.extend([refs[2][k], refs[3][k]]);
        }
    }
    let (eb, er) = (rel_rms(&got_bus, &want_bus), rel_rms(&got_rev, &want_rev));
    r.check(eb < 1e-5 && er < 1e-5, format!("event effects, {n} instances x {VOICES_PER_INSTANCE} voices, {nq} quanta: bus rel RMS {eb:.2e}, reverb-send rel RMS {er:.2e} vs scalar f64 direct-form biquad (bound 1e-5)"));
}

pub fn run_all(stride: usize, secs_list: &[u32]) -> Report {
    let mut r = Report::new();
    m1_parity(&mut r);
    accuracy(&mut r, stride, secs_list);
    stagger(&mut r);
    blend(&mut r, stride);
    switch(&mut r, stride);
    events(&mut r);
    r.lines.push(format!("{} failure(s)", r.fails));
    r
}
