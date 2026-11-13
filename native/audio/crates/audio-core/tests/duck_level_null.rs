//! Sc1 (0171/0172 M5c): the null test of level mode. Every M5 golden (`golden/m5/*.json`) replayed
//! with level rules whose thresholds sit above their triggers' levels gives the fixture's digest
//! bit for bit: a level rule that never fires leaves the duck lane at identity (skipped, R3), and
//! its detector reads without writing a sample.
//!
//! **How.** Each fixture's steps are replayed as `runtime/golden/audioGoldenM5.test.ts` replays
//! them (each `send` is a BATCH of the recorded records, stamped at the current frame or at its
//! `firstFrame`; each `run` renders quanta), on the fixture's preset with no limiter look-ahead.
//! Right after the first step one more BATCH sends `BUS_DUCK` with two level rules on the master
//! (bus 1's peak and bus 2's RMS, thresholds −5 dB, just over the loudest DC level the scenes
//! reach, −6.02 dB), plus the scene's own rules when it has some (the presence duck's), since `BUS_DUCK` replaces the table. Edges into
//! the master are already in the tree, so the order (and so the sums) is unchanged.

mod m5_common;

use audio_core::scheduler;
use audio_wire::generated as wire;
use m5_common::common::*;
use m5_common::fnv1a64;

/// A JSON string member's value (the fixtures are machine-written, one line).
fn str_member<'a>(json: &'a str, key: &str) -> &'a str {
    let k = format!("\"{key}\":\"");
    let at = json.find(&k).unwrap_or_else(|| panic!("no {key}")) + k.len();
    &json[at..at + json[at..].find('"').unwrap()]
}

fn num_member(json: &str, key: &str) -> Option<u64> {
    let k = format!("\"{key}\":");
    let at = json.find(&k)? + k.len();
    let end = json[at..].find(|c: char| !c.is_ascii_digit()).map_or(json.len(), |e| at + e);
    json[at..end].parse().ok()
}

/// The steps, as `(send hex, count, firstFrame)` or a run of quanta.
enum Step {
    Send(Vec<u8>, u32, Option<u64>),
    Run(usize),
}

fn steps(json: &str) -> Vec<Step> {
    let at = json.find("\"steps\":[").unwrap() + 9;
    let body = &json[at..at + json[at..].find(']').unwrap()];
    body.split('}')
        .filter(|s| s.contains('"'))
        .map(|s| {
            if s.contains("\"run\"") {
                Step::Run(num_member(s, "run").unwrap() as usize)
            } else {
                let hex = str_member(s, "send");
                let bytes = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
                Step::Send(bytes, num_member(s, "count").unwrap() as u32, num_member(s, "firstFrame"))
            }
        })
        .collect()
}

/// A BATCH of already-written records `body` (`count` of them), its header naming `first_frame`.
fn batch_of(first_frame: u64, body: &[u8], count: u32) -> Vec<u8> {
    let mut buf = vec![0u8; 32];
    buf.extend_from_slice(body);
    wire::Envelope::new(wire::kind::BATCH, 1, (buf.len() - 16) as u32).write(&mut buf, 0).unwrap();
    wire::BatchHeader { first_frame: first_frame as f64, count, flags: 0 }.write(&mut buf, 0).unwrap();
    buf
}

/// The level rules the null test adds, plus `own` (the scene's own rules).
fn duck_body(own: &[wire::BusDuckRules]) -> Vec<u8> {
    let mut rules = own.to_vec();
    rules.push(wire::BusDuckRules { target: 0, trigger: 1, flags: wire::DUCK_FLAG_LEVEL, threshold_db: -5.0, amount: 0.1, attack: 0.0, release: 0.05 });
    rules.push(wire::BusDuckRules { target: 0, trigger: 2, flags: wire::DUCK_FLAG_LEVEL | wire::DUCK_FLAG_RMS, threshold_db: -5.0, amount: 0.1, attack: 0.01, release: 0.05 });
    let mut b = vec![0u8; wire::BusDuck::FIXED_END + rules.len() * wire::BusDuckRules::FIXED_END];
    wire::BusDuck { voice_id: 0, frame_offset: wire::ASAP, rules }.write(&mut b, 0).unwrap();
    b
}

/// Replays fixture `name` with the level rules; returns (the fixture's digest, the replay's, the
/// level rules' detector levels at the end).
fn replay(name: &str, own: &[wire::BusDuckRules]) -> (String, String, Vec<f32>) {
    let path = format!("{}/../../../../src/plugins/audio/runtime/golden/m5/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let json = std::fs::read_to_string(&path).unwrap();
    let max_buses = num_member(&json, "maxBuses").unwrap() as u32;
    let mut m = Mixer::new(max_buses);
    m.set_lookahead(0.0);
    let (mut left, mut right) = (Vec::new(), Vec::new());
    for (i, step) in steps(&json).into_iter().enumerate() {
        match step {
            Step::Send(body, count, first) => {
                let msg = batch_of(first.unwrap_or(m.frame), &body, count);
                assert_eq!(scheduler::submit(&mut m.core, &msg), 0, "{name}: step {i} refused");
            }
            Step::Run(n) => {
                let (l, r) = m.render_n(n);
                left.extend(l);
                right.extend(r);
            }
        }
        if i == 0 {
            let msg = batch_of(m.frame, &duck_body(own), 1);
            assert_eq!(scheduler::submit(&mut m.core, &msg), 0, "{name}: the rules refused");
        }
    }
    let d = audio_core::duck::area(&mut m.core.regions_mut().duck[..]).unwrap();
    let levels = d.detectors[..d.level_count as usize].iter().map(|x| x.level_db).collect();
    (str_member(&json, "fnv1a64").to_string(), fnv1a64(&left, &right), levels)
}

#[test]
fn every_m5_golden_keeps_its_digest_with_level_rules_under_their_thresholds() {
    // The presence duck's own rule (`m5_presence_golden.rs`: target 1, trigger slot 2).
    let presence = [wire::BusDuckRules { target: 1, trigger: 2, flags: 0, threshold_db: 0.0, amount: 0.4, attack: 0.05, release: 0.3 }];
    let names = ["bus-mute-send", "late-sequence", "presence-duck", "stamped-fade", "stamped-slot", "stamped-snapshot", "tombstone", "two-sends"];
    let mut heard = 0;
    for name in names {
        let own: &[wire::BusDuckRules] = if name == "presence-duck" { &presence } else { &[] };
        let (want, got, levels) = replay(name, own);
        eprintln!("{name}: {got} (fixture {want}); detector levels {levels:?} dB");
        assert_eq!(got, want, "{name}: the digest changed with level rules under their thresholds");
        assert_eq!(levels.len(), 2);
        assert!(levels.iter().all(|&l| l < -5.0), "{name}: a level reached the threshold");
        heard += levels.iter().any(|&l| l > -100.0) as usize;
    }
    assert!(heard >= 6, "the detectors read signal in most scenes ({heard} of {})", names.len());
}
