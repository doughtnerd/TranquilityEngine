//! G1's scene recorder (0171/0172 M5-0): Z3's fixture format (`in_voice_goldens.rs`,
//! `sends_post_fader_golden.rs`) for the M5 goldens under `src/plugins/audio/runtime/golden/m5/`,
//! replayed bit for bit on the real wasm by `runtime/golden/audioGoldenM5.test.ts`.
//!
//! **The fixture**, as Z3's, plus three optional members:
//! - a send step may carry `firstFrame`: the batch header's first frame when it isn't the current
//!   frame (a batch that arrives late, ARCH §3.3); without it the batch is stamped at the current
//!   frame, as Z3's;
//! - `late`: the core's cumulative `lateCommands` and `maxLatenessFrames` after the last step;
//! - `null`: the native comparison with the scene's offline reference (`maxError` against
//!   `tolerance`, over the frames `[from, to)`), informational on the wasm side (the digests agree);
//! - `ds0`: the discontinuity check's windows (`[from, to, bound]`: the largest sample-to-sample
//!   step inside the window stays at or under `bound`), run on both sides;
//! - scene-specific members (`raw`), such as the presence duck's `busDuck` bounds.
//!
//! `UPDATE_GOLDENS=1 cargo test -p audio-core --test <file>` writes a fixture; without it the test
//! compares. Every scene here is new in M5: no M1–M4 fixture is written by these tests.
#![allow(dead_code)]

#[path = "../common/mod.rs"]
pub mod common;

use audio_core::status;
use audio_wire::generated as wire;
use common::*;

/// The fixture preset: `(maxLogical, maxMixed, maxBuses)`; no limiter look-ahead (latency 0).
pub const PRESET: (u32, u32, u32) = (64, 16, 8);

/// The largest step between neighbouring samples of `x` (`runtime/golden/maxStep.ts`, F-40).
pub fn max_step(x: &[f32]) -> f32 {
    x.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max)
}

/// FNV-1a 64 over `left`'s f32 bytes then `right`'s, as 16 lowercase hex digits (Z3's digest).
pub fn fnv1a64(left: &[f32], right: &[f32]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for x in left.iter().chain(right) {
        for b in x.to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("{h:016x}")
}

/// A scene: a mixer with no look-ahead, its records as hex steps, its output.
pub struct Scene {
    pub m: Mixer,
    pub steps: Vec<String>,
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

impl Scene {
    pub fn new() -> Scene {
        let mut m = Mixer::new(PRESET.2);
        m.set_lookahead(0.0);
        assert_eq!(m.latency(), 0);
        Scene { m, steps: Vec::new(), left: Vec::new(), right: Vec::new() }
    }

    /// The first frame of the next quantum.
    pub fn frame(&self) -> u64 {
        self.m.frame
    }

    /// One BATCH at the current frame.
    pub fn send(&mut self, recs: &[Rec]) {
        let bytes = batch(self.m.frame as f64, recs);
        let hex: String = bytes[32..].iter().map(|b| format!("{b:02x}")).collect();
        self.steps.push(format!("{{\"send\":\"{hex}\",\"count\":{}}}", recs.iter().map(Rec::count).sum::<usize>()));
        self.m.submit(recs);
    }

    /// One BATCH whose header names `first_frame` (stamped offsets count from it): a batch that
    /// arrives after its frame when `first_frame` is before the current frame.
    pub fn send_at(&mut self, first_frame: u64, recs: &[Rec]) {
        let bytes = batch(first_frame as f64, recs);
        let hex: String = bytes[32..].iter().map(|b| format!("{b:02x}")).collect();
        self.steps.push(format!("{{\"send\":\"{hex}\",\"count\":{},\"firstFrame\":{first_frame}}}", recs.iter().map(Rec::count).sum::<usize>()));
        assert_eq!(audio_core::scheduler::submit(&mut self.m.core, &bytes), 0, "the batch was refused");
    }

    pub fn run(&mut self, quanta: usize) {
        self.steps.push(format!("{{\"run\":{quanta}}}"));
        let (l, r) = self.m.render_n(quanta);
        self.left.extend(l);
        self.right.extend(r);
    }

    pub fn split_quanta(&self) -> u32 {
        status::counters(&self.m.core).music.split_quanta
    }

    pub fn late(&self) -> (u32, u32) {
        let c = status::counters(&self.m.core);
        (c.late_commands, c.max_lateness_frames)
    }

    pub fn early(&self) -> u16 {
        status::counters(&self.m.core).mix.bus_records_early
    }
}

/// A DC voice (the common DC clip, looping, mixed, centred) at `gain` on `bus`.
pub fn dc_at(voice: u32, bus: u16, gain: f32) -> Rec {
    let Rec::Play(mut p) = dc(voice, bus, 0.0) else { unreachable!() };
    p.gain = gain;
    Rec::Play(p)
}

/// A `BUS_RAMP` of `lane` on `bus` to `gain` over `frames`, stamped `offset` frames after its
/// batch's first frame.
pub fn stamped(bus: u32, lane: u32, gain: f32, frames: u32, offset: u32) -> Rec {
    Rec::Ramps(vec![wire::BusRamp { frame_offset: offset, ..lane_ramp(bus, lane, Some(gain), None, frames) }])
}

/// An asap `BUS_RAMP` of `lane` on `bus`.
pub fn asap(bus: u32, lane: u32, gain: f32, frames: u32) -> Rec {
    Rec::Ramps(vec![lane_ramp(bus, lane, Some(gain), None, frames)])
}

/// A `BUS_RAMP` of the `dip` lane on `bus`, tagged with structural sequence `seq` (C27).
pub fn dip(bus: u32, gain: f32, frames: u32, seq: u32, offset: u32) -> Rec {
    Rec::Ramps(vec![wire::BusRamp { frame_offset: offset, shape: wire::pack_ramp_shape(0, seq, 0), ..lane_ramp(bus, wire::LANE_DIP, Some(gain), None, frames) }])
}

/// A `BUS_SLOT` record (head included); an effect is `(type, p0, p1)`.
pub fn slot(slot: u16, flags: u16, seq: u16, parent: u16, effects: &[(u32, f32, f32)], offset: u32) -> Rec {
    let r = wire::BusSlot {
        voice_id: 0,
        frame_offset: offset,
        slot,
        flags,
        sequence_id: seq,
        reserved: 0,
        reserved2: 0,
        parent,
        effects: effects.iter().map(|&(t, p0, p1)| wire::BusSlotEffects { type_: t, p: [p0, p1, 0.0, 0.0, 0.0, 0.0, 0.0] }).collect(),
    };
    let mut b = vec![0u8; wire::BusSlot::FIXED_END + effects.len() * wire::BusSlotEffects::FIXED_END];
    r.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

/// One presence rule of `BUS_DUCK`: `(target, trigger slot, amount, attack s, release s)`.
pub type PresenceRule = (u16, u16, f32, f32, f32);

/// `BUS_DUCK` of presence rules (asap, replace-all).
pub fn duck_rules(rules: &[PresenceRule]) -> Rec {
    let r = wire::BusDuck {
        voice_id: 0,
        frame_offset: wire::ASAP,
        rules: rules.iter().map(|&(target, trigger, amount, attack, release)| wire::BusDuckRules { target, trigger, flags: 0, threshold_db: 0.0, amount, attack, release }).collect(),
    };
    let mut b = vec![0u8; wire::BusDuck::FIXED_END + rules.len() * wire::BusDuckRules::FIXED_END];
    r.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

/// `BUS_PRESENCE` of `mask`, stamped `offset` frames after its batch's first frame.
pub fn presence(mask: u32, offset: u32) -> Rec {
    let mut b = vec![0u8; wire::BusPresence::FIXED_END];
    wire::BusPresence { voice_id: 0, frame_offset: offset, mask }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

/// The per-sample offline reference of one lane under class B: from `start`, each event
/// `(frame, target, frames)` retargets the lane from its value at that frame, before that frame's
/// sample (architecture §4.5, "ramp start"); the law is `audio_dsp::ramp::Ramp`'s (linear, the
/// value advanced by one step per sample, landing on the target).
pub fn lane_reference(start: f32, events: &[(u64, f32, u32)], n: usize) -> Vec<f32> {
    let mut r = audio_dsp::ramp::Ramp::at(start);
    (0..n as u64)
        .map(|f| {
            for e in events.iter().filter(|e| e.0 == f) {
                r.set_target(e.1, e.2);
            }
            r.next()
        })
        .collect()
}

/// The same lane as an exact line in f64 (each segment `v0 + (target − v0)(k + 1)/frames` from
/// the line's own value at the event, then `target`): an arithmetic-independent reference.
pub fn lane_line(start: f64, events: &[(u64, f32, u32)], n: usize) -> Vec<f64> {
    let (mut v0, mut target, mut len, mut at) = (start, start, 0u64, 0u64);
    let mut value = start;
    (0..n as u64)
        .map(|f| {
            for e in events.iter().filter(|e| e.0 == f) {
                v0 = value;
                target = e.1 as f64;
                len = e.2 as u64;
                at = f;
            }
            let k = f - at;
            value = if k < len { v0 + (target - v0) * (k + 1) as f64 / len as f64 } else { target };
            value
        })
        .collect()
}

/// The largest `|a − want|` over `a[from..to]`, both channels.
pub fn max_error(s: &Scene, from: usize, to: usize, want: impl Fn(usize) -> f64) -> f64 {
    (from..to).map(|i| ((s.left[i] as f64 - want(i)).abs()).max((s.right[i] as f64 - want(i)).abs())).fold(0.0, f64::max)
}

/// Optional parts of a fixture.
#[derive(Default)]
pub struct Extra {
    /// `(maxError, tolerance, from, to)` against the offline reference.
    pub null: Option<(f64, f64, usize, usize)>,
    /// The discontinuity windows `(from, to, bound)`.
    pub ds0: Vec<(usize, usize, f32)>,
    /// Record the late counters.
    pub late: bool,
    /// More members, as JSON text starting with a comma.
    pub raw: String,
}

/// Writes (`UPDATE_GOLDENS=1`) or compares `golden/m5/<name>.json`.
pub fn write_or_check(test: &str, name: &str, about: &str, s: &Scene, extra: &Extra) {
    let music = &status::counters(&s.m.core).music;
    let mut tail = String::new();
    if extra.late {
        let (n, worst) = s.late();
        tail.push_str(&format!(",\"late\":{{\"lateCommands\":{n},\"maxLatenessFrames\":{worst}}}"));
    }
    if let Some((err, tol, from, to)) = extra.null {
        tail.push_str(&format!(",\"null\":{{\"maxError\":{err:e},\"tolerance\":{tol:e},\"from\":{from},\"to\":{to}}}"));
    }
    if !extra.ds0.is_empty() {
        let w: Vec<String> = extra.ds0.iter().map(|(a, b, bound)| format!("[{a},{b},{bound:e}]")).collect();
        tail.push_str(&format!(",\"ds0\":[{}]", w.join(",")));
    }
    tail.push_str(&extra.raw);
    let json = format!(
        "{{\"scene\":\"{name}\",\"about\":\"{about}\",\"preset\":{{\"maxLogical\":{},\"maxMixed\":{},\"maxBuses\":{},\"limiterLookaheadMs\":0}},\"clips\":[{{\"id\":{DC},\"frames\":64,\"fill\":\"dc\",\"value\":1}}],\"steps\":[{}],\"frames\":{},\"fnv1a64\":\"{}\",\"splits\":{{\"splitQuanta\":{},\"voiceSplits\":{}}}{tail}}}\n",
        PRESET.0,
        PRESET.1,
        PRESET.2,
        s.steps.join(","),
        s.left.len(),
        fnv1a64(&s.left, &s.right),
        music.split_quanta,
        music.voice_splits,
    );
    let path = format!("{}/../../../../src/plugins/audio/runtime/golden/m5/{name}.json", env!("CARGO_MANIFEST_DIR"));
    if std::env::var("UPDATE_GOLDENS").as_deref() == Ok("1") {
        std::fs::create_dir_all(std::path::Path::new(&path).parent().unwrap()).unwrap();
        std::fs::write(&path, json).unwrap();
        return;
    }
    let want = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("no golden/m5/{name}.json; run UPDATE_GOLDENS=1 cargo test -p audio-core --test {test}"));
    assert!(want == json, "the scene no longer matches golden/m5/{name}.json (rerun with UPDATE_GOLDENS=1 and review the diff)");
}
