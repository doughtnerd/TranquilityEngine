// Native 0.6.1 baseline on the fixtures. Run from decode/v06: cargo run --release --example native
use std::time::Instant;
fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}
fn main() {
    // fixtures (see README: regenerate with ffmpeg), whole-file decode + streaming 4096-frame chunks + seek
    #[cfg(feature = "dec")]
    for name in ["town.mp3", "town.ogg", "town.flac", "town.opus.ogg", "town.m4a"] {
        let Ok(bytes) = std::fs::read(format!("../fixtures/{name}")) else { continue };
        let Ok(d) = decode_spike06::dec::decode_all(bytes.clone()) else { println!("native {name}: decode unsupported"); continue };
        let dur = d.samples.len() as f64 / d.channels as f64 / d.rate as f64;
        let mut times = vec![];
        for _ in 0..9 {
            let t = Instant::now();
            let _ = decode_spike06::dec::decode_all(bytes.clone()).unwrap();
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let m = median(times);
        println!("native fixture {name}: {:.2}s audio, {:.2} ms median, {:.0}x realtime", dur, m, dur * 1000.0 / m);
        let mut st = decode_spike06::stream::Stream::open(bytes).unwrap();
        let mut c = vec![];
        loop {
            let t = Instant::now();
            let n = st.read(4096);
            if n == 0 { break; }
            c.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        c.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!("native stream {name}: chunks {} p50 {:.3} p99 {:.3} max {:.3} ms (budget 4096 frames = {:.1} ms)", c.len(), c[c.len() / 2], c[c.len() * 99 / 100], c[c.len() - 1], 4096.0 / st.rate as f64 * 1000.0);
        let mut st = decode_spike06::stream::Stream::open(std::fs::read(format!("../fixtures/{name}")).unwrap()).unwrap();
        st.read(4096);
        for mode in [0u32, 1] {
            let mut sk = vec![];
            let mut first = vec![];
            let mut err = vec![];
            for i in 0..20 {
                let t = Instant::now();
                let ts = st.seek(dur / 2.0 + i as f64 * 0.37, mode);
                sk.push(t.elapsed().as_secs_f64() * 1000.0);
                let t = Instant::now();
                let n = st.read(4096);
                first.push(t.elapsed().as_secs_f64() * 1000.0);
                err.push((ts as f64 / st.rate as f64 - (dur / 2.0 + i as f64 * 0.37)) * 1000.0);
                assert!(ts >= 0 && n > 0, "seek failed: {:?} ts {ts} n {n}", unsafe { decode_spike06::stream::SEEK_ERR.clone() });
            }
            println!("native seek {name} mode {mode}: seek median {:.3} ms, first chunk after {:.3} ms, landed-minus-requested median {:.1} ms (min {:.1}, max {:.1})", median(sk), median(first), median(err.clone()), err.iter().cloned().fold(f64::MAX, f64::min), err.iter().cloned().fold(f64::MIN, f64::max));
        }
    }
}
