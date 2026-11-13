//! Generator of `loudnessVectors.json`: reference values from spike S1's Rust `Feed`, `Gating` (exact) and `Hist`.
//!
//! Not part of any build. Reproduce (from the repository root; needs `libm` from the crates.io cache or network):
//!   1. a scratch crate outside the repository whose `Cargo.toml` has `[workspace]`, `libm = "0.2"` and a
//!      `[[bin]] path = "<repo>/src/plugins/audio/runtime/mix/__fixtures__/genLoudnessVectors.rs"` (the two `#[path]`
//!      lines below are relative to this file), then
//!   2. `CARGO_TARGET_DIR=.target-ld3 cargo run --release --manifest-path <scratch>/Cargo.toml > .../__fixtures__/loudnessVectors.json`
//!      (delete `.target-ld3` afterwards).
//! The spike files are used unmodified: `Loudness` (K-weighting, sub-block energies, ring) produces the sub-blocks
//! from synthesized signals, `Feed::take` turns (seq, ring) takes into energies, and `Hist` / `Gating` read them.
//! True peak is off (it is not part of the statistics). Energies are f32 values widened to f64 (exact in JSON).
#[path = "../../../../../../spikes/audio-mix/loudness/src/loud.rs"]
#[allow(dead_code)]
mod loud;
#[path = "../../../../../../spikes/audio-mix/loudness/src/signals.rs"]
#[allow(dead_code)]
mod signals;

use loud::*;
use signals::*;

fn num(x: f64) -> String {
    if x.is_finite() { format!("{}", x) } else { "null".into() }
}

struct Run {
    subs: Vec<f64>,
    takes: Vec<(u32, [f32; RING], usize)>,
    lost: u64,
}

fn run(rate: f64, sig: &Stereo, every: usize) -> Run {
    let mut b = Loudness::new(rate, TpMode::Off);
    let mut feed = Feed::default();
    let mut out: Vec<f64> = Vec::new();
    let mut takes = Vec::new();
    let n = sig.0.len();
    let (mut q, mut o) = (0, 0);
    while o < n {
        let e = (o + QUANTUM).min(n);
        b.process(&sig.0[o..e], &sig.1[o..e]);
        q += 1;
        o = e;
        if q % every == 0 || o == n {
            let before = out.len();
            feed.take(b.seq, &b.ring, &mut out);
            takes.push((b.seq, b.ring, out.len() - before));
        }
    }
    Run { subs: out, takes, lost: feed.lost }
}

fn main() {
    let r48 = 48000.0;
    let r44 = 44100.0;
    let cases: Vec<(&str, f64, Stereo)> = vec![
        ("t1 1k -23 20s", r48, sine(r48, 1000.0, -23.0, 20.0)),
        ("t3 -36 10s, -23 60s, -36 10s", r48, concat(vec![sine(r48, 1000.0, -36.0, 10.0), sine(r48, 1000.0, -23.0, 60.0), sine(r48, 1000.0, -36.0, 10.0)])),
        ("t4 -80 20s, -23 20s", r48, concat(vec![sine(r48, 1000.0, -80.0, 20.0), sine(r48, 1000.0, -23.0, 20.0)])),
        ("t5 -20 10s, -26 10s", r48, concat(vec![sine(r48, 1000.0, -20.0, 10.0), sine(r48, 1000.0, -26.0, 10.0)])),
        ("l1 -20 20s, -30 20s", r48, concat(vec![sine(r48, 1000.0, -20.0, 20.0), sine(r48, 1000.0, -30.0, 20.0)])),
        ("l2 -20 20s, -15 20s", r48, concat(vec![sine(r48, 1000.0, -20.0, 20.0), sine(r48, 1000.0, -15.0, 20.0)])),
        ("l3 -40 20s, -20 20s", r48, concat(vec![sine(r48, 1000.0, -40.0, 20.0), sine(r48, 1000.0, -20.0, 20.0)])),
        ("music 60s 48k", r48, music(r48, 60.0, 0.7, 5)),
        ("music 40s 44.1k", r44, music(r44, 40.0, 0.5, 11)),
        ("burst 40s (digital silence between)", r48, burst(r48, 40.0, 0.3)),
    ];
    println!("{{\"source\":\"spikes/audio-mix/loudness/src/loud.rs Feed/Gating/Hist via genLoudnessVectors.rs\",\"cases\":[");
    for (ci, (name, rate, sig)) in cases.iter().enumerate() {
        let run = run(*rate, sig, 6);
        let subs = &run.subs;
        let (mut hi, mut hl) = (Hist::new(), Hist::new());
        let mut cps = Vec::new();
        for n in 1..=subs.len() {
            if n >= 4 {
                hi.add(subs[n - 4..n].iter().sum::<f64>() / 4.0);
            }
            if n >= 30 && (n - 30) % 10 == 0 {
                hl.add(subs[n - 30..n].iter().sum::<f64>() / 30.0);
            }
            if n % 5 == 0 || n == subs.len() {
                let g = Gating { subs: subs[..n].to_vec() };
                cps.push(format!(
                    "{{\"n\":{n},\"m\":{},\"s\":{},\"i\":{},\"iExact\":{},\"lra\":{},\"lraExact\":{}}}",
                    num(g.momentary()), num(g.shortterm()), num(hi.integrated()), num(g.integrated()), num(hl.lra()), num(g.lra())
                ));
            }
        }
        let list: Vec<String> = subs.iter().map(|x| format!("{x}")).collect();
        println!("{{\"name\":\"{name}\",\"rate\":{rate},\"subs\":[{}],\"checkpoints\":[{}]}}{}", list.join(","), cps.join(","), if ci + 1 < cases.len() { "," } else { "" });
    }
    println!("],\"feeds\":[");
    let sig = music(r48, 12.0, 0.6, 3);
    let feeds = [("music 12s, take every 6 quanta", 6usize), ("music 12s, idle cadence 48", 48), ("music 12s, take every 24 quanta", 24), ("music 12s, stall: take every 200 quanta overruns the ring of 4", 200)];
    for (fi, (name, every)) in feeds.iter().enumerate() {
        let r = run(r48, &sig, *every);
        let takes: Vec<String> = r.takes.iter().map(|(seq, ring, c)| format!("{{\"seq\":{seq},\"ring\":[{}],\"pushed\":{c}}}", ring.iter().map(|x| format!("{}", *x as f64)).collect::<Vec<_>>().join(","))).collect();
        let out: Vec<String> = r.subs.iter().map(|x| format!("{x}")).collect();
        println!("{{\"name\":\"{name}\",\"ringLen\":{RING},\"takes\":[{}],\"out\":[{}],\"lost\":{}}}{}", takes.join(","), out.join(","), r.lost, if fi + 1 < feeds.len() { "," } else { "" });
    }
    println!("]}}");
}
