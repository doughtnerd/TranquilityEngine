//! The status writer (`audio_core::status`) against the wire schema (contract K1): every field the
//! writer puts down is read back by `audio-wire`'s generated `StatusBlock::read`. A drift between
//! the writer's offsets and the schema fails here.

use audio_core::counters::{flag, BedStatus, Counters, Event, GroupStart, MusicRing, Playhead, ZoneEvent, ZoneStatus, BEDS_CAP, CLIP_EVENTS_CAP, ENDED_CAP, GROUP_STARTS_CAP, MUSIC_RINGS_CAP, PEAKS_CAP, PLAYHEADS_CAP, ZONES_CAP, ZONE_EVENTS_CAP};
use audio_core::status::{write, BUFFER_BYTES};
use audio_wire::generated::StatusBlock;

#[test]
fn every_counter_reads_back_through_the_generated_reader() {
    let mut c = Counters::default();
    c.current_frame = 98_765_432.0;
    c.date_ms = 1_700_000_000_123.0;
    c.ping_seq = 1;
    c.ping_frame_lo = 2;
    c.underruns = 3;
    c.late_commands = 4;
    c.work_units = 5;
    c.work_units_max = 6;
    c.mixed_voices = 7;
    c.live_voices = 8;
    c.flags = flag::READY | flag::ADAPTIVE_CAP_ACTIVE | flag::BED_DECODER_READY;
    c.mixed_cap = 9;
    c.load_permille = 10;
    c.traps = 11;
    c.note_slack(-12);
    c.underrun_frames = 13;
    c.arena_used_kb = 14;
    c.arena_largest_free_kb = 15;
    c.abi_version = 0x100;
    c.max_lateness_frames = 16;
    c.hrtf_voices = 17;
    c.hrtf_load_failure = 1;
    c.ended.push(100);
    c.demoted.push(101);
    c.starved.push(102);
    c.playheads.push(Playhead { id: 103, clip_frame: 104 });
    c.clip_events.push(Event { id: 105, code: 4 });
    c.stream_events.push(Event { id: 106, code: 3 });
    c.set_bus_count(1);
    c.set_peak(0, 0.5, -0.25);
    // ADR 0162 §4.3.
    let sp = &mut c.spatial;
    sp.bed_voices = 18;
    sp.fx_voices = 19;
    sp.ambisonic_voices = 20;
    sp.zones_active = 21;
    sp.zones_ringing = 22;
    sp.note_beds_refused(23);
    sp.zone_used_kb = 24;
    sp.work_bed = 25;
    sp.work_zones = 26;
    sp.beds_active = 1;
    sp.beds[0] = BedStatus { bus: 27, voices: 28, work: 29 };
    sp.zone_slots = 2;
    sp.zones[1] = ZoneStatus { kernel_id: 0xFFFF_0201, state: 4, _pad: 0, quanta_since_input: 30, wet_peak: 0.75 };
    sp.zone_events.push(ZoneEvent { slot: 1, code: 3 });

    let mut out = vec![0u8; BUFFER_BYTES];
    let n = write(&c, 5, &mut out);
    let (s, read) = StatusBlock::read(&out, 0).expect("the generated reader accepts the writer's bytes");
    assert_eq!(read, n);
    assert_eq!(s.current_frame, 98_765_432.0);
    assert_eq!(s.date_ms, 1_700_000_000_123.0);
    assert_eq!((s.ping_seq, s.ping_frame_lo, s.underruns, s.late_commands), (1, 2, 3, 4));
    assert_eq!((s.work_units, s.work_units_max, s.mixed_voices, s.live_voices), (5, 6, 7, 8));
    assert_eq!(s.flags, flag::READY | flag::ADAPTIVE_CAP_ACTIVE | flag::BED_DECODER_READY);
    assert_eq!((s.mixed_cap, s.load_permille, s.traps, s.min_slack_frames), (9, 10, 11, -12));
    assert_eq!((s.underrun_frames, s.arena_used_kb, s.arena_largest_free_kb, s.abi_version), (13, 14, 15, 0x100));
    assert_eq!((s.max_lateness_frames, s.hrtf_voices, s.hrtf_load_failure), (16, 17, 1));
    assert_eq!(s.ended, [100]);
    assert_eq!(s.demoted, [101]);
    assert_eq!(s.starved, [102]);
    assert_eq!((s.playheads[0].id, s.playheads[0].clip_frame), (103, 104));
    assert_eq!((s.clip_events[0].clip_id, s.clip_events[0].code), (105, 4));
    assert_eq!((s.stream_events[0].id, s.stream_events[0].code), (106, 3));
    assert_eq!((s.peaks[0].l, s.peaks[0].r), (0.5, -0.25));
    assert_eq!((s.bed_voices, s.fx_voices, s.ambisonic_voices, s.zones_active, s.zones_ringing, s.beds_refused), (18, 19, 20, 21, 22, 23));
    assert_eq!((s.zone_used_kb, s.work_bed, s.work_zones, s.m3_shed), (24, 25, 26, 0));
    assert_eq!((s.beds.len(), s.beds[0].bus, s.beds[0].voices, s.beds[0].work), (1, 27, 28, 29));
    assert_eq!(s.zones.len(), 2);
    assert_eq!((s.zones[0].kernel_id, s.zones[0].state), (0, 0));
    assert_eq!((s.zones[1].kernel_id, s.zones[1].state, s.zones[1].quanta_since_input, s.zones[1].wet_peak), (0xFFFF_0201, 4, 30, 0.75));
    assert_eq!((s.zone_events.len(), s.zone_events[0].slot, s.zone_events[0].code), (1, 1, 3));
}

#[test]
fn full_sections_read_back_in_order() {
    let mut c = Counters::default();
    for i in 0..ENDED_CAP as u32 {
        c.ended.push(i);
        c.demoted.push(i + 10_000);
        c.starved.push(i + 20_000);
    }
    for i in 0..PLAYHEADS_CAP as u32 {
        c.playheads.push(Playhead { id: i, clip_frame: i * 2 });
    }
    for i in 0..CLIP_EVENTS_CAP as u32 {
        c.clip_events.push(Event { id: i, code: 1 });
        c.stream_events.push(Event { id: i, code: 2 });
    }
    c.set_bus_count(PEAKS_CAP);
    c.spatial.beds_active = BEDS_CAP as u16;
    c.spatial.zone_slots = ZONES_CAP as u16;
    for i in 0..ZONE_EVENTS_CAP {
        c.spatial.zone_events.push(ZoneEvent { slot: i as u8, code: 2 });
    }
    // 0166 M4 §4.4 (C1): every music ring open, epoch i, primed on the odd ones, bound on the last.
    for i in 0..MUSIC_RINGS_CAP as u32 {
        let flags = i | if i % 2 == 1 { audio_wire::generated::MUSIC_RING_PRIMED } else { 0 } | if i == 15 { audio_wire::generated::MUSIC_RING_BOUND } else { 0 };
        assert!(c.music.music_rings.push(MusicRing { stream_id: 500 + i, epoch_flags: flags }));
    }
    // 0166 M4 §4.4 (C2b): eight group starts, the last one late and past 2^32 frames.
    for i in 0..GROUP_STARTS_CAP as u16 {
        let late = i == 7;
        assert!(c.music.group_starts.push(GroupStart { group_id: 100 + i, flags: late as u16, slip_frames: if late { 256 } else { 0 }, start_frame: if late { (1 << 32) + 5 } else { 1_000 * i as u64 } }));
    }
    let mut out = vec![0u8; BUFFER_BYTES];
    let n = write(&c, 0, &mut out);
    // M4 worst case 16,192 B with the 176-B header; the 256-B header (ADR 0171) adds 80 B. The 17,824 B case is K1's (k1_hooks.rs).
    assert_eq!(n, 16_192 - 176 + 256, "api-and-models §4.4 worst case under the 256-B header");
    let (s, _) = StatusBlock::read(&out, 0).unwrap();
    assert_eq!(s.music_rings.len(), MUSIC_RINGS_CAP);
    assert_eq!(s.group_starts.len(), GROUP_STARTS_CAP);
    let g = &s.group_starts[7];
    assert_eq!((g.group_id, g.flags, g.slip_frames, g.start_frame_lo, g.start_frame_hi), (107, 1, 256, 5, 1));
    assert_eq!((s.group_starts[3].group_id, s.group_starts[3].start_frame_lo), (103, 3_000));
    assert_eq!((s.music_rings[3].stream_id, s.music_rings[3].epoch_flags), (503, 3 | audio_wire::generated::MUSIC_RING_PRIMED));
    assert_eq!(s.music_rings[15].epoch_flags, 15 | audio_wire::generated::MUSIC_RING_PRIMED | audio_wire::generated::MUSIC_RING_BOUND);
    assert_eq!(s.ended.len(), ENDED_CAP);
    assert_eq!(s.demoted[5], 10_005);
    assert_eq!(s.starved[ENDED_CAP - 1], 20_000 + ENDED_CAP as u32 - 1);
    assert_eq!(s.playheads[PLAYHEADS_CAP - 1].clip_frame, (PLAYHEADS_CAP as u32 - 1) * 2);
    assert_eq!(s.stream_events.len(), CLIP_EVENTS_CAP);
    assert_eq!(s.peaks.len(), PEAKS_CAP);
    assert_eq!((s.beds.len(), s.zones.len(), s.zone_events.len()), (BEDS_CAP, ZONES_CAP, ZONE_EVENTS_CAP));
    assert_eq!(s.zone_events[ZONE_EVENTS_CAP - 1].slot as usize, ZONE_EVENTS_CAP - 1);
}
