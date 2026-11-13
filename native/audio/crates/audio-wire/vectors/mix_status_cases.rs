//! ADR 0171 M5 STATUS vectors: every section at its cap (17,824 B, the worst case) and the whole message at zero
//! (256 B). The bytes come from a small encoder that writes each field at its literal offset from API section 4.3,
//! never from the schema or the writers, so the cases still check the generator's layout against the spec's table.
//! Section items follow simple patterns in `i`. Included by `cases.rs`.

use super::{va, vf, vi, vr, vu};
use crate::model::Value;
use crate::vector::{Subject, VectorCase};

/// Little-endian byte sink.
struct Raw(Vec<u8>);

impl Raw {
    fn at(&mut self, off: usize, bytes: &[u8]) {
        self.0[off..off + bytes.len()].copy_from_slice(bytes);
    }
    fn push(&mut self, bytes: &[u8]) {
        self.0.extend_from_slice(bytes);
    }
}

fn hex_of(bytes: &[u8]) -> &'static str {
    Box::leak(bytes.iter().map(|b| format!("{b:02x}")).collect::<String>().into_boxed_str())
}

/// (name, offset, width: 'd' f64, 'w' u32, 'h' u16, 'i' i32): the stated (non-count) header fields.
const FIELDS: &[(&str, usize, char)] = &[
    ("currentFrame", 16, 'd'), ("dateMs", 24, 'd'), ("pingSeq", 32, 'w'), ("pingFrameLo", 36, 'w'), ("underruns", 40, 'w'),
    ("lateCommands", 44, 'w'), ("workUnits", 48, 'w'), ("workUnitsMax", 52, 'w'), ("mixedVoices", 56, 'h'), ("liveVoices", 58, 'h'),
    ("flags", 60, 'w'), ("mixedCap", 78, 'h'), ("loadPermille", 80, 'h'), ("traps", 82, 'h'), ("minSlackFrames", 84, 'i'),
    ("underrunFrames", 88, 'w'), ("arenaUsedKB", 92, 'w'), ("arenaLargestFreeKB", 96, 'w'), ("abiVersion", 100, 'w'),
    ("maxLatenessFrames", 104, 'w'), ("hrtfVoices", 108, 'h'), ("hrtfLoadFailure", 110, 'h'), ("bedVoices", 112, 'h'),
    ("fxVoices", 116, 'h'), ("ambisonicVoices", 118, 'h'), ("zonesActive", 120, 'h'), ("zonesRinging", 122, 'h'),
    ("bedsRefused", 126, 'h'), ("m3Shed", 130, 'h'), ("zoneUsedKB", 132, 'w'), ("workBed", 136, 'w'), ("workZones", 140, 'w'),
    ("musicRingsOpen", 148, 'h'), ("streamStartsLate", 150, 'h'), ("groupsLate", 152, 'h'), ("groupsHeld", 154, 'h'),
    ("groupsAbandoned", 156, 'h'), ("curvePoolFull", 158, 'h'), ("maxSlipFrames", 160, 'w'), ("splitQuanta", 164, 'w'),
    ("voiceSplits", 168, 'w'), ("busyMsTotal", 176, 'd'), ("quantaTotal", 184, 'd'), ("wuVoices", 192, 'd'), ("wuBuses", 200, 'd'),
    ("wuSpatial", 208, 'd'), ("wuMusic", 216, 'd'), ("wuLoudness", 224, 'd'), ("clockStepMs", 238, 'h'),
    ("loudSubBlockFrames", 240, 'w'), ("clockSteps", 244, 'h'), ("loudShed", 246, 'h'), ("busRecordsEarly", 248, 'h'),
    ("sidechainLate", 250, 'h'), ("reserved2", 252, 'w'),
];

/// Section counts at the caps: (count offset, count).
const COUNTS: [(usize, u16); 15] = [
    (64, 1024), (66, 1024), (68, 1024), (70, 256), (72, 32), (74, 64), (76, 64), (114, 4), (124, 16), (128, 4), (144, 16),
    (146, 8), (232, 9), (234, 288), (236, 32),
];

const SECTION_NAMES: [&str; 15] = [
    "ended", "demoted", "starved", "playheads", "clipEvents", "streamEvents", "peaks", "beds", "zones", "zoneEvents", "musicRings",
    "groupStarts", "loudBuses", "loudEnergies", "busDuck",
];

/// Two-u32 items: (field a, field b, pattern, count).
fn pairs(raw: &mut Raw, a: &'static str, b: &'static str, f: &dyn Fn(u32) -> (u32, u32), n: u32) -> Value {
    let mut items = Vec::new();
    for i in 0..n {
        let (x, y) = f(i);
        raw.push(&x.to_le_bytes());
        raw.push(&y.to_le_bytes());
        items.push(vr(vec![(a, vu(x as u64)), (b, vu(y as u64))]));
    }
    va(items)
}

fn cap_sections(raw: &mut Raw) -> Vec<(&'static str, Value)> {
    let mut s: Vec<(&'static str, Value)> = Vec::new();
    for (name, d) in [("ended", 0u32), ("demoted", 1), ("starved", 2)] {
        let mut items = Vec::new();
        for i in 0..1024u32 {
            raw.push(&(i + d).to_le_bytes());
            items.push(vu((i + d) as u64));
        }
        s.push((name, va(items)));
    }
    s.push(("playheads", pairs(raw, "id", "clipFrame", &|i| (i, i * 3), 256)));
    s.push(("clipEvents", pairs(raw, "clipId", "code", &|i| (i, 1 + i % 5), 64)));
    s.push(("streamEvents", pairs(raw, "id", "code", &|i| (i, 1 + i % 3), 64)));
    let mut items = Vec::new();
    for i in 0..32u32 {
        let l = i as f32 / 64.0;
        raw.push(&l.to_bits().to_le_bytes());
        raw.push(&0.5f32.to_bits().to_le_bytes());
        items.push(vr(vec![("l", vf(l as f64)), ("r", vf(0.5))]));
    }
    s.push(("peaks", va(items)));
    let mut items = Vec::new();
    for i in 0..4u32 {
        raw.push(&(i as u16).to_le_bytes());
        raw.push(&2u16.to_le_bytes());
        raw.push(&(100 + i).to_le_bytes());
        items.push(vr(vec![("bus", vu(i as u64)), ("voices", vu(2)), ("work", vu(100 + i as u64))]));
    }
    s.push(("beds", va(items)));
    let mut items = Vec::new();
    for i in 0..4u32 {
        raw.push(&(0xFFFF_0200 + i).to_le_bytes());
        raw.push(&[3u8, 0]);
        raw.push(&(i as u16).to_le_bytes());
        raw.push(&0.5f32.to_bits().to_le_bytes());
        items.push(vr(vec![
            ("kernelId", vu(0xFFFF_0200 + i as u64)),
            ("state", vu(3)),
            ("pad", vu(0)),
            ("quantaSinceInput", vu(i as u64)),
            ("wetPeak", vf(0.5)),
        ]));
    }
    s.push(("zones", va(items)));
    let mut items = Vec::new();
    for i in 0..16u32 {
        raw.push(&[(i % 4) as u8, (1 + i % 3) as u8, 0, 0]);
        items.push(vr(vec![("slot", vu((i % 4) as u64)), ("code", vu((1 + i % 3) as u64)), ("reserved", vu(0))]));
    }
    s.push(("zoneEvents", va(items)));
    s.push(("musicRings", pairs(raw, "streamId", "epochFlags", &|i| (i + 1, 0x4000_0000 | i), 16)));
    let mut items = Vec::new();
    for i in 0..8u32 {
        raw.push(&(i as u16 + 1).to_le_bytes());
        raw.push(&((i % 8) as u16).to_le_bytes());
        raw.push(&(i * 128).to_le_bytes());
        raw.push(&(1000 + i).to_le_bytes());
        raw.push(&i.to_le_bytes());
        items.push(vr(vec![
            ("groupId", vu(i as u64 + 1)),
            ("flags", vu((i % 8) as u64)),
            ("slipFrames", vu((i * 128) as u64)),
            ("startFrameLo", vu(1000 + i as u64)),
            ("startFrameHi", vu(i as u64)),
        ]));
    }
    s.push(("groupStarts", va(items)));
    // The M5 sections: loudBuses (9 x 16 B), loudEnergies (288 x 4 B), busDuck (32 x 8 B).
    let mut items = Vec::new();
    for i in 0..9u32 {
        let slot: u16 = if i == 8 { 0xFFFF } else { i as u16 };
        let peak = i as f32 / 8.0;
        raw.push(&slot.to_le_bytes());
        raw.push(&((i % 33) as u16).to_le_bytes());
        raw.push(&(1000 + i).to_le_bytes());
        raw.push(&peak.to_bits().to_le_bytes());
        raw.push(&(i * 7).to_le_bytes());
        items.push(vr(vec![
            ("slot", vu(slot as u64)),
            ("flags", vu((i % 33) as u64)),
            ("firstSeq", vu(1000 + i as u64)),
            ("truePeak", vf(peak as f64)),
            ("gatedQuanta", vu((i * 7) as u64)),
        ]));
    }
    s.push(("loudBuses", va(items)));
    let mut items = Vec::new();
    for i in 0..288u32 {
        let e = i as f32 / 1024.0;
        raw.push(&e.to_bits().to_le_bytes());
        items.push(vf(e as f64));
    }
    s.push(("loudEnergies", va(items)));
    let mut items = Vec::new();
    for i in 0..32u32 {
        let g = 1.0 - i as f32 / 64.0;
        raw.push(&(i as u16).to_le_bytes());
        raw.push(&0u16.to_le_bytes());
        raw.push(&g.to_bits().to_le_bytes());
        items.push(vr(vec![("slot", vu(i as u64)), ("pad", vu(0)), ("gain", vf(g as f64))]));
    }
    s.push(("busDuck", va(items)));
    s
}

/// The two vectors: `STATUS_m5_every_section_at_its_cap` (seq 60) and `STATUS_m5_at_zero` (seq 61).
pub fn mix_status_cases() -> Vec<VectorCase> {
    let mut out = Vec::new();
    for full in [true, false] {
        let mut raw = Raw(vec![0u8; 256]);
        let mut values: Vec<(&'static str, Value)> = Vec::new();
        for (k, (name, off, w)) in FIELDS.iter().enumerate() {
            let v: u64 = if !full || *name == "reserved2" { 0 } else if *name == "flags" { 0x7F } else { k as u64 + 1 };
            match w {
                'd' => raw.at(*off, &(v as f64).to_le_bytes()),
                'w' => raw.at(*off, &(v as u32).to_le_bytes()),
                'h' => raw.at(*off, &(v as u16).to_le_bytes()),
                _ => raw.at(*off, &(if full { -3i32 } else { 0 }).to_le_bytes()),
            }
            let value = match w {
                'd' => vf(v as f64),
                'i' => vi(if full { -3 } else { 0 }),
                _ => vu(v),
            };
            values.push((name, value));
        }
        let sections = if full {
            for (off, n) in COUNTS {
                raw.at(off, &n.to_le_bytes());
            }
            cap_sections(&mut raw)
        } else {
            SECTION_NAMES.iter().map(|n| (*n, va(vec![]))).collect()
        };
        let seq: u32 = if full { 60 } else { 61 };
        let mut bytes = Raw(Vec::new());
        bytes.push(&0x4D59_4131u32.to_le_bytes());
        bytes.push(&0x0103u16.to_le_bytes());
        bytes.push(&9u16.to_le_bytes());
        bytes.push(&seq.to_le_bytes());
        bytes.push(&(raw.0.len() as u32 - 16).to_le_bytes());
        bytes.push(&raw.0[16..]);
        values.insert(0, ("seq", vu(seq as u64)));
        values.extend(sections);
        out.push(VectorCase {
            name: if full { "STATUS_m5_every_section_at_its_cap" } else { "STATUS_m5_at_zero" },
            subject: Subject::Status,
            values,
            hex: hex_of(&bytes.0),
        });
    }
    out
}
