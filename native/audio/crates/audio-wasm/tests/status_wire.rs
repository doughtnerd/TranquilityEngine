//! The status writer (`audio_core::status`) against the wire schema (contract K1): every field the
//! writer puts down is read back by `audio-wire`'s generated `StatusBlock::read`. A drift between
//! the writer's offsets and the schema fails here.

use audio_core::counters::{flag, Counters, Event, Playhead, CLIP_EVENTS_CAP, ENDED_CAP, PEAKS_CAP, PLAYHEADS_CAP};
use audio_core::status::{write, BUFFER_BYTES};
use audio_wire::generated::StatusBlock;

#[test]
#[ignore = "A0.3 core: needs A0.3-L2's counters"]
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
    c.flags = flag::READY | flag::ADAPTIVE_CAP_ACTIVE;
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

    let mut out = vec![0u8; BUFFER_BYTES];
    let n = write(&c, 5, &mut out);
    let (s, read) = StatusBlock::read(&out, 0).expect("the generated reader accepts the writer's bytes");
    assert_eq!(read, n);
    assert_eq!(s.current_frame, 98_765_432.0);
    assert_eq!(s.date_ms, 1_700_000_000_123.0);
    assert_eq!((s.ping_seq, s.ping_frame_lo, s.underruns, s.late_commands), (1, 2, 3, 4));
    assert_eq!((s.work_units, s.work_units_max, s.mixed_voices, s.live_voices), (5, 6, 7, 8));
    assert_eq!(s.flags, flag::READY | flag::ADAPTIVE_CAP_ACTIVE);
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
}

#[test]
#[ignore = "A0.3 core: needs A0.3-L2's counters"]
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
    let mut out = vec![0u8; BUFFER_BYTES];
    let n = write(&c, 0, &mut out);
    assert_eq!(n, 15_728);
    let (s, _) = StatusBlock::read(&out, 0).unwrap();
    assert_eq!(s.ended.len(), ENDED_CAP);
    assert_eq!(s.demoted[5], 10_005);
    assert_eq!(s.starved[ENDED_CAP - 1], 20_000 + ENDED_CAP as u32 - 1);
    assert_eq!(s.playheads[PLAYHEADS_CAP - 1].clip_frame, (PLAYHEADS_CAP as u32 - 1) * 2);
    assert_eq!(s.stream_events.len(), CLIP_EVENTS_CAP);
    assert_eq!(s.peaks.len(), PEAKS_CAP);
}
