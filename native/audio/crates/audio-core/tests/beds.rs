//! ADR 0162 A4: the core bed, end to end through `scheduler::submit` and `Core::process`
//! (api-and-models §9 and §10 A4; architecture §2.1, §3.1, §4.2, §4.3, §7.3).
//!
//! Goldens (each against values computed here from the spec, < 0.05 dB):
//! - **bed**: 256 kind-2 voices into a root-hosted bed, decoded through the baked matrix (R9), and a
//!   voice decoded through the committed MagLS filters (`magls-o3.bin`, format 4) against
//!   `BedDecoder` run here;
//! - **crossfade**: a voice going equal-power to bed and back follows the equal-power law frame by
//!   frame (the level bump of correlated halves is recorded, not asserted, §9); an HRTF voice holds
//!   its slot through the crossfade and frees it after;
//! - **ducked chain**: a voice on a bus sharing an ancestor's bed follows the chain's ducking (a
//!   12 dB, 5 ms duck whose knee is inside a quantum) at every frame.
//!
//! Lifecycle: BED_CONFIG validation and `bedsRefused`; no BED_CONFIG is M2 (kind 2 pans equal-power,
//! bit for bit as kind 0); idle after the decoder's partitions, or after 1 quantum once the load
//! shedding ladder took its bed-idle step (`m3Shed`); a removed host drains; a bus move crossfades;
//! RESET clears; format 4 refusals and `bedDecoderReady`.
//!
//! The limiter's look-ahead is 0, so the output is in core time. Counters reported by
//! `bed::begin_quantum` describe the quantum before the last one rendered.

use audio_core::bed;
use audio_core::clips::{self, ClipFormat};
use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::params::InitParams;
use audio_core::{bus, chain, scheduler, status, Core, QUANTUM};
use audio_dsp::ambisonic::{encode_gains, engine_to_ambix, CHANNELS};
use audio_dsp::bed_decoder::{BedDecoder, MaglsFilters};
use audio_dsp::ramp::Ramp;
use audio_wire::generated as wire;

const DC: u32 = 1;
const ROOT: u16 = wire::BUS_ROOT as u16;
const OFF: f32 = wire::BUS_LP_OFF_HZ as f32;
const BED_KIND: u16 = wire::panner::BED as u16;

fn new_core(rate: f32, max_beds: u32, max_logical: u32, max_mixed: u32) -> Core {
    let p = InitParams { sample_rate: rate, max_logical, max_mixed, max_buses: 8, arena_initial_bytes: 1 << 20, max_beds, ..InitParams::default() };
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose ('static).
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: a fresh block of `layout.total()` zeroed bytes, aligned to PAGE_BYTES.
    let mut core = unsafe { Core::new(p, layout, base) };
    assert!(bus::set_limiter_lookahead(&mut core, 0.0));
    let rate = core.params().sample_rate;
    core.clips_mut().reserve(DC, 64, 1, rate, ClipFormat::F32).unwrap();
    let bytes: Vec<u8> = [1.0f32; 64].iter().flat_map(|s| s.to_le_bytes()).collect();
    core.clips_mut().write(DC, 0, &bytes).unwrap();
    core
}

fn submit(core: &mut Core, frame: u64, recs: &[Vec<u8>]) -> i32 {
    let mut buf = vec![0u8; 32];
    for r in recs {
        buf.extend_from_slice(r);
    }
    wire::Envelope::new(wire::kind::BATCH, 1, (buf.len() - 16) as u32).write(&mut buf, 0).unwrap();
    wire::BatchHeader { first_frame: frame as f64, count: recs.len() as u32, flags: 0 }.write(&mut buf, 0).unwrap();
    scheduler::submit(core, &buf)
}

fn rec(write: impl Fn(&mut [u8]) -> Result<usize, i32>) -> Vec<u8> {
    let mut b = vec![0u8; 8192];
    let n = write(&mut b).unwrap();
    b.truncate(n);
    b
}

/// A mixed, looping, spatial PLAY of the DC clip on `bus`, gain `gain`, from `dir`, kind `kind`.
fn play(voice: u32, bus: u16, gain: f32, dir: [f32; 3], kind: u16) -> Vec<u8> {
    rec(|b| {
        wire::Play {
            voice_id: voice,
            frame_offset: wire::ASAP,
            clip: DC,
            bus,
            flags: wire::PLAY_FLAGS_MIXED | wire::PLAY_FLAGS_LOOP | wire::PLAY_FLAGS_SPATIAL | (kind << wire::PLAY_FLAGS_PANNER_SHIFT),
            gain,
            pitch: 1.0,
            dir_x: dir[0],
            dir_y: dir[1],
            dir_z: dir[2],
            lp_hz: OFF,
            ..Default::default()
        }
        .write(b, 0)
    })
}

fn set_kind(voice: u32, kind: u32) -> Vec<u8> {
    rec(|b| wire::SetParams { voice_id: voice, frame_offset: wire::ASAP, mask: wire::SET_PARAMS_MASK_FLAGS, flags: kind << wire::SET_PARAMS_FLAGS_PANNER_SHIFT, ..Default::default() }.write(b, 0))
}

fn stop(voice: u32) -> Vec<u8> {
    rec(|b| wire::Stop { voice_id: voice, frame_offset: wire::ASAP, fade_frames: 0, ..Default::default() }.write(b, 0))
}

fn buses(parents: &[u16]) -> Vec<u8> {
    rec(|b| wire::BusConfig { voice_id: 0, frame_offset: wire::ASAP, buses: parents.iter().map(|&parent| wire::BusConfigBuses { parent, effects: vec![] }).collect() }.write(b, 0))
}

/// What BUS_MIX of `gains` (low-pass off) was: per bus, an asap `BUS_RAMP` on the runtime lane's
/// gain and one on the snapshot lane's low-pass, over `ramp` (B1a's mapping, bit-identical by R3).
/// Several records: callers splice them in with `concat`.
fn mix(ramp: u32, gains: &[f32]) -> Vec<Vec<u8>> {
    let ramp_rec = |bus: usize, lane: u32, mask: u16, gain: f32| {
        rec(move |b| wire::BusRamp { voice_id: bus as u32, frame_offset: wire::ASAP, lane: lane as u16, mask, gain, lp_hz: OFF, frames: ramp, shape: 0 }.write(b, 0))
    };
    gains.iter().enumerate().flat_map(|(i, &g)| [ramp_rec(i, wire::LANE_RUNTIME, wire::BUS_RAMP_MASK_GAIN, g), ramp_rec(i, wire::LANE_SNAPSHOT, wire::BUS_RAMP_MASK_LP_HZ, 1.0)]).collect()
}

fn bed_config(bed_slot: &[u8], host_bus: &[u16]) -> Vec<u8> {
    rec(|b| wire::BedConfig { voice_id: 0, frame_offset: wire::ASAP, bed_slot: bed_slot.to_vec(), host_bus: host_bus.to_vec() }.write(b, 0))
}

fn reset(keep_clips: bool) -> Vec<u8> {
    rec(|b| wire::Reset { voice_id: 0, frame_offset: wire::ASAP, keep_clips: keep_clips as u32 }.write(b, 0))
}

/// Renders one quantum at `*frame`; returns (left, right).
fn render(core: &mut Core, frame: &mut u64) -> (Vec<f32>, Vec<f32>) {
    let out = core.process(*frame);
    let pair = (out[..QUANTUM].to_vec(), out[QUANTUM..2 * QUANTUM].to_vec());
    *frame += QUANTUM as u64;
    pair
}

fn db(a: f32, b: f32) -> f32 {
    (20.0 * (a.abs() / b.abs()).log10()).abs()
}

/// The matrix decode's `(left, right)` for a unit source from engine direction `dir`.
fn matrix_gains(dir: [f32; 3]) -> (f32, f32) {
    audio_dsp::bed_matrix::gains(&encode_gains(engine_to_ambix(dir), 3))
}

/// The equal-power panner's mono `(left, right)` for `dir`.
fn ep_gains(dir: [f32; 3]) -> (f32, f32) {
    let m = audio_core::panner::matrix(true, 0, dir, 1);
    (m[0], m[2])
}

fn dir_at(k: usize, n: usize) -> [f32; 3] {
    let az = k as f32 / n as f32 * core::f32::consts::TAU;
    let el = ((k * 7) % 5) as f32 * 0.2 - 0.4;
    [az.sin() * el.cos(), el.sin(), -az.cos() * el.cos()]
}

#[test]
fn golden_256_voices_into_a_root_bed_through_the_matrix() {
    let mut core = new_core(48_000.0, 2, 512, 256);
    let mut frame = 0u64;
    let n = 256usize;
    let gain = |k: usize| 0.001 + 0.002 * (k % 3) as f32;
    let mut recs = [vec![buses(&[ROOT])], mix(0, &[1.0]), vec![bed_config(&[0], &[0])]].concat();
    for k in 0..n {
        recs.push(play(0x0001_0000 | k as u32, ROOT, gain(k), dir_at(k, n), BED_KIND));
    }
    assert_eq!(submit(&mut core, frame, &recs), 0);
    let (mut want_l, mut want_r) = (0.0f32, 0.0f32);
    for k in 0..n {
        let (l, r) = matrix_gains(dir_at(k, n));
        want_l += gain(k) * l;
        want_r += gain(k) * r;
    }
    let mut worst = 0.0f32;
    for q in 0..4 {
        let (l, r) = render(&mut core, &mut frame);
        for i in 0..QUANTUM {
            worst = worst.max(db(l[i], want_l)).max(db(r[i], want_r));
        }
        if q >= 1 {
            let c = &status::counters(&core).spatial;
            assert_eq!((c.bed_voices, c.beds_active), (n as u16, 1), "quantum {q}: 256 voices into one bed");
            assert_eq!(c.sent_beds()[0].bus, 0);
            assert!(c.work_bed > 0);
        }
    }
    assert!(worst < 0.05, "256 voices into a bed: {worst} dB");
    eprintln!("bed golden (matrix, 256 voices): worst {worst:.2e} dB");
}

/// The committed MagLS asset, a format 4 blob at its own rate (44.1 kHz).
fn magls_blob() -> Vec<u8> {
    std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../src/engine/audio/magls-o3.bin")).expect("the MagLS asset")
}

/// Sends a format 4 blob as main does: CLIP_BEGIN (channels 1, frames = bytes / 4), chunks.
fn load_magls(core: &mut Core, bytes: &[u8], rate: f32) -> i32 {
    let id = wire::MAGLS_CLIP_ID;
    let r = clips::reserve(core, id, (bytes.len() / 4) as u32, 1, rate, wire::clip_format::MAG_LS);
    if r != wire::ERR_OK {
        return r;
    }
    for (k, chunk) in bytes.chunks(4096).enumerate() {
        let at = (k * 4096 / 4) as u32;
        let p = clips::chunk_ptr(core, id, at, chunk.len() as u32);
        assert!(!p.is_null());
        // SAFETY: chunk_ptr gave room for `chunk.len()` bytes.
        unsafe { core::ptr::copy_nonoverlapping(chunk.as_ptr(), p, chunk.len()) };
        assert_eq!(clips::commit(core, id, at, chunk.len() as u32), wire::ERR_OK);
    }
    wire::ERR_OK
}

fn clip_events(core: &Core) -> Vec<(u32, u32)> {
    status::counters(core).clip_events.as_slice().iter().filter(|e| e.id == wire::MAGLS_CLIP_ID).map(|e| (e.id, e.code)).collect()
}

fn decoder_ready(core: &Core) -> bool {
    status::counters(core).flags & audio_core::counters::flag::BED_DECODER_READY != 0
}

#[test]
fn golden_a_voice_through_the_magls_filters() {
    let rate = 44_100.0;
    let mut core = new_core(rate, 1, 64, 16);
    let blob = magls_blob();
    assert!(!decoder_ready(&core));
    assert_eq!(load_magls(&mut core, &blob, rate), wire::ERR_OK);
    assert_eq!(clip_events(&core), vec![(wire::MAGLS_CLIP_ID, wire::clip_event::RESIDENT)]);
    assert!(decoder_ready(&core), "bedDecoderReady");
    assert!(core.clips().frames(wire::MAGLS_CLIP_ID).is_none(), "never a voice's source");
    // The reference: the same filters and an encode written here.
    let taps = 256;
    let time: Vec<f32> = blob[32..].chunks(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let mut scratch = audio_dsp::hrtf::HrtfScratch::new();
    let mut filters = Box::new(MaglsFilters::<2>::ZERO);
    filters.load(&time, taps, &mut scratch).unwrap();
    let mut decoder = Box::new(BedDecoder::ZERO);
    let dir = [0.6f32, 0.2, -0.77];
    let g = 0.5f32;
    let gains = encode_gains(engine_to_ambix(dir), 3);
    let mut acc = [[0.0f32; QUANTUM]; CHANNELS];
    for (c, ch) in acc.iter_mut().enumerate() {
        ch.fill(g * gains[c]);
    }
    let mut frame = 0u64;
    assert_eq!(submit(&mut core, frame, &[vec![buses(&[ROOT])], mix(0, &[1.0]), vec![bed_config(&[0], &[0]), play(0x0001_0001, ROOT, g, dir, BED_KIND)]].concat()), 0);
    let mut worst = 0.0f32;
    for q in 0..6 {
        let (l, r) = render(&mut core, &mut frame);
        let (mut wl, mut wr) = ([0.0f32; QUANTUM], [0.0f32; QUANTUM]);
        decoder.process(&acc, CHANNELS, &filters, &mut scratch, &mut wl, &mut wr);
        for i in 0..QUANTUM {
            assert!((l[i] - wl[i]).abs() < 1e-5 && (r[i] - wr[i]).abs() < 1e-5, "quantum {q} frame {i}: {} {} vs {} {}", l[i], r[i], wl[i], wr[i]);
            if wl[i].abs() > 1e-3 {
                worst = worst.max(db(l[i], wl[i]));
            }
            if wr[i].abs() > 1e-3 {
                worst = worst.max(db(r[i], wr[i]));
            }
        }
    }
    assert!(worst < 0.05, "MagLS decode: {worst} dB");
    // Freeing the clip clears the filters: the matrix decodes again.
    assert_eq!(clips::free(&mut core, wire::MAGLS_CLIP_ID), wire::ERR_OK);
    assert!(!decoder_ready(&core));
    let (l, _) = render(&mut core, &mut frame);
    let (ml, _) = matrix_gains(dir);
    assert!(db(l[100], g * ml) < 0.05, "back on the matrix: {} vs {}", l[100], g * ml);
    eprintln!("bed golden (MagLS): worst {worst:.2e} dB");
}

#[test]
fn format_4_refusals() {
    // No beds: refused, with refusedFormat.
    let mut core = new_core(44_100.0, 0, 64, 16);
    assert_eq!(load_magls(&mut core, &magls_blob(), 44_100.0), wire::ERR_BAD_ARG);
    assert_eq!(clip_events(&core), vec![(wire::MAGLS_CLIP_ID, wire::clip_event::REFUSED_FORMAT)]);
    // Another rate than the core's: refused.
    let mut core = new_core(48_000.0, 1, 64, 16);
    assert_eq!(load_magls(&mut core, &magls_blob(), 44_100.0), wire::ERR_BAD_ARG);
    // A blob whose header says another rate: resident data, but refusedFormat and not ready.
    let mut core = new_core(48_000.0, 1, 64, 16);
    assert_eq!(load_magls(&mut core, &magls_blob(), 48_000.0), wire::ERR_OK);
    assert_eq!(clip_events(&core), vec![(wire::MAGLS_CLIP_ID, wire::clip_event::REFUSED_FORMAT)]);
    assert!(!decoder_ready(&core));
    // A bad magic.
    let mut core = new_core(44_100.0, 1, 64, 16);
    let mut blob = magls_blob();
    blob[0] ^= 1;
    assert_eq!(load_magls(&mut core, &blob, 44_100.0), wire::ERR_OK);
    assert!(!decoder_ready(&core));
    // Format 4 under another id, or with 2 channels.
    let mut core = new_core(44_100.0, 1, 64, 16);
    assert_eq!(clips::reserve(&mut core, 7, 8200, 1, 44_100.0, wire::clip_format::MAG_LS), wire::ERR_BAD_ARG);
    assert_eq!(clips::reserve(&mut core, wire::MAGLS_CLIP_ID, 4100, 2, 44_100.0, wire::clip_format::MAG_LS), wire::ERR_BAD_ARG);
    // RESET 0 drops it with the clips.
    assert_eq!(load_magls(&mut core, &magls_blob(), 44_100.0), wire::ERR_OK);
    assert!(decoder_ready(&core));
    assert_eq!(submit(&mut core, 0, &[reset(true)]), 0);
    assert!(decoder_ready(&core), "RESET 1 keeps the clips, so the filters");
    assert_eq!(submit(&mut core, 0, &[reset(false)]), 0);
    assert!(!decoder_ready(&core));
}

/// Expected crossfade output (frame by frame) of a DC voice at gain `g` from `dir` whose bed share
/// ramps from `from` to `to` over `fade` frames, starting at the quantum's first frame.
fn crossfade_want(g: f32, dir: [f32; 3], share: &mut Ramp) -> (f32, f32) {
    let (el, er) = ep_gains(dir);
    let (ml, mr) = matrix_gains(dir);
    let (c, s) = bed::equal_power(share.next());
    (g * (el * c + ml * s), g * (er * c + mr * s))
}

#[test]
fn golden_crossfade_equal_power_to_bed_and_back_follows_the_law() {
    let rate = 48_000.0;
    let mut core = new_core(rate, 1, 64, 16);
    let fade = (0.045f32 * rate).round() as u32;
    let dir = [0.5f32, 0.0, -0.866_025_4];
    let g = 0.5;
    let v = 0x0001_0001;
    let mut frame = 0u64;
    assert_eq!(submit(&mut core, frame, &[vec![buses(&[ROOT])], mix(0, &[1.0]), vec![bed_config(&[0], &[0]), play(v, ROOT, g, dir, 0)]].concat()), 0);
    let (el, er) = ep_gains(dir);
    for _ in 0..2 {
        let (l, r) = render(&mut core, &mut frame);
        assert_eq!((l[5], r[5]), (g * el, g * er), "kind 0 on a bed bus: equal-power, M2's path");
    }
    let (mut worst, mut lo, mut hi) = (0.0f32, f32::MAX, f32::MIN);
    for (to, kind) in [(1.0f32, wire::panner::BED), (0.0, wire::panner::EQUAL_POWER)] {
        assert_eq!(submit(&mut core, frame, &[set_kind(v, kind)]), 0);
        let mut share = Ramp::at(1.0 - to);
        share.set_target(to, fade);
        let quanta = (fade as usize).div_ceil(QUANTUM) + 2;
        for _ in 0..quanta {
            let (l, r) = render(&mut core, &mut frame);
            for i in 0..QUANTUM {
                let (wl, wr) = crossfade_want(g, dir, &mut share);
                worst = worst.max(db(l[i], wl)).max(db(r[i], wr));
                let p = 10.0 * (l[i] * l[i] + r[i] * r[i]).log10();
                lo = lo.min(p);
                hi = hi.max(p);
            }
        }
    }
    let p0 = 10.0 * ((g * el).powi(2) + (g * er).powi(2)).log10();
    assert!(worst < 0.05, "crossfade law: {worst} dB");
    // §9: the dip (or, with correlated halves, the bump) is recorded, not asserted.
    eprintln!("crossfade golden: worst {worst:.2e} dB; level {:.2} .. {:.2} dB around the equal-power {p0:.2} dB", lo - p0, hi - p0);
    let (l, r) = render(&mut core, &mut frame);
    assert_eq!((l[5], r[5]), (g * el, g * er), "back on equal-power exactly");
}

#[test]
fn golden_ducked_chain_a_sharing_bus_follows_the_duck_within_0_05_db() {
    let mut core = new_core(48_000.0, 1, 64, 16);
    let dir = [-0.3f32, 0.1, -0.95];
    let g = 0.4;
    let mut frame = 0u64;
    // root <- A <- B; the root hosts slot 0; A and B share it.
    let recs = [vec![buses(&[ROOT, 0, 1])], mix(0, &[0.5, 1.0, 0.5]), vec![bed_config(&[0, 0, 0], &[0]), play(0x0001_0001, 2, g, dir, BED_KIND)]].concat();
    assert_eq!(submit(&mut core, frame, &recs), 0);
    render(&mut core, &mut frame);
    // The duck: A from 1 to 0.25 (-12 dB) over 240 frames (5 ms) while the root goes 0.5 to 1.
    assert_eq!(submit(&mut core, frame, &mix(240, &[1.0, 0.25, 0.5])), 0);
    let (ml, mr) = matrix_gains(dir);
    let mut worst = 0.0f32;
    for _ in 0..8 {
        // The whole chain's gain (B, A and the root host), frame by frame, as `bus::mixdown` applies it.
        let mut chain_gain = [0.0f32; QUANTUM];
        chain::fill(&mut core, 2, None, &mut chain_gain);
        let (l, r) = render(&mut core, &mut frame);
        for i in 0..QUANTUM {
            worst = worst.max(db(l[i], g * ml * chain_gain[i])).max(db(r[i], g * mr * chain_gain[i]));
        }
    }
    assert!(worst < 0.05, "ducked chain: {worst} dB");
    eprintln!("ducked chain golden: worst {worst:.2e} dB");
}

#[test]
fn no_bed_config_is_m2_kind_2_pans_equal_power_bit_for_bit() {
    // With beds in the layout but no BED_CONFIG, and with no beds at all.
    for max_beds in [0, 2] {
        let dir = [0.7f32, 0.0, -0.7];
        let run = |kind: u16| {
            let mut core = new_core(48_000.0, max_beds, 64, 16);
            let mut frame = 0;
            assert_eq!(submit(&mut core, frame, &[buses(&[ROOT]), play(0x0001_0001, ROOT, 0.5, dir, kind)]), 0);
            let mut out = Vec::new();
            for _ in 0..4 {
                let (l, r) = render(&mut core, &mut frame);
                out.extend(l);
                out.extend(r);
            }
            (out, status::counters(&core).spatial.beds_active)
        };
        let (bed, active) = run(BED_KIND);
        assert_eq!(bed, run(0).0, "max_beds {max_beds}: kind 2 without a bed is kind 0");
        assert_eq!(active, 0);
    }
}

#[test]
fn bed_config_validation_refuses_non_ancestor_hosts() {
    let mut core = new_core(48_000.0, 2, 64, 16);
    let mut frame = 0;
    // root <- A, root <- B. Slot 0 hosted by A; B asks for it (A isn't its ancestor): refused.
    // Slot 3 is past max_beds: refused. Slot 1 is unused: refused.
    let recs = [buses(&[ROOT, 0, 0]), bed_config(&[NONE_SLOT, 0, 0, 3], &[1, wire::BED_HOST_NONE as u16])];
    assert_eq!(submit(&mut core, frame, &recs), 0);
    assert_eq!(status::counters(&core).spatial.beds_refused, 1, "B's non-ancestor host");
    assert_eq!(submit(&mut core, frame, &[bed_config(&[1, 3, 0], &[0])]), 0);
    assert_eq!(status::counters(&core).spatial.beds_refused, 3, "plus an unused slot and one past max_beds");
    // A voice on the refused bus pans equal-power.
    assert_eq!(submit(&mut core, frame, &[play(0x0001_0001, 1, 0.5, [1.0, 0.0, 0.0], BED_KIND)]), 0);
    let (l, r) = render(&mut core, &mut frame);
    assert!(l[3].abs() < 1e-6 && r[3] == 0.5, "hard right, equal-power: {} {}", l[3], r[3]);
    // BED_CONFIG with more than MAX_BEDS slots is malformed: the batch is refused.
    let bad = rec(|b| {
        let n = wire::BedConfig { voice_id: 0, frame_offset: wire::ASAP, bed_slot: vec![0], host_bus: vec![0; 4] }.write(b, 0)?;
        b[16] = 5;
        Ok(n)
    });
    assert_ne!(submit(&mut core, frame, &[bad]), 0);
}

const NONE_SLOT: u8 = wire::BED_SLOT_NONE as u8;

#[test]
fn a_bed_idles_after_its_partitions_then_after_one_quantum_once_the_ladder_steps() {
    // max_mixed 16: the cap's floor is the configured cap, so it sits at its floor from the start.
    let mut core = new_core(48_000.0, 1, 64, 16);
    let mut frame = 0;
    let v = 0x0001_0001;
    assert_eq!(submit(&mut core, frame, &[buses(&[ROOT]), bed_config(&[0], &[0]), play(v, ROOT, 0.5, [0.0, 0.0, -1.0], BED_KIND)]), 0);
    let active = |core: &mut Core, frame: &mut u64, n: usize| -> Vec<u16> {
        (0..n)
            .map(|_| {
                render(core, frame);
                status::counters(core).spatial.beds_active
            })
            .collect()
    };
    assert_eq!(active(&mut core, &mut frame, 3)[1..], [1, 1]);
    assert_eq!(submit(&mut core, frame, &[stop(v)]), 0);
    // The stop lands in quantum k (nothing encodes); counters lag one quantum.
    let seen = active(&mut core, &mut frame, 6);
    assert_eq!(seen, [1, 1, 1, 0, 0, 0], "decodes 2 more quanta (its partitions' history), then idle");
    // The ladder: underruns every quantum for 1 s with the cap at its floor.
    assert_eq!((bed::m3_shed(&mut core), bed::ladder_steps(&mut core)), (0, 0));
    let second = (48_000 / QUANTUM) as u32 + 2;
    for k in 1..=second {
        core.note_underruns(k);
        render(&mut core, &mut frame);
    }
    assert_eq!(bed::ladder_steps(&mut core), bed::step::BED_IDLE);
    assert_eq!(bed::m3_shed(&mut core), 1, "m3Shed counts the step");
    // D5: STATUS carries it (bed steps plus zone steps).
    let mut out = vec![0u8; 20_000];
    let n = status::take(&mut core, &mut out, 0);
    assert_eq!(wire::StatusBlock::read(&out[..n], 0).unwrap().0.m3_shed, 1, "STATUS m3Shed");
    // More underruns: no further bed step (the zone steps are C3's).
    for k in second + 1..=3 * second {
        core.note_underruns(k);
        render(&mut core, &mut frame);
    }
    assert_eq!(bed::m3_shed(&mut core), 1);
    let v2 = 0x0001_0002;
    assert_eq!(submit(&mut core, frame, &[play(v2, ROOT, 0.5, [0.0, 0.0, -1.0], BED_KIND)]), 0);
    assert_eq!(active(&mut core, &mut frame, 3)[1..], [1, 1]);
    assert_eq!(submit(&mut core, frame, &[stop(v2)]), 0);
    assert_eq!(active(&mut core, &mut frame, 5), [1, 1, 0, 0, 0], "idle after 1 silent quantum");
}

#[test]
fn the_ladder_waits_for_the_floor_and_for_a_full_second() {
    let mut core = new_core(48_000.0, 1, 64, 32);
    let mut frame = 0;
    // The cap starts at 32 (above its floor of 16): underruns move the cap, not the ladder.
    for k in 1..=200 {
        core.note_underruns(k);
        render(&mut core, &mut frame);
    }
    assert!(core.cap().cap() > core.cap().config().floor);
    assert_eq!(bed::m3_shed(&mut core), 0);
    // At the floor (max_mixed 16) but underruns stopping before 1 s: no step.
    let mut core = new_core(48_000.0, 1, 64, 16);
    let mut frame = 0;
    for k in 1..=200 {
        core.note_underruns(k);
        render(&mut core, &mut frame);
    }
    for _ in 0..800 {
        render(&mut core, &mut frame);
    }
    for k in 201..=300 {
        core.note_underruns(k);
        render(&mut core, &mut frame);
    }
    assert_eq!(bed::m3_shed(&mut core), 0, "two short runs, a quiet gap between");
}

#[test]
fn the_bed_step_and_the_cap_come_back_once_underruns_stop() {
    // ADR 0170: max_mixed 64, so underruns first walk the cap down to its floor of 16, then the
    // ladder takes its bed-idle step; once they stop, the cap climbs back to 64 and the step comes
    // back after 20 s without an underrun.
    let q_per_s = (48_000 / QUANTUM) as u32;
    let mut core = new_core(48_000.0, 1, 64, 64);
    let mut frame = 0;
    let mut k = 0;
    while bed::m3_shed(&mut core) == 0 {
        k += 1;
        assert!(k < 30 * q_per_s, "the ladder steps within 30 s of underruns");
        core.note_underruns(k);
        render(&mut core, &mut frame);
    }
    assert_eq!(core.cap().cap(), core.cap().config().floor);
    assert_eq!(bed::ladder_steps(&mut core), bed::step::BED_IDLE);
    // Clean from here: 20 s less a quantum keeps the step, the hold's end gives it back.
    let hold = (20 * 48_000 / QUANTUM) as u32;
    for _ in 0..hold - 1 {
        render(&mut core, &mut frame);
    }
    assert_eq!(bed::m3_shed(&mut core), 1, "held for 20 s");
    render(&mut core, &mut frame);
    render(&mut core, &mut frame);
    assert_eq!((bed::m3_shed(&mut core), bed::ladder_steps(&mut core)), (0, 0), "given back");
    assert_eq!(core.cap().ladder().restores, 1);
    let mut out = vec![0u8; 20_000];
    let n = status::take(&mut core, &mut out, 0);
    assert_eq!(wire::StatusBlock::read(&out[..n], 0).unwrap().0.m3_shed, 0, "STATUS m3Shed is the steps in force");
    // The cap: 5 s of calm, then +2 a second from 16 to 64.
    for _ in 0..15 * q_per_s {
        render(&mut core, &mut frame);
    }
    assert_eq!(core.cap().cap(), 64, "the cap is back at its preset");
    // A bed after the give-back idles after its partitions again, not after one quantum.
    let v = 0x0001_0001;
    assert_eq!(submit(&mut core, frame, &[buses(&[ROOT]), bed_config(&[0], &[0]), play(v, ROOT, 0.5, [0.0, 0.0, -1.0], BED_KIND)]), 0);
    for _ in 0..3 {
        render(&mut core, &mut frame);
    }
    assert_eq!(submit(&mut core, frame, &[stop(v)]), 0);
    let mut seen = Vec::new();
    for _ in 0..6 {
        render(&mut core, &mut frame);
        seen.push(status::counters(&core).spatial.beds_active);
    }
    assert_eq!(seen, [1, 1, 1, 0, 0, 0], "its partitions' history again");
}

#[test]
fn a_removed_host_drains_and_reset_clears_every_bed() {
    let mut core = new_core(48_000.0, 2, 64, 16);
    let mut frame = 0;
    let v = 0x0001_0001;
    assert_eq!(submit(&mut core, frame, &[buses(&[ROOT, 0]), bed_config(&[0, 1], &[0, 1]), play(v, 1, 0.5, [0.0, 0.0, -1.0], BED_KIND)]), 0);
    for _ in 0..3 {
        render(&mut core, &mut frame);
    }
    let c = &status::counters(&core).spatial;
    assert_eq!((c.beds_active, c.sent_beds()[0].bus), (1, 1), "bus 1 hosts its own bed");
    // Slot 1's host is removed and bus 1 moves to the root's slot 0 (the voice follows by its
    // share: slot 1 isn't kept, so the move has no old slot to crossfade from).
    assert_eq!(submit(&mut core, frame, &[bed_config(&[0, 0], &[0, wire::BED_HOST_NONE as u16])]), 0);
    let mut hosts = Vec::new();
    for _ in 0..5 {
        render(&mut core, &mut frame);
        hosts.push(status::counters(&core).spatial.sent_beds().iter().map(|b| b.bus).collect::<Vec<_>>());
    }
    assert!(hosts.iter().any(|h| h.contains(&1)), "slot 1 drains into bus 1: {hosts:?}");
    assert_eq!(*hosts.last().unwrap(), vec![0], "then only the root's bed: {hosts:?}");
    assert_eq!(submit(&mut core, frame, &[reset(true)]), 0);
    assert_eq!(status::counters(&core).spatial.beds_active, 0);
    // After RESET no bus has a bed: a new kind-2 voice pans equal-power.
    assert_eq!(submit(&mut core, frame, &[buses(&[ROOT]), play(0x0001_0002, ROOT, 0.5, [1.0, 0.0, 0.0], BED_KIND)]), 0);
    let (l, r) = render(&mut core, &mut frame);
    assert!(l[3].abs() < 1e-6 && r[3] == 0.5, "equal-power: {} {}", l[3], r[3]);
    render(&mut core, &mut frame);
    assert_eq!(status::counters(&core).spatial.beds_active, 0);
}

#[test]
fn a_bus_move_between_slots_crossfades_with_complementary_equal_power_weights() {
    let mut core = new_core(48_000.0, 2, 64, 16);
    let mut frame = 0;
    let dir = [0.0f32, 0.0, -1.0];
    let g = 0.5;
    // Both slots hosted by the root: the move changes nothing heard (same decode), so the output
    // stays at g × matrix while both slots decode for the 45 ms.
    assert_eq!(submit(&mut core, frame, &[buses(&[ROOT, 0]), bed_config(&[NONE_SLOT, 0], &[0, 0]), play(0x0001_0001, 1, g, dir, BED_KIND)]), 0);
    for _ in 0..3 {
        render(&mut core, &mut frame);
    }
    assert_eq!(submit(&mut core, frame, &[bed_config(&[NONE_SLOT, 1], &[0, 0])]), 0);
    let (ml, _) = matrix_gains(dir);
    let (mut both, mut peak) = (0, 0.0f32);
    for _ in 0..24 {
        let (l, _) = render(&mut core, &mut frame);
        for x in &l {
            // The two halves are the same signal, so equal-power weights sum to at most √2 (+3 dB).
            peak = peak.max(db(*x, g * ml));
        }
        both += (status::counters(&core).spatial.beds_active == 2) as u32;
    }
    assert!(both >= 15, "both slots decode during the move: {both} quanta");
    let (l, _) = render(&mut core, &mut frame);
    assert!(db(l[0], g * ml) < 1e-4, "after the move, the new slot alone");
    assert!(peak <= 3.02, "the move's bump: {peak} dB");
    render(&mut core, &mut frame);
    render(&mut core, &mut frame);
    render(&mut core, &mut frame);
    assert_eq!(status::counters(&core).spatial.beds_active, 1);
}

/// A synthetic HRIR table at `rate` (every response a 0.5 impulse, delays 3 and 7.5), loaded as
/// main sends it (as `tests/hrtf.rs`).
fn load_impulse_hrir(core: &mut Core, rate: f32) {
    use audio_dsp::hrtf::database::{encode, HrirHeader};
    let header = HrirHeader { elevations: 10, azimuths: 24, ir_length: 256, rate };
    let delays: Vec<f32> = (0..480).map(|i| if i % 2 == 0 { 3.0 } else { 7.5 }).collect();
    let mut irs = vec![0i16; 240 * 256 * 2];
    for d in 0..240 {
        irs[d * 512] = 16384;
        irs[d * 512 + 1] = 16384;
    }
    let mut bytes = vec![0u8; header.byte_len()];
    encode(&header, &delays, &irs, &mut bytes).unwrap();
    let id = wire::HRIR_CLIP_ID_FIRST;
    assert_eq!(clips::reserve(core, id, (bytes.len() / 2) as u32, 1, rate, wire::clip_format::HRIR), wire::ERR_OK);
    for (k, chunk) in bytes.chunks(clips::MAX_CHUNK_BYTES).enumerate() {
        let at = (k * clips::MAX_CHUNK_BYTES / 2) as u32;
        let p = clips::chunk_ptr(core, id, at, chunk.len() as u32);
        // SAFETY: chunk_ptr gave room for `chunk.len()` bytes.
        unsafe { core::ptr::copy_nonoverlapping(chunk.as_ptr(), p, chunk.len()) };
        assert_eq!(clips::commit(core, id, at, chunk.len() as u32), wire::ERR_OK);
    }
}

/// Renders `n` quanta; returns `hrtfVoices` and `bedVoices` per quantum and the lowest quantum RMS.
fn run_counting(core: &mut Core, frame: &mut u64, n: usize) -> (Vec<u16>, Vec<u16>, f32) {
    let (mut h, mut b, mut lo) = (Vec::new(), Vec::new(), f32::MAX);
    for _ in 0..n {
        let (l, r) = render(core, frame);
        let rms = (l.iter().chain(&r).map(|x| x * x).sum::<f32>() / (2 * QUANTUM) as f32).sqrt();
        lo = lo.min(rms);
        let c = status::counters(core);
        h.push(c.hrtf_voices);
        b.push(c.spatial.bed_voices);
    }
    (h, b, lo)
}

#[test]
fn an_hrtf_voice_holds_its_slot_through_the_crossfade_to_the_bed_and_comes_back_whole() {
    let rate = 48_000.0;
    let mut core = new_core(rate, 1, 64, 16);
    load_impulse_hrir(&mut core, rate);
    let v = 0x0001_0001;
    let mut frame = 0;
    assert_eq!(submit(&mut core, frame, &[buses(&[ROOT]), bed_config(&[0], &[0]), play(v, ROOT, 0.5, [0.5, 0.0, -0.866], wire::panner::HRTF as u16)]), 0);
    let fade_quanta = (0.045f32 * rate / QUANTUM as f32).ceil() as usize;
    let (h, _, _) = run_counting(&mut core, &mut frame, fade_quanta + 4);
    assert!(h.iter().all(|&x| x == 1), "HRTF: {h:?}");
    // To the bed: the HRTF half is held while the law fades it, then freed.
    assert_eq!(submit(&mut core, frame, &[set_kind(v, wire::panner::BED)]), 0);
    let (h, b, lo_to_bed) = run_counting(&mut core, &mut frame, fade_quanta + 4);
    let held = h.iter().take_while(|&&x| x == 1).count();
    assert!(held + 1 >= fade_quanta && held <= fade_quanta + 1, "held for the crossfade: {h:?}");
    assert!(h[held..].iter().all(|&x| x == 0), "then freed: {h:?}");
    assert!(b[2..].iter().all(|&x| x == 1), "encoded from the first quantum: {b:?}");
    // Back to HRTF: a slot at once, the bed fading out by the law.
    assert_eq!(submit(&mut core, frame, &[set_kind(v, wire::panner::HRTF)]), 0);
    let (h, b, lo_back) = run_counting(&mut core, &mut frame, fade_quanta + 4);
    assert!(h.iter().all(|&x| x == 1), "HRTF at once: {h:?}");
    assert_eq!(*b.last().unwrap(), 0, "the bed half gone: {b:?}");
    eprintln!("HRTF <-> bed: lowest quantum RMS {lo_to_bed:.4} (to the bed), {lo_back:.4} (back)");
    assert!(lo_to_bed > 0.1 && lo_back > 0.1, "no gap");
}
