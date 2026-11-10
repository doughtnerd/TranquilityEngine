//! H3: HRTF for the voices main flags (panner kind 1), end to end through the core.
//!
//! - The HRIR table (`format = 2`, a reserved id) loads into the HRTF store: clip event 4
//!   `hrtfReady`, never `resident`, never a voice's source; bad data gives `hrtfLoadFailure` 2.
//! - A kind change crossfades the two panners over 45 ms in either direction, with no click; so
//!   does the table arriving while a voice is flagged.
//! - Virtual (demoted) voices drop their HRTF state; promoted back they start equal-power.
//! - `hrtfVoices` counts the voices panned with HRTF; at most 32 (the bank), and the rest of the
//!   flagged voices pan equal-power.
//! - The per-voice cost, natively (printed; compare with `cap::wu::HRTF_VOICE`).
//!
//! The limiter's look-ahead is 0 here, so the output is in core time.

use audio_core::clips;
use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::panner::{HrtfBank, HRTF_CROSSFADE_SECONDS, HRTF_SLOTS, KERNEL_BUDGET};
use audio_core::params::InitParams;
use audio_core::{bus, scheduler, status, Core, QUANTUM};
use audio_dsp::hrtf::database::{encode, HrirHeader};
use audio_wire::generated as wire;

const HRIR_ID: u32 = wire::HRIR_CLIP_ID_FIRST;
const SINE: u32 = 1;
const STEREO: u32 = 2;
const HRTF_FLAGS: u32 = (wire::panner::HRTF as u32) << wire::SET_PARAMS_FLAGS_PANNER_SHIFT;

fn new_core(rate: f32, max_mixed: u32) -> Core {
    let p = InitParams { sample_rate: rate, max_logical: 256, max_mixed, max_buses: 4, arena_initial_bytes: 4 << 20 };
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose ('static).
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: a fresh block of `layout.total()` zeroed bytes, aligned to PAGE_BYTES.
    let mut core = unsafe { Core::new(p, layout, base) };
    assert!(bus::set_limiter_lookahead(&mut core, 0.0));
    core
}

/// The shipped table as main sends it to a 44.1 kHz context (H5): the asset (header, then int16
/// responses with their delays in) with each response's delay extracted
/// (`kernel::extract_average_group_delay`, as `hrir.ts` does) into the `format = 2` delay table.
fn shipped_table() -> Vec<u8> {
    let asset = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../src/plugins/audio/runtime/wasm/myco_hrir.bin")).expect("the HRIR asset");
    let header = HrirHeader::read(&asset).unwrap();
    assert_eq!((header.ir_length, header.rate), (256, 44100.0));
    let directions = header.directions();
    let n = header.ir_length as usize;
    assert_eq!(asset.len(), 16 + directions * n * 4, "the asset has no delay table");
    let mut scratch = audio_dsp::hrtf::HrtfScratch::new();
    let mut delays = vec![0.0f32; directions * 2];
    let mut irs = vec![0i16; directions * n * 2];
    let mut ir = vec![0.0f32; n];
    for d in 0..directions {
        for ear in 0..2 {
            for (f, s) in ir.iter_mut().enumerate() {
                let at = 16 + ((d * n + f) * 2 + ear) * 2;
                *s = i16::from_le_bytes([asset[at], asset[at + 1]]) as f32 / 32768.0;
            }
            delays[d * 2 + ear] = audio_dsp::hrtf::kernel::extract_average_group_delay(&mut ir, &mut scratch);
            for (f, s) in ir.iter().enumerate() {
                irs[(d * n + f) * 2 + ear] = (s * 32768.0).round().clamp(-32768.0, 32767.0) as i16;
            }
        }
    }
    let mut bytes = vec![0u8; header.byte_len()];
    encode(&header, &delays, &irs, &mut bytes).unwrap();
    bytes
}

/// A synthetic table at `rate`: every response a 0.5 impulse, delays 3 (left) and 7.5 (right).
fn impulse_table(rate: f32) -> Vec<u8> {
    let header = HrirHeader { elevations: 10, azimuths: 24, ir_length: 256, rate };
    let delays: Vec<f32> = (0..480).map(|i| if i % 2 == 0 { 3.0 } else { 7.5 }).collect();
    let mut irs = vec![0i16; 240 * 256 * 2];
    for d in 0..240 {
        irs[d * 512] = 16384;
        irs[d * 512 + 1] = 16384;
    }
    let mut bytes = vec![0u8; header.byte_len()];
    encode(&header, &delays, &irs, &mut bytes).unwrap();
    bytes
}

/// Sends the table as main does: CLIP_BEGIN (format 2, channels 1, frames = bytes / 2), then
/// 256 KB chunks. Returns the reserve's result.
fn load_table(core: &mut Core, id: u32, bytes: &[u8], rate: f32) -> i32 {
    let frames = (bytes.len() / 2) as u32;
    let r = clips::reserve(core, id, frames, 1, rate, wire::clip_format::HRIR);
    if r != wire::ERR_OK {
        return r;
    }
    for (k, chunk) in bytes.chunks(clips::MAX_CHUNK_BYTES).enumerate() {
        let at = (k * clips::MAX_CHUNK_BYTES / 2) as u32;
        let p = clips::chunk_ptr(core, id, at, chunk.len() as u32);
        assert!(!p.is_null());
        // SAFETY: chunk_ptr gave room for `chunk.len()` bytes.
        unsafe { core::ptr::copy_nonoverlapping(chunk.as_ptr(), p, chunk.len()) };
        assert_eq!(clips::commit(core, id, at, chunk.len() as u32), wire::ERR_OK);
    }
    wire::ERR_OK
}

fn clip_events(core: &Core) -> Vec<(u32, u32)> {
    status::counters(core).clip_events.as_slice().iter().map(|e| (e.id, e.code)).collect()
}

/// A looping sine clip of whole cycles: `cycles` of `period` frames at `rate`.
fn load_sine(core: &mut Core, id: u32, rate: f32, channels: u32) {
    let period = 160usize;
    let frames = period * 50;
    let mut samples = Vec::with_capacity(frames * channels as usize);
    for i in 0..frames {
        let s = 0.25 * libm::sinf(2.0 * core::f32::consts::PI * i as f32 / period as f32);
        samples.push(s);
        if channels == 2 {
            samples.push(0.5 * s);
        }
    }
    core.clips_mut().reserve(id, frames as u32, channels, rate, clips::ClipFormat::F32).unwrap();
    let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
    core.clips_mut().write(id, 0, &bytes).unwrap();
}

enum Rec {
    Play(wire::Play),
    Set(wire::SetParams),
    Mixed(wire::SetMixed),
}

fn submit(core: &mut Core, frame: u64, recs: &[Rec]) {
    let mut buf = vec![0u8; 32 + 64 * 1024];
    let mut at = 32;
    for rec in recs {
        at += match rec {
            Rec::Play(r) => r.write(&mut buf, at),
            Rec::Set(r) => r.write(&mut buf, at),
            Rec::Mixed(r) => r.write(&mut buf, at),
        }
        .unwrap();
    }
    buf.truncate(at);
    wire::Envelope::new(wire::kind::BATCH, 1, (buf.len() - 16) as u32).write(&mut buf, 0).unwrap();
    wire::BatchHeader { first_frame: frame as f64, count: recs.len() as u32, flags: 0 }.write(&mut buf, 0).unwrap();
    assert_eq!(scheduler::submit(core, &buf), 0);
}

/// A mixed, looping, spatial PLAY of `clip` from direction `dir`, kind `panner`.
fn play(voice: u32, clip: u32, dir: [f32; 3], panner: u16) -> Rec {
    Rec::Play(wire::Play {
        voice_id: voice,
        frame_offset: wire::ASAP,
        clip,
        bus: wire::BUS_ROOT as u16,
        flags: wire::PLAY_FLAGS_MIXED | wire::PLAY_FLAGS_LOOP | wire::PLAY_FLAGS_SPATIAL | (panner << wire::PLAY_FLAGS_PANNER_SHIFT),
        gain: 1.0,
        pitch: 1.0,
        dir_x: dir[0],
        dir_y: dir[1],
        dir_z: dir[2],
        lp_hz: wire::BUS_LP_OFF_HZ as f32,
        ..Default::default()
    })
}

fn kind(voice: u32, hrtf: bool) -> Rec {
    Rec::Set(wire::SetParams { voice_id: voice, frame_offset: wire::ASAP, mask: wire::SET_PARAMS_MASK_FLAGS, flags: if hrtf { HRTF_FLAGS } else { 0 }, ..Default::default() })
}

fn mixed(voice: u32, on: bool, dir: [f32; 3]) -> Rec {
    Rec::Mixed(wire::SetMixed { voice_id: voice, frame_offset: wire::ASAP, mixed: on as u32, gain: 1.0, dir_x: dir[0], dir_y: dir[1], dir_z: dir[2], lp_hz: wire::BUS_LP_OFF_HZ as f32 })
}

/// Renders `quanta` quanta from `*frame`; returns the planar output and `hrtfVoices` per quantum.
fn render(core: &mut Core, frame: &mut u64, quanta: usize) -> (Vec<f32>, Vec<f32>, Vec<u16>) {
    let (mut l, mut r, mut h) = (Vec::new(), Vec::new(), Vec::new());
    for _ in 0..quanta {
        let out = core.process(*frame);
        l.extend_from_slice(&out[..QUANTUM]);
        r.extend_from_slice(&out[QUANTUM..2 * QUANTUM]);
        h.push(status::counters(core).hrtf_voices);
        *frame += QUANTUM as u64;
    }
    (l, r, h)
}

/// The largest step between neighbouring frames (a click shows as a step far above the signal's).
fn max_step(x: &[f32]) -> f32 {
    x.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max)
}

const AHEAD_LEFT: [f32; 3] = [-0.6, 0.0, -0.8];

#[test]
fn the_table_loads_into_the_hrtf_store() {
    let rate = 44_100.0;
    let mut core = new_core(rate, 32);
    let bytes = shipped_table();
    assert_eq!(load_table(&mut core, HRIR_ID, &bytes, rate), wire::ERR_OK);
    assert_eq!(clip_events(&core), vec![(HRIR_ID, wire::clip_event::HRTF_READY)], "hrtfReady, not resident");
    assert!(core.clips().frames(HRIR_ID).is_none(), "never a voice's source");
    assert!(core.clips().hrtf_bank().is_some());
    assert_eq!(status::counters(&core).hrtf_load_failure, 0);
    let bank = HrtfBank::bytes_for(rate).unwrap();
    std::println!("HRIR table {} B; HRTF bank {} B at 44.1 kHz ({} B at 48 kHz, {} B at 96 kHz)", bytes.len(), bank, HrtfBank::bytes_for(48_000.0).unwrap(), HrtfBank::bytes_for(96_000.0).unwrap());
    assert!(HrtfBank::bytes_for(48_000.0).unwrap() < 720 * 1024);
    assert!(HrtfBank::bytes_for(176_400.0).is_none(), "past the port's 4 partitions");

    // Freeing the table drops the bank (kind-1 voices go back to equal-power).
    assert_eq!(clips::free(&mut core, HRIR_ID), wire::ERR_OK);
    assert!(core.clips().hrtf_bank().is_none());
    // And it can load again (a rebuild's re-send goes to a new core, but a reset keeps this one).
    assert_eq!(load_table(&mut core, HRIR_ID, &bytes, rate), wire::ERR_OK);
    assert!(core.clips().hrtf_bank().is_some());
    clips::reset(&mut core);
    assert!(core.clips().hrtf_bank().is_none(), "RESET without keepClips drops it");
}

#[test]
fn bad_tables_are_refused_or_reported() {
    let rate = 48_000.0;
    let mut core = new_core(rate, 32);
    let good = impulse_table(rate);
    // Not a reserved id, two channels, another rate than the core's.
    assert_eq!(clips::reserve(&mut core, 7, 100, 1, rate, wire::clip_format::HRIR), wire::ERR_BAD_ARG);
    assert_eq!(clips::reserve(&mut core, HRIR_ID, 100, 2, rate, wire::clip_format::HRIR), wire::ERR_BAD_ARG);
    assert_eq!(status::counters(&core).hrtf_load_failure, 0);
    assert_eq!(clips::reserve(&mut core, HRIR_ID, 100, 1, 44_100.0, wire::clip_format::HRIR), wire::ERR_BAD_ARG);
    assert_eq!(status::counters(&core).hrtf_load_failure, wire::hrtf_load_failure::DATA as u16, "a table at the wrong rate is data trouble");
    // Corrupt data: a bad grid in the header. No event, failure 2, no bank.
    let mut bad = good.clone();
    bad[0] = 9;
    let mut core = new_core(rate, 32);
    assert_eq!(load_table(&mut core, HRIR_ID, &bad, rate), wire::ERR_OK);
    assert!(clip_events(&core).is_empty());
    assert!(core.clips().hrtf_bank().is_none());
    assert_eq!(status::counters(&core).hrtf_load_failure, wire::hrtf_load_failure::DATA as u16);
    // A second table while one is held is refused; freeing the bad one allows a good one.
    assert_eq!(clips::reserve(&mut core, HRIR_ID + 1, 100, 1, rate, wire::clip_format::HRIR), wire::ERR_BAD_ARG);
    assert_eq!(clips::free(&mut core, HRIR_ID), wire::ERR_OK);
    assert_eq!(load_table(&mut core, HRIR_ID + 1, &good, rate), wire::ERR_OK);
    assert_eq!(status::counters(&core).hrtf_load_failure, 0, "a good table clears it");
    assert!(core.clips().hrtf_bank().is_some());
}

/// The impulse table makes HRTF exact: each ear is the source halved and delayed (3 / 7.5 frames).
#[test]
fn a_kind_change_crossfades_over_45_ms_both_ways() {
    let rate = 48_000.0;
    let fade = libm::roundf(HRTF_CROSSFADE_SECONDS * rate) as usize; // 2160 frames
    let mut core = new_core(rate, 32);
    load_table(&mut core, HRIR_ID, &impulse_table(rate), rate);
    load_sine(&mut core, SINE, rate, 1);
    let mut frame = 0u64;
    let dir = [0.0, 0.0, -1.0]; // ahead: equal-power gives 0.7071 each side
    submit(&mut core, frame, &[play(0x1_0000, SINE, dir, 0)]);
    let (ep_l, _, h) = render(&mut core, &mut frame, 20);
    assert!(h.iter().all(|&n| n == 0));
    submit(&mut core, frame, &[kind(0x1_0000, true)]);
    let start = frame as usize;
    let (l, r, h) = render(&mut core, &mut frame, 40);
    assert!(h.iter().all(|&n| n == 1), "one HRTF voice while it crossfades and after: {h:?}");
    // After the crossfade the output is the HRTF one exactly: the source halved, delayed.
    let sine = |n: usize| 0.25 * libm::sinf(2.0 * core::f32::consts::PI * (n % 160) as f32 / 160.0);
    for k in fade + 16..l.len() {
        let n = start + k;
        assert!((l[k] - 0.5 * sine(n - 3)).abs() < 1e-5, "left at {k}: {} vs {}", l[k], 0.5 * sine(n - 3));
        let want_r = 0.25 * (sine(n - 7) + sine(n - 8));
        assert!((r[k] - want_r).abs() < 1e-5, "right at {k}");
    }
    // During it, both panners: no step above the signal's own (a click would be one).
    let steady = max_step(&ep_l);
    assert!(max_step(&l) <= steady * 1.05, "left steps {} vs steady {}", max_step(&l), steady);
    // Halfway, the mix of the two.
    let k = fade / 2;
    let x = (k + 1) as f32 / fade as f32;
    let want = (1.0 - x) * core::f32::consts::FRAC_1_SQRT_2 * sine(start + k) + x * 0.5 * sine(start + k - 3);
    assert!((l[k] - want).abs() < 2e-4, "halfway: {} vs {want}", l[k]);

    // Back to equal-power: the same 45 ms, then the slot is freed and the output is the matrix's.
    submit(&mut core, frame, &[kind(0x1_0000, false)]);
    let start = frame as usize;
    let (l, _, h) = render(&mut core, &mut frame, 40);
    let quanta = fade.div_ceil(QUANTUM);
    assert!(h[..quanta].iter().all(|&n| n == 1) && h[quanta + 1..].iter().all(|&n| n == 0), "{h:?}");
    assert!(max_step(&l) <= steady * 1.05);
    for k in fade + 16..l.len() {
        assert!((l[k] - core::f32::consts::FRAC_1_SQRT_2 * sine(start + k)).abs() < 1e-5, "equal-power again at {k}");
    }
}

#[test]
fn the_table_arriving_crossfades_a_flagged_voice_in() {
    let rate = 44_100.0;
    let mut core = new_core(rate, 32);
    load_sine(&mut core, SINE, rate, 1);
    let mut frame = 0u64;
    submit(&mut core, frame, &[play(0x1_0000, SINE, AHEAD_LEFT, 1)]);
    let (ep, _, h) = render(&mut core, &mut frame, 10);
    assert!(h.iter().all(|&n| n == 0), "no table yet: equal-power");
    let bytes = shipped_table();
    load_table(&mut core, HRIR_ID, &bytes, rate);
    let (l, r, h) = render(&mut core, &mut frame, 30);
    assert!(h.iter().all(|&n| n == 1));
    // The real table: no click across the change (steps stay near the steady signals').
    let (hl, hr, _) = render(&mut core, &mut frame, 10);
    let steady = max_step(&ep).max(max_step(&hl)).max(max_step(&hr));
    assert!(max_step(&l) <= steady * 1.1 && max_step(&r) <= steady * 1.1, "{} {} vs {}", max_step(&l), max_step(&r), steady);
    // Left of ahead: the left ear louder.
    let rms = |x: &[f32]| (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt();
    assert!(rms(&hl) > rms(&hr) * 1.2, "left {} right {}", rms(&hl), rms(&hr));
}

#[test]
fn virtual_voices_drop_their_hrtf_state_and_return_equal_power() {
    let rate = 48_000.0;
    let mut core = new_core(rate, 32);
    load_table(&mut core, HRIR_ID, &impulse_table(rate), rate);
    load_sine(&mut core, SINE, rate, 1);
    let mut frame = 0u64;
    submit(&mut core, frame, &[play(0x1_0000, SINE, AHEAD_LEFT, 1)]);
    let (_, _, h) = render(&mut core, &mut frame, 30);
    assert_eq!(*h.last().unwrap(), 1);
    // Demote: the 5 ms fade renders (still HRTF), then the voice is virtual and the slot freed.
    submit(&mut core, frame, &[mixed(0x1_0000, false, AHEAD_LEFT)]);
    let (_, _, h) = render(&mut core, &mut frame, 6);
    assert_eq!(h[0], 1);
    assert_eq!(*h.last().unwrap(), 0, "virtual: no HRTF state");
    // Promote: kind is still 1, so it takes a slot again, starting from equal-power.
    submit(&mut core, frame, &[mixed(0x1_0000, true, AHEAD_LEFT)]);
    let (l, _, h) = render(&mut core, &mut frame, 30);
    assert!(h.iter().all(|&n| n == 1));
    let steady = 2.0 * core::f32::consts::PI / 160.0 * 0.25; // the sine's largest step
    assert!(max_step(&l) <= steady * 1.05, "no click on the way back: {}", max_step(&l));
}

#[test]
fn at_most_32_voices_take_hrtf_and_the_rest_pan_equal_power() {
    let rate = 48_000.0;
    let mut core = new_core(rate, 64);
    load_table(&mut core, HRIR_ID, &impulse_table(rate), rate);
    load_sine(&mut core, SINE, rate, 1);
    load_sine(&mut core, STEREO, rate, 2);
    let mut frame = 0u64;
    let recs: Vec<Rec> = (0..40u32).map(|i| play(((i + 1) << 16) | i, if i % 2 == 0 { SINE } else { STEREO }, AHEAD_LEFT, 1)).collect();
    submit(&mut core, frame, &recs);
    // The kernel budget lets KERNEL_BUDGET / 2 new panners start per quantum (each computes one
    // kernel set first), so the 32 slots fill over 32 / (KERNEL_BUDGET / 2) quanta.
    let per_quantum = (KERNEL_BUDGET / 2) as usize;
    let fill = HRTF_SLOTS.div_ceil(per_quantum);
    let (l, r, h) = render(&mut core, &mut frame, fill + 4);
    assert_eq!(h[0] as usize, per_quantum, "{h:?}");
    assert!(h.windows(2).all(|w| w[1] >= w[0] && (w[1] - w[0]) as usize <= per_quantum), "{h:?}");
    assert!(h[fill..].iter().all(|&n| n as usize == HRTF_SLOTS), "{h:?}");
    assert!(l.iter().chain(&r).all(|v| v.is_finite()));
    // Unflag 10: those holding slots fade out over 45 ms and free them; the 8 flagged voices that
    // were waiting take the slots, so the 30 still flagged all end up on HRTF.
    let recs: Vec<Rec> = (0..10u32).map(|i| kind(((i + 1) << 16) | i, false)).collect();
    submit(&mut core, frame, &recs);
    let (_, _, h) = render(&mut core, &mut frame, 25);
    assert!(h.iter().all(|&n| n as usize <= HRTF_SLOTS));
    assert_eq!(*h.last().unwrap() as usize, 30, "the 30 still flagged: {h:?}");
    assert_eq!(status::counters(&core).mixed_voices, 40);
}

/// Native cost per HRTF voice per quantum (all 32 static, and all 32 moving so their kernels
/// crossfade), against equal-power. Printed for A3.5; the gate is loose (debug builds are slow).
#[test]
fn hrtf_cost_per_voice() {
    let rate = 48_000.0;
    let time = |hrtf: bool, moving: bool| -> f64 {
        let mut core = new_core(rate, 64);
        load_table(&mut core, HRIR_ID, &impulse_table(rate), rate);
        load_sine(&mut core, SINE, rate, 1);
        let mut frame = 0u64;
        let recs: Vec<Rec> = (0..32u32).map(|i| play(((i + 1) << 16) | i, SINE, AHEAD_LEFT, hrtf as u16)).collect();
        submit(&mut core, frame, &recs);
        render(&mut core, &mut frame, 40); // past the crossfade in
        let quanta = 400;
        let t = std::time::Instant::now();
        for q in 0..quanta {
            if moving && q % 8 == 0 {
                let a = q as f32 * 0.05;
                let dir = [libm::sinf(a), 0.0, -libm::cosf(a)];
                let recs: Vec<Rec> = (0..32u32)
                    .map(|i| Rec::Set(wire::SetParams { voice_id: ((i + 1) << 16) | i, frame_offset: wire::ASAP, mask: wire::SET_PARAMS_MASK_DIR, dir_x: dir[0], dir_y: dir[1], dir_z: dir[2], ramp_frames: 128, ..Default::default() }))
                    .collect();
                submit(&mut core, frame, &recs);
            }
            core.process(frame);
            frame += QUANTUM as u64;
        }
        t.elapsed().as_secs_f64() / quanta as f64
    };
    let ep = time(false, false);
    let still = time(true, false);
    let moving = time(true, true);
    let per = |t: f64| (t - ep) / 32.0 * 1e6;
    std::println!("per HRTF voice per quantum (native): static {:.2} µs, moving {:.2} µs (equal-power quantum {:.1} µs for 32 voices)", per(still), per(moving), ep * 1e6);
    assert!(per(still) < 500.0);
    // The table's last commit builds the bank (32 panners) in `onmessage`, on the audio thread.
    let mut core = new_core(rate, 64);
    let bytes = impulse_table(rate);
    let frames = (bytes.len() / 2) as u32;
    assert_eq!(clips::reserve(&mut core, HRIR_ID, frames, 1, rate, wire::clip_format::HRIR), wire::ERR_OK);
    let p = clips::chunk_ptr(&mut core, HRIR_ID, 0, bytes.len() as u32);
    // SAFETY: chunk_ptr gave room for the whole table (it is under 256 KB).
    unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len()) };
    let t = std::time::Instant::now();
    assert_eq!(clips::commit(&mut core, HRIR_ID, 0, bytes.len() as u32), wire::ERR_OK);
    std::println!("the completing commit (parse and build the bank): {:.0} µs", t.elapsed().as_secs_f64() * 1e6);
}

/// A3.5: the work-unit model counts each HRTF voice, each panner crossfading kernel sets and each
/// kernel computation (the render notes the last two; `CapState::render_work`).
#[test]
fn the_model_counts_hrtf_voices_crossfades_and_kernels() {
    use audio_core::cap::wu;
    let rate = 48_000.0;
    let mut core = new_core(rate, 64);
    load_table(&mut core, HRIR_ID, &shipped_table_at(rate), rate);
    load_sine(&mut core, SINE, rate, 1);
    let mut frame = 0u64;
    let recs: Vec<Rec> = (0..4u32).map(|i| play(((i + 1) << 16) | i, SINE, AHEAD_LEFT, 1)).collect();
    submit(&mut core, frame, &recs);
    render(&mut core, &mut frame, 40);
    let (mut saw_kernels, mut saw_crossfade) = (false, false);
    for q in 0..64u32 {
        let a = (q as f32 * 4.0).to_radians();
        let recs: Vec<Rec> = (0..4u32)
            .map(|i| Rec::Set(wire::SetParams { voice_id: ((i + 1) << 16) | i, frame_offset: wire::ASAP, mask: wire::SET_PARAMS_MASK_DIR, dir_x: libm::sinf(a), dir_z: -libm::cosf(a), ramp_frames: 128, ..Default::default() }))
            .collect();
        submit(&mut core, frame, &recs);
        core.process(frame);
        frame += QUANTUM as u64;
        let w = core.cap().render_work();
        let (crossfading, kernels) = (w.hrtf_crossfading, w.hrtf_kernels);
        assert!(kernels <= KERNEL_BUDGET, "quantum {q}: {kernels} kernel computations past the budget");
        assert!(crossfading <= 4);
        saw_kernels |= kernels > 0;
        saw_crossfade |= crossfading > 0;
        // The rest of the model: 4 mixed voices, their source frames, the root bus, the limiter and
        // the 4 records of this quantum's batch.
        let c = status::counters(&core);
        assert_eq!(c.hrtf_voices, 4);
        let rest = 4 * wu::MIXED_VOICE + 4 * wu::SOURCE_QUANTUM + w.moving * wu::MOVING_VOICE + wu::LIMITER + 4 * wu::RECORD + audio_core::bus::count(&core) as u32 * wu::BUS;
        assert_eq!(core.work_units(), rest + 4 * wu::HRTF_VOICE + crossfading * wu::HRTF_CROSSFADE + kernels * wu::HRTF_KERNEL, "quantum {q}");
    }
    assert!(saw_kernels && saw_crossfade, "the voices turned");
}

/// Many voices switching kernels in the same quanta never take more than `KERNEL_BUDGET` kernel
/// computations in one quantum; the switches wait their turn (each on its last direction).
#[test]
fn kernel_work_stays_within_the_budget_per_quantum() {
    let rate = 48_000.0;
    let mut core = new_core(rate, 64);
    load_table(&mut core, HRIR_ID, &shipped_table_at(rate), rate);
    load_sine(&mut core, SINE, rate, 1);
    let mut frame = 0u64;
    let recs: Vec<Rec> = (0..32u32).map(|i| play(((i + 1) << 16) | i, SINE, AHEAD_LEFT, 1)).collect();
    submit(&mut core, frame, &recs);
    let mut total = 0;
    for q in 0..200u32 {
        // Every voice turns 4 degrees a quantum (a new interpolated azimuth index each time).
        let a = (q as f32 * 4.0).to_radians();
        let recs: Vec<Rec> = (0..32u32)
            .map(|i| Rec::Set(wire::SetParams { voice_id: ((i + 1) << 16) | i, frame_offset: wire::ASAP, mask: wire::SET_PARAMS_MASK_DIR, dir_x: libm::sinf(a + i as f32), dir_z: -libm::cosf(a + i as f32), ramp_frames: 128, ..Default::default() }))
            .collect();
        submit(&mut core, frame, &recs);
        let out = core.process(frame);
        assert!(out.iter().all(|v| v.is_finite()));
        let used = audio_core::panner::kernels_last_quantum(&core);
        assert!(used <= KERNEL_BUDGET, "quantum {q}: {used} kernel computations");
        let computed = core.cap().render_work().hrtf_kernels;
        assert!(computed <= KERNEL_BUDGET, "quantum {q}: the panners computed {computed} kernels");
        total += used;
        frame += QUANTUM as u64;
    }
    assert!(total >= 180 * KERNEL_BUDGET, "the budget is used, not starved: {total}");
}

/// The shipped table at `rate` by nearest-frame resampling (enough for load and cost tests, not
/// for listening: main's `hrir.ts` resamples properly before upload).
fn shipped_table_at(rate: f32) -> Vec<u8> {
    let src = shipped_table();
    let header = audio_dsp::hrtf::HrirHeader::read(&src).unwrap();
    let ratio = rate / header.rate;
    let out_len = ((header.ir_length as f32) * ratio).ceil() as u32;
    let db = audio_dsp::hrtf::HrirDatabase::parse(&src).unwrap();
    let out_header = HrirHeader { ir_length: out_len, rate, ..header };
    let mut delays = Vec::new();
    let mut irs = vec![0i16; header.directions() * out_len as usize * 2];
    let mut tmp = vec![0.0f32; header.ir_length as usize];
    for d in 0..header.directions() {
        let (az, el) = (d / header.elevations as usize, d % header.elevations as usize);
        for ear in [audio_dsp::hrtf::Ear::Left, audio_dsp::hrtf::Ear::Right] {
            delays.push(db.ear_delay(el, az, ear) * ratio);
            db.read_ir(el, az, ear, &mut tmp);
            for f in 0..out_len as usize {
                let s = tmp.get((f as f32 / ratio) as usize).copied().unwrap_or(0.0);
                irs[(d * out_len as usize + f) * 2 + ear as usize] = (s * 32767.0) as i16;
            }
        }
    }
    let mut bytes = vec![0u8; out_header.byte_len()];
    encode(&out_header, &delays, &irs, &mut bytes).unwrap();
    bytes
}
