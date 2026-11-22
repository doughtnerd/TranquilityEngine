//! PCM, Vorbis and Opus through the crate's interface. PCM and Vorbis decode with the shipped decoder (audio-decode);
//! Opus decoding arrives with ADR 0337 A7, so Opus is checked by its Ogg pages: OpusHead, pre-skip, the end granule
//! and the packet count.

mod common;

use common::*;
use myco_audio_decode::{Codec as Decoded, FormatHint};
use myco_audio_encode::{encode, Codec, EncodeError, Settings, ERR_ARG, ERR_REFUSED, VENDOR};

fn settings(codec: Codec, quality: f32) -> Settings {
    Settings { codec, quality, rate_ceiling: None, mono: false }
}

#[test]
fn pcm_is_a_16_bit_wav_the_decoder_reads_exactly() {
    let frames = 10_007;
    let src = sines(frames, 2, 44_100, 220.0);
    let out = encode(&src, 2, 44_100, &settings(Codec::Pcm, 0.5)).unwrap();
    assert_eq!(&out.bytes[0..4], b"RIFF");
    assert_eq!(&out.bytes[8..16], b"WAVEfmt ");
    assert_eq!(out.bytes.len(), 44 + frames * 4);
    let (info, back) = decode(out.bytes, FormatHint::Wav);
    assert_eq!((info.codec, info.sample_rate, info.channels, info.frames), (Decoded::Pcm, 44_100, 2, Some(frames as u64)));
    for (i, (&a, &b)) in src.iter().zip(&back).enumerate() {
        let want = (a * 32768.0).round().clamp(-32768.0, 32767.0) / 32768.0;
        assert_eq!(b, want, "sample {i}");
    }
}

#[test]
fn vorbis_decodes_through_audio_decode_to_the_exact_frame_count() {
    for (channels, rate, quality) in [(2usize, 44_100u32, 0.4f32), (1, 48_000, 0.1), (2, 22_050, 0.9)] {
        let frames = rate as usize * 2 + 77;
        let src = sines(frames, channels, rate, 330.0);
        let out = encode(&src, channels, rate, &settings(Codec::Vorbis, quality)).unwrap();
        assert_eq!((out.rate, out.channels, out.frames, out.pre_skip), (rate, channels, frames as u64, 0));
        let p = pages(&out.bytes);
        assert_eq!(&p[0].body[1..7], b"vorbis", "identification header");
        assert!(p.last().unwrap().flags & 4 != 0, "the last page ends the stream");
        assert_eq!(p.last().unwrap().granule, frames as i64, "the end granule trims to the source length");
        let comment = String::from_utf8_lossy(&p[1].body);
        assert!(comment.contains(&format!("ENCODER={VENDOR}")), "vendor comment");
        let (info, back) = decode(out.bytes, FormatHint::Ogg);
        assert_eq!((info.codec, info.sample_rate, info.channels as usize), (Decoded::Vorbis, rate, channels));
        assert_eq!(back.len(), frames * channels, "{channels} ch {rate} Hz q {quality}: decoded frames");
        for c in 0..channels {
            let snr = snr_db(&channel(&src, channels, c), &channel(&back, channels, c));
            assert!(snr > 15.0, "{channels} ch {rate} Hz q {quality} channel {c}: SNR {snr:.1} dB");
        }
    }
}

#[test]
fn vorbis_quality_raises_the_bitrate() {
    let src = sines(44_100 * 3, 2, 44_100, 440.0);
    let low = encode(&src, 2, 44_100, &settings(Codec::Vorbis, 0.1)).unwrap().bytes.len();
    let high = encode(&src, 2, 44_100, &settings(Codec::Vorbis, 0.9)).unwrap().bytes.len();
    assert!(high > low, "q 0.9 {high} B vs q 0.1 {low} B");
}

#[test]
fn rate_ceiling_resamples_down_never_up() {
    let frames = 44_100;
    let src = sines(frames, 1, 44_100, 1000.0);
    let down = encode(&src, 1, 44_100, &Settings { rate_ceiling: Some(22_050), ..settings(Codec::Vorbis, 0.5) }).unwrap();
    assert_eq!(down.rate, 22_050);
    let (info, back) = decode(down.bytes, FormatHint::Ogg);
    assert_eq!(info.sample_rate, 22_050);
    assert!((back.len() as i64 - 22_050).abs() <= 1, "{} frames at 22.05 kHz", back.len());
    // One second of 1 kHz stays 1,000 cycles.
    let cycles = crossings(&back) as i64;
    assert!((cycles - 1000).abs() <= 2, "{cycles} cycles");
    // A ceiling above the source's rate leaves it alone.
    let same = encode(&src, 1, 44_100, &Settings { rate_ceiling: Some(48_000), ..settings(Codec::Pcm, 0.5) }).unwrap();
    assert_eq!((same.rate, same.frames), (44_100, frames as u64));
}

#[test]
fn fft_resampling_to_32_khz_keeps_the_tone_and_its_level() {
    let src = sines(48_000, 1, 48_000, 440.0);
    let out = encode(&src, 1, 48_000, &Settings { rate_ceiling: Some(32_000), ..settings(Codec::Pcm, 0.5) }).unwrap();
    assert_eq!(out.rate, 32_000);
    assert!((out.frames as i64 - 32_000).abs() <= 1);
    let (_, back) = decode(out.bytes, FormatHint::Wav);
    let mid = &back[4_000..28_000];
    let peak = mid.iter().fold(0f32, |m, &x| m.max(x.abs()));
    assert!((peak - 0.5).abs() < 0.01, "peak {peak}");
    // Aligned with a 440 Hz sine generated at 32 kHz (rubato trims its delay).
    let want = sines(32_000, 1, 32_000, 440.0);
    let snr = snr_db(&want[4_000..28_000], mid);
    assert!(snr > 40.0, "SNR against the ideal tone {snr:.1} dB");
}

#[test]
fn mono_downmix_is_the_mean_of_the_channels() {
    let frames = 4_800;
    let mut src = vec![0f32; frames * 2];
    for i in 0..frames {
        src[i * 2] = 0.5;
        src[i * 2 + 1] = -0.25;
    }
    let out = encode(&src, 2, 48_000, &Settings { mono: true, ..settings(Codec::Pcm, 0.5) }).unwrap();
    assert_eq!(out.channels, 1);
    let (info, back) = decode(out.bytes, FormatHint::Wav);
    assert_eq!(info.channels, 1);
    assert!(back.iter().all(|&s| (s - 0.125).abs() < 1.0 / 32768.0), "(0.5 - 0.25) / 2");
}

/// OpusHead's fields: (channels, pre-skip, input rate, mapping family).
fn opus_head(bytes: &[u8]) -> (u8, u16, u32, u8) {
    let p = pages(bytes);
    let h = &p[0].body;
    assert_eq!(&h[0..8], b"OpusHead");
    assert_eq!(h[8], 1, "version");
    assert!(p[0].flags & 2 != 0, "first page begins the stream");
    assert_eq!(&p[1].body[0..8], b"OpusTags");
    (h[9], u16::from_le_bytes([h[10], h[11]]), u32::from_le_bytes(h[12..16].try_into().unwrap()), h[18])
}

#[test]
fn opus_is_48_khz_with_pre_skip_and_end_trimming() {
    for (channels, rate) in [(2usize, 44_100u32), (1, 48_000), (2, 22_050)] {
        let frames = rate as usize * 2 + 311;
        let src = sines(frames, channels, rate, 440.0);
        let out = encode(&src, channels, rate, &settings(Codec::Opus, 0.3)).unwrap();
        assert_eq!((out.rate, out.channels), (48_000, channels));
        let want = (frames as f64 * 48_000.0 / rate as f64).ceil() as i64;
        assert!((out.frames as i64 - want).abs() <= 1, "{channels} ch {rate} Hz: {} frames at 48 kHz, want ≈ {want}", out.frames);
        let (ch, pre_skip, input_rate, family) = opus_head(&out.bytes);
        assert_eq!((ch as usize, pre_skip as u32, input_rate, family), (channels, out.pre_skip, rate, 0));
        assert!(pre_skip > 0 && pre_skip < 960, "pre-skip {pre_skip} is the encoder's look-ahead");
        let p = pages(&out.bytes);
        let last = p.last().unwrap();
        assert!(last.flags & 4 != 0, "the last page ends the stream");
        assert_eq!(last.granule - pre_skip as i64, out.frames as i64, "end granule − pre-skip = the frames");
        // One 20 ms packet per 960 samples of (frames + pre-skip).
        let audio_packets: usize = p[2..].iter().map(packets_ending).sum();
        assert_eq!(audio_packets as u64, (out.frames + pre_skip as u64).div_ceil(960), "packets");
        assert!(p.iter().all(|pg| pg.serial == p[0].serial), "one logical stream");
    }
}

#[test]
fn opus_bitrate_follows_the_quality_mapping() {
    // 16 + 112 × q kbps per stereo pair: q 0.3 is ≈ 49.6 kbps stereo, ≈ 24.8 kbps mono. VBR on a tone lands near it.
    let seconds = 4.0;
    let src = sines((48_000.0 * seconds) as usize, 2, 48_000, 440.0);
    let stereo = encode(&src, 2, 48_000, &settings(Codec::Opus, 0.3)).unwrap();
    let kbps = stereo.bytes.len() as f64 * 8.0 / seconds / 1000.0;
    assert!(kbps > 25.0 && kbps < 75.0, "stereo q 0.3: {kbps:.1} kbps");
    let mono = encode(&src, 2, 48_000, &Settings { mono: true, ..settings(Codec::Opus, 0.3) }).unwrap();
    assert_eq!(mono.channels, 1);
    assert!(mono.bytes.len() < stereo.bytes.len(), "mono {} B < stereo {} B", mono.bytes.len(), stereo.bytes.len());
}

#[test]
fn refusals_and_bad_arguments_are_errors_not_panics() {
    let quad = sines(4_800, 4, 48_000, 440.0);
    let e = encode(&quad, 4, 48_000, &settings(Codec::Opus, 0.5)).unwrap_err();
    assert!(matches!(e, EncodeError::Refused(_)) && e.code() == ERR_REFUSED, "{e:?}");
    // Mono first makes it encodable.
    assert!(encode(&quad, 4, 48_000, &Settings { mono: true, ..settings(Codec::Opus, 0.5) }).is_ok());
    // Vorbis takes four channels.
    assert!(encode(&quad, 4, 48_000, &settings(Codec::Vorbis, 0.5)).is_ok());
    for (samples, ch, rate) in [(vec![0f32; 10], 0usize, 48_000u32), (vec![0f32; 10], 17, 48_000), (vec![0f32; 10], 1, 1_000), (vec![0f32; 3], 2, 48_000)] {
        let e = encode(&samples, ch, rate, &settings(Codec::Pcm, 0.5)).unwrap_err();
        assert_eq!(e.code(), ERR_ARG, "{ch} ch {rate} Hz: {e:?}");
    }
    // Out-of-range quality is clamped, not refused.
    assert!(encode(&sines(4_800, 1, 48_000, 440.0), 1, 48_000, &settings(Codec::Vorbis, 7.0)).is_ok());
}
