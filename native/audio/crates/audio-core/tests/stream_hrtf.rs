//! B3 with H3: a stream voice pans like a clip voice, HRTF included. A spatial stream voice
//! flagged for HRTF takes a slot of the bank, counts in `hrtfVoices`, and renders exactly what a
//! clip voice of the same samples renders; unflagged, it takes the equal-power path.
//!
//! The limiter's look-ahead is 0 here, so the output is in core time.

use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::params::InitParams;
use audio_core::{bus, clips, scheduler, status, Core, QUANTUM};
use audio_dsp::hrtf::database::{encode, HrirHeader};
use audio_wire::generated::{self as wire, StreamOpen};

const RATE: f32 = 48_000.0;
const HRIR_ID: u32 = wire::HRIR_CLIP_ID_FIRST;
const CLIP: u32 = 1;
const STREAM: u32 = 0xFFFF_0100;
const VOICE: u32 = 0x0001_0001;
const FRAMES: usize = 16_000;
const LEFT: [f32; 3] = [-0.6, 0.0, -0.8];

fn new_core() -> Core {
    let p = InitParams { sample_rate: RATE, max_logical: 64, max_mixed: 32, max_buses: 4, arena_initial_bytes: 4 << 20 };
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose ('static).
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: a fresh block of `layout.total()` zeroed bytes, aligned to PAGE_BYTES.
    let mut core = unsafe { Core::new(p, layout, base) };
    assert!(bus::set_limiter_lookahead(&mut core, 0.0));
    core
}

/// A synthetic table: every response a 0.5 impulse, delays 3 (left) and 7.5 (right).
fn load_impulse_table(core: &mut Core) {
    let header = HrirHeader { elevations: 10, azimuths: 24, ir_length: 256, rate: RATE };
    let delays: Vec<f32> = (0..480).map(|i| if i % 2 == 0 { 3.0 } else { 7.5 }).collect();
    let mut irs = vec![0i16; 240 * 256 * 2];
    for d in 0..240 {
        irs[d * 512] = 16384;
        irs[d * 512 + 1] = 16384;
    }
    let mut bytes = vec![0u8; header.byte_len()];
    encode(&header, &delays, &irs, &mut bytes).unwrap();
    assert_eq!(clips::reserve(core, HRIR_ID, (bytes.len() / 2) as u32, 1, RATE, wire::clip_format::HRIR), wire::ERR_OK);
    for (k, chunk) in bytes.chunks(clips::MAX_CHUNK_BYTES).enumerate() {
        let at = (k * clips::MAX_CHUNK_BYTES / 2) as u32;
        let p = clips::chunk_ptr(core, HRIR_ID, at, chunk.len() as u32);
        assert!(!p.is_null());
        // SAFETY: chunk_ptr gave room for `chunk.len()` bytes.
        unsafe { core::ptr::copy_nonoverlapping(chunk.as_ptr(), p, chunk.len()) };
        assert_eq!(clips::commit(core, HRIR_ID, at, chunk.len() as u32), wire::ERR_OK);
    }
    assert!(core.clips().hrtf_bank().is_some());
}

fn sample(k: usize) -> f32 {
    0.25 * libm::sinf(2.0 * core::f32::consts::PI * k as f32 / 160.0)
}

fn submit_play(core: &mut Core, clip: u32, extra: u16, hrtf: bool) {
    let panner = if hrtf { wire::panner::HRTF as u16 } else { 0 };
    let rec = wire::Play {
        voice_id: VOICE,
        frame_offset: wire::ASAP,
        clip,
        bus: wire::BUS_ROOT as u16,
        flags: wire::PLAY_FLAGS_MIXED | wire::PLAY_FLAGS_SPATIAL | extra | (panner << wire::PLAY_FLAGS_PANNER_SHIFT),
        gain: 1.0,
        pitch: 1.0,
        dir_x: LEFT[0],
        dir_y: LEFT[1],
        dir_z: LEFT[2],
        lp_hz: wire::BUS_LP_OFF_HZ as f32,
        ..Default::default()
    };
    let mut buf = vec![0u8; 32 + 1024];
    let at = 32 + rec.write(&mut buf, 32).unwrap();
    buf.truncate(at);
    wire::Envelope::new(wire::kind::BATCH, 1, (buf.len() - 16) as u32).write(&mut buf, 0).unwrap();
    wire::BatchHeader { first_frame: 0.0, count: 1, flags: 0 }.write(&mut buf, 0).unwrap();
    assert_eq!(scheduler::submit(core, &buf), 0);
}

/// A mono clip voice of `FRAMES` frames of the sine.
fn clip_core(hrtf: bool) -> Core {
    let mut core = new_core();
    load_impulse_table(&mut core);
    core.clips_mut().reserve(CLIP, FRAMES as u32, 1, RATE, clips::ClipFormat::F32).unwrap();
    let bytes: Vec<u8> = (0..FRAMES).flat_map(|k| sample(k).to_le_bytes()).collect();
    core.clips_mut().write(CLIP, 0, &bytes).unwrap();
    submit_play(&mut core, CLIP, 0, hrtf);
    core
}

/// The same samples as a mono stream, all buffered before the first quantum (the input ended).
fn stream_core(hrtf: bool) -> Core {
    let mut core = new_core();
    load_impulse_table(&mut core);
    submit_play(&mut core, STREAM, wire::PLAY_FLAGS_STREAM as u16, hrtf);
    let o = StreamOpen { stream_id: STREAM, channels: 1, sample_rate: RATE, total_frames: FRAMES as u32, epoch: 1, ..Default::default() };
    assert!(core.streams_mut().open(&o));
    let mut at = 0;
    while at < FRAMES {
        let n = (FRAMES - at).min(4_096);
        let data: Vec<f32> = (at..at + n).map(sample).collect();
        let p = core.streams_mut().chunk_ptr(STREAM, n as u32).unwrap();
        // SAFETY: room for `n` mono frames.
        unsafe { core::ptr::copy_nonoverlapping(data.as_ptr(), p as *mut f32, n) };
        let last = if at + n == FRAMES { wire::STREAM_CHUNK_FLAGS_LAST } else { 0 };
        assert_eq!(core.streams_mut().commit(STREAM, n as u32, 1, last), wire::ERR_OK);
        at += n;
    }
    core
}

/// Renders `quanta` quanta; returns the planar output and `hrtfVoices` per quantum.
fn render(core: &mut Core, quanta: usize) -> (Vec<f32>, Vec<f32>, Vec<u16>) {
    let (mut l, mut r, mut h) = (vec![], vec![], vec![]);
    for q in 0..quanta {
        let out = core.process((q * QUANTUM) as u64).to_vec();
        l.extend_from_slice(&out[..QUANTUM]);
        r.extend_from_slice(&out[QUANTUM..2 * QUANTUM]);
        h.push(status::counters(core).hrtf_voices);
        status::counters_mut(core).end_block();
    }
    (l, r, h)
}

#[test]
fn a_stream_voice_flagged_for_hrtf_pans_with_hrtf_like_a_clip_voice() {
    let quanta = FRAMES / QUANTUM - 4;
    let (cl, cr, ch) = render(&mut clip_core(true), quanta);
    let (sl, sr, sh) = render(&mut stream_core(true), quanta);
    assert!(ch.iter().skip(2).all(|&n| n == 1), "the clip voice is panned with HRTF: {ch:?}");
    assert_eq!(sh, ch, "the stream voice takes the bank as the clip voice does");
    for k in 0..cl.len() {
        assert!((sl[k] - cl[k]).abs() < 1e-6 && (sr[k] - cr[k]).abs() < 1e-6, "frame {k}: stream {} {} vs clip {} {}", sl[k], sr[k], cl[k], cr[k]);
    }
    assert!(sl.iter().any(|s| *s != 0.0));
}

#[test]
fn an_unflagged_stream_voice_pans_equal_power_like_a_clip_voice() {
    let quanta = FRAMES / QUANTUM - 4;
    let (cl, cr, ch) = render(&mut clip_core(false), quanta);
    let (sl, sr, sh) = render(&mut stream_core(false), quanta);
    assert!(ch.iter().chain(&sh).all(|&n| n == 0), "no HRTF");
    for k in 0..cl.len() {
        assert!((sl[k] - cl[k]).abs() < 1e-6 && (sr[k] - cr[k]).abs() < 1e-6, "frame {k}");
    }
    // From the left, equal-power: louder on the left.
    let energy = |x: &[f32]| x.iter().map(|s| s * s).sum::<f32>();
    assert!(energy(&sl) > 2.0 * energy(&sr));
}
