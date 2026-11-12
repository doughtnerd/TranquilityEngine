//! 0166 M4-0's exit case (waves plan, M4-0 row; Z5): a stamped FADE on one voice among 256 leaves the other 255
//! voices bit for bit as they were, with no split of either kind.
//!
//! Three mixers run the same 256 looping mixed voices (three generated clips, distinct gains) on the root bus:
//! `faded` (voice `TARGET` gets a stamped FADE to 0 over `LEN` frames at sample `AT` of a later quantum), `twin` (the
//! same 256 voices, no FADE) and `without` (255 voices: `TARGET` was never played).
//!
//! - Every other voice's slot bytes in `faded` equal `twin`'s after each quantum (the 255 are untouched, not merely
//!   unchanged in output).
//! - Before sample `AT` of the fade's quantum, and in every quantum before it, `faded`'s output equals `twin`'s bit for bit.
//! - Once the fade has reached 0 (sample `AT + LEN`) the target contributes exactly zero, so `faded`'s output equals
//!   `without`'s bit for bit from there on: what the 255 produce is the same sum they produce alone.
//! - Neither `splitQuanta` nor `voiceSplits` moves (a gain-only record applies in the gain loop).
//!
//! Samples `AT..AT + LEN`, where the target's fade is part of the sum, cannot be held bit-exact against a twin
//! (`class_g.rs` checks the fade's shape against its closed form); here they are only checked to differ from the
//! twin's, so the test cannot pass by the fade never running.

mod common;

use audio_core::layout::{Layout, PAGE_BYTES, VOICE_SLOT_BYTES};
use audio_core::params::InitParams;
use audio_core::{status, voices, Core, QUANTUM};
use audio_wire::generated as wire;
use common::*;

const VOICES: u32 = 256;
const TARGET: u32 = 131;
/// The fade's stamp inside its quantum, and its length: it ends inside the same quantum.
const AT: usize = 20;
const LEN: usize = 60;
const FADE_QUANTUM: usize = 3;
const CLIPS: [u32; 3] = [11, 12, 13];

fn voice(index: u32) -> u32 {
    0x0001_0000 | index
}

fn core() -> Core {
    let p = InitParams { sample_rate: RATE, max_logical: VOICES + 16, max_mixed: VOICES, max_buses: 4, arena_initial_bytes: 0, ..InitParams::default() };
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose ('static).
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: a fresh zeroed block of `layout.total()` bytes aligned to PAGE_BYTES.
    unsafe { Core::new(p, layout, base) }
}

/// 256 looping mixed voices (255 without `TARGET` when `skip`), submitted.
fn mixer(skip: bool) -> Mixer {
    let mut m = Mixer::over(core());
    m.set_lookahead(0.0);
    let n = 3_000;
    let sine: Vec<f32> = (0..n).map(|k| (k as f32 * 0.031).sin() * 0.5).collect();
    let saw: Vec<f32> = (0..n).map(|k| ((k % 97) as f32 / 97.0 - 0.5) * 0.4).collect();
    let mut x = 0x1234_5678u32;
    let noise: Vec<f32> = (0..n)
        .map(|_| {
            x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (x >> 8) as f32 / (1u32 << 24) as f32 * 0.3 - 0.15
        })
        .collect();
    m.load_clip(CLIPS[0], &sine);
    m.load_clip(CLIPS[1], &saw);
    m.load_clip(CLIPS[2], &noise);
    let recs: Vec<Rec> = (0..VOICES)
        .filter(|&i| !(skip && i == TARGET))
        .map(|i| {
            let Rec::Play(mut p) = play(voice(i), CLIPS[(i % 3) as usize], ROOT, MIXED | LOOP) else { unreachable!() };
            p.gain = 0.002 + 0.0001 * (i % 17) as f32;
            p.pitch = 0.8 + 0.01 * (i % 41) as f32;
            Rec::Play(p)
        })
        .collect();
    m.submit(&recs);
    m
}

fn fade_to_zero() -> Rec {
    let mut b = vec![0u8; wire::Fade::FIXED_END];
    wire::Fade { voice_id: voice(TARGET), frame_offset: AT as u32, target: 0.0, frames: LEN as u32, flags: 0, shape: 0 }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

fn slot_bytes(core: &Core, index: u32) -> &[u8] {
    let at = index as usize * VOICE_SLOT_BYTES;
    &core.regions().voices[at..at + VOICE_SLOT_BYTES]
}

fn bits(a: &[f32]) -> Vec<u32> {
    a.iter().map(|s| s.to_bits()).collect()
}

#[test]
fn a_stamped_fade_on_one_of_256_voices_leaves_the_other_255_bit_identical() {
    let (mut faded, mut twin, mut without) = (mixer(false), mixer(false), mixer(true));
    let mut compared_after = 0;
    for q in 0..8 {
        if q == FADE_QUANTUM {
            // The batch is stamped for this quantum's frames: the record is stamped inside the quantum.
            faded.submit(&[fade_to_zero()]);
        }
        let (fl, fr) = faded.render();
        let (tl, tr) = twin.render();
        let (wl, wr) = without.render();
        assert_eq!(fl.len(), QUANTUM);
        // The 255 others: the whole slot, every quantum.
        for i in (0..VOICES).filter(|&i| i != TARGET) {
            assert_eq!(slot_bytes(&faded.core, i), slot_bytes(&twin.core, i), "quantum {q}: voice {i}'s slot");
        }
        let music = &status::counters(&faded.core).music;
        assert_eq!((music.split_quanta, music.voice_splits), (0, 0), "quantum {q}: nothing split");
        for (name, a, b) in [("left", &fl, &tl), ("right", &fr, &tr)] {
            let (a, b) = (bits(a), bits(b));
            match q.cmp(&FADE_QUANTUM) {
                std::cmp::Ordering::Less => assert_eq!(a, b, "quantum {q} {name}: before the fade, identical to the twin"),
                std::cmp::Ordering::Equal => {
                    assert_eq!(a[..AT], b[..AT], "{name}: before the stamp, identical to the twin");
                    assert_ne!(a[AT..AT + LEN], b[AT..AT + LEN], "{name}: the fade really ran");
                }
                std::cmp::Ordering::Greater => {}
            }
        }
        // From the fade's end the target adds exactly zero: the 255 alone.
        let from = match q.cmp(&FADE_QUANTUM) {
            std::cmp::Ordering::Less => QUANTUM,
            std::cmp::Ordering::Equal => AT + LEN,
            std::cmp::Ordering::Greater => 0,
        };
        for (name, a, b) in [("left", &fl, &wl), ("right", &fr, &wr)] {
            assert_eq!(bits(&a[from..]), bits(&b[from..]), "quantum {q} {name}: after the fade, identical to the 255 alone");
            compared_after += QUANTUM - from;
        }
    }
    assert!(compared_after > 2 * 4 * QUANTUM, "the comparison covered the quanta after the fade");
    let s = voices::slots(&faded.core);
    assert_eq!((s[TARGET as usize].fade.target, s[TARGET as usize].fade.value), (0.0, 0.0), "the fade reached the target");
}
