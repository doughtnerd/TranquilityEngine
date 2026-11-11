//! The shared reverb stays **bit-identical** across ADR 0162's convolver split (task C1, #133):
//! a digest of `convolver::process`'s output, recorded on the tree before the split (base
//! `88cf6b61`), for several rates (a head shorter than 32 partitions at 2 kHz, a short tail at
//! 8 kHz, the real rates), with a `reset` partway through. Any change to the arithmetic, the
//! kernel's spectra or the schedule changes a digest.

use audio_dsp::convolver::{self, QUANTUM};

/// FNV-1a, 64-bit, over the outputs' bit patterns.
struct Digest(u64);

impl Digest {
    fn add(&mut self, xs: &[f32]) {
        for x in xs {
            for b in x.to_bits().to_le_bytes() {
                self.0 ^= b as u64;
                self.0 = self.0.wrapping_mul(0x0000_0100_0000_01B3);
            }
        }
    }
}

fn bytes(r: &mut [u64]) -> &mut [u8] {
    // SAFETY: a u64 buffer viewed as its bytes.
    unsafe { core::slice::from_raw_parts_mut(r.as_mut_ptr() as *mut u8, r.len() * 8) }
}

/// Runs `quanta` quanta of seeded noise bursts (left and right differ) through a fresh region at
/// `sample_rate`, resetting at `quanta / 2`, and digests every output quantum.
fn digest(sample_rate: f32, quanta: usize) -> u64 {
    let mut r = vec![0u64; convolver::region_bytes(sample_rate).div_ceil(8)];
    convolver::init(bytes(&mut r), sample_rate);
    let mut s = 0x1234_5678u32;
    let mut noise = move || {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        (s as f32 / u32::MAX as f32) * 2.0 - 1.0
    };
    let mut d = Digest(0xCBF2_9CE4_8422_2325);
    for q in 0..quanta {
        if q == quanta / 2 {
            convolver::reset(bytes(&mut r));
        }
        // Bursts: 40 quanta of noise, then 60 of silence, so tails ring out into silence.
        let on = q % 100 < 40;
        let in_l: [f32; QUANTUM] = core::array::from_fn(|_| if on { noise() } else { 0.0 });
        let in_r: [f32; QUANTUM] = core::array::from_fn(|i| if on { 0.5 * noise() } else if i == 0 { 0.25 } else { 0.0 });
        let (mut l, mut rr) = ([0.125f32; QUANTUM], [-0.125f32; QUANTUM]);
        convolver::process(bytes(&mut r), &in_l, &in_r, &mut l, &mut rr);
        d.add(&l);
        d.add(&rr);
    }
    d.0
}

const QUANTA: usize = 3_000;

#[test]
fn the_shared_reverb_is_bit_identical_to_the_tree_before_the_split() {
    let got: Vec<(f32, u64)> = [2_000.0f32, 8_000.0, 44_100.0, 48_000.0, 96_000.0].iter().map(|&sr| (sr, digest(sr, QUANTA))).collect();
    for (sr, d) in &got {
        println!("{sr}: {d:#018x}");
    }
    let want: [(f32, u64); 5] = [
        (2_000.0, 0x204b_8ca0_65a8_35f1),
        (8_000.0, 0x6eb1_7691_856a_c9a4),
        (44_100.0, 0xaa5f_94e9_c6f7_be3f),
        (48_000.0, 0xd7fc_b747_3637_bc08),
        (96_000.0, 0x7597_eb79_bace_8049),
    ];
    assert_eq!(got, want);
}
