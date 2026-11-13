//! M5 wire records (ADR 0171 sections 4.2 and 4.3; the M5 part of the section 4.5 fuzz rows): round
//! trip of the five new records, truncation, over-count, NaN and infinite targets, the three new
//! STATUS sections at their caps, the header fields at 176..255, and the zero and worst cases.
//!
//! The codec is the spec's wire, not the core's behaviour: a lane 7, a slot 0xFFFF or a loudBuses
//! flag sum that disagrees with loudEnergyCount is accepted here; the refusals belong to K1/B1a
//! (the core) and to StatusReader (Wa2).

use audio_wire::generated::*;
use std::fmt::Debug;

/// The five M5 records share one shape: write at a base, read back with the consumed length.
trait Record: Clone + Debug + PartialEq + Sized {
    fn enc(&self, out: &mut [u8], base: usize) -> Result<usize, i32>;
    fn dec(buf: &[u8], base: usize) -> Result<(Self, usize), i32>;
}

macro_rules! record {
    ($($t:ty),*) => {$(
        impl Record for $t {
            fn enc(&self, out: &mut [u8], base: usize) -> Result<usize, i32> {
                <$t>::write(self, out, base)
            }
            fn dec(buf: &[u8], base: usize) -> Result<(Self, usize), i32> {
                <$t>::read(buf, base)
            }
        }
    )*};
}
record!(BusRamp, BusDuck, BusPresence, LoudConfig, BusSlot);

const BUF: usize = 4096;

/// Writes `value`, checks the returned length against the head's words field, reads it back equal
/// and returns the written bytes.
fn round_trip<T: Record>(value: &T) -> Vec<u8> {
    let mut buf = vec![0u8; BUF];
    let n = value.enc(&mut buf, 0).unwrap_or_else(|e| panic!("write {value:?}: code {e}"));
    let words = u16::from_le_bytes([buf[2], buf[3]]) as usize;
    assert_eq!(n, 4 * words, "returned length is 4 x the words field, for {value:?}");
    let (back, used) = T::dec(&buf[..n], 0).unwrap_or_else(|e| panic!("read {value:?}: code {e}"));
    assert_eq!(&back, value);
    assert_eq!(used, n, "the reader consumes the whole record");
    buf[..n].to_vec()
}

/// Every cut shorter than the record is an error, never a panic.
fn every_cut_is_err<T: Record>(bytes: &[u8]) {
    for len in 0..bytes.len() {
        assert!(T::dec(&bytes[..len], 0).is_err(), "cut to {len} of {} B must be an error", bytes.len());
    }
}

fn patch_u16(bytes: &mut [u8], off: usize, v: u16) {
    bytes[off..off + 2].copy_from_slice(&v.to_le_bytes());
}

fn patch_u32(bytes: &mut [u8], off: usize, v: u32) {
    bytes[off..off + 4].copy_from_slice(&v.to_le_bytes());
}

fn effect(i: usize) -> BusSlotEffects {
    BusSlotEffects {
        type_: (i % 4) as u32,
        p: [i as f32 * 0.5, 1.0, -2.0, 0.25, 8.0, 0.0, 1.5],
    }
}

fn rule(i: usize) -> BusDuckRules {
    BusDuckRules {
        target: i as u16,
        trigger: i as u16 + 1,
        flags: (i % 4) as u32,
        threshold_db: -20.0 - i as f32,
        amount: 0.5,
        attack: 0.01,
        release: 0.2,
    }
}

fn meter(i: usize) -> LoudConfigMeters {
    LoudConfigMeters { slot: i as u16, reserved: 0 }
}

/// Case 1: round trip of each of the five records over the values the brief names.
#[test]
fn case1_round_trip_every_m5_record() {
    // BUS_RAMP: every lane 0..=6, masks 1, 2, 3, gains 0, 4, 1e-9, shapes with sequence 0, 1, 8191,
    // asap and stamped frames, and BUS_MASTER_OUT as the voice.
    for lane in 0..=6u16 {
        for mask in [1u16, 2, 3] {
            for gain in [0.0f32, 4.0, 1e-9] {
                for seq in [0u32, 1, 8191] {
                    let ramp = BusRamp {
                        voice_id: if lane == 0 { BUS_MASTER_OUT } else { 3 },
                        frame_offset: if lane % 2 == 0 { ASAP } else { 2400 },
                        lane,
                        mask,
                        gain,
                        lp_hz: 1000.0,
                        frames: 240,
                        shape: pack_ramp_shape(0, seq, 0),
                    };
                    round_trip(&ramp);
                }
            }
        }
    }
    assert_eq!(ramp_sequence_id(pack_ramp_shape(0, 8191, 0)), 8191);

    // BUS_SLOT: 0, 1, 4 and 5 effects, flags 0..=3, parent BUS_ROOT and a real parent, asap and stamped.
    for flags in 0..=3u16 {
        for parent in [BUS_ROOT as u16, 1] {
            for n in [0usize, 1, 4, 5] {
                let slot = BusSlot {
                    voice_id: 0,
                    frame_offset: if n % 2 == 0 { ASAP } else { 2400 },
                    slot: 2,
                    flags,
                    sequence_id: if n == 4 { 5 } else { 0 },
                    reserved: 0,
                    reserved2: 0,
                    parent,
                    effects: (0..n).map(effect).collect(),
                };
                round_trip(&slot);
            }
        }
    }

    // BUS_DUCK: 0, 1 and 32 rules.
    for n in [0usize, 1, 32] {
        let duck = BusDuck { voice_id: 0, frame_offset: ASAP, rules: (0..n).map(rule).collect() };
        let bytes = round_trip(&duck);
        assert_eq!(bytes.len(), 16 + 24 * n, "BUS_DUCK is 16 B plus 24 B per rule");
    }

    // LOUD_CONFIG: 0 and 8 meters.
    for n in [0usize, 8] {
        let config = LoudConfig {
            voice_id: 0,
            frame_offset: ASAP,
            tp_gate_dbfs: -7.0,
            meters: (0..n).map(meter).collect(),
        };
        let bytes = round_trip(&config);
        assert_eq!(bytes.len(), 20 + 4 * n, "LOUD_CONFIG is 20 B plus 4 B per meter");
    }

    // BUS_PRESENCE: masks 0, 1 and all ones, asap and stamped.
    for mask in [0u32, 1, 0xFFFF_FFFF] {
        for frame_offset in [ASAP, 2400] {
            let presence = BusPresence { voice_id: 0, frame_offset, mask };
            assert_eq!(round_trip(&presence).len(), 16);
        }
    }
}

/// Case 2: every cut of each record's bytes, from length 0 to n-1, is an error and never a panic.
#[test]
fn case2_every_truncation_is_an_error() {
    let ramp = BusRamp { lane: 2, mask: 3, gain: 0.5, lp_hz: 900.0, frames: 240, ..Default::default() };
    every_cut_is_err::<BusRamp>(&round_trip(&ramp));

    let duck = BusDuck { rules: vec![rule(0), rule(1)], ..Default::default() };
    every_cut_is_err::<BusDuck>(&round_trip(&duck));

    let presence = BusPresence { mask: 0x5, ..Default::default() };
    every_cut_is_err::<BusPresence>(&round_trip(&presence));

    let config = LoudConfig { tp_gate_dbfs: -7.0, meters: vec![meter(0), meter(8)], ..Default::default() };
    every_cut_is_err::<LoudConfig>(&round_trip(&config));

    let slot = BusSlot { slot: 1, sequence_id: 9, parent: 0, effects: vec![effect(0), effect(3)], ..Default::default() };
    every_cut_is_err::<BusSlot>(&round_trip(&slot));
}

/// Case 3: a count one past the records present is refused on read; a writer given one more than
/// the cap refuses with ERR_OVERSIZE. The codes are the generated reader's, asserted exactly.
#[test]
fn case3_over_count_is_refused() {
    // BUS_SLOT effectCount at offset 26: 3 claimed, 2 present. The reader runs out of bytes.
    let slot = BusSlot { effects: vec![effect(0), effect(1)], ..Default::default() };
    let mut bytes = round_trip(&slot);
    patch_u16(&mut bytes, 26, 3);
    assert_eq!(BusSlot::read(&bytes, 0), Err(ERR_TRUNCATED), "BUS_SLOT effectCount 3 of 2 present");

    // BUS_DUCK ruleCount at offset 12: 3 claimed, 2 present.
    let duck = BusDuck { rules: vec![rule(0), rule(1)], ..Default::default() };
    let mut bytes = round_trip(&duck);
    patch_u32(&mut bytes, 12, 3);
    assert_eq!(BusDuck::read(&bytes, 0), Err(ERR_TRUNCATED), "BUS_DUCK ruleCount 3 of 2 present");

    // LOUD_CONFIG meterCount at offset 16: 3 claimed, 2 present.
    let config = LoudConfig { meters: vec![meter(0), meter(1)], ..Default::default() };
    let mut bytes = round_trip(&config);
    patch_u32(&mut bytes, 16, 3);
    assert_eq!(LoudConfig::read(&bytes, 0), Err(ERR_TRUNCATED), "LOUD_CONFIG meterCount 3 of 2 present");

    // BUS_DUCK ruleCount 33 with the bytes present: over the cap, so the reader gives ERR_MALFORMED
    // (the generated reader checks the cap before the byte count).
    let duck32 = BusDuck { rules: (0..32).map(rule).collect(), ..Default::default() };
    let mut bytes = round_trip(&duck32);
    bytes.extend_from_slice(&[0u8; 24]);
    patch_u32(&mut bytes, 12, 33);
    let words = (bytes.len() / 4) as u16;
    patch_u16(&mut bytes, 2, words);
    assert_eq!(BusDuck::read(&bytes, 0), Err(ERR_MALFORMED), "BUS_DUCK ruleCount 33 with room for it");

    // LOUD_CONFIG meterCount 9 with the bytes present: ERR_MALFORMED, as for the rule count.
    let config8 = LoudConfig { meters: (0..8).map(meter).collect(), ..Default::default() };
    let mut bytes = round_trip(&config8);
    bytes.extend_from_slice(&[0u8; 4]);
    patch_u32(&mut bytes, 16, 9);
    let words = (bytes.len() / 4) as u16;
    patch_u16(&mut bytes, 2, words);
    assert_eq!(LoudConfig::read(&bytes, 0), Err(ERR_MALFORMED), "LOUD_CONFIG meterCount 9 with room for it");

    // The writer refuses one item over each cap.
    let mut buf = vec![0u8; BUF];
    let duck33 = BusDuck { rules: (0..33).map(rule).collect(), ..Default::default() };
    assert_eq!(duck33.write(&mut buf, 0), Err(ERR_OVERSIZE), "33 rules");
    let config9 = LoudConfig { meters: (0..9).map(meter).collect(), ..Default::default() };
    assert_eq!(config9.write(&mut buf, 0), Err(ERR_OVERSIZE), "9 meters");
}

/// Case 4: NaN and infinite targets round trip bit for bit (the wire carries them; the core clamps
/// or ignores them, K1/B1a). Compared by bit pattern, since NaN is not equal to itself.
#[test]
fn case4_nan_and_infinite_targets_round_trip_bit_exact() {
    let targets = [
        f32::from_bits(0x7fc0_0001),
        f32::from_bits(0xffc0_1234),
        f32::INFINITY,
        f32::NEG_INFINITY,
    ];
    let mut records = Vec::new();
    for t in targets {
        records.push(BusRamp { lane: 0, mask: 1, gain: t, lp_hz: 1000.0, frames: 240, ..Default::default() });
        records.push(BusRamp { lane: 2, mask: 2, gain: 1.0, lp_hz: t, frames: 240, ..Default::default() });
    }
    for value in records {
        let mut buf = vec![0u8; 64];
        let n = value.write(&mut buf, 0).unwrap();
        assert_eq!(&buf[16..20], &value.gain.to_bits().to_le_bytes(), "gain bits on the wire");
        assert_eq!(&buf[20..24], &value.lp_hz.to_bits().to_le_bytes(), "lpHz bits on the wire");
        let (back, used) = BusRamp::read(&buf[..n], 0).unwrap();
        assert_eq!(back.gain.to_bits(), value.gain.to_bits(), "gain bits: {value:?}");
        assert_eq!(back.lp_hz.to_bits(), value.lp_hz.to_bits(), "lpHz bits: {value:?}");
        assert_eq!(
            (back.voice_id, back.frame_offset, back.lane, back.mask, back.frames, back.shape),
            (value.voice_id, value.frame_offset, value.lane, value.mask, value.frames, value.shape),
        );
        assert_eq!(used, n);
    }
}

/// The M5 STATUS sections at their caps: 9 loudBuses (flags up to 0x7FF), 288 loudEnergies, 32 busDuck.
fn caps_block() -> StatusBlock {
    StatusBlock {
        loud_buses: (0..LOUD_METERS as usize)
            .map(|i| StatusLoudBusesItem {
                slot: if i == LOUD_METERS as usize - 1 { LOUD_OUTPUT_TAP as u16 } else { i as u16 },
                flags: 0x7FF - i as u16,
                first_seq: 100 + i as u32,
                true_peak: 0.25 * (i as f32 + 1.0),
                gated_quanta: 7 * i as u32,
            })
            .collect(),
        loud_energies: (0..MAX_LOUD_ENERGIES as usize).map(|i| i as f32 * 0.5 - 3.0).collect(),
        bus_duck: (0..MAX_DUCK_RULES as usize)
            .map(|i| StatusBusDuckItem { slot: i as u16, pad: 0, gain: i as f32 / 32.0 })
            .collect(),
        ..Default::default()
    }
}

/// Case 5: the three sections at their caps round trip; one past each cap is refused on write and
/// on read (a header count patched on a valid buffer); every truncation of a STATUS with all three
/// sections non-empty is an error.
#[test]
fn case5_status_m5_sections_at_caps_and_past_them() {
    let block = caps_block();
    let mut buf = vec![0u8; STATUS_BUFFER_BYTES as usize];
    let n = block.write(&mut buf, 0, 1).unwrap();
    assert_eq!(n, 256 + 9 * 16 + 288 * 4 + 32 * 8);
    assert_eq!(StatusBlock::read(&buf[..n], 0).unwrap(), (block.clone(), n));

    // One past each cap, refused on write.
    let mut over = caps_block();
    over.loud_buses.push(StatusLoudBusesItem::default());
    assert_eq!(over.write(&mut buf, 0, 1), Err(ERR_OVERSIZE), "10 loudBuses");
    let mut over = caps_block();
    over.loud_energies.push(0.0);
    assert_eq!(over.write(&mut buf, 0, 1), Err(ERR_OVERSIZE), "289 loudEnergies");
    let mut over = caps_block();
    over.bus_duck.push(StatusBusDuckItem::default());
    assert_eq!(over.write(&mut buf, 0, 1), Err(ERR_OVERSIZE), "33 busDuck");

    // One past each cap in the header, on a valid buffer: refused on read.
    for (off, value, what) in [(232usize, 10u16, "loudBusCount 10"), (234, 289, "loudEnergyCount 289"), (236, 33, "duckCount 33")] {
        let mut bad = buf[..n].to_vec();
        patch_u16(&mut bad, off, value);
        assert_eq!(StatusBlock::read(&bad, 0).unwrap_err(), ERR_OVERSIZE, "{what}");
    }

    // Every truncation of a STATUS with all three sections non-empty is an error.
    let small = StatusBlock {
        loud_buses: caps_block().loud_buses[..2].to_vec(),
        loud_energies: vec![1.0, 2.0, 3.0],
        bus_duck: caps_block().bus_duck[..2].to_vec(),
        ..Default::default()
    };
    let m = small.write(&mut buf, 0, 1).unwrap();
    assert_eq!(StatusBlock::read(&buf[..m], 0).unwrap(), (small.clone(), m));
    for len in 0..m {
        assert!(StatusBlock::read(&buf[..len], 0).is_err(), "STATUS cut to {len} of {m} B must be an error");
    }
}

/// Case 6: the worst case of every section at its cap, M4 and M5, with the M5 header fields set,
/// writes exactly STATUS_WORST_CASE_BYTES, fits the buffer and reads back equal. The body is the
/// worst-case block of tests/m4_gate.rs plus the three M5 sections.
#[test]
fn case6_worst_case_status_is_17824_bytes() {
    assert_eq!(STATUS_HEADER_BYTES, 256);
    assert_eq!(STATUS_BUFFER_BYTES, 20_480);
    assert_eq!(STATUS_WORST_CASE_BYTES, 17_824);
    assert_eq!(STATUS_BUFFER_BYTES - STATUS_WORST_CASE_BYTES, 2_656);
    // Header growth 176 -> 256 (80 B) plus the three sections at their caps (1,552 B).
    assert_eq!(STATUS_HEADER_BYTES - 176, 80);
    assert_eq!(LOUD_METERS as usize * 16 + MAX_LOUD_ENERGIES as usize * 4 + MAX_DUCK_RULES as usize * 8, 1_552);

    let mut full = StatusBlock {
        ended: vec![0; MAX_ENDED_PER_BLOCK as usize],
        demoted: vec![0; MAX_DEMOTED_PER_BLOCK as usize],
        starved: vec![0; MAX_STARVED_PER_BLOCK as usize],
        playheads: vec![Default::default(); MAX_PLAYHEADS_PER_BLOCK as usize],
        clip_events: vec![Default::default(); MAX_CLIP_EVENTS_PER_BLOCK as usize],
        stream_events: vec![Default::default(); MAX_STREAM_EVENTS_PER_BLOCK as usize],
        peaks: vec![Default::default(); 32],
        beds: vec![Default::default(); MAX_BEDS as usize],
        zones: vec![Default::default(); MAX_ZONE_SLOTS as usize],
        zone_events: vec![Default::default(); MAX_ZONE_EVENTS_PER_BLOCK as usize],
        music_rings: (0..MAX_MUSIC_RINGS as usize)
            .map(|i| StatusMusicRingsItem {
                stream_id: i as u32 + 1,
                epoch_flags: MUSIC_RING_PRIMED | MUSIC_RING_BOUND | (i as u32 + 1),
            })
            .collect(),
        group_starts: (0..MAX_GROUP_STARTS_PER_BLOCK as usize)
            .map(|i| StatusGroupStartsItem {
                group_id: i as u16 + 1,
                flags: GROUP_START_HELD as u16,
                slip_frames: i as u32,
                start_frame_lo: 0x1000 * i as u32,
                start_frame_hi: i as u32,
            })
            .collect(),
        busy_ms_total: 1.5,
        quanta_total: 2.0,
        wu_voices: 3.0,
        wu_buses: 4.0,
        wu_spatial: 5.0,
        wu_music: 6.0,
        wu_loudness: 7.0,
        clock_step_ms: 1,
        loud_sub_block_frames: 4_800,
        clock_steps: 2,
        loud_shed: 1,
        bus_records_early: 3,
        sidechain_late: 4,
        ..Default::default()
    };
    let caps = caps_block();
    full.loud_buses = caps.loud_buses;
    full.loud_energies = caps.loud_energies;
    full.bus_duck = caps.bus_duck;

    let mut buf = vec![0u8; STATUS_BUFFER_BYTES as usize];
    let n = full.write(&mut buf, 0, 1).unwrap();
    assert_eq!(n, STATUS_WORST_CASE_BYTES as usize);
    assert!(n <= STATUS_BUFFER_BYTES as usize);
    assert_eq!(StatusBlock::read(&buf, 0).unwrap(), (full.clone(), n));

    // Without the three M5 sections the same block is 1,552 B shorter.
    let mut without = full.clone();
    without.loud_buses.clear();
    without.loud_energies.clear();
    without.bus_duck.clear();
    assert_eq!(without.write(&mut buf, 0, 1).unwrap(), n - 1_552);
}

/// Case 7: the header M5 fields read 0 when unset. A default block writes 256 B with bytes 176..255
/// all zero and reads its three sections empty; a block whose M5 header is zeroed (an M4 header)
/// still reads its M4 sections and reads the M5 sections empty.
#[test]
fn case7_later_fields_read_zero() {
    let mut buf = vec![0u8; STATUS_BUFFER_BYTES as usize];
    let n = StatusBlock::default().write(&mut buf, 0, 1).unwrap();
    assert_eq!(n, 256);
    assert!(buf[176..256].iter().all(|b| *b == 0), "M5 header fields are zero in a default block");
    let (back, _) = StatusBlock::read(&buf[..n], 0).unwrap();
    assert!(back.loud_buses.is_empty() && back.loud_energies.is_empty() && back.bus_duck.is_empty());

    // An M4 header: the M5 bytes are zero, the M4 music rings are still there.
    let with_m5 = StatusBlock {
        music_rings: vec![StatusMusicRingsItem { stream_id: 3, epoch_flags: MUSIC_RING_PRIMED | 4 }],
        ..caps_block()
    };
    let n = with_m5.write(&mut buf, 0, 1).unwrap();
    buf[176..256].iter_mut().for_each(|b| *b = 0);
    let (back, _) = StatusBlock::read(&buf[..n], 0).unwrap();
    assert!(back.loud_buses.is_empty() && back.loud_energies.is_empty() && back.bus_duck.is_empty());
    assert_eq!(back.music_rings, with_m5.music_rings, "the M4 sections read as before");
}

/// Case 8: the codec does not check that the sum of loudBuses `flags & 0x3F` equals loudEnergyCount.
/// The flag sum is 1 + 2 = 3 and the energy count is 5, and the generated reader accepts the block.
/// The check belongs to StatusReader (Wa2), which owns the count sum, not to this codec.
#[test]
fn case8_count_sum_mismatch_is_accepted_by_the_codec() {
    let block = StatusBlock {
        loud_buses: vec![
            StatusLoudBusesItem { slot: 0, flags: 1, ..Default::default() },
            StatusLoudBusesItem { slot: 1, flags: 2, ..Default::default() },
        ],
        loud_energies: vec![0.0, 1.0, 2.0, 3.0, 4.0],
        ..Default::default()
    };
    let mut buf = vec![0u8; STATUS_BUFFER_BYTES as usize];
    let n = block.write(&mut buf, 0, 1).unwrap();
    assert_eq!(StatusBlock::read(&buf[..n], 0).unwrap(), (block.clone(), n));
}

/// Case 9: the wire accepts an unknown lane (7, 0xFFFF) and a slot past the configured count
/// (BUS_SLOT slot 0xFFFF). The core's refusal is tested in K1/B1a.
#[test]
fn case9_unknown_lane_and_slot_round_trip() {
    for lane in [7u16, 0xFFFF] {
        let ramp = BusRamp { voice_id: 1, frame_offset: ASAP, lane, mask: 1, gain: 1.0, frames: 240, ..Default::default() };
        round_trip(&ramp);
    }
    let slot = BusSlot { slot: 0xFFFF, parent: BUS_ROOT as u16, ..Default::default() };
    round_trip(&slot);
}
