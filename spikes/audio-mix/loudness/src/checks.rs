//! Correctness: EBU Tech 3341/3342-style cases against the expected values, own vs the `ebur128` crate, main-side
//! histogram vs exact gating, the STATUS ring at the idle cadence, K-weighting coefficients vs the BS.1770-4 table.
use crate::loud::*;
use crate::signals::*;

pub struct Meas {
    pub m: f64,
    pub s: f64,
    pub i: f64,
    pub lra: f64,
    pub hist_i: f64,
    pub hist_lra: f64,
    pub tp_db: f64,
    pub lost: u64,
}

fn dbf(x: f64) -> f64 {
    if x > 0.0 { 20.0 * x.log10() } else { f64::NEG_INFINITY }
}

/// Own implementation, fed quantum by quantum; STATUS taken every `every` quanta.
pub fn own(rate: f64, sig: &Stereo, mode: TpMode, every: usize) -> Meas {
    let mut b = Loudness::new(rate, mode);
    let mut feed = Feed::default();
    let mut g = Gating::default();
    let mut tp = 0.0f32;
    let n = sig.0.len();
    let mut q = 0;
    let mut o = 0;
    while o < n {
        let e = (o + QUANTUM).min(n);
        b.process(&sig.0[o..e], &sig.1[o..e]);
        q += 1;
        o = e;
        if q % every == 0 || o == n {
            feed.take(b.seq, &b.ring, &mut g.subs);
            let p = b.take_peak();
            tp = tp.max(p[0]).max(p[1]);
        }
    }
    let (mut hi, mut hl) = (Hist::new(), Hist::new());
    for i in 3..g.subs.len() {
        hi.add(g.subs[i - 3..=i].iter().sum::<f64>() / 4.0);
    }
    for i in (29..g.subs.len()).step_by(10) {
        hl.add(g.subs[i - 29..=i].iter().sum::<f64>() / 30.0);
    }
    Meas { m: g.momentary(), s: g.shortterm(), i: g.integrated(), lra: g.lra(), hist_i: hi.integrated(), hist_lra: hl.lra(), tp_db: dbf(tp as f64), lost: feed.lost }
}

#[cfg(feature = "ebur")]
pub fn reference(rate: f64, sig: &Stereo) -> Meas {
    let mut r = crate::ebur::Ref::full(rate as u32);
    let n = sig.0.len();
    let mut o = 0;
    while o < n {
        let e = (o + QUANTUM).min(n);
        r.add(&sig.0[o..e], &sig.1[o..e]);
        o = e;
    }
    let tp = r.m.true_peak(0).unwrap().max(r.m.true_peak(1).unwrap());
    Meas {
        m: r.m.loudness_momentary().unwrap(),
        s: r.m.loudness_shortterm().unwrap(),
        i: r.m.loudness_global().unwrap(),
        lra: r.m.loudness_range().unwrap(),
        hist_i: f64::NAN,
        hist_lra: f64::NAN,
        tp_db: dbf(tp),
        lost: 0,
    }
}

struct Out {
    all: bool,
    json: bool,
}
impl Out {
    fn row(&mut self, name: &str, what: &str, expect: f64, tol: f64, own: f64, refv: f64) {
        let ok_own = (own - expect).abs() <= tol;
        let ok_ref = refv.is_nan() || (refv - expect).abs() <= tol;
        self.all &= ok_own && ok_ref;
        if self.json {
            crate::print(&format!(
                "{{\"check\":\"{name}\",\"what\":\"{what}\",\"expect\":{expect:.4},\"tol\":{tol},\"own\":{own:.4},\"ebur\":{},\"pass\":{}}}",
                if refv.is_nan() { "null".into() } else { format!("{refv:.4}") },
                ok_own && ok_ref
            ));
        }
    }
    fn pair(&mut self, name: &str, what: &str, tol: f64, a: f64, b: f64) {
        let ok = (a - b).abs() <= tol || (a.is_infinite() && a == b);
        self.all &= ok;
        if self.json {
            crate::print(&format!("{{\"check\":\"{name}\",\"what\":\"{what}\",\"a\":{a:.5},\"b\":{b:.5},\"tol\":{tol},\"pass\":{ok}}}"));
        }
    }
}

pub fn run(json: bool) -> bool {
    let mut o = Out { all: true, json };
    // K-weighting coefficients at 48 kHz vs the BS.1770-4 table.
    {
        let k = KCoef::new(48000.0);
        let want = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585, -1.99004745483398, 0.99007225036621];
        let got = [k.b[0][0], k.b[0][1], k.b[0][2], k.a[0][0], k.a[0][1], k.a[1][0], k.a[1][1]];
        for (i, (g, w)) in got.iter().zip(want).enumerate() {
            o.row("k-coef-48k", ["b0", "b1", "b2", "a1", "a2", "hp a1", "hp a2"][i], w, 1e-8, *g, f64::NAN);
        }
    }
    for rate in [48000.0f64, 44100.0] {
        let tag = |s: &str| format!("{s}@{}", rate as u32);
        let case = |o: &mut Out, name: &str, sig: Stereo, i: Option<f64>, m: Option<f64>, s: Option<f64>, lra: Option<(f64, f64)>| {
            let a = own(rate, &sig, TpMode::Full, 6);
            #[cfg(feature = "ebur")]
            let r = reference(rate, &sig);
            #[cfg(not(feature = "ebur"))]
            let r = Meas { m: f64::NAN, s: f64::NAN, i: f64::NAN, lra: f64::NAN, hist_i: 0.0, hist_lra: 0.0, tp_db: f64::NAN, lost: 0 };
            let n = tag(name);
            if let Some(e) = i { o.row(&n, "I", e, 0.1, a.i, r.i); o.pair(&n, "I hist vs exact (own)", 0.11, a.hist_i, a.i); }
            if let Some(e) = m { o.row(&n, "M", e, 0.1, a.m, r.m); }
            if let Some(e) = s { o.row(&n, "S", e, 0.1, a.s, r.s); }
            if let Some((e, tol)) = lra { o.row(&n, "LRA", e, tol, a.lra, r.lra); o.pair(&n, "LRA hist vs exact (own)", 0.11, a.hist_lra, a.lra); }
            if !r.i.is_nan() {
                o.pair(&n, "own vs ebur I", 1e-3, a.i, r.i);
                o.pair(&n, "own vs ebur M", 1e-3, a.m, r.m);
                o.pair(&n, "own vs ebur S", 1e-3, a.s, r.s);
                o.pair(&n, "own vs ebur LRA", 0.01, a.lra, r.lra);
                o.pair(&n, "own vs ebur TP dB", 1e-3, a.tp_db, r.tp_db);
            }
            o.pair(&n, "ring lost", 0.0, a.lost as f64, 0.0);
        };
        // Tech 3341 style
        case(&mut o, "t1 1k stereo -23 20s", sine(rate, 1000.0, -23.0, 20.0), Some(-23.0), Some(-23.0), Some(-23.0), None);
        case(&mut o, "t2 1k stereo -33 20s", sine(rate, 1000.0, -33.0, 20.0), Some(-33.0), Some(-33.0), Some(-33.0), None);
        case(&mut o, "t2b 1k stereo -20 20s", sine(rate, 1000.0, -20.0, 20.0), Some(-20.0), Some(-20.0), Some(-20.0), None);
        case(&mut o, "t3 -36 10s,-23 60s,-36 10s (relative gate)", concat(vec![sine(rate, 1000.0, -36.0, 10.0), sine(rate, 1000.0, -23.0, 60.0), sine(rate, 1000.0, -36.0, 10.0)]), Some(-23.0), None, None, None);
        case(&mut o, "t4 -80 20s,-23 20s (absolute gate)", concat(vec![sine(rate, 1000.0, -80.0, 20.0), sine(rate, 1000.0, -23.0, 20.0)]), Some(-23.0), None, None, None);
        // analytic: both halves pass both gates, I = 10log10((1e-2.0 + 1e-2.6)/2) - 0.691 + 0.691
        case(&mut o, "t5 -20 10s,-26 10s (no gating effect)", concat(vec![sine(rate, 1000.0, -20.0, 10.0), sine(rate, 1000.0, -26.0, 10.0)]), Some(10.0 * ((10f64.powf(-2.0) + 10f64.powf(-2.6)) / 2.0).log10()), None, None, None);
        // Tech 3342 style (tolerance 1 LU)
        case(&mut o, "l1 -20 20s,-30 20s", concat(vec![sine(rate, 1000.0, -20.0, 20.0), sine(rate, 1000.0, -30.0, 20.0)]), None, None, None, Some((10.0, 1.0)));
        case(&mut o, "l2 -20 20s,-15 20s", concat(vec![sine(rate, 1000.0, -20.0, 20.0), sine(rate, 1000.0, -15.0, 20.0)]), None, None, None, Some((5.0, 1.0)));
        case(&mut o, "l3 -40 20s,-20 20s", concat(vec![sine(rate, 1000.0, -40.0, 20.0), sine(rate, 1000.0, -20.0, 20.0)]), None, None, None, Some((20.0, 1.0)));
        // true peak: fs/4 at 45 degrees (sample peak is 3.01 dB below the true peak)
        for (amp, want) in [(0.5, -6.0206), (1.0, 0.0), (1.4125, 3.0)] {
            let sig = fs4_45(rate, amp, 2.0);
            let a = own(rate, &sig, TpMode::Full, 6);
            #[cfg(feature = "ebur")]
            let r = reference(rate, &sig).tp_db;
            #[cfg(not(feature = "ebur"))]
            let r = f64::NAN;
            o.row(&tag(&format!("tp fs/4 45deg A={amp} (sample peak {:.2} dBFS)", dbf(amp / 2f64.sqrt()))), "TP dBTP", want, 0.3, a.tp_db, r);
        }
        // own vs crate on music-like content with level swings (exercises gating, 60 s)
        let sig = music(rate, 60.0, 0.7, 5);
        let a = own(rate, &sig, TpMode::Full, 6);
        let g = own(rate, &sig, TpMode::Gated(0.5), 6);
        let n = tag("music 60s");
        o.pair(&n, "gated TP (>= -6 dBFS) vs full TP dB", 1e-6, g.tp_db, a.tp_db);
        o.pair(&n, "idle STATUS cadence (48 quanta) I vs 6", 0.0, own(rate, &sig, TpMode::Off, 48).i, a.i);
        o.pair(&n, "I hist vs exact", 0.11, a.hist_i, a.i);
        o.pair(&n, "LRA hist vs exact", 0.11, a.hist_lra, a.lra);
        #[cfg(feature = "ebur")]
        {
            let r = reference(rate, &sig);
            o.pair(&n, "I own vs ebur", 1e-3, a.i, r.i);
            o.pair(&n, "M own vs ebur", 1e-3, a.m, r.m);
            o.pair(&n, "S own vs ebur", 1e-3, a.s, r.s);
            o.pair(&n, "LRA own vs ebur", 0.01, a.lra, r.lra);
            o.pair(&n, "TP dB own vs ebur", 1e-3, a.tp_db, r.tp_db);
        }
        // tail after loud: silence must not produce denormals/NaN, and a NaN burst must not poison the meter
        let mut b = Loudness::new(rate, TpMode::Full);
        let z = vec![0.0f32; QUANTUM];
        let tone = sine(rate, 1000.0, -3.0, 0.1);
        for c in tone.0.chunks(QUANTUM).filter(|c| c.len() == QUANTUM) {
            b.process(c, c);
        }
        for _ in 0..4000 {
            b.process(&z, &z);
        }
        let mut nanq = z.clone();
        nanq[5] = f32::NAN;
        b.process(&nanq, &nanq);
        for c in tone.0.chunks(QUANTUM).filter(|c| c.len() == QUANTUM) {
            b.process(c, c);
        }
        o.pair(&n, "NaN burst: energy still finite", 0.0, b.ring.iter().all(|x| x.is_finite()) as u8 as f64, 1.0);
    }
    o.all
}

#[cfg(test)]
mod tests {
    #[test]
    fn all_checks_pass() {
        assert!(super::run(false));
    }
}
