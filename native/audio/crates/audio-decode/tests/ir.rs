//! Zone impulse-response preparation (ADR 0162 C2a): the blob equals the core's `prepare_ir`, mono
//! and stereo, refusals, trim, cut and fade, the resampler, presets, and the `myco_ir_*` ABI.
//! `cargo test --release -p audio-decode --test ir -- --ignored --nocapture` prints the timings.

use std::sync::Arc;
use std::time::Instant;

use audio_dsp::convolver::ir::blink_normalization_scale;
use audio_dsp::convolver::kernel::{kernel_bytes, prepare_ir, IrSpec, Kernel, FLAG_SOURCE_MONO};
use audio_dsp::convolver::{presets, Scratch, SCRATCH_BYTES};
use myco_audio_decode::ir::{self, TRIM_THRESHOLD};
use myco_audio_decode::*;

/// A 16-bit PCM WAV of `channels` interleaved channels.
fn wav16(rate: u32, channels: u16, samples: &[f32]) -> Vec<u8> {
    let data = samples.len() * 2;
    let mut b = Vec::with_capacity(44 + data);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + data as u32).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&channels.to_le_bytes());
    b.extend_from_slice(&rate.to_le_bytes());
    b.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes());
    b.extend_from_slice(&(channels * 2).to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&(data as u32).to_le_bytes());
    for s in samples {
        b.extend_from_slice(&((s * 32768.0).round().clamp(-32768.0, 32767.0) as i16).to_le_bytes());
    }
    b
}

/// What a 16-bit WAV gives back for `x`.
fn q16(x: f32) -> f32 {
    (x * 32768.0).round().clamp(-32768.0, 32767.0) / 32768.0
}

/// Decaying noise (a seeded LCG), `frames` per channel, interleaved.
fn noise_ir(frames: usize, channels: usize, seed: u32) -> Vec<f32> {
    let mut s = seed;
    let mut out = Vec::with_capacity(frames * channels);
    for i in 0..frames {
        let e = (1.0 - i as f32 / frames as f32).powi(3);
        for _ in 0..channels {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            out.push(((s >> 8) as f32 / 16_777_216.0 * 2.0 - 1.0) * 0.8 * e);
        }
    }
    out
}

/// The kernel the core would prepare from `left` and `right` (the same slice twice for mono).
fn reference_kernel(left: &[f32], right: &[f32], rate: f32, mono: bool) -> Vec<u8> {
    let frames = left.len();
    let sum: f64 = left.iter().chain(right).map(|&x| x as f64 * x as f64).sum();
    let scale = blink_normalization_scale(sum, 2 * frames, rate);
    let mut sw = vec![0u32; SCRATCH_BYTES / 4];
    let sb = unsafe { std::slice::from_raw_parts_mut(sw.as_mut_ptr() as *mut u8, SCRATCH_BYTES) };
    let mut sc = Scratch::from_bytes(sb).unwrap();
    sc.fill_twiddles();
    let mut out = vec![0u32; kernel_bytes(frames) / 4];
    let ob = unsafe { std::slice::from_raw_parts_mut(out.as_mut_ptr() as *mut u8, out.len() * 4) };
    let mut it = left.iter().chain(right).copied();
    let spec = IrSpec { frames, sample_rate: rate, scale, flags: if mono { FLAG_SOURCE_MONO } else { 0 } };
    prepare_ir(ob, &mut sc, spec, || it.next().unwrap()).unwrap();
    ob.to_vec()
}

fn bytes(v: Vec<u8>) -> Bytes {
    Arc::new(v)
}

#[test]
fn stereo_blob_equals_prepare_ir() {
    let frames = 9_000;
    let mut src = noise_ir(frames, 2, 7);
    // A silent tail the trim drops.
    src.extend(std::iter::repeat(0.0).take(2 * 3_000));
    let p = ir::prepare(bytes(wav16(48_000, 2, &src)), FormatHint::Wav, 48_000.0, 100_000).unwrap();
    let left: Vec<f32> = src.iter().step_by(2).map(|&x| q16(x)).collect();
    let right: Vec<f32> = src.iter().skip(1).step_by(2).map(|&x| q16(x)).collect();
    let last = (0..left.len()).rev().find(|&i| left[i].abs() >= TRIM_THRESHOLD || right[i].abs() >= TRIM_THRESHOLD).unwrap();
    assert_eq!(p.frames, last + 1);
    assert!(p.frames <= frames);
    assert!(!p.truncated);
    assert_eq!(p.bytes(), &reference_kernel(&left[..p.frames], &right[..p.frames], 48_000.0, false)[..]);
    let k = Kernel::parse(p.bytes()).unwrap();
    assert_eq!((k.frames(), k.sample_rate(), k.flags()), (p.frames, 48_000.0, 0));
}

#[test]
fn mono_feeds_both_channels_and_sets_the_flag() {
    let src = noise_ir(5_000, 1, 3);
    let p = ir::prepare(bytes(wav16(44_100, 1, &src)), FormatHint::Wav, 44_100.0, 100_000).unwrap();
    let m: Vec<f32> = src.iter().map(|&x| q16(x)).collect();
    let m = &m[..p.frames];
    assert_eq!(p.bytes(), &reference_kernel(m, m, 44_100.0, true)[..]);
    assert_eq!(Kernel::parse(p.bytes()).unwrap().flags(), FLAG_SOURCE_MONO);
}

#[test]
fn refuses_wide_silent_and_bad_arguments() {
    let wide = wav16(48_000, 4, &noise_ir(1_000, 4, 1));
    assert_eq!(ir::prepare(bytes(wide), FormatHint::Wav, 48_000.0, 10_000).unwrap_err().code, ERR_CODEC);
    let silent = wav16(48_000, 2, &vec![0.0; 2_000]);
    let e = ir::prepare(bytes(silent), FormatHint::Wav, 48_000.0, 10_000).unwrap_err();
    assert_eq!(e.code, ERR_DECODE);
    assert!(e.message.contains("silent"), "{}", e.message);
    let ok = wav16(48_000, 1, &noise_ir(100, 1, 2));
    assert_eq!(ir::prepare(bytes(ok.clone()), FormatHint::Wav, 0.0, 10).unwrap_err().code, ERR_ARG);
    assert_eq!(ir::prepare(bytes(ok.clone()), FormatHint::Wav, f32::NAN, 10).unwrap_err().code, ERR_ARG);
    assert_eq!(ir::prepare(bytes(ok), FormatHint::Wav, 48_000.0, 0).unwrap_err().code, ERR_ARG);
    assert_eq!(ir::prepare(bytes(vec![1, 2, 3, 4]), FormatHint::None, 48_000.0, 10).unwrap_err().code, ERR_FORMAT);
    assert_eq!(ir::generate(5, 48_000.0, 10).unwrap_err().code, ERR_ARG);
}

#[test]
fn trims_the_tail_and_cuts_with_a_fade() {
    // Trim: the last frame at or above -80 dBFS on either channel ends the response.
    let mut ch = vec![vec![0.5f32; 1_000], vec![0.0f32; 1_000]];
    ch[0][600..].fill(TRIM_THRESHOLD * 0.99);
    ch[1][700] = -TRIM_THRESHOLD;
    assert_eq!(ir::trim_and_cut(&mut ch, 48_000.0, 10_000), (701, false));
    assert!(ch.iter().all(|c| c.len() == 701));
    // Cut: 2,400 frames of fade (50 ms at 48 kHz) ending at (nearly) 0.
    let mut ch = vec![vec![1.0f32; 10_000]];
    assert_eq!(ir::trim_and_cut(&mut ch, 48_000.0, 6_000), (6_000, true));
    let c = &ch[0];
    assert_eq!(c.len(), 6_000);
    assert_eq!(c[6_000 - 2_401], 1.0, "before the fade");
    assert!(c[6_000 - 2_400] < 1.0 && c[6_000 - 2_400] > 0.999);
    assert!((c[6_000 - 1_200] - 0.5).abs() < 1e-3, "half way");
    assert!(c[5_999].abs() < 1e-6, "ends at 0");
    assert!(c[3_600..].windows(2).all(|w| w[1] <= w[0]), "monotonic");
    // A file longer than max_frames reports truncated.
    let long = wav16(48_000, 2, &vec![0.5; 2 * 20_000]);
    let p = ir::prepare(bytes(long), FormatHint::Wav, 48_000.0, 4_096).unwrap();
    assert_eq!((p.frames, p.truncated), (4_096, true));
    assert_eq!(p.bytes().len(), kernel_bytes(4_096));
}

fn sine(rate: f32, hz: f32, frames: usize) -> Vec<f32> {
    (0..frames).map(|i| (2.0 * std::f64::consts::PI * hz as f64 * i as f64 / rate as f64).sin() as f32 * 0.5).collect()
}

#[test]
fn the_resampler_is_clean_and_band_limited() {
    // Up 44.1 -> 48 kHz: a 1 kHz tone lands on the analytic tone at the new rate (-80 dB error mid-block).
    let x = sine(44_100.0, 1_000.0, 44_100);
    let y = ir::resample(&x, 44_100.0, 48_000.0);
    assert_eq!(y.len(), 48_000);
    let want = sine(48_000.0, 1_000.0, 48_000);
    let err: f64 = y[100..47_900].iter().zip(&want[100..47_900]).map(|(a, b)| ((a - b) as f64).powi(2)).sum();
    let sig: f64 = want[100..47_900].iter().map(|b| (*b as f64).powi(2)).sum();
    assert!(10.0 * (err / sig).log10() < -80.0, "{} dB", 10.0 * (err / sig).log10());
    // Down 48 -> 44.1 kHz: a tone above the new Nyquist (23 kHz, inside the 32-tap Blackman kernel's transition band,
    // as with Blink's SincResampler) is attenuated by at least 40 dB rather than folded to 21.1 kHz.
    let x = sine(48_000.0, 23_000.0, 48_000);
    let y = ir::resample(&x, 48_000.0, 44_100.0);
    assert_eq!(y.len(), 44_100);
    let e_in: f64 = x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64;
    let e_out: f64 = y[100..44_000].iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / 43_900.0;
    assert!(10.0 * (e_out / e_in).log10() < -40.0, "{} dB", 10.0 * (e_out / e_in).log10());
    // Equal rates copy.
    assert_eq!(ir::resample(&x[..100], 48_000.0, 48_000.0), x[..100].to_vec());
}

#[test]
fn a_resampled_file_is_prepared_at_the_target_rate() {
    let src = noise_ir(4_410, 2, 5);
    let p = ir::prepare(bytes(wav16(44_100, 2, &src)), FormatHint::Wav, 48_000.0, 100_000).unwrap();
    let k = Kernel::parse(p.bytes()).unwrap();
    assert_eq!(k.sample_rate(), 48_000.0);
    assert!(p.frames <= 4_800 && p.frames > 4_500, "{}", p.frames);
}

#[test]
fn presets_are_prepared_as_files_are() {
    for (i, preset) in presets::PRESETS.iter().enumerate() {
        let n = presets::frames(i as u32, 48_000.0);
        let p = ir::generate(i as u32, 48_000.0, 192_000).unwrap();
        assert!(p.frames <= n && p.frames > n * 9 / 10, "{}: {} of {n}", preset.name, p.frames);
        assert!(!p.truncated, "{}", preset.name);
        let (mut l, mut r) = (vec![0.0; n], vec![0.0; n]);
        presets::generate(i as u32, 48_000.0, &mut l, &mut r);
        assert_eq!(p.bytes(), &reference_kernel(&l[..p.frames], &r[..p.frames], 48_000.0, false)[..], "{}", preset.name);
    }
    // cave (3.63 s) cut at 2 s.
    let p = ir::generate(3, 48_000.0, 96_000).unwrap();
    assert_eq!((p.frames, p.truncated), (96_000, true));
}

/// The C ABI, as the worker calls it (one test: the state is process-wide).
#[test]
fn the_abi() {
    assert_eq!(myco_decode_abi_version(), 0x103);
    let file = wav16(48_000, 2, &noise_ir(3_000, 2, 9));
    let p = myco_decode_alloc(file.len() as u32);
    let frames = unsafe {
        std::ptr::copy_nonoverlapping(file.as_ptr(), p, file.len());
        myco_ir_prepare(p, file.len() as u32, 1, 48_000.0, 1_000)
    };
    assert_eq!(frames, 1_000);
    assert_eq!(myco_ir_truncated(), 1);
    assert_eq!(myco_ir_blob_len() as usize, kernel_bytes(1_000));
    assert_eq!(myco_ir_blob_ptr() as usize % 4, 0);
    let blob = unsafe { std::slice::from_raw_parts(myco_ir_blob_ptr(), myco_ir_blob_len() as usize) };
    assert_eq!(Kernel::parse(blob).unwrap().frames(), 1_000);

    let n = myco_ir_generate(0, 44_100.0, 1_000_000);
    assert!(n > 0);
    assert_eq!(myco_ir_truncated(), 0);
    assert_eq!(myco_ir_blob_len() as usize, kernel_bytes(n as usize));

    assert_eq!(myco_ir_generate(99, 48_000.0, 1_000), ERR_ARG);
    assert_eq!((myco_ir_blob_len(), myco_ir_blob_ptr()), (0, std::ptr::null()));
    let len = myco_decode_error_len() as usize;
    let msg = String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(myco_decode_error_ptr(), len) }).into_owned();
    assert!(msg.contains("preset"), "{msg}");
    assert_eq!(unsafe { myco_ir_prepare(std::ptr::null_mut(), 10, 0, 48_000.0, 10) }, ERR_ARG);
}

fn percentile(v: &mut [f64], q: f64) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((v.len() - 1) as f64 * q).round() as usize]
}

/// Timings (ms) for 1 / 2 / 4 s stereo IRs at 44.1 and 48 kHz, prepared at 48 kHz: decode,
/// resample, trim + normalise + partition + transform, and the whole `prepare`.
#[test]
#[ignore = "timings; run with --release --ignored --nocapture"]
fn timings() {
    const RUNS: usize = 9;
    println!("source  len  stage      p50 ms   p99 ms");
    for rate in [44_100u32, 48_000] {
        for secs in [1usize, 2, 4] {
            let frames = rate as usize * secs;
            let file = wav16(rate, 2, &noise_ir(frames, 2, 11));
            let max = 48_000 * 4;
            let (mut td, mut tr, mut tk, mut tt) = (vec![], vec![], vec![], vec![]);
            for _ in 0..RUNS {
                let t0 = Instant::now();
                let src = ir::decode(bytes(file.clone()), FormatHint::Wav, 48_000.0, max).unwrap();
                let t1 = Instant::now();
                let mut ch: Vec<Vec<f32>> = src.channels.iter().map(|c| ir::resample(c, src.rate, 48_000.0)).collect();
                let t2 = Instant::now();
                ir::trim_and_cut(&mut ch, 48_000.0, max);
                let k = ir::kernel(&ch, 48_000.0).unwrap();
                let t3 = Instant::now();
                std::hint::black_box(k);
                let p = ir::prepare(bytes(file.clone()), FormatHint::Wav, 48_000.0, max).unwrap();
                let t4 = Instant::now();
                std::hint::black_box(p);
                let ms = |a: Instant, b: Instant| (b - a).as_secs_f64() * 1e3;
                td.push(ms(t0, t1));
                tr.push(ms(t1, t2));
                tk.push(ms(t2, t3));
                tt.push(ms(t3, t4));
            }
            for (name, v) in [("decode", &mut td), ("resample", &mut tr), ("prepare", &mut tk), ("total", &mut tt)] {
                println!("{rate:>6} {secs:>3} s  {name:<9} {:>7.2}  {:>7.2}", percentile(v, 0.5), percentile(v, 0.99));
            }
        }
    }
}
