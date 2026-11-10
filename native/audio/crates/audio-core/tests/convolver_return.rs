//! The shared reverb return through the core (task A2.2b): a bus's `reverbSend` feeds the shared
//! convolver, whose wet signal joins the output before MASTER; RESET clears its tail. MASTER is at
//! 0.25 in both renders so the dry DC plus its reverb stays under the master limiter's ceiling
//! (A2.8); the comparison is linear, so the reference is unchanged.

mod common;

use audio_core::fx::kind;
use audio_dsp::convolver;
use common::*;

const V1: u32 = 0x0001_0001;
const QUANTA: usize = 40;

fn render(send: f32) -> (Vec<f32>, Vec<f32>, Mixer) {
    let mut m = Mixer::new(8);
    m.submit(&[config_fx(&[(ROOT, vec![(kind::REVERB_SEND, send, 0.0)])]), master(0.25, false, 0), dc(V1, 0, 0.0)]);
    let (l, r) = m.render_n(QUANTA);
    (l, r, m)
}

#[test]
fn a_send_adds_the_convolved_bus_signal_before_master() {
    let (dry_l, dry_r, _) = render(0.0);
    let (wet_l, wet_r, mut m) = render(0.5);
    // The reference: the same convolver, standalone, fed half the dry bus signal.
    let mut region = vec![0u64; convolver::region_bytes(RATE).div_ceil(8)];
    let bytes = unsafe { core::slice::from_raw_parts_mut(region.as_mut_ptr() as *mut u8, region.len() * 8) };
    convolver::init(bytes, RATE);
    let mut peak = 0.0f32;
    for q in 0..QUANTA {
        let s = q * QUANTUM..(q + 1) * QUANTUM;
        let in_l: Vec<f32> = dry_l[s.clone()].iter().map(|x| 0.5 * x).collect();
        let in_r: Vec<f32> = dry_r[s.clone()].iter().map(|x| 0.5 * x).collect();
        let (mut out_l, mut out_r) = (dry_l[s.clone()].to_vec(), dry_r[s.clone()].to_vec());
        convolver::process(bytes, &in_l, &in_r, &mut out_l, &mut out_r);
        for i in 0..QUANTUM {
            assert!((wet_l[q * QUANTUM + i] - out_l[i]).abs() < 1e-6, "left frame {}", q * QUANTUM + i);
            assert!((wet_r[q * QUANTUM + i] - out_r[i]).abs() < 1e-6, "right frame {}", q * QUANTUM + i);
            peak = peak.max((out_l[i] - dry_l[q * QUANTUM + i]).abs());
        }
    }
    assert!(peak > 1e-3, "the wet signal is audible: {peak}");
    assert_ne!(wet_l, wet_r, "each channel has its own response");

    // RESET stops the voice and clears the tail: silence follows at once.
    m.submit(&[reset(true)]);
    let (l, r) = m.render_n(QUANTA);
    assert!(l.iter().chain(&r).all(|x| *x == 0.0), "no tail after RESET");
}

const QUANTUM: usize = 128;
