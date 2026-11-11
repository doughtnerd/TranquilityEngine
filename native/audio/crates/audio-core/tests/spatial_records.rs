//! ADR 0162 K2: the scheduler routes SET_VOICE_FX, BED_CONFIG, ZONE_CONFIG and LISTENER to their
//! stub handlers (parsed, then dropped), and refuses a malformed one with the whole batch
//! (api-and-models §9: "parse refusal for every new record"). Until A4, C3 and B3 fill the
//! handlers and hooks, a batch carrying them renders bit for bit what it renders without them.
//! D1 applies SET_VOICE_FX (`tests/voice_filters.rs`), so this file's no-change check sends it
//! with only `yaw`, which nothing reads before B3.

mod common;

use audio_core::status;
use audio_wire::generated as wire;
use common::*;

const V1: u32 = 0x0001_0001;

fn raw<F: Fn(&mut [u8]) -> usize>(write: F) -> Rec {
    let mut buf = vec![0u8; 1024];
    let n = write(&mut buf);
    buf.truncate(n);
    Rec::Raw(buf)
}

fn voice_fx() -> Rec {
    voice_fx_masked(wire::SET_VOICE_FX_MASK_HP_HZ | wire::SET_VOICE_FX_MASK_SENDS | wire::SET_VOICE_FX_MASK_AUX)
}

fn voice_fx_masked(mask: u32) -> Rec {
    raw(|b| {
        wire::SetVoiceFx {
            voice_id: V1,
            frame_offset: wire::ASAP,
            mask,
            ramp_frames: 128,
            hp_hz: 400.0,
            send: [0.5, 0.25, 0.0, 1.0],
            yaw: 0.0,
            aux_level: 0.5,
            aux_bus: 0,
            reserved: 0,
        }
        .write(b, 0)
        .unwrap()
    })
}

fn bed_config(bed_slot: Vec<u8>, host_bus: Vec<u16>) -> Rec {
    raw(|b| wire::BedConfig { voice_id: 0, frame_offset: wire::ASAP, bed_slot: bed_slot.clone(), host_bus: host_bus.clone() }.write(b, 0).unwrap())
}

fn zone_config(slots: usize) -> Rec {
    raw(|b| {
        let slot = wire::ZoneConfigSlots { kernel_id: wire::ZONE_KERNEL_ID_FIRST, return_bus: 0, state: 1, reserved: 0, wet: 1.0, ir_frames: 96_000 };
        wire::ZoneConfig { voice_id: 0, frame_offset: wire::ASAP, shared_return_gain: 0.5, ramp_frames: 128, slots: vec![slot; slots] }.write(b, 0).unwrap()
    })
}

fn listener(q: [f32; 4]) -> Rec {
    raw(|b| wire::Listener { voice_id: 0, frame_offset: wire::ASAP, qx: q[0], qy: q[1], qz: q[2], qw: q[3], ramp_frames: 128, flags: wire::LISTENER_FLAGS_SNAP }.write(b, 0).unwrap())
}

/// `rec` with its head's `words` cut by `less` words (the bytes stay, so only the length lies).
fn shortened(rec: Rec, less: u16) -> Rec {
    let Rec::Raw(mut b) = rec else { unreachable!() };
    let words = u16::from_le_bytes([b[2], b[3]]) - less;
    b[2..4].copy_from_slice(&words.to_le_bytes());
    b.truncate(words as usize * 4);
    Rec::Raw(b)
}

/// `rec` with the u32 at byte `at` replaced.
fn patched(rec: Rec, at: usize, value: u32) -> Rec {
    let Rec::Raw(mut b) = rec else { unreachable!() };
    b[at..at + 4].copy_from_slice(&value.to_le_bytes());
    Rec::Raw(b)
}

fn render(with_m3: bool) -> Vec<f32> {
    let mut m = Mixer::new(4);
    m.submit(&[config(&[ROOT, 0])]);
    let mut recs = vec![dc(V1, 1, 0.5)];
    if with_m3 {
        recs.extend([voice_fx_masked(wire::SET_VOICE_FX_MASK_YAW), bed_config(vec![0, 0xFF], vec![0]), zone_config(3), listener([0.0, 0.0, 0.0, 1.0])]);
    }
    m.submit(&recs);
    let (l, r) = m.render_n(8);
    // RESET runs the M3 handlers' resets too.
    m.submit(&[reset(true)]);
    l.into_iter().chain(r).collect()
}

#[test]
fn m3_records_are_accepted_and_change_nothing_until_their_tasks() {
    let plain = render(false);
    let with_m3 = render(true);
    assert!(plain.iter().any(|x| *x != 0.0));
    assert_eq!(plain.iter().map(|x| x.to_bits()).collect::<Vec<_>>(), with_m3.iter().map(|x| x.to_bits()).collect::<Vec<_>>());
}

/// Every refusal: the batch returns `ERR_MALFORMED` and its PLAY never applies.
fn refused(bad: Rec, what: &str) {
    let mut m = Mixer::new(4);
    assert_eq!(m.try_submit(&[dc(V1, 0, 0.0), bad]), wire::ERR_MALFORMED, "{what}");
    let (l, _) = m.render_n(2);
    assert!(l.iter().all(|x| *x == 0.0), "{what}: nothing applied");
    assert_eq!(status::counters(&m.core).live_voices, 0, "{what}: nothing applied");
}

#[test]
fn malformed_m3_records_refuse_the_batch() {
    refused(shortened(voice_fx(), 1), "SET_VOICE_FX of 48 B");
    refused(shortened(listener([0.0, 0.0, 0.0, 1.0]), 1), "LISTENER of 32 B");
    refused(shortened(zone_config(0), 1), "ZONE_CONFIG shorter than its fixed part");
    refused(shortened(bed_config(vec![], vec![]), 1), "BED_CONFIG shorter than its fixed part");
    // Counts the record can't hold.
    refused(patched(zone_config(2), 12, 3), "ZONE_CONFIG claiming 3 slots in 2 slots' bytes");
    refused(patched(zone_config(4), 12, 5), "ZONE_CONFIG with 5 slots");
    refused(patched(bed_config(vec![0; 4], vec![0, 1]), 12, 5), "BED_CONFIG with bedSlot past its length");
    refused(patched(bed_config(vec![0; 4], vec![0, 1, 2, 3]), 16, 5), "BED_CONFIG with 5 slots");
    refused(patched(bed_config(vec![0; 4], vec![0, 1]), 12, u32::MAX), "BED_CONFIG with a huge busCount");
}

#[test]
fn edge_shapes_are_accepted() {
    let mut m = Mixer::new(4);
    // No buses or slots, odd counts that pad, 4 zone slots, a NaN or zero rotation (the wire carries
    // it; B3's handler ignores it).
    m.submit(&[bed_config(vec![], vec![]), bed_config(vec![0, 0xFF, 1], vec![0, 0xFFFF, 2]), zone_config(0), zone_config(4)]);
    m.submit(&[listener([f32::NAN, 0.0, 0.0, 1.0]), listener([0.0; 4])]);
}
