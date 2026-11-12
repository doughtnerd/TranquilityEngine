//! F-40: a voice whose low-pass runs (occlusion) and whose zone send starts or settles at 0 must
//! not click. The voice chain takes the dry gain before the filters without a send (M2's order)
//! and after them with one (R11, K3), so the filters' history changes units when the send starts
//! or stops; before F-40 that was a step of up to the ungained level through the low-pass (heard
//! in the Sound Lab as the Doppler ball entered and left the cave zone: 0.13 to 0.15 at a 0.05
//! dry gain). The dry path is checked alone (the zone returns to a bus at gain 0) against the same
//! voice that never sends: the order's change must leave it to float rounding.

mod common;
#[allow(dead_code)]
mod zones_common;

use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::Core;
use audio_wire::generated as wire;
use common::*;

const V1: u32 = 0x0001_0001;
const SINE: u32 = 2;
const K1: u32 = zones_common::K1;
const IR: u32 = 4_096;
/// The dry gain: far from 1, as a distant, occluded source's (the Sound Lab ball's was 0.05).
const DRY: f32 = 0.05;

fn core() -> Core {
    let p = zones_common::zone_params(1, IR);
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose ('static).
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: a fresh block of `layout.total()` zeroed bytes, aligned to PAGE_BYTES.
    unsafe { Core::new(p, layout, base) }
}

fn raw(write: impl Fn(&mut [u8]) -> Result<usize, i32>) -> Rec {
    let mut b = vec![0u8; 4096];
    let n = write(&mut b).unwrap();
    b.truncate(n);
    Rec::Raw(b)
}

fn send(level: f32, ramp_frames: u32) -> Rec {
    raw(|b| {
        wire::SetVoiceFx { voice_id: V1, frame_offset: wire::ASAP, mask: wire::SET_VOICE_FX_MASK_SENDS, ramp_frames, hp_hz: 0.0, send: [level, 0.0, 0.0, 0.0], yaw: 0.0, aux_level: 0.0, aux_bus: wire::AUX_BUS_NONE as u16, reserved: 0 }
            .write(b, 0)
    })
}

/// A 200 Hz sine at 0.3 (a whole number of cycles: it loops seamlessly), dry gain [`DRY`], its
/// low-pass settled at 2.5 kHz (wood's cut-off); zone slot 0 active, returning to bus 2 at gain 0.
fn scene() -> Mixer {
    let mut m = Mixer::over(core());
    m.set_lookahead(0.0);
    zones_common::load_kernel(&mut m.core, K1, &zones_common::kernel_blob_at(IR, 1, RATE));
    let sine: Vec<f32> = (0..4_800).map(|i| 0.3 * (std::f32::consts::TAU * 200.0 * i as f32 / RATE).sin()).collect();
    m.load_clip(SINE, &sine);
    m.submit(&[config(&[ROOT, 0, 0]), gains(0, &[1.0, 1.0, 0.0])]);
    m.submit(&[Rec::Raw(zones_common::zone_config(1.0, 0, &[(K1, 2, wire::zone_slot_state::ACTIVE as u8, 1.0, IR)]))]);
    m.submit(&[
        play(V1, SINE, 1, MIXED | LOOP),
        Rec::Set(wire::SetParams { voice_id: V1, frame_offset: wire::ASAP, mask: wire::SET_PARAMS_MASK_GAIN | wire::SET_PARAMS_MASK_LP_HZ, gain: DRY, lp_hz: 2_500.0, ..Default::default() }),
    ]);
    m.render_n(40);
    m
}

/// The largest sample-to-sample step of both channels.
fn max_step(l: &[f32], r: &[f32]) -> f32 {
    l.windows(2).chain(r.windows(2)).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max)
}

/// Renders `script` (quanta to render, then the records to submit) on the scene and on the same
/// scene with no sends; returns the largest difference and the largest step of the first.
fn against_no_send(script: &[(usize, Vec<Rec>)]) -> (f32, f32) {
    let (mut with, mut without) = (scene(), scene());
    let (mut wl, mut wr, mut ol, mut or) = (vec![], vec![], vec![], vec![]);
    for (quanta, recs) in script {
        with.submit(recs);
        let (l, r) = with.render_n(*quanta);
        wl.extend(l);
        wr.extend(r);
        let (l, r) = without.render_n(*quanta);
        ol.extend(l);
        or.extend(r);
    }
    let diff = wl.iter().zip(&ol).chain(wr.iter().zip(&or)).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max);
    (diff, max_step(&wl, &wr))
}

#[test]
fn a_send_that_fades_in_and_settles_at_0_leaves_the_dry_path_unchanged() {
    // Main's zone send as the Sound Lab's ball crosses a zone: up over a frame (768 frames), held,
    // down over a frame, settling at 0 (the sends' order ends there).
    let (diff, step) = against_no_send(&[(4, vec![send(0.3, 768)]), (20, vec![send(0.0, 768)]), (20, vec![])]);
    // The clean voice's largest step: 0.3 × 0.05 × 2π × 200 / 48,000 ≈ 4e-4.
    eprintln!("send in and out: {diff:.2e} from the voice without sends, largest step {step:.2e}");
    assert!(diff < 1e-5, "the dry path moved by {diff}");
    assert!(step < 5e-4, "a click: step {step}");
}

#[test]
fn a_send_that_jumps_on_and_off_leaves_the_dry_path_unchanged() {
    // `rampFrames` 0 on an audible voice: the send ramps jump, so the order changes when the record
    // lands, both ways.
    let (diff, step) = against_no_send(&[(4, vec![send(0.3, 0)]), (6, vec![send(0.0, 0)]), (6, vec![send(0.2, 0)]), (6, vec![])]);
    eprintln!("send jumped on and off: {diff:.2e} from the voice without sends, largest step {step:.2e}");
    assert!(diff < 1e-5, "the dry path moved by {diff}");
    assert!(step < 5e-4, "a click: step {step}");
}
