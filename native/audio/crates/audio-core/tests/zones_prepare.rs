//! The in-core preparation of a zone kernel from format 5 PCM (ADR 0162 C3b, api-and-models §4.5,
//! §5.2, §10 C3b; architecture §2.2 "Worker missing"): a worker-less run prepares a 2 s response
//! over quanta, the kernel is the one the decoder would have prepared from the same samples, the
//! slot then plays as if the kernel had been uploaded, and a quantum adds at most 23 µs.

mod zones_common;

use std::time::Instant;

use audio_core::{clips, zones, Core};
use audio_dsp::convolver::ir::blink_normalization_scale;
use audio_dsp::convolver::kernel::{kernel_bytes, prepare_ir, IrSpec};
use audio_dsp::convolver::{Scratch, SCRATCH_BYTES};
use audio_wire::generated as wire;
use zones_common::*;

/// 2 s at 48 kHz (api-and-models §10 C3b).
const FRAMES_2S: u32 = 96_000;

/// A seeded decaying stereo response, interleaved (what main uploads as format 5).
fn response(frames: u32, seed: u32) -> Vec<f32> {
    let mut s = seed | 1;
    (0..2 * frames)
        .map(|i| {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            let t = (i / 2) as f32 / frames as f32;
            ((s as f32 / u32::MAX as f32) * 2.0 - 1.0) * (1.0 - t) * (1.0 - t) * (1.0 - t)
        })
        .collect()
}

fn le_bytes(x: &[f32]) -> Vec<u8> {
    x.iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// The decoder's step 4 (`audio_decode::ir::kernel`, task C2a) on a stereo response at [`RATE`]:
/// the sum of squares in `f64`, channel 0's samples then channel 1's, Blink's scale, `prepare_ir`.
fn decoder_kernel(pcm: &[f32]) -> Vec<u8> {
    let frames = pcm.len() / 2;
    let (left, right): (Vec<f32>, Vec<f32>) = (pcm.iter().step_by(2).copied().collect(), pcm.iter().skip(1).step_by(2).copied().collect());
    let sum: f64 = left.iter().chain(&right).map(|&x| x as f64 * x as f64).sum();
    let scale = blink_normalization_scale(sum, 2 * frames, RATE);
    let mut sb = vec![0u32; SCRATCH_BYTES / 4];
    // SAFETY: a u32 buffer viewed as its bytes.
    let sbytes = unsafe { core::slice::from_raw_parts_mut(sb.as_mut_ptr() as *mut u8, sb.len() * 4) };
    let mut scratch = Scratch::from_bytes(sbytes).unwrap();
    scratch.fill_twiddles();
    let n = kernel_bytes(frames);
    let mut words = vec![0u32; n / 4];
    // SAFETY: as above.
    let out = unsafe { core::slice::from_raw_parts_mut(words.as_mut_ptr() as *mut u8, n) };
    let mut it = left.iter().chain(&right).copied();
    prepare_ir(out, &mut scratch, IrSpec { frames, sample_rate: RATE, scale, flags: 0 }, || it.next().unwrap()).unwrap();
    out.to_vec()
}

/// A core with `slots` slots of 2 s, slot 0 active on `K1` (waiting), and `pcm` uploaded as K1's
/// format 5 clip.
fn worker_less(slots: u32, pcm: &[f32]) -> Zones {
    let mut z = Zones::over(core_with(zone_params(slots, FRAMES_2S)));
    z.config(1.0, 0, &[(K1, 0, zone_slot_state::ACTIVE as u8, 1.0, FRAMES_2S)]);
    upload_pcm(&mut z.core, K1, pcm);
    z
}

fn upload_pcm(core: &mut Core, id: u32, pcm: &[f32]) {
    let frames = (pcm.len() / 2) as u32;
    assert_eq!(clips::reserve(core, id, frames, 2, RATE, wire::clip_format::ZONE_IR_PCM), wire::ERR_OK);
    // In chunks, as the shell copies them.
    let bytes = le_bytes(pcm);
    for (i, chunk) in bytes.chunks(64 * 1024).enumerate() {
        assert_eq!(clips::write(core, id, (i * 64 * 1024 / 8) as u32, chunk), wire::ERR_OK);
    }
}

fn steps(frames: u32) -> usize {
    zones::prep_steps(frames as usize).iter().sum::<usize>() + 1
}

#[test]
fn a_worker_less_run_prepares_a_2_s_response_and_the_slot_starts() {
    let pcm = response(FRAMES_2S, 7);
    let mut z = worker_less(1, &pcm);
    assert_eq!(z.state(0), zone_state::WAITING_KERNEL);
    assert!(z.core.clips().zone_kernel(K1).is_none(), "format 5 is not a kernel yet");
    let want = steps(FRAMES_2S);
    let mut quanta = 0;
    while z.state(0) == zone_state::WAITING_KERNEL {
        assert!(quanta <= want, "prepared within {want} quanta");
        z.render();
        quanta += 1;
    }
    assert_eq!(quanta, want);
    eprintln!("2 s response prepared in {quanta} quanta ({:.0} ms at 48 kHz)", quanta as f64 * 128.0 / 48.0);
    assert!(quanta as f64 * 128.0 / 48_000.0 <= 0.8, "within the design's 0.25-0.8 s");
    assert_eq!(z.state(0), zone_state::FADING_IN);
    assert_eq!(zones::preparing(&z.core), None);
    // The clip is now the format 3 kernel, and it is the decoder's, bit for bit.
    let got = z.core.clips().zone_kernel(K1).expect("a format 3 kernel");
    assert!(got == decoder_kernel(&pcm).as_slice(), "the kernel equals the decoder's");
    assert!(z.core.clips().is_resident(K1));
    // `resident` was reported for the id.
    clips::flush_events(&mut z.core);
    let events = audio_core::status::counters(&z.core).clip_events.as_slice().to_vec();
    assert!(events.iter().any(|e| e.id == K1 && e.code == wire::clip_event::RESIDENT), "{events:?}");
    // It plays: a burst of input comes back wet.
    let (l, _) = z.run(40, |q| (q < 4).then(|| (0, noise(q as u32 + 1))));
    assert!(peak(&l) > 1e-4, "the slot returns its wet signal");
}

#[test]
fn the_prepared_slot_sounds_exactly_like_an_uploaded_kernel() {
    let frames = 20_000; // 32 head and 8 tail partitions: quick
    let pcm = response(frames, 11);
    let config = [(K1, 0, zone_slot_state::ACTIVE as u8, 1.0, frames)];
    let mut a = Zones::over(core_with(zone_params(1, frames)));
    a.config(1.0, 0, &config);
    upload_pcm(&mut a.core, K1, &pcm);
    let mut b = Zones::over(core_with(zone_params(1, frames)));
    b.config(1.0, 0, &config);
    let mut q = 0;
    while a.state(0) == zone_state::WAITING_KERNEL {
        a.render();
        b.render();
        q += 1;
    }
    // The uploaded kernel arrives where the prepared one finished, so both slots start on the
    // same quantum.
    load_kernel(&mut b.core, K1, &decoder_kernel(&pcm));
    assert_eq!((a.state(0), b.state(0)), (zone_state::FADING_IN, zone_state::FADING_IN), "after {q} quanta");
    let input = |q: usize| (q % 3 != 2).then(|| (0, noise(q as u32 + 5)));
    assert_eq!(a.run(300, input), b.run(300, input), "bit-identical output");
}

#[test]
fn every_slot_waiting_on_the_response_starts_and_the_others_keep_waiting() {
    let frames = 9_000;
    let pcm = response(frames, 3);
    let mut z = Zones::over(core_with(zone_params(3, frames)));
    let s = |id| (id, 0u16, zone_slot_state::ACTIVE as u8, 1.0f32, frames);
    z.config(1.0, 0, &[s(K1), s(K1), s(K2)]);
    upload_pcm(&mut z.core, K1, &pcm);
    for _ in 0..steps(frames) {
        z.render();
    }
    assert_eq!((z.state(0), z.state(1), z.state(2)), (zone_state::FADING_IN, zone_state::FADING_IN, zone_state::WAITING_KERNEL));
}

#[test]
fn nothing_is_prepared_without_a_waiting_slot() {
    let frames = 9_000;
    let mut z = Zones::over(core_with(zone_params(1, frames)));
    upload_pcm(&mut z.core, K1, &response(frames, 3));
    z.run(steps(frames) + 4, |_| None);
    assert_eq!(zones::preparing(&z.core), None);
    assert!(z.core.clips().zone_kernel(K1).is_none());
    // A slot asking for it starts the preparation.
    z.config(1.0, 0, &[(K1, 0, zone_slot_state::ACTIVE as u8, 1.0, frames)]);
    z.run(steps(frames), |_| None);
    assert_eq!(z.state(0), zone_state::FADING_IN);
}

#[test]
fn a_response_freed_mid_preparation_is_dropped_and_a_new_one_prepares_from_the_start() {
    let frames = 20_000;
    let mut z = Zones::over(core_with(zone_params(1, frames)));
    z.config(1.0, 0, &[(K1, 0, zone_slot_state::ACTIVE as u8, 1.0, frames)]);
    upload_pcm(&mut z.core, K1, &response(frames, 1));
    z.run(steps(frames) / 2, |_| None);
    assert!(zones::preparing(&z.core).is_some());
    assert_eq!(clips::free(&mut z.core, K1), wire::ERR_OK);
    let pcm = response(frames, 2);
    upload_pcm(&mut z.core, K1, &pcm);
    assert_eq!(zones::preparing(&z.core), None, "the old preparation was dropped");
    z.run(steps(frames), |_| None);
    assert_eq!(z.state(0), zone_state::FADING_IN);
    assert!(z.core.clips().zone_kernel(K1).unwrap() == decoder_kernel(&pcm).as_slice());
}

#[test]
fn reset_keeping_clips_lets_the_preparation_finish() {
    let frames = 20_000;
    let mut z = Zones::over(core_with(zone_params(1, frames)));
    z.config(1.0, 0, &[(K1, 0, zone_slot_state::ACTIVE as u8, 1.0, frames)]);
    let pcm = response(frames, 4);
    upload_pcm(&mut z.core, K1, &pcm);
    z.run(steps(frames) / 2, |_| None);
    z.submit(&[reset_rec(true)]);
    assert_eq!(z.state(0), zone_state::OFF);
    z.run(steps(frames), |_| None);
    assert!(z.core.clips().zone_kernel(K1).unwrap() == decoder_kernel(&pcm).as_slice(), "finished without a slot");
    // A slot asking for it now starts at once, as for an uploaded kernel.
    z.config(1.0, 0, &[(K1, 0, zone_slot_state::ACTIVE as u8, 1.0, frames)]);
    assert_eq!(z.state(0), zone_state::FADING_IN);
}

#[test]
fn format_5_takes_its_kernel_block_and_is_refused_past_the_slots_length() {
    let mut core = core_with(zone_params(1, FRAMES_2S));
    assert_eq!(clips::reserve(&mut core, K1, FRAMES_2S + 1, 2, RATE, wire::clip_format::ZONE_IR_PCM), wire::ERR_BAD_ARG, "longer than a slot holds");
    assert_eq!(clips::reserve(&mut core, K1, FRAMES_2S, 2, RATE, wire::clip_format::ZONE_IR_PCM), wire::ERR_OK);
    assert_eq!(core.clips().zone_bytes(), zones::arena_block_bytes(kernel_bytes(FRAMES_2S as usize)), "the kernel's block: one slot's budget");
    // The budget (one kernel) is spent: a second response is refused.
    assert_eq!(clips::reserve(&mut core, K2, 1_000, 2, RATE, wire::clip_format::ZONE_IR_PCM), wire::ERR_CEILING);
    assert_eq!(clips::free(&mut core, K1), wire::ERR_OK);
    assert_eq!(core.clips().zone_bytes(), 0);
}

/// The time of the slowest step of a 2 s preparation, each step the fastest of `runs` runs.
fn slowest_step_us(runs: usize) -> (f64, usize) {
    let pcm = response(FRAMES_2S, 9);
    let n = steps(FRAMES_2S);
    let mut best = vec![f64::INFINITY; n];
    for _ in 0..runs {
        let mut z = worker_less(1, &pcm);
        for b in best.iter_mut() {
            let t = Instant::now();
            zones::prepare(&mut z.core);
            *b = b.min(t.elapsed().as_secs_f64() * 1e6);
        }
        assert_eq!(z.state(0), zone_state::FADING_IN);
    }
    eprintln!("{:?}", best.iter().map(|v| (v * 10.0).round() / 10.0).collect::<Vec<_>>());
    let (i, us) = best.iter().enumerate().fold((0, 0.0), |m, (i, &v)| if v > m.1 { (i, v) } else { m });
    (us, i)
}

#[test]
fn a_quantum_adds_at_most_23_us() {
    // Natively, in release (`cargo test --release -p audio-core --test zones_prepare`); a debug
    // build only reports.
    let (us, step) = slowest_step_us(5);
    let [sums, heads, tails, clears, plans] = zones::prep_steps(FRAMES_2S as usize);
    eprintln!("slowest step {step} ({us:.1} µs); steps: sum {sums}, head {heads}, tail {tails}, clear {clears}, plan {plans}, finish 1");
    if !cfg!(debug_assertions) {
        assert!(us <= 23.0, "step {step} took {us:.1} µs");
    }
}
