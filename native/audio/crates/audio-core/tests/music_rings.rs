//! 0166 M4, C1 (api-and-models §3.1, §4.3, §4.4; architecture §2.3, §4.2): the music ring pool.
//! A `music` STREAM_OPEN takes only a ring of the music pool (indices `G..G + M`) and an open
//! without the flag never does; a full music pool refuses with stream event 4 (`musicFull`), never
//! falling back to a general ring; STATUS lists every open music ring each block with its epoch,
//! primed and bound bits, and `musicRingsOpen`.

use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::status::{self, BUFFER_BYTES};
use audio_core::{scheduler, Core, InitParams};
use audio_wire::generated::{self as wire, Envelope, StatusBlock, StreamOpen};

const G: usize = 4;
const M: usize = 4;

/// A core with `G` = 4 general rings (64 mixed voices) and `M` = 4 music rings.
fn new_core() -> Core {
    let p = InitParams { sample_rate: 48_000.0, max_logical: 256, max_mixed: 64, max_buses: 8, arena_initial_bytes: 0, max_music_rings: M as u32, ..InitParams::default() };
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose ('static).
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: a fresh block of `layout.total()` zeroed bytes, aligned to PAGE_BYTES.
    unsafe { Core::new(p, layout, base) }
}

fn rec(id: u32, channels: u32, music: bool, epoch: u32) -> StreamOpen {
    let flags = if music { wire::STREAM_OPEN_FLAG_MUSIC } else { 0 };
    StreamOpen { stream_id: id, channels, sample_rate: 48_000.0, total_frames: wire::STREAM_TOTAL_FRAMES_UNKNOWN, flags, epoch, ..Default::default() }
}

/// STREAM_OPEN as the worker posts it (envelope and body), through `scheduler::submit`.
fn open(core: &mut Core, o: &StreamOpen) -> i32 {
    let mut buf = vec![0u8; StreamOpen::FIXED_END];
    Envelope::new(wire::kind::STREAM_OPEN, 0, (buf.len() - 16) as u32).write(&mut buf, 0).unwrap();
    o.write(&mut buf, 0).unwrap();
    scheduler::submit(core, &buf)
}

fn close(core: &mut Core, id: u32) {
    assert!(core.streams_mut().close(id));
}

/// Commits `frames` (≤ 4,096) silent stereo frames of stream `id` at `epoch`.
fn feed(core: &mut Core, id: u32, frames: u32, epoch: u32, last: bool) {
    let p = core.streams_mut().chunk_ptr(id, frames).expect("room for the chunk");
    // SAFETY: chunk_ptr handed out room for `frames` stereo f32 frames.
    unsafe { core::ptr::write_bytes(p, 0, frames as usize * 8) };
    let flags = if last { wire::STREAM_CHUNK_FLAGS_LAST } else { 0 };
    assert_eq!(core.streams_mut().commit(id, frames, epoch, flags), wire::ERR_OK);
}

fn take(core: &mut Core) -> StatusBlock {
    let mut out = vec![0u8; BUFFER_BYTES];
    let n = status::take(core, &mut out, 0);
    assert!(n > 0);
    let (s, read) = StatusBlock::read(&out, 0).expect("the generated reader accepts the block");
    assert_eq!(read, n);
    s
}

fn stream_events(s: &StatusBlock) -> Vec<(u32, u32)> {
    s.stream_events.iter().map(|e| (e.id, e.code)).collect()
}

#[test]
fn music_and_general_streams_never_take_each_others_rings() {
    let mut core = new_core();
    assert_eq!((core.streams().general_count(), core.streams().music_count()), (G, M));
    // The general pool fills, then refuses (event 3) with every music ring still free.
    for id in 1..=G as u32 {
        assert_eq!(open(&mut core, &rec(id, 2, false, 1)), wire::ERR_OK);
        assert!(core.streams().index_of(id).unwrap() < G, "a general stream takes a general ring");
    }
    assert_eq!(open(&mut core, &rec(50, 2, false, 1)), wire::ERR_BAD_ARG);
    assert_eq!(stream_events(&take(&mut core)), [(50, wire::stream_event::ERROR)]);
    // The music pool fills, each in G..G+M, then refuses (event 4) with a general ring free.
    close(&mut core, 1);
    for id in 101..=100 + M as u32 {
        assert_eq!(open(&mut core, &rec(id, 1 + id % 2, true, 1)), wire::ERR_OK);
        let i = core.streams().index_of(id).unwrap();
        assert!((G..G + M).contains(&i) && core.streams().is_music(i), "a music stream takes a music ring");
    }
    assert_eq!(open(&mut core, &rec(200, 2, true, 1)), wire::ERR_BAD_ARG);
    let s = take(&mut core);
    assert_eq!(stream_events(&s), [(200, wire::stream_event::MUSIC_FULL)]);
    assert_eq!(core.streams().index_of(200), None, "never a fall back to the free general ring");
    assert_eq!(core.streams().music_refused(), 1);
    // The free general ring still takes a general stream; the full music pool still refuses.
    assert_eq!(open(&mut core, &rec(51, 2, false, 1)), wire::ERR_OK);
    assert!(core.streams().index_of(51).unwrap() < G);
    assert_eq!(open(&mut core, &rec(201, 2, true, 1)), wire::ERR_BAD_ARG);
    assert_eq!(stream_events(&take(&mut core)), [(201, wire::stream_event::MUSIC_FULL)]);
    // A closed music ring returns to the music pool only.
    close(&mut core, 102);
    assert_eq!(open(&mut core, &rec(52, 2, false, 1)), wire::ERR_BAD_ARG, "general pool full; the music ring isn't taken");
    assert_eq!(stream_events(&take(&mut core)), [(52, wire::stream_event::ERROR)]);
    assert_eq!(open(&mut core, &rec(202, 2, true, 1)), wire::ERR_OK);
    assert!(core.streams().is_music(core.streams().index_of(202).unwrap()));
}

#[test]
fn a_music_open_with_an_unusable_shape_or_a_pool_change_is_event_3() {
    let mut core = new_core();
    // A music stream is 1-2 channels (the pool's rings are narrow).
    assert_eq!(open(&mut core, &rec(1, 4, true, 1)), wire::ERR_BAD_ARG);
    // A restart can't move a stream between pools, either way.
    assert_eq!(open(&mut core, &rec(2, 2, true, 1)), wire::ERR_OK);
    assert_eq!(open(&mut core, &rec(2, 2, false, 2)), wire::ERR_BAD_ARG);
    assert_eq!(open(&mut core, &rec(3, 2, false, 1)), wire::ERR_OK);
    assert_eq!(open(&mut core, &rec(3, 2, true, 2)), wire::ERR_BAD_ARG);
    let e = wire::stream_event::ERROR;
    assert_eq!(stream_events(&take(&mut core)), [(1, e), (2, e), (3, e)]);
    assert_eq!(core.streams().music_refused(), 0);
    // A music restart at a new epoch keeps its ring.
    let i = core.streams().index_of(2).unwrap();
    assert_eq!(open(&mut core, &rec(2, 2, true, 3)), wire::ERR_OK);
    assert_eq!((core.streams().index_of(2), core.streams().ring(i).epoch), (Some(i), 3));
}

#[test]
fn without_music_rings_a_music_open_is_refused_as_full() {
    let p = InitParams { sample_rate: 48_000.0, max_logical: 256, max_mixed: 64, max_buses: 8, arena_initial_bytes: 0, ..InitParams::default() };
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: as `new_core`.
    let mut core = unsafe { Core::new(p, layout, std::alloc::alloc_zeroed(block)) };
    assert_eq!((core.streams().general_count(), core.streams().music_count()), (G, 0));
    assert_eq!(open(&mut core, &rec(1, 2, true, 1)), wire::ERR_BAD_ARG);
    assert_eq!(stream_events(&take(&mut core)), [(1, wire::stream_event::MUSIC_FULL)]);
    assert_eq!(open(&mut core, &rec(2, 2, false, 1)), wire::ERR_OK);
}

#[test]
fn status_lists_every_open_music_ring_with_epoch_primed_and_bound() {
    let mut core = new_core();
    let s = take(&mut core);
    assert_eq!((s.music_rings.len(), s.music_rings_open), (0, 0));
    assert_eq!(open(&mut core, &rec(7, 2, false, 1)), wire::ERR_OK); // general: never listed
    assert_eq!(open(&mut core, &rec(11, 2, true, 5)), wire::ERR_OK);
    assert_eq!(open(&mut core, &rec(12, 1, true, 9)), wire::ERR_OK);
    let flags = |s: &StatusBlock| s.music_rings.iter().map(|r| (r.stream_id, r.epoch_flags)).collect::<Vec<_>>();
    let s = take(&mut core);
    assert_eq!(s.music_rings_open, 2);
    assert_eq!(flags(&s), [(11, 5), (12, 9)]);
    // A level: the next block lists them again.
    assert_eq!(flags(&take(&mut core)), [(11, 5), (12, 9)]);
    // Primed at START_FRAMES (4,096) frames of the current epoch, not before.
    feed(&mut core, 11, 4_095, 5, false);
    assert_eq!(flags(&take(&mut core))[0], (11, 5));
    feed(&mut core, 11, 1, 5, false);
    assert_eq!(flags(&take(&mut core))[0], (11, 5 | wire::MUSIC_RING_PRIMED));
    // Or once the input ended, however short.
    feed(&mut core, 12, 100, 9, true);
    assert_eq!(flags(&take(&mut core))[1], (12, 9 | wire::MUSIC_RING_PRIMED));
    // A new epoch (a re-target) is not primed until its own 4,096 frames.
    assert_eq!(open(&mut core, &rec(11, 2, true, 6)), wire::ERR_OK);
    assert_eq!(flags(&take(&mut core))[0], (11, 6));
    feed(&mut core, 11, 4_096, 6, false);
    assert_eq!(flags(&take(&mut core))[0], (11, 6 | wire::MUSIC_RING_PRIMED));
    // Bound while a voice reads it (C2b binds; set here directly), not once that voice ended.
    let i = core.streams().index_of(11).unwrap();
    core.streams_mut().ring_mut(i).voice = 40;
    assert_eq!(flags(&take(&mut core))[0], (11, 6 | wire::MUSIC_RING_PRIMED | wire::MUSIC_RING_BOUND));
    core.streams_mut().release(11, 40);
    assert_eq!(flags(&take(&mut core))[0].1 & wire::MUSIC_RING_BOUND, 0);
    // Only the epoch's low 30 bits go in the word.
    assert_eq!(open(&mut core, &rec(13, 2, true, 0x4000_0003)), wire::ERR_OK);
    assert_eq!(flags(&take(&mut core))[2], (13, 3));
    // A closed ring leaves the list and the count.
    close(&mut core, 11);
    close(&mut core, 12);
    let s = take(&mut core);
    assert_eq!((flags(&s), s.music_rings_open), (vec![(13, 3)], 1));
}

#[test]
fn every_music_ring_open_is_listed_and_reset_frees_them() {
    let p = InitParams { sample_rate: 48_000.0, max_logical: 256, max_mixed: 256, max_buses: 8, arena_initial_bytes: 0, max_music_rings: 16, ..InitParams::default() };
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: as `new_core`.
    let mut core = unsafe { Core::new(p, layout, std::alloc::alloc_zeroed(block)) };
    assert_eq!((core.streams().general_count(), core.streams().music_count()), (16, 16));
    for id in 1..=16 {
        assert_eq!(open(&mut core, &rec(id, 2, true, id)), wire::ERR_OK);
        assert_eq!(open(&mut core, &rec(100 + id, 2, false, 1)), wire::ERR_OK);
    }
    let s = take(&mut core);
    assert_eq!((s.music_rings.len(), s.music_rings_open), (16, 16));
    assert!(s.music_rings.iter().enumerate().all(|(k, r)| r.stream_id == k as u32 + 1 && r.epoch_flags == k as u32 + 1));
    scheduler::reset(&mut core, true);
    let s = take(&mut core);
    assert_eq!((s.music_rings.len(), s.music_rings_open), (0, 0));
}
