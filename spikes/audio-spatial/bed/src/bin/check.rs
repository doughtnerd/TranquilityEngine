//! Correctness checks. `cargo run --release --bin check` prints every number the README quotes.
use audio_dsp::hrtf::angles::azimuth_elevation;
use audio_dsp::hrtf::fft::{rfft, Twiddles};
use audio_dsp::hrtf::{HrtfPannerN, HrtfScratch};
use audio_dsp::resample::{lagrange, Samples, Source};
use bedspike::cases::*;
use bedspike::content::*;
use bedspike::decoder::*;
use bedspike::encoder::*;
use bedspike::sh::*;
use microfft::Complex32;

static mut FAILS: u32 = 0;
fn verdict(ok: bool, what: &str) {
    println!("  [{}] {what}", if ok { "PASS" } else { "FAIL" });
    if !ok { unsafe { FAILS += 1; } }
}

fn rand_dir(r: &mut Rng) -> [f32; 3] { unit(r) }

// ------------------------------------------------------------ analysis helpers
const BANDS: [(f32, f32); 6] = [(200.0, 500.0), (500.0, 1000.0), (1000.0, 2000.0), (2000.0, 4000.0), (4000.0, 8000.0), (8000.0, 16000.0)];

struct Meas {
    level: [[f64; 6]; 2], // dB per ear per band
    itd_us: f64,
}

fn measure(l: &[f32], r: &[f32]) -> Meas {
    let tw = Twiddles::new();
    let mut work = vec![Complex32 { re: 0.0, im: 0.0 }; 512];
    let n = 1024;
    let blocks = l.len() / n;
    let mut pl = vec![0.0f64; 512];
    let mut pr = vec![0.0f64; 512];
    let mut cr = vec![0.0f64; 512];
    let mut ci = vec![0.0f64; 512];
    for b in 0..blocks {
        let mut bl = vec![0.0f32; n];
        let mut br = vec![0.0f32; n];
        for i in 0..n {
            let w = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * (i as f32 + 0.5) / n as f32).cos();
            bl[i] = l[b * n + i] * w;
            br[i] = r[b * n + i] * w;
        }
        let xl = rfft(&mut bl, &mut work, &tw).to_vec();
        let xr = rfft(&mut br, &mut work, &tw).to_vec();
        for k in 1..512 {
            pl[k] += (xl[k].re * xl[k].re + xl[k].im * xl[k].im) as f64;
            pr[k] += (xr[k].re * xr[k].re + xr[k].im * xr[k].im) as f64;
            // conj(XL) * XR
            cr[k] += (xl[k].re * xr[k].re + xl[k].im * xr[k].im) as f64;
            ci[k] += (xl[k].re * xr[k].im - xl[k].im * xr[k].re) as f64;
        }
    }
    let df = 48000.0 / n as f32;
    let mut level = [[0.0; 6]; 2];
    for (bi, (lo, hi)) in BANDS.iter().enumerate() {
        let (mut sl, mut sr) = (0.0, 0.0);
        for k in 1..512 {
            let f = k as f32 * df;
            if f >= *lo && f < *hi { sl += pl[k]; sr += pr[k]; }
        }
        level[0][bi] = 10.0 * (sl.max(1e-30)).log10();
        level[1][bi] = 10.0 * (sr.max(1e-30)).log10();
    }
    let (mut sr_, mut si_) = (0.0f64, 0.0f64);
    for k in 2..512 {
        let f = k as f32 * df;
        if f > 200.0 && f < 1200.0 {
            // C[k] * conj(C[k-1])
            let (a, b, c, d) = (cr[k], ci[k], cr[k - 1], ci[k - 1]);
            sr_ += a * c + b * d;
            si_ += b * c - a * d;
        }
    }
    let itd = -(si_.atan2(sr_)) / (2.0 * std::f64::consts::PI * df as f64) * 1e6;
    Meas { level, itd_us: itd }
}

/// Renders `quanta` of white noise from engine-space (az, el) through the bed (`dec`) and through M1's panner.
fn render_pair(sh: &Shared, dec: &mut Decoder, az: f64, el: f64, quanta: usize, tone: Option<f32>) -> ((Vec<f32>, Vec<f32>), (Vec<f32>, Vec<f32>)) {
    let el_r = el.to_radians();
    let az_r = az.to_radians();
    // engine listener space: x right, y up, forward -z; az + is right.
    let d_eng = [(el_r.cos() * az_r.sin()) as f32, el_r.sin() as f32, (-el_r.cos() * az_r.cos()) as f32];
    let amb = from_engine(d_eng);
    let y = sh16(amb[0], amb[1], amb[2]);
    let (a2, e2) = azimuth_elevation(d_eng);
    dec.reset();
    let mut pan = HrtfPannerN::<2>::new(48000.0).unwrap();
    let mut scratch = HrtfScratch::new();
    let mut src = vec![0.0f32; quanta * Q];
    match tone {
        None => noise(4242, &mut src),
        Some(f) => for (i, s) in src.iter_mut().enumerate() { *s = 0.5 * (2.0 * std::f32::consts::PI * f * i as f32 / 48000.0).sin(); },
    }
    let mut bed = Bed::new();
    let (mut bl, mut br, mut ml, mut mr) = (vec![], vec![], vec![], vec![]);
    for q in 0..quanta {
        let x = &src[q * Q..(q + 1) * Q];
        bed.clear();
        let mut c = [0.0f32; 16];
        for i in 0..16 { c[i] = y[i]; }
        encode(&mut bed, x, &c, &c);
        let (mut l, mut r) = ([0.0; Q], [0.0; Q]);
        dec.process(&bed, 16, &mut l, &mut r);
        let (mut pl, mut pr) = ([0.0; Q], [0.0; Q]);
        pan.pan(&sh.db, &mut scratch, a2, e2, x.try_into().unwrap(), None, &mut pl, &mut pr);
        if q >= 16 {
            bl.extend_from_slice(&l); br.extend_from_slice(&r);
            ml.extend_from_slice(&pl); mr.extend_from_slice(&pr);
        }
    }
    ((bl, br), (ml, mr))
}

fn fft_f64(re: &mut [f64], im: &mut [f64]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 { j ^= bit; bit >>= 1; }
        j ^= bit;
        if i < j { re.swap(i, j); im.swap(i, j); }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * std::f64::consts::PI / len as f64;
        for s in (0..n).step_by(len) {
            for k in 0..len / 2 {
                let (c, sn) = ((ang * k as f64).cos(), (ang * k as f64).sin());
                let (a, b) = (s + k, s + k + len / 2);
                let (tr, ti) = (re[b] * c - im[b] * sn, re[b] * sn + im[b] * c);
                re[b] = re[a] - tr; im[b] = im[a] - ti;
                re[a] += tr; im[a] += ti;
            }
        }
        len <<= 1;
    }
}

fn main() {
    let asset = include_bytes!("../../../../../src/plugins/audio/runtime/wasm/myco_hrir.bin");
    let sh = Shared::new(asset);
    let mut rng = Rng(99);

    println!("## 1. Layout and encoder");
    let leb = lebedev26();
    let mut worst = 0.0f64;
    for a in 0..16 { for b in 0..16 {
        let mut s = 0.0;
        for (d, w) in &leb { let y = sh16_f64(d[0], d[1], d[2]); s += w * (2 * order_of(a) + 1) as f64 * y[a] * y[b]; }
        worst = worst.max((s - if a == b { 1.0 } else { 0.0 }).abs());
    }}
    println!("Lebedev-26 quadrature, max |sum_k w_k (2l+1) Y_a Y_b - delta_ab| = {worst:.2e}");
    verdict(worst < 1e-12, "Lebedev-26 integrates all 16x16 harmonic products exactly (a 7-design)");
    let (mut lo, mut hi) = (f64::MAX, 0.0f64);
    for _ in 0..200000 {
        let d = rand_dir(&mut rng);
        let y = sh16(d[0], d[1], d[2]);
        let e: f64 = y.iter().map(|v| (*v as f64).powi(2)).sum();
        lo = lo.min(e); hi = hi.max(e);
    }
    println!("Encoder energy, sum of squared SN3D gains over 200,000 random directions: min {lo:.7}, max {hi:.7} (exact: 4 = one per order 0..3)");
    verdict((lo - 4.0).abs() < 2e-5 && (hi - 4.0).abs() < 2e-5, "energy preserved: sum of squares = 4 within 2e-5 (f32)");
    // per-order energy
    let d = rand_dir(&mut rng);
    let y = sh16(d[0], d[1], d[2]);
    for (l, (a, b)) in [(0, 1), (1, 4), (4, 9), (9, 16)].iter().enumerate() {
        let e: f32 = y[*a..*b].iter().map(|v| v * v).sum();
        println!("  order {l}: {e:.6}");
    }

    println!("\n## 2. Rotation");
    let rb = RotBuilder::new();
    let mut max_rt = 0.0f32;
    let mut max_def = 0.0f32;
    for trial in 0..200 {
        let (yaw, pitch, roll) = if trial == 0 { (std::f64::consts::FRAC_PI_2, 0.0, 0.0) } else { ((rng.sym() * 3.14) as f64, (rng.sym() * 1.5) as f64, (rng.sym() * 3.14) as f64) };
        let r = euler(yaw, pitch, roll);
        let fwd = rb.build(&r);
        let back = rb.build(&mat3_t(&r));
        let mut inp = vec![[0.0f32; Q]; 16];
        for c in 0..16 { for i in 0..Q { inp[c][i] = rng.sym(); } }
        let refs: Vec<&[f32]> = inp.iter().map(|v| &v[..]).collect();
        let mut o1 = vec![[0.0f32; Q]; 16];
        apply_rot_ramp(&refs, &mut o1, 16, &fwd, &fwd);
        let refs1: Vec<&[f32]> = o1.iter().map(|v| &v[..]).collect();
        let mut o2 = vec![[0.0f32; Q]; 16];
        apply_rot_ramp(&refs1, &mut o2, 16, &back, &back);
        for c in 0..16 { for i in 0..Q { max_rt = max_rt.max((o2[c][i] - inp[c][i]).abs()); } }
        // Y(R d) == M Y(d)
        let d = rand_dir(&mut rng);
        let y0 = sh16(d[0], d[1], d[2]);
        let rd = [(r[0][0] * d[0] as f64 + r[0][1] * d[1] as f64 + r[0][2] * d[2] as f64) as f32, (r[1][0] * d[0] as f64 + r[1][1] * d[1] as f64 + r[1][2] * d[2] as f64) as f32, (r[2][0] * d[0] as f64 + r[2][1] * d[1] as f64 + r[2][2] * d[2] as f64) as f32];
        let y1 = sh16(rd[0], rd[1], rd[2]);
        let m = fwd.dense();
        for a in 0..16 {
            let mut s = 0.0f32;
            for b in 0..16 { s += m[a][b] * y0[b]; }
            max_def = max_def.max((s - y1[a]).abs());
        }
    }
    println!("Rotate by random (yaw, pitch, roll) then by the inverse, 200 trials x 16 ch x 128 frames of noise: max |error| = {max_rt:.2e}");
    println!("Rotation by yaw 90 deg then back is trial 0 of those. Y(Rd) = M Y(d) for random d, R: max |error| = {max_def:.2e}");
    verdict(max_rt < 1e-5, "rotated and back equals the original to 1e-5");
    verdict(max_def < 1e-5, "matrix agrees with direct re-encoding to 1e-5");
    // yaw 90: front -> left
    let r90 = rb.build(&euler(std::f64::consts::FRAC_PI_2, 0.0, 0.0));
    let yf = sh16(1.0, 0.0, 0.0);
    let m = r90.dense();
    let mut got = [0.0f32; 16];
    for a in 0..16 { for b in 0..16 { got[a] += m[a][b] * yf[b]; } }
    let yl = sh16(0.0, 1.0, 0.0);
    let e = (0..16).map(|i| (got[i] - yl[i]).abs()).fold(0.0, f32::max);
    println!("yaw +90: encoded front becomes encoded left, max |diff| = {e:.2e}");
    verdict(e < 1e-5, "yaw +90 turns a front source to the left");
    // ramp end value
    {
        let a = rb.build(&euler(0.0, 0.0, 0.0));
        let b = rb.build(&euler(1.0, 0.4, -0.3));
        let mut inp = vec![[0.0f32; Q]; 16];
        for c in 0..16 { for i in 0..Q { inp[c][i] = rng.sym(); } }
        let refs: Vec<&[f32]> = inp.iter().map(|v| &v[..]).collect();
        let mut o = vec![[0.0f32; Q]; 16];
        apply_rot_ramp(&refs, &mut o, 16, &a, &b);
        let mb = b.dense();
        let mut e = 0.0f32;
        for c in 0..16 { let mut s = 0.0; for k in 0..16 { s += mb[c][k] * inp[k][Q - 1]; } e = e.max((s - o[c][Q - 1]).abs()); }
        println!("Ramped rotation, last frame equals the new matrix applied: max |diff| = {e:.2e}");
        verdict(e < 1e-5, "ramp lands on the new matrix");
    }
    // FOA subset
    {
        let r = rb.build(&euler(0.7, -0.2, 0.4));
        let mut inp = vec![[0.0f32; Q]; 16];
        for c in 0..16 { for i in 0..Q { inp[c][i] = rng.sym(); } }
        let refs: Vec<&[f32]> = inp.iter().map(|v| &v[..]).collect();
        let (mut a, mut b) = (vec![[0.0f32; Q]; 16], vec![[0.0f32; Q]; 16]);
        apply_rot_ramp(&refs[..4], &mut a, 4, &r, &r);
        apply_rot_ramp(&refs, &mut b, 16, &r, &r);
        let e = (0..4).map(|c| (0..Q).map(|i| (a[c][i] - b[c][i]).abs()).fold(0.0, f32::max)).fold(0.0, f32::max);
        println!("FOA (4 ch) rotation equals the first 4 channels of the 16-ch rotation: max |diff| = {e:.2e}");
        verdict(e == 0.0, "FOA path identical to the order-1 block");
    }

    println!("\n## 3. Decoders against each other and against M1's per-voice HRTF");
    println!("Filters: speakers {} B (26 feeds x 2 ears x {} partitions, complex f32 spectra, plus the 16x26 gain matrix), SH-quad {} B, SH-LS {} B (16 x 2 x {} partitions); truncated energy beyond 256 taps: speakers {:.1e}, quad {:.1e}, LS {:.1e}, MagLS {:.1e}",
        sh.speakers.bytes(), PARTS, sh.sh_quad.bytes(), sh.sh_ls.bytes(), PARTS, sh.speakers.truncated_energy, sh.sh_quad.truncated_energy, sh.sh_ls.truncated_energy, sh.sh_mag.truncated_energy);
    {
        let mut ds = Decoder::new(sh.filters(Kind::Speakers));
        let mut dq = Decoder::new(sh.filters(Kind::ShQuad));
        let mut bed = Bed::new();
        let (mut num, mut den, mut mx) = (0.0f64, 0.0f64, 0.0f32);
        for _ in 0..50 {
            for c in 0..16 { for i in 0..Q { bed.ch[c][i] = rng.sym(); } }
            let (mut a, mut b, mut c, mut d) = ([0.0; Q], [0.0; Q], [0.0; Q], [0.0; Q]);
            ds.process(&bed, 16, &mut a, &mut b);
            dq.process(&bed, 16, &mut c, &mut d);
            for i in 0..Q { num += ((a[i] - c[i]) as f64).powi(2) + ((b[i] - d[i]) as f64).powi(2); den += (a[i] as f64).powi(2) + (b[i] as f64).powi(2); mx = mx.max((a[i] - c[i]).abs()); }
        }
        println!("Speaker decode vs SH-quad decode on a random bed: relative error {:.2e} (rms), max abs {mx:.2e}", (num / den).sqrt());
        verdict((num / den).sqrt() < 1e-4, "Lebedev speakers and their SH-domain fold are the same decode");
    }

    let dirs_main: Vec<(f64, f64)> = {
        let mut v = vec![];
        for el in [0.0, 30.0, -30.0, 60.0] {
            for az in [0.0, 30.0, 60.0, 90.0, 120.0, 150.0, 180.0, -150.0, -120.0, -90.0, -60.0, -30.0] { v.push((az, el)); }
        }
        v
    };
    for (kind, name) in [(Kind::ShLs, "SH-LS"), (Kind::ShMagLs, "SH-MagLS"), (Kind::ShQuad, "SH-quad (= 26 speakers)")] {
        println!("\n### {name} vs M1 per-voice HRTF, white noise, 48 blocks of 1,024; {} directions", dirs_main.len());
        let mut dec = Decoder::new(sh.filters(kind));
        let mut band_ild_max = [0.0f64; 6];
        let mut band_ild_sum = [0.0f64; 6];
        let mut band_lvl_max = [0.0f64; 6];
        let mut band_lvl_sum = [0.0f64; 6];
        let (mut itd_max, mut itd_sum) = (0.0f64, 0.0f64);
        let (mut itd_max0, mut n0) = (0.0f64, 0usize);
        let mut dir_ok = 0;
        let mut dir_n = 0;
        let mut worst_dir = String::new();
        let mut worst_val = 0.0;
        for &(az, el) in &dirs_main {
            let (bed, m1) = render_pair(&sh, &mut dec, az, el, 16 + 400, None);
            let b = measure(&bed.0, &bed.1);
            let m = measure(&m1.0, &m1.1);
            for k in 0..6 {
                let ild_b = b.level[1][k] - b.level[0][k];
                let ild_m = m.level[1][k] - m.level[0][k];
                let d = (ild_b - ild_m).abs();
                band_ild_max[k] = band_ild_max[k].max(d);
                band_ild_sum[k] += d;
                let lv = ((b.level[0][k] - m.level[0][k]).abs()).max((b.level[1][k] - m.level[1][k]).abs());
                band_lvl_max[k] = band_lvl_max[k].max(lv);
                band_lvl_sum[k] += lv;
                if k == 3 && d > worst_val { worst_val = d; worst_dir = format!("az {az} el {el}"); }
            }
            let di = (b.itd_us - m.itd_us).abs();
            itd_max = itd_max.max(di);
            itd_sum += di;
            if el == 0.0 { itd_max0 = itd_max0.max(di); n0 += 1; }
            // right way
            if el == 0.0 {
                dir_n += 1;
                let side = az.abs() > 20.0 && az.abs() < 160.0;
                let ok = if side {
                    let right = az > 0.0;
                    let ild = b.level[1][3] - b.level[0][3]; // 2-4 kHz, R - L
                    (ild > 0.0) == right && (b.itd_us < 0.0) == right && b.itd_us.abs() > 150.0
                } else {
                    (b.level[1][3] - b.level[0][3]).abs() < 3.0 && b.itd_us.abs() < 120.0
                };
                if ok { dir_ok += 1; } else { println!("    wrong-way: az {az} el 0: ILD2-4k {:.1} dB, ITD {:.0} us", b.level[1][3] - b.level[0][3], b.itd_us); }
            }
        }
        let n = dirs_main.len() as f64;
        println!("| band | mean abs dILD (dB) | max abs dILD | mean worst-ear level diff | max worst-ear level diff |\n|---|---|---|---|---|");
        for k in 0..6 {
            println!("| {}-{} Hz | {:.2} | {:.2} | {:.2} | {:.2} |", BANDS[k].0, BANDS[k].1, band_ild_sum[k] / n, band_ild_max[k], band_lvl_sum[k] / n, band_lvl_max[k]);
        }
        println!("ITD (200-1200 Hz group delay): mean abs diff {:.1} us, max {:.1} us (el 0 only: max {:.1} us over {n0} dirs); worst 2-4 kHz ILD diff at {worst_dir}", itd_sum / n, itd_max, itd_max0);
        println!("Points the right way at el 0: {dir_ok}/{dir_n} azimuths (side sources: R louder and R earlier for az>0, |ITD|>150 us; front/back: |ILD|<3 dB, |ITD|<120 us)");
        if kind == Kind::ShQuad { println!("  [INFO] {name}: {dir_ok}/{dir_n} azimuths the right way (the plain-quadrature fit is not the one the design would ship)"); } else { verdict(dir_ok == dir_n, &format!("{name}: ILD and ITD point the right way at every azimuth")); }
    }

    // Level calibration, per direction table for the default decoder
    println!("\n### Per-direction detail, SH-MagLS (the default), el 0 (R-L ILD in dB per band; ITD R-L in us; bed vs M1)");
    {
        let mut dec = Decoder::new(sh.filters(Kind::ShMagLs));
        println!("| az | ILD 500-1k bed/M1 | ILD 1-2k | ILD 2-4k | ILD 4-8k | ITD bed/M1 |\n|---|---|---|---|---|---|");
        for az in [0.0, 30.0, 60.0, 90.0, 120.0, 150.0, 180.0, -90.0, -45.0] {
            let (bed, m1) = render_pair(&sh, &mut dec, az, 0.0, 16 + 400, None);
            let b = measure(&bed.0, &bed.1);
            let m = measure(&m1.0, &m1.1);
            let f = |k: usize| format!("{:+.1} / {:+.1}", b.level[1][k] - b.level[0][k], m.level[1][k] - m.level[0][k]);
            println!("| {az} | {} | {} | {} | {} | {:+.0} / {:+.0} |", f(1), f(2), f(3), f(4), b.itd_us, m.itd_us);
        }
    }

    println!("\n### Below the listener (the HRIR grid ends at -45 degrees)");
    for (kind, name) in [(Kind::ShLs, "SH-LS (filled rows -60, -75, -90 from the -45 data)"), (Kind::ShMagLs, "SH-MagLS (same filled rows)"), (Kind::ShQuad, "SH-quad (nadir and lower speakers read the -45 data)")] {
        let mut dec = Decoder::new(sh.filters(kind));
        println!("{name}:");
        println!("| source | ILD 2-4k bed/M1 | ITD bed/M1 us | worst-ear level diff per band 0.2-16 kHz (dB) |\n|---|---|---|---|");
        for (az, el) in [(90.0, -30.0), (90.0, -45.0), (90.0, -60.0), (90.0, -75.0), (0.0, -90.0), (180.0, -60.0)] {
            let (bed, m1) = render_pair(&sh, &mut dec, az, el, 16 + 400, None);
            let b = measure(&bed.0, &bed.1);
            let m = measure(&m1.0, &m1.1);
            let lv: Vec<String> = (0..6).map(|k| format!("{:.1}", ((b.level[0][k] - m.level[0][k]).abs()).max((b.level[1][k] - m.level[1][k]).abs()))).collect();
            println!("| az {az} el {el} | {:+.1} / {:+.1} | {:+.0} / {:+.0} | {} |", b.level[1][3] - b.level[0][3], m.level[1][3] - m.level[0][3], b.itd_us, m.itd_us, lv.join(" ")); 
        }
    }

    println!("\n## 4. Doppler (the same `DopplerVoice::rate_from_motion`, ramp and `lagrange` the case runs)");
    {
        let frames = 48000;
        let clip: Vec<i16> = (0..frames).map(|i| (16000.0 * (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / 48000.0).sin()) as i16).collect();
        let n = 16384;
        println!("| source velocity toward listener | expected Hz | FFT peak bin Hz | parabolic Hz | error (bins of 2.93 Hz) |\n|---|---|---|---|---|");
        for v in [34.3f32, 68.6, -34.3, 0.0, 10.0] {
            let mut vo = DopplerVoice { pos: 0.0, p: [1000.0, 0.0, 0.0], v: [-v, 0.0, 0.0], r_prev: 1000.0, ramp: audio_dsp::ramp::Ramp::at(1.0) };
            let mut out = vec![];
            let mut steps = [0.0f32; Q];
            for _ in 0..(n / Q + 8) {
                let rate = vo.rate_from_motion(Q as f32 / 48000.0);
                vo.ramp.set_target(rate, Q as u32);
                vo.ramp.fill(&mut steps);
                let (mut l, mut r) = ([0.0f32; Q], [0.0f32; Q]);
                let src = Source { samples: Samples::I16(&clip), channels: 1, frames: frames as u32 };
                lagrange(&src, &mut vo.pos, &steps, false, &mut l, &mut r);
                out.extend_from_slice(&l);
            }
            let skip = 4 * Q;
            let mut re: Vec<f64> = (0..n).map(|i| out[skip + i] as f64 * (0.5 - 0.5 * (2.0 * std::f64::consts::PI * (i as f64 + 0.5) / n as f64).cos())).collect();
            let mut im = vec![0.0; n];
            fft_f64(&mut re, &mut im);
            let mag: Vec<f64> = (0..n / 2).map(|k| (re[k] * re[k] + im[k] * im[k]).sqrt()).collect();
            let kpk = (1..n / 2).max_by(|a, b| mag[*a].partial_cmp(&mag[*b]).unwrap()).unwrap();
            let (a, b, c) = (mag[kpk - 1].ln(), mag[kpk].ln(), mag[kpk + 1].ln());
            let off = 0.5 * (a - c) / (a - 2.0 * b + c);
            let bin = 48000.0 / n as f64;
            let expected = 1000.0 * 343.0 / (343.0 - v as f64);
            let peak = kpk as f64 * bin;
            let par = (kpk as f64 + off) * bin;
            println!("| {v:+.1} m/s | {expected:.2} | {peak:.2} | {par:.2} | {:.2} |", (peak - expected).abs() / bin);
            verdict((peak - expected).abs() <= bin, &format!("v {v:+.1}: peak within one bin of the expected {expected:.1} Hz"));
        }
    }

    println!("\n## 5. Direction interpolation across the quantum");
    {
        let x = [1.0f32; Q];
        for interp in [true, false] {
            let mut bed = Bed::new();
            let prev = sh16(1.0, 0.0, 0.0);
            let new = sh16(0.0, 1.0, 0.0);
            let c0: [f32; 16] = if interp { prev } else { new };
            encode(&mut bed, &x, &c0, &new);
            println!("interp {interp}: Y channel (ACN1) value at frame 0 = {:.4} (previous quantum ended at {:.1}); jump {:.4}; frame 127 = {:.4}", bed.ch[1][0], prev[1], (bed.ch[1][0] - prev[1]).abs(), bed.ch[1][Q - 1]);
        }
    }

    println!("\n## 6. Panner-kind crossfade, kind 1 (HRTF) -> kind 2 (bed)");
    println!("Both paths run for the crossfade; the voice enters the bed (gain ramp 0 to 1) while the HRTF output ramps 1 to 0, linearly over N quanta. The bed decoder starts with no history of this voice, so its first ~2 quanta build up (256-tap filters plus the ITD).");
    println!("| signal | N quanta | steady-state mismatch kind 2 - kind 1, L / R (dB) | lowest quantum level re kind 1, L / R (dB) | largest sample step in the transition vs in kind-1 quanta |\n|---|---|---|---|---|");
    for (name, tone, az) in [("440 Hz tone, az 45", Some(440.0f32), 45.0f64), ("white noise, az 45", None, 45.0), ("white noise, az -120", None, -120.0)] {
        for nq in [1usize, 2, 4, 16] {
            let el_r = 0.0f64;
            let az_r = az.to_radians();
            let d_eng = [(el_r.cos() * az_r.sin()) as f32, 0.0, (-el_r.cos() * az_r.cos()) as f32];
            let amb = from_engine(d_eng);
            let y = sh16(amb[0], amb[1], amb[2]);
            let (a2, e2) = azimuth_elevation(d_eng);
            let mut pan = HrtfPannerN::<2>::new(48000.0).unwrap();
            let mut scratch = HrtfScratch::new();
            let mut dec = Decoder::new(sh.filters(DEFAULT_SH));
            let total = 64;
            let xq = 20;
            let mut src = vec![0.0f32; total * Q];
            match tone { None => noise(31, &mut src), Some(f) => for (i, s) in src.iter_mut().enumerate() { *s = 0.5 * (2.0 * std::f32::consts::PI * f * i as f32 / 48000.0).sin(); } }
            let mut outl = vec![];
            let mut outr = vec![];
            for q in 0..total {
                let x: &[f32; Q] = src[q * Q..(q + 1) * Q].try_into().unwrap();
                let (mut pl, mut pr) = ([0.0; Q], [0.0; Q]);
                if q < xq + nq { pan.pan(&sh.db, &mut scratch, a2, e2, x, None, &mut pl, &mut pr); }
                let mut bed = Bed::new();
                let (mut bl, mut br) = ([0.0; Q], [0.0; Q]);
                if q >= xq {
                    // bed gain ramp: 0 -> 1 over nq quanta, then 1
                    let g0 = ((q - xq) as f32 / nq as f32).min(1.0);
                    let g1 = ((q - xq + 1) as f32 / nq as f32).min(1.0);
                    let c0: [f32; 16] = std::array::from_fn(|i| y[i] * g0);
                    let c1: [f32; 16] = std::array::from_fn(|i| y[i] * g1);
                    encode(&mut bed, x, &c0, &c1);
                }
                dec.process(&bed, 16, &mut bl, &mut br);
                for i in 0..Q {
                    let t = (((q as i32 - xq as i32) as f32 * Q as f32 + (i + 1) as f32) / (nq * Q) as f32).clamp(0.0, 1.0);
                    outl.push(pl[i] * (1.0 - t) + bl[i]);
                    outr.push(pr[i] * (1.0 - t) + br[i]);
                }
            }
            let rms = |v: &[f32]| (v.iter().map(|s| (*s as f64).powi(2)).sum::<f64>() / v.len() as f64).sqrt();
            let q_db = |v: &[f32], q: usize| 20.0 * rms(&v[q * Q..(q + 1) * Q]).max(1e-9).log10();
            let base = |v: &[f32]| (8..xq).map(|q| q_db(v, q)).sum::<f64>() / (xq - 8) as f64;
            let after = |v: &[f32]| (xq + nq + 4..total).map(|q| q_db(v, q)).sum::<f64>() / (total - xq - nq - 4) as f64;
            let (bl_, br_) = (base(&outl), base(&outr));
            let worst_l = (xq..xq + nq + 2).map(|q| q_db(&outl, q) - bl_).fold(f64::MAX, f64::min);
            let worst_r = (xq..xq + nq + 2).map(|q| q_db(&outr, q) - br_).fold(f64::MAX, f64::min);
            let step = |v: &[f32], a: usize, b: usize| (a + 1..b).map(|i| (v[i] - v[i - 1]).abs()).fold(0.0f32, f32::max);
            let base_step = step(&outl, 8 * Q, xq * Q).max(step(&outr, 8 * Q, xq * Q));
            let tr_step = step(&outl, xq * Q, (xq + nq + 2) * Q).max(step(&outr, xq * Q, (xq + nq + 2) * Q));
            println!("| {name} | {nq} | {:+.2} / {:+.2} | {worst_l:+.2} / {worst_r:+.2} | {tr_step:.3} vs {base_step:.3} |", after(&outl) - bl_, after(&outr) - br_);
        }
    }

    println!("\n## 7. Footprint");
    println!("HRIR asset (shared with kind 1): {} B; M1 f32 table at 48 kHz built here: {} B", asset.len(), 16 + 240 * 8 + 240 * 279 * 4);
    println!("SH decoder filter data (SH-LS): {} B as complex partition spectra ({} B as 16 x 2 x 256-tap f32 time responses)", sh.sh_ls.bytes(), 16 * 2 * 256 * 4);
    println!("Speaker decoder data: {} B", sh.speakers.bytes());
    println!("Decoder state: SH {} B history+prev (16 ch x {} partitions x 128 bins x 8 B + 16 x 128 x 4), speakers {} B", 16 * PARTS * 128 * 8 + 16 * 128 * 4, PARTS, 26 * PARTS * 128 * 8 + 26 * 128 * 4);
    println!("Bed: {} B; BedVoices state per voice: ~{} B", 16 * Q * 4, 3 * 4 + 9 * 4 + 16 * 4 + 4 + 4);

    let fails = unsafe { FAILS };
    println!("\n{} check(s) failed", fails);
    if fails > 0 { std::process::exit(1); }
}
