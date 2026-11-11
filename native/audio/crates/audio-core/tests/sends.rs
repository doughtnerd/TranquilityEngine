//! ADR 0162 C4: voice sends through the real render path (api-and-models §4.4, §10 C4; architecture
//! §3.3 "the tap", "bus chain", "aux send", §4): a zone send follows its voice's ducked bus within
//! 0.05 dB, a muted bus mutes its reverb, the send is taken before the dry gain, aux sends work
//! without zone slots (post-fader, panned, × the chain gain, through the aux bus's own fader), and
//! a voice with sends keeps its dry path to float rounding.

mod common;
#[allow(dead_code)]
mod zones_common;

use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::{bus, Core, QUANTUM};
use audio_dsp::convolver::kernel::{kernel_bytes, prepare_ir, IrSpec};
use audio_dsp::convolver::{Scratch, SCRATCH_BYTES};
use audio_wire::generated as wire;
use common::*;

const V1: u32 = 0x0001_0001;
/// A 1 kHz sine at 0.25, 4,800 frames (loops seamlessly).
const SINE: u32 = 2;
const K1: u32 = zones_common::K1;
const IR: u32 = 4_096;

fn core(slots: u32) -> Core {
    let p = zones_common::zone_params(slots, IR);
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose ('static).
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: a fresh block of `layout.total()` zeroed bytes, aligned to PAGE_BYTES.
    unsafe { Core::new(p, layout, base) }
}

fn bytes_of(v: &mut [u64]) -> &mut [u8] {
    // SAFETY: a u64 buffer viewed as its bytes.
    unsafe { core::slice::from_raw_parts_mut(v.as_mut_ptr() as *mut u8, v.len() * 8) }
}

/// A unit-impulse kernel of `IR` frames: the slot's wet is its input, delayed by the convolver.
fn delta_kernel() -> Vec<u8> {
    let mut sb = vec![0u64; SCRATCH_BYTES / 8];
    let mut scratch = Scratch::from_bytes(bytes_of(&mut sb)).unwrap();
    scratch.fill_twiddles();
    let n = kernel_bytes(IR as usize);
    let mut kb = vec![0u64; n.div_ceil(8)];
    let mut i = 0u32;
    prepare_ir(bytes_of(&mut kb), &mut scratch, IrSpec { frames: IR as usize, sample_rate: RATE, scale: 1.0, flags: 0 }, || {
        let x = if i % IR == 0 { 1.0 } else { 0.0 };
        i += 1;
        x
    })
    .unwrap();
    let mut out = bytes_of(&mut kb).to_vec();
    out.truncate(n);
    out
}

fn raw(write: impl Fn(&mut [u8]) -> Result<usize, i32>) -> Rec {
    let mut b = vec![0u8; 4096];
    let n = write(&mut b).unwrap();
    b.truncate(n);
    Rec::Raw(b)
}

fn voice_fx(voice: u32, mask: u32, send: [f32; 4], aux_bus: u16, aux_level: f32) -> Rec {
    raw(|b| wire::SetVoiceFx { voice_id: voice, frame_offset: wire::ASAP, mask, ramp_frames: 0, hp_hz: 0.0, send, yaw: 0.0, aux_level, aux_bus, reserved: 0 }.write(b, 0))
}

fn set_gain(voice: u32, gain: f32) -> Rec {
    Rec::Set(wire::SetParams { voice_id: voice, frame_offset: wire::ASAP, mask: wire::SET_PARAMS_MASK_GAIN, gain, ..Default::default() })
}

/// Buses: 0 the root, 1 "Footsteps" (the voice's), 2 the zone's return / the aux bus, both under 0.
fn tree() -> Rec {
    config(&[ROOT, 0, 0])
}

/// A mixer with zone slot 0 active on the delta kernel returning to bus 2, the DC voice on bus 1 at
/// dry gain 0 (so only the wet is heard) sending 0.5 into slot 0, faded in and settled.
fn zone_scene() -> Mixer {
    let mut m = Mixer::over(core(1));
    m.set_lookahead(0.0);
    zones_common::load_kernel(&mut m.core, K1, &delta_kernel());
    m.submit(&[tree(), gains(0, &[0.5, 1.0, 1.0])]);
    m.submit(&[Rec::Raw(zones_common::zone_config(1.0, 0, &[(K1, 2, wire::zone_slot_state::ACTIVE as u8, 1.0, IR)]))]);
    m.submit(&[play(V1, DC, 1, MIXED | LOOP), set_gain(V1, 0.0), voice_fx(V1, wire::SET_VOICE_FX_MASK_SENDS, [0.5, 0.0, 0.0, 0.0], wire::AUX_BUS_NONE as u16, 0.0)]);
    m.render_n(zones_common::quanta(150));
    m
}

fn db(a: f32, b: f32) -> f32 {
    (20.0 * (a / b).log10()).abs()
}

#[test]
fn a_zone_send_is_taken_before_the_dry_gain_and_scaled_by_the_chain() {
    let mut m = zone_scene();
    let (l, r) = m.render_n(4);
    // Dry gain 0: all of it is the wet, 1 (DC) × 0.5 (send) × 0.5 (root, the chain of bus 1) through a
    // unit impulse, then bus 2 (1) and the root (0.5) again on the return.
    for (a, b) in l.iter().zip(&r) {
        assert!((a - 0.125).abs() < 1e-5 && (b - 0.125).abs() < 1e-5, "{a} {b}");
    }
}

#[test]
fn a_send_follows_a_ducked_bus_within_0_05_db() {
    let mut reference = zone_scene();
    let mut ducked = zone_scene();
    // Footsteps ducked 12 dB over 5 ms (a ramp ending inside a quantum: the straight line between a
    // quantum's ends misses its knee by 0.86 dB), then back up over 7 ms.
    ducked.submit(&[gains(240, &[0.5, 0.25, 1.0])]);
    let (want, got) = (reference.render_n(3).0, ducked.render_n(3).0);
    ducked.submit(&[gains(336, &[0.5, 1.0, 1.0])]);
    let (want2, got2) = (reference.render_n(6).0, ducked.render_n(6).0);
    let (want, got) = ([want, want2].concat(), [got, got2].concat());
    // The bus's own gain at each frame, as `bus::mixdown` steps it.
    let gain = |k: usize| if k < 384 { ramp_to(1.0, 0.25, 240, k) } else { ramp_to(0.25, 1.0, 336, k - 384) };
    // The wet lags the tap by the convolver's latency: find it (the first frame the duck shows).
    let lag = got.iter().zip(&want).position(|(g, w)| (g - w).abs() > 1e-6).unwrap();
    assert!(lag < 2 * QUANTUM, "latency {lag}");
    let mut worst = 0.0f32;
    for k in 0..want.len() - lag {
        worst = worst.max(db(got[k + lag] / want[k + lag], gain(k)));
    }
    eprintln!("send under a duck: {worst:.2e} dB from the bus's gain (convolver latency {lag} frames)");
    assert!(worst < 0.05, "{worst} dB");
}

#[test]
fn a_muted_bus_mutes_its_reverb() {
    let mut m = zone_scene();
    // The mixer folds mute into the bus's gain: Footsteps to 0 over 5 ms.
    m.submit(&[gains(240, &[0.5, 0.0, 1.0])]);
    m.render_n(2 + (IR as usize).div_ceil(QUANTUM) + audio_core::zones::IDLE_MARGIN_QUANTA as usize);
    let (l, r) = m.render_n(4);
    assert!(zones_common::peak(&l) < 1e-7 && zones_common::peak(&r) < 1e-7, "the reverb rang out to silence");
    // Unmuted, it comes back.
    m.submit(&[gains(0, &[0.5, 1.0, 1.0])]);
    m.render_n(2);
    assert!(zones_common::peak(&m.render().0) > 0.1);
    // Muting an ancestor mutes it too (the return as well here, but the send goes first).
    m.submit(&[gains(0, &[0.0, 1.0, 1.0])]);
    m.render_n(2);
    assert_eq!(zones_common::peak(&m.render().0), 0.0);
}

#[test]
fn aux_sends_work_without_zone_slots() {
    let mut m = Mixer::over(core(0));
    m.set_lookahead(0.0);
    assert_eq!(audio_core::zones::slot_count(&m.core), 0);
    m.submit(&[tree(), gains(0, &[1.0, 0.5, 1.0])]);
    m.submit(&[play(V1, DC, 1, MIXED | LOOP), set_gain(V1, 0.5)]);
    m.render_n(2);
    let (dry, _) = m.render();
    check(&dry, 1e-6, "dry", |_| 0.25);
    // Post-fader: 1 × 0.5 (gain) × 0.5 (aux) × 0.5 (Footsteps' chain) into bus 2 (× 1, root × 1).
    m.submit(&[voice_fx(V1, wire::SET_VOICE_FX_MASK_AUX, [0.0; 4], 2, 0.5)]);
    m.render();
    let (l, r) = m.render();
    check(&l, 1e-6, "dry + aux L", |_| 0.375);
    check(&r, 1e-6, "dry + aux R", |_| 0.375);
    // The aux bus's own fader applies on top; muting Footsteps mutes both.
    m.submit(&[gains(0, &[1.0, 0.5, 0.5])]);
    m.render();
    check(&m.render().0, 1e-6, "aux bus at 0.5", |_| 0.25 + 0.0625);
    m.submit(&[gains(0, &[1.0, 0.0, 1.0])]);
    m.render();
    check(&m.render().0, 0.0, "Footsteps muted", |_| 0.0);
    // An aux bus past the configured ones is dropped; AUX_BUS_NONE stops the send.
    m.submit(&[gains(0, &[1.0, 0.5, 1.0]), voice_fx(V1, wire::SET_VOICE_FX_MASK_AUX, [0.0; 4], 7, 0.5)]);
    m.render();
    check(&m.render().0, 1e-6, "unknown aux bus", |_| 0.25);
    m.submit(&[voice_fx(V1, wire::SET_VOICE_FX_MASK_AUX, [0.0; 4], wire::AUX_BUS_NONE as u16, 0.5)]);
    m.render();
    check(&m.render().0, 1e-6, "no aux bus", |_| 0.25);
}

#[test]
fn an_aux_send_is_panned_with_its_voice() {
    let mut m = Mixer::over(core(0));
    m.set_lookahead(0.0);
    m.submit(&[tree(), gains(0, &[1.0, 1.0, 1.0])]);
    // Hard left, spatial: the equal-power panner leaves the right channel silent.
    m.submit(&[dc(V1, 1, -1.0), set_gain(V1, 0.25), voice_fx(V1, wire::SET_VOICE_FX_MASK_AUX, [0.0; 4], 2, 1.0)]);
    m.render_n(2);
    let (l, r) = m.render();
    assert!(zones_common::peak(&r) < 1e-6, "right {}", zones_common::peak(&r));
    check(&l, 1e-5, "dry + aux, left (under the limiter)", |_| 0.5);
}

/// The one allowed golden difference (waves plan, "What shippable means" 3): a voice with sends
/// runs fade × mix, `gainMul`, filters, tap, then the dry gain, where M2 runs the gain with the
/// fade first. Its dry output differs from the send-free reference by float rounding only.
#[test]
fn a_voice_with_sends_keeps_its_dry_path_to_float_rounding() {
    let render = |sends: bool, slots: u32| {
        let mut m = Mixer::over(core(slots));
        let sine: Vec<f32> = (0..4_800).map(|i| 0.25 * (std::f32::consts::TAU * i as f32 / 48.0).sin()).collect();
        m.load_clip(SINE, &sine);
        let mut recs = vec![play(V1, SINE, 0, MIXED | LOOP | SPATIAL), set_gain(V1, 0.7)];
        if sends {
            recs.push(voice_fx(V1, wire::SET_VOICE_FX_MASK_SENDS, [0.5, 0.0, 0.0, 0.25], wire::AUX_BUS_NONE as u16, 0.0));
        }
        m.submit(&recs);
        // A gain ramp and a fade under way as well.
        let (mut l, _) = m.render_n(2);
        m.submit(&[
            Rec::Set(wire::SetParams { voice_id: V1, frame_offset: wire::ASAP, mask: wire::SET_PARAMS_MASK_GAIN, gain: 0.2, ramp_frames: 300, ..Default::default() }),
            raw(|b| wire::Fade { voice_id: V1, frame_offset: wire::ASAP, target: 0.3, frames: 500, flags: 0, shape: 0 }.write(b, 0)),
        ]);
        l.extend(m.render_n(6).0);
        l
    };
    let reference = render(false, 0);
    let mut worst = 0.0f32;
    let mut differ = 0;
    for slots in [0, 1] {
        let sending = render(true, slots);
        for (a, b) in reference.iter().zip(&sending) {
            worst = worst.max((a - b).abs());
            differ += (a.to_bits() != b.to_bits()) as usize;
        }
    }
    eprintln!("a voice with sends against its send-free reference: max |diff| {worst:.3e} ({differ} of {} samples differ)", 2 * reference.len());
    assert!(worst <= 2.0 * f32::EPSILON * 0.25, "{worst}");
}

#[test]
fn the_sends_area_is_there_with_or_without_zone_slots() {
    for slots in [0, 1] {
        let mut c = core(slots);
        let area = audio_core::zones::sends_area(&mut c.regions_mut().zones[..]).expect("laid out");
        assert_eq!((area.head.buses, area.gains.len(), area.aux.len()), (0, 8 * QUANTUM, 8 * 2 * QUANTUM), "{slots} slots");
        let aux: *const f32 = area.aux.as_ptr();
        assert_eq!(aux, audio_core::zones::aux_accumulator(&mut c.regions_mut().zones[..]).as_ptr(), "the same accumulator");
        let zones = c.regions().zones.len();
        assert_eq!(zones, audio_core::zones::region_bytes(c.params()), "{slots} slots");
    }
    let _ = bus::count;
}
