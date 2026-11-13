//! Rv1's one named golden (0171/0172 M5; ADR 0172 owner decision 1; R3's single exception, R11):
//! `golden/m5/bus-mute-send.json`, a bus with a reverb send that is muted, unmuted, then turned
//! down. Post-fader (architecture §4.5), the mute stops the bus feeding the reverb (only the tail
//! from before rings on) and the turned-down bus feeds it at its gain; before Rv1 the send fed the
//! reverb at full level throughout.
//!
//! Checked here, natively:
//! - **post-fader**: once the mute has settled and the tail has rung out, the output is exactly 0
//!   (a pre-fader send would keep the reverb at its steady wet level);
//! - **the discontinuity check** (`maxStep`, F-40's detector from `runtime/audioGolden.test.ts`):
//!   the largest sample-to-sample step through the mute and unmute ramps (`BUS_MIN_RAMP_MS`, 5 ms)
//!   stays within the scene's own steady-state step plus the dry ramp's step; the same scene with
//!   the mute applied at once (no ramp) exceeds it, so the check sees a click;
//! - **the fixture**: the scene's records as bytes, its clip, its frames and its output's FNV-1a 64
//!   digest, in Z3's format (`in_voice_goldens.rs`). The wasm half (`golden/audioGoldenSends.test.ts`)
//!   replays it on the loopback host with the real wasm and must get the same digest.
//!   `UPDATE_GOLDENS=1 cargo test -p audio-core --test sends_post_fader_golden` rewrites it.

mod common;

use audio_core::fx::kind;
use audio_core::status;
use audio_wire::generated as wire;
use common::*;

const NAME: &str = "bus-mute-send";
/// Common's `params(4)`, as Z3's fixtures.
const PRESET: (u32, u32, u32) = (64, 16, 4);
/// The bus with the send.
const BUS: u32 = 1;
/// `BUS_MIN_RAMP_MS` (5 ms) at 48 kHz: what a mute toggle ramps over.
const TOGGLE: u32 = 240;
/// The send level and the voice's gain (a DC voice: the dry path is a constant 0.5).
const SEND: f32 = 0.5;
const VOICE_GAIN: f32 = 0.5;

/// The largest step between neighbouring samples (`runtime/audioGolden.test.ts`' `maxStep`).
fn max_step(x: &[f32]) -> f32 {
    x.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max)
}

fn fnv1a64(left: &[f32], right: &[f32]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for x in left.iter().chain(right) {
        for b in x.to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("{h:016x}")
}

/// The scene recorder (Z3's): a mixer with no look-ahead, its records as hex steps, its output.
struct Scene {
    m: Mixer,
    steps: Vec<String>,
    left: Vec<f32>,
    right: Vec<f32>,
    /// `(first frame, frames)` of each mute or unmute transition, for the click check.
    toggles: Vec<(usize, usize)>,
}

impl Scene {
    fn new() -> Scene {
        let mut m = Mixer::new(PRESET.2);
        m.set_lookahead(0.0);
        Scene { m, steps: Vec::new(), left: Vec::new(), right: Vec::new(), toggles: Vec::new() }
    }

    fn send(&mut self, recs: &[Rec]) {
        let bytes = batch(self.m.frame as f64, recs);
        let hex: String = bytes[32..].iter().map(|b| format!("{b:02x}")).collect();
        self.steps.push(format!("{{\"send\":\"{hex}\",\"count\":{}}}", recs.iter().map(Rec::count).sum::<usize>()));
        self.m.submit(recs);
    }

    fn run(&mut self, quanta: usize) {
        self.steps.push(format!("{{\"run\":{quanta}}}"));
        let (l, r) = self.m.render_n(quanta);
        self.left.extend(l);
        self.right.extend(r);
    }

    /// A `runtime`-lane ramp of the bus to `gain` over `frames`, noted as a transition.
    fn toggle(&mut self, gain: f32, frames: u32) {
        self.toggles.push((self.left.len(), frames.max(1) as usize));
        self.send(&[Rec::Ramps(vec![lane_ramp(BUS, wire::LANE_RUNTIME, Some(gain), None, frames)])]);
    }
}

/// The scene, with the mute and unmute ramped over `toggle` frames (0: at once).
fn scene(toggle: u32) -> Scene {
    let mut s = Scene::new();
    let Rec::Play(mut voice) = dc(0x0001_0001, BUS as u16, 0.0) else { unreachable!() };
    voice.gain = VOICE_GAIN;
    // Root and the bus with a reverb send; MASTER at 0.5 keeps the sum under the limiter.
    s.send(&[config_fx(&[(ROOT, vec![]), (0, vec![(kind::REVERB_SEND, SEND, 0.0)])]), master(0.5, false, 0), Rec::Play(voice)]);
    s.run(40);
    // Muted: the send stops feeding; the tail from before rings out (≈ 2 s IR), then silence.
    s.toggle(0.0, toggle);
    s.run(900);
    // Unmuted.
    s.toggle(1.0, toggle);
    s.run(40);
    // Turned down to 0.25 over 20 ms: the send follows.
    s.send(&[Rec::Ramps(vec![lane_ramp(BUS, wire::LANE_RUNTIME, Some(0.25), None, 960)])]);
    s.run(60);
    s
}

#[test]
fn a_muted_bus_stops_feeding_the_reverb_and_the_toggles_do_not_click() {
    let s = scene(TOGGLE);
    let (l, r) = (&s.left, &s.right);
    assert!(l.iter().chain(r).all(|x| x.is_finite()));
    // Post-fader: muted from frame 40·128 + 240; the tail is gone well before the unmute (900
    // quanta ≈ 2.4 s later), and from then on the output is exactly 0. Pre-fader it stayed at the
    // reverb's steady wet level.
    let unmute = s.toggles[1].0;
    let quiet = &l[unmute - 50 * 128..unmute];
    let loud = quiet.iter().fold(0.0f32, |p, x| p.max(x.abs()));
    assert_eq!(loud, 0.0, "a muted bus with a send is silent once its tail has rung out (largest {loud})");

    // The discontinuity check: the steady output (before the mute, after the reverb built up)
    // against each toggle's window (the ramp and a quantum either side).
    let steady = max_step(&l[20 * 128..40 * 128]).max(max_step(&r[20 * 128..40 * 128]));
    // The dry path ramps its 0.25 (the voice's 0.5 under MASTER 0.5) over the toggle.
    let dry_ramp = 0.5 * VOICE_GAIN / TOGGLE as f32;
    let bound = steady + dry_ramp;
    for &(at, n) in &s.toggles {
        let w = at.saturating_sub(128)..(at + n + 128).min(l.len());
        let step = max_step(&l[w.clone()]).max(max_step(&r[w]));
        eprintln!("{NAME}: toggle at {at}: maxStep {step:e} (steady {steady:e}, bound {bound:e})");
        assert!(step <= bound, "toggle at frame {at}: largest step {step} over {bound}");
    }
    // The same toggles at once do click: the check can see one.
    let abrupt = scene(0);
    let (at, _) = abrupt.toggles[1];
    let step = max_step(&abrupt.left[at - 128..at + 256]);
    eprintln!("{NAME}: unmute at once: maxStep {step:e}");
    assert!(step > 4.0 * bound, "an unramped unmute steps {step}, the detector's bound is {bound}");
    write_or_check(&s);
}

/// Writes (`UPDATE_GOLDENS=1`) or compares the fixture.
fn write_or_check(s: &Scene) {
    let music = &status::counters(&s.m.core).music;
    let json = format!(
        "{{\"scene\":\"{NAME}\",\"about\":\"{}\",\"preset\":{{\"maxLogical\":{},\"maxMixed\":{},\"maxBuses\":{},\"limiterLookaheadMs\":0}},\"clips\":[{{\"id\":{DC},\"frames\":64,\"fill\":\"dc\",\"value\":1}}],\"steps\":[{}],\"frames\":{},\"fnv1a64\":\"{}\",\"splits\":{{\"splitQuanta\":{},\"voiceSplits\":{}}},\"toggles\":[{}]}}\n",
        "Rv1, O1: a bus with a reverb send muted (the send stops feeding, the tail rings out), unmuted, then turned down to 0.25 (the send follows): post-fader",
        PRESET.0,
        PRESET.1,
        PRESET.2,
        s.steps.join(","),
        s.left.len(),
        fnv1a64(&s.left, &s.right),
        music.split_quanta,
        music.voice_splits,
        s.toggles.iter().map(|(a, n)| format!("[{a},{n}]")).collect::<Vec<_>>().join(","),
    );
    let path = format!("{}/../../../../src/plugins/audio/runtime/golden/m5/{NAME}.json", env!("CARGO_MANIFEST_DIR"));
    if std::env::var("UPDATE_GOLDENS").as_deref() == Ok("1") {
        std::fs::create_dir_all(std::path::Path::new(&path).parent().unwrap()).unwrap();
        std::fs::write(&path, json).unwrap();
        return;
    }
    let want = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("no fixture; run UPDATE_GOLDENS=1 cargo test -p audio-core --test sends_post_fader_golden"));
    assert!(want == json, "the scene no longer matches golden/m5/{NAME}.json (rerun with UPDATE_GOLDENS=1 and review the diff)");
}
