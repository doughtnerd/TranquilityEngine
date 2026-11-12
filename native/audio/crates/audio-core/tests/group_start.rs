//! 0166 M4a, C2b (architecture §2.2, §3.1, §3.6, §4.3; api-and-models §3.1, §4.1, §4.4): the group
//! gate in the render loop. A gated PLAY (`gate` = 10-bit id + 6-bit size) holds its voice SCHEDULED
//! until every member of its group is present and ready (a decoded member always; a streamed one
//! once its music ring holds 4,096 frames of its epoch or its input ended); then every member starts
//! on one frame: the stamp when all are ready by its quantum, else the first quantum where they are
//! (a late start, reported with its slip). A group not started 1 s after its stamp is abandoned.
//! Each start, late start and abandon is one `groupStarts` item in STATUS.
//!
//! "One frame" is checked twice: every member's playhead has advanced by the same number of frames
//! (decoded and streamed members alike start their reads at frame 0 at the context rate), and the
//! mix of their DC signals steps once, from silence to the full sum, on the start frame (plus the
//! output latency).

use audio_core::clips::ClipFormat;
use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::status::{self, BUFFER_BYTES};
use audio_core::voices::{self, state};
use audio_core::{bus, groups, scheduler, Core, InitParams, QUANTUM};
use audio_wire::generated::{self as wire, Envelope, StatusBlock, StreamOpen};

const RATE: f32 = 48_000.0;
const Q: u64 = QUANTUM as u64;
/// 1 s at 48 kHz: the give-up.
const GIVE_UP: u64 = 48_000;
/// A decoded member's clip frames (longer than any test runs).
const CLIP_FRAMES: u32 = 4 * 48_000;

/// A core with 4 general rings (64 mixed voices) and 8 music rings, the limiter's look-ahead 0.
fn new_core() -> Core {
    let p = InitParams { sample_rate: RATE, max_logical: 64, max_mixed: 64, max_buses: 4, arena_initial_bytes: 0, max_music_rings: 8, ..InitParams::default() };
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose ('static).
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: a fresh block of `layout.total()` zeroed bytes, aligned to PAGE_BYTES.
    let mut core = unsafe { Core::new(p, layout, base) };
    assert!(bus::set_limiter_lookahead(&mut core, 0.0));
    core
}

/// The rig: a core, the next quantum's frame, and every output sample so far (left channel).
struct Rig {
    core: Core,
    frame: u64,
    out: Vec<f32>,
}

impl Rig {
    fn new() -> Rig {
        Rig { core: new_core(), frame: 0, out: Vec::new() }
    }

    /// A decoded mono DC clip `id` of `level`.
    fn clip(&mut self, id: u32, level: f32) {
        self.core.clips_mut().reserve(id, CLIP_FRAMES, 1, RATE, ClipFormat::F32).unwrap();
        let bytes: Vec<u8> = (0..CLIP_FRAMES).flat_map(|_| level.to_le_bytes()).collect();
        self.core.clips_mut().write(id, 0, &bytes).unwrap();
    }

    /// STREAM_OPEN of music stream `id` (stereo, epoch 1), as the worker posts it.
    fn open(&mut self, id: u32) {
        let o = StreamOpen { stream_id: id, channels: 2, sample_rate: RATE, total_frames: wire::STREAM_TOTAL_FRAMES_UNKNOWN, flags: wire::STREAM_OPEN_FLAG_MUSIC, epoch: 1, ..Default::default() };
        let mut buf = vec![0u8; StreamOpen::FIXED_END];
        Envelope::new(wire::kind::STREAM_OPEN, 0, (buf.len() - 16) as u32).write(&mut buf, 0).unwrap();
        o.write(&mut buf, 0).unwrap();
        assert_eq!(scheduler::submit(&mut self.core, &buf), wire::ERR_OK);
    }

    /// Commits `frames` (≤ 4,096) stereo frames of DC `level` to stream `id`.
    fn feed(&mut self, id: u32, frames: u32, level: f32) {
        let p = self.core.streams_mut().chunk_ptr(id, frames).expect("room for the chunk") as *mut f32;
        for i in 0..frames as usize * 2 {
            // SAFETY: chunk_ptr handed out room for `frames` stereo f32 frames.
            unsafe { *p.add(i) = level };
        }
        assert_eq!(self.core.streams_mut().commit(id, frames, 1, 0), wire::ERR_OK);
    }

    fn submit(&mut self, recs: &[Vec<u8>]) {
        let body: usize = recs.iter().map(|r| r.len()).sum();
        let mut buf = vec![0u8; 32 + body];
        let mut at = 32;
        for r in recs {
            buf[at..at + r.len()].copy_from_slice(r);
            at += r.len();
        }
        Envelope::new(wire::kind::BATCH, 1, (buf.len() - 16) as u32).write(&mut buf, 0).unwrap();
        wire::BatchHeader { first_frame: self.frame as f64, count: recs.len() as u32, flags: 0 }.write(&mut buf, 0).unwrap();
        assert_eq!(scheduler::submit(&mut self.core, &buf), wire::ERR_OK);
    }

    /// Renders `n` quanta.
    fn render(&mut self, n: usize) {
        for _ in 0..n {
            let out = self.core.process(self.frame);
            self.out.extend_from_slice(&out[..QUANTUM]);
            status::after_quantum(&mut self.core);
            self.frame += Q;
        }
    }

    /// Renders up to and including the quantum holding `frame`.
    fn render_through(&mut self, frame: u64) {
        while self.frame <= frame {
            self.render(1);
        }
    }

    fn slot(&self, voice: u32) -> voices::VoiceSlot {
        voices::slots(&self.core)[(voice & 0xFFFF) as usize]
    }

    fn take(&mut self) -> StatusBlock {
        let mut out = vec![0u8; BUFFER_BYTES];
        let n = status::take(&mut self.core, &mut out, 0);
        assert!(n > 0);
        StatusBlock::read(&out, 0).expect("the generated reader accepts the block").0
    }

    fn table_free(&self) -> bool {
        groups::entries_of(self.core.regions().groups).iter().all(|e| e.state == groups::state::FREE)
    }

    /// The output (left) is 0 before `onset` and one constant level from it for `len` samples:
    /// every member stepped in on that one sample.
    fn one_step_at(&self, onset: usize, len: usize) -> f32 {
        let latency = bus::output_latency_frames(&self.core) as usize;
        let at = onset + latency;
        assert!(self.out[..at].iter().all(|&s| s == 0.0), "silent before the start frame {onset}: first sound at {:?}", self.out.iter().position(|&s| s != 0.0));
        let level = self.out[at];
        assert!(level > 0.0, "sounding at the start frame {onset}");
        for (k, &s) in self.out[at..at + len].iter().enumerate() {
            assert!((s - level).abs() < 1e-6, "one step: frame {} is {s}, the start frame {level}", onset + k);
        }
        level
    }
}

const fn voice(i: u32) -> u32 {
    0x0001_0000 | i
}

fn play(voice_id: u32, clip: u32, stream: bool, at: u32, gate: u16) -> Vec<u8> {
    let mut flags = wire::PLAY_FLAGS_MIXED;
    if stream {
        flags |= wire::PLAY_FLAGS_STREAM;
    }
    let p = wire::Play { voice_id, frame_offset: at, clip, bus: 0, flags, gain: 1.0, pitch: 1.0, dir_z: -1.0, lp_hz: wire::BUS_LP_OFF_HZ as f32, gate, ..Default::default() };
    let mut b = vec![0u8; wire::Play::FIXED_END];
    p.write(&mut b, 0).unwrap();
    b
}

fn stop(voice_id: u32) -> Vec<u8> {
    let mut b = vec![0u8; wire::Stop::FIXED_END];
    wire::Stop { voice_id, frame_offset: wire::ASAP, ..Default::default() }.write(&mut b, 0).unwrap();
    b
}

fn fade(voice_id: u32, at: u32, target: f32, frames: u32) -> Vec<u8> {
    let mut b = vec![0u8; wire::Fade::FIXED_END];
    wire::Fade { voice_id, frame_offset: at, target, frames, ..Default::default() }.write(&mut b, 0).unwrap();
    b
}

fn reset() -> Vec<u8> {
    let mut b = vec![0u8; wire::Reset::FIXED_END];
    wire::Reset { voice_id: 0, frame_offset: wire::ASAP, keep_clips: 1 }.write(&mut b, 0).unwrap();
    b
}

/// Eight stems, members 0..3 decoded (clips 1..4), members 4..7 streamed (streams 101..104), all
/// gated in group `id` and stamped at `stamp`. Streams in `fed` get two chunks (8,192 frames, ready);
/// the others one half chunk (2,048, not ready).
fn eight_stems(r: &mut Rig, id: u32, stamp: u32, fed: &[u32]) -> Vec<u32> {
    let gate = wire::pack_gate(id, 8);
    let mut recs = Vec::new();
    for i in 0..4u32 {
        r.clip(1 + i, 0.01 * (1 + i) as f32);
        recs.push(play(voice(i), 1 + i, false, stamp, gate));
    }
    for i in 4..8u32 {
        let s = 97 + i;
        r.open(s);
        if fed.contains(&s) {
            r.feed(s, 4_096, 0.02);
            r.feed(s, 4_096, 0.02);
        } else {
            r.feed(s, 2_048, 0.02);
        }
        recs.push(play(voice(i), s, true, stamp, gate));
    }
    r.submit(&recs);
    (0..8).map(voice).collect()
}

fn group_starts(s: &StatusBlock) -> Vec<(u16, u16, u32, u64)> {
    s.group_starts.iter().map(|g| (g.group_id, g.flags, g.slip_frames, (g.start_frame_hi as u64) << 32 | g.start_frame_lo as u64)).collect()
}

/// Every member has played the same number of frames: they started on one frame.
fn same_playhead(r: &Rig, members: &[u32], expect: f64) {
    for &m in members {
        let s = r.slot(m);
        assert_eq!(s.state, state::PLAYING, "member {m:#x} plays");
        assert_eq!(s.position, expect, "member {m:#x}'s playhead: every member started on one frame");
    }
}

#[test]
fn eight_stems_decoded_and_streamed_start_on_one_frame() {
    let mut r = Rig::new();
    // The stamp mid-quantum: frame 1,000 is sample 104 of the quantum at 896.
    let stamp = 1_000u32;
    let members = eight_stems(&mut r, 7, stamp, &[101, 102, 103, 104]);
    r.render_through(stamp as u64 - Q);
    for &m in &members {
        assert_eq!(r.slot(m).state, state::SCHEDULED, "held until the stamp");
        assert!(r.slot(m).flags2 & groups::FLAG2_GATED != 0);
    }
    let s = r.take();
    assert!(s.group_starts.is_empty());
    assert!(s.music_rings.iter().all(|m| m.epoch_flags & wire::MUSIC_RING_PRIMED != 0 && m.epoch_flags & wire::MUSIC_RING_BOUND == 0), "primed, not bound before the start");
    r.render_through(stamp as u64 + 3 * Q);
    // Started at 1,000; the quantum after the last rendered one starts at 1,408 (4 quanta from 896).
    same_playhead(&r, &members, (r.frame - stamp as u64) as f64);
    for &m in &members {
        assert_eq!(r.slot(m).flags2 & groups::FLAG2_GATED, 0, "let go");
    }
    let level = r.one_step_at(stamp as usize, 3 * QUANTUM);
    assert!(level > 0.05, "all eight in the step ({level})");
    let s = r.take();
    assert_eq!(group_starts(&s), [(7, 0, 0, stamp as u64)], "one on-time start, slip 0");
    assert_eq!((s.groups_late, s.max_slip_frames, s.late_commands, s.stream_starts_late), (0, 0, 0, 0));
    assert!(s.music_rings.iter().all(|m| m.epoch_flags & wire::MUSIC_RING_BOUND != 0), "every ring bound at the start");
    assert_eq!(r.take().group_starts.len(), 0, "reported once");
}

#[test]
fn a_slow_ring_delays_every_member_equally_and_they_start_on_one_frame() {
    let mut r = Rig::new();
    let stamp = 1_000u32;
    // Stream 103 holds only 2,048 frames: not ready at the stamp.
    let members = eight_stems(&mut r, 9, stamp, &[101, 102, 104]);
    r.render_through(stamp as u64 + 5 * Q);
    for &m in &members {
        assert_eq!(r.slot(m).state, state::SCHEDULED, "every member waits for the slow ring, decoded ones too");
    }
    assert!(r.out.iter().all(|&s| s == 0.0), "nothing sounds while the group waits");
    // The slow ring catches up between quanta: the group starts at the next quantum's frame.
    r.feed(103, 4_096, 0.02);
    let start = r.frame;
    r.render(3);
    same_playhead(&r, &members, (r.frame - start) as f64);
    r.one_step_at(start as usize, 2 * QUANTUM);
    let slip = (start - stamp as u64) as u32;
    let s = r.take();
    assert_eq!(group_starts(&s), [(9, wire::GROUP_START_LATE as u16, slip, start)], "a late start, its slip");
    assert_eq!((s.groups_late, s.max_slip_frames), (1, slip));
    assert_eq!((s.late_commands, s.stream_starts_late), (0, 0), "a held member isn't late; the group is");
}

#[test]
fn a_group_not_started_one_second_after_its_stamp_is_abandoned_and_frees_its_voices_and_rings() {
    let mut r = Rig::new();
    let stamp = 1_000u32;
    let members = eight_stems(&mut r, 11, stamp, &[101, 102, 103]);
    // At 1 s past the stamp it still waits (the give-up is strict).
    r.render_through(stamp as u64 + GIVE_UP);
    assert!(members.iter().all(|&m| r.slot(m).state == state::SCHEDULED));
    assert!(r.take().group_starts.is_empty());
    r.render(1);
    for &m in &members {
        assert_eq!(r.slot(m).state, state::FREE, "member {m:#x} ended and freed");
    }
    assert!(r.table_free(), "the entry is freed once reported");
    let s = r.take();
    let at = r.frame - Q;
    assert_eq!(group_starts(&s), [(11, wire::GROUP_START_ABANDONED as u16, (at - stamp as u64) as u32, at)]);
    assert_eq!(s.groups_abandoned, 1);
    let mut ended = s.ended.clone();
    ended.sort_unstable();
    assert_eq!(ended, members, "every member reported ended (main closes their streams)");
    assert!(r.out.iter().all(|&s| s == 0.0));
    // The rings: unbound, everything consumed, freed by main's STREAM_CLOSE.
    for id in 101..=104u32 {
        let ring = *r.core.streams().get(id).expect("open until main closes it");
        assert_eq!((ring.voice, ring.orphan, ring.consumed), (0, 1, ring.written), "ring {id} orphaned");
        assert!(r.core.streams_mut().close(id));
        assert!(r.core.streams().get(id).is_none(), "ring {id} freed");
    }
    assert_eq!(r.take().music_rings_open, 0);
}

#[test]
fn a_member_stopped_before_the_start_leaves_and_the_rest_start_without_it() {
    let mut r = Rig::new();
    let stamp = 2_000u32;
    // Stream 104 is the slow one; its member (7) is stopped before the stamp.
    let members = eight_stems(&mut r, 12, stamp, &[101, 102, 103]);
    r.render(4);
    r.submit(&[stop(voice(7))]);
    r.render_through(stamp as u64 + 2 * Q);
    let rest = &members[..7];
    same_playhead(&r, rest, (r.frame - stamp as u64) as f64);
    r.one_step_at(stamp as usize, 2 * QUANTUM);
    assert_eq!(r.slot(voice(7)).state, state::FREE);
    let s = r.take();
    assert_eq!(group_starts(&s), [(12, 0, 0, stamp as u64)], "on time: the stopped member doesn't hold it");
    assert!(s.ended.contains(&voice(7)));
    let e = groups::entries_of(r.core.regions().groups)[0];
    assert_eq!((e.id, e.size, e.present, e.state), (12, 7, 7, groups::state::STARTED), "the size shrank");
    // The members ending free the entry.
    r.submit(&rest.iter().map(|&m| stop(m)).collect::<Vec<_>>());
    r.render(1);
    assert!(r.table_free());
}

#[test]
fn reset_clears_the_group_table() {
    let mut r = Rig::new();
    eight_stems(&mut r, 13, 5_000, &[101]);
    r.render(2);
    assert!(!r.table_free());
    r.submit(&[reset()]);
    assert!(r.table_free(), "RESET frees every entry");
    // The same id is free again: a new group of one decoded member starts on its stamp.
    // (A PLAY's frame offset counts from the batch's first frame, the rig's next quantum.)
    let stamp = r.frame as u32 + 300;
    r.submit(&[play(voice(20), 1, false, 300, wire::pack_gate(13, 1))]);
    r.render_through(stamp as u64 + Q);
    assert_eq!(r.slot(voice(20)).state, state::PLAYING);
    assert_eq!(group_starts(&r.take()), [(13, 0, 0, stamp as u64)]);
}

#[test]
fn a_held_members_stamped_records_stay_parked_until_the_group_starts() {
    let mut r = Rig::new();
    let stamp = 1_000u32;
    let members = eight_stems(&mut r, 14, stamp, &[101, 102, 104]);
    // A FADE to 0.5 stamped at the group's stamp for a decoded and a streamed member.
    r.submit(&[fade(voice(0), stamp, 0.5, 0), fade(voice(6), stamp, 0.5, 0)]);
    r.render_through(stamp as u64 + 3 * Q);
    let due = audio_core::due::view(r.core.regions_mut());
    assert_eq!(due.parked().len(), 2, "both parked while the group waits");
    assert_eq!(r.slot(voice(0)).fade.value, 1.0);
    r.feed(103, 4_096, 0.02);
    let start = r.frame;
    r.render(1);
    assert_eq!(audio_core::due::view(r.core.regions_mut()).parked().len(), 0, "released at the start");
    for m in [voice(0), voice(6)] {
        assert_eq!(r.slot(m).fade.value, 0.5, "applied before the member's first sample");
    }
    same_playhead(&r, &members, (r.frame - start) as f64);
    let s = r.take();
    assert_eq!(s.late_commands, 0, "a held record isn't late");
    assert_eq!(s.groups_late, 1);
}

#[test]
fn an_ungated_stamped_stream_voice_whose_ring_isnt_ready_counts_stream_starts_late() {
    let mut r = Rig::new();
    r.open(101);
    r.feed(101, 2_048, 0.02);
    r.open(102);
    r.feed(102, 4_096, 0.02);
    r.submit(&[play(voice(1), 101, true, 300, 0), play(voice(2), 102, true, 300, 0)]);
    r.render(4);
    let s = r.take();
    assert_eq!(s.stream_starts_late, 1, "only the voice whose ring wasn't ready");
    assert!(s.group_starts.is_empty());
}

#[test]
fn an_asap_gated_group_starts_in_the_first_quantum_every_member_is_ready() {
    let mut r = Rig::new();
    r.clip(1, 0.1);
    r.open(101);
    r.feed(101, 2_048, 0.02);
    let gate = wire::pack_gate(30, 2);
    r.submit(&[play(voice(1), 1, false, wire::ASAP, gate), play(voice(2), 101, true, wire::ASAP, gate)]);
    r.render(2);
    assert_eq!(r.slot(voice(1)).state, state::SCHEDULED);
    r.feed(101, 4_096, 0.02);
    let start = r.frame;
    r.render(2);
    same_playhead(&r, &[voice(1), voice(2)], (r.frame - start) as f64);
    let g = group_starts(&r.take());
    assert_eq!(g, [(30, wire::GROUP_START_LATE as u16, 2 * Q as u32, start)], "late against its first quantum");
}

#[test]
fn group_starts_past_the_cap_carry_over_to_the_next_block() {
    let mut r = Rig::new();
    r.clip(1, 0.01);
    // Ten one-member groups stamped on the same frame: 8 in this block, 2 in the next.
    let stamp = 400u32;
    let recs: Vec<Vec<u8>> = (0..10u32).map(|i| play(voice(i), 1, false, stamp, wire::pack_gate(40 + i, 1))).collect();
    r.submit(&recs);
    r.render(4);
    let a = r.take();
    assert_eq!(a.group_starts.len(), 8);
    r.render(1);
    let b = r.take();
    assert_eq!(b.group_starts.len(), 2);
    let mut ids: Vec<u16> = a.group_starts.iter().chain(b.group_starts.iter()).map(|g| g.group_id).collect();
    ids.sort_unstable();
    assert_eq!(ids, (40..50).collect::<Vec<u16>>());
    assert!(a.group_starts.iter().chain(b.group_starts.iter()).all(|g| g.start_frame_lo == stamp && g.slip_frames == 0), "each with its own start frame, on time");
}
