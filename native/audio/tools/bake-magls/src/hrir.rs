//! The shipped HRIR set (`src/plugins/audio/runtime/wasm/myco_hrir.bin`, IRCAM Listen
//! IRC_Composite_C as Chromium decodes it; licence: docs/design/0157-audio-core/hrir-licence.md),
//! turned into M1's `format = 2` table at the asset's own rate exactly as `hrir.ts` does for a
//! context at that rate (no resampling: the leading delay extracted over `fft_size / 2` frames,
//! the responses quantised to int16), so the HRTF panner's kernels can be read from it.

use audio_dsp::hrtf::database::{encode, HrirHeader};
use audio_dsp::hrtf::elevation_index::fft_size_for_sample_rate;
use audio_dsp::hrtf::kernel::extract_average_group_delay;
use audio_dsp::hrtf::HrtfScratch;

/// The asset's 16-byte header plus its responses (delays in), as read.
pub struct Asset {
    pub header: HrirHeader,
    /// `[direction][frame][ear]` int16, direction `d = azimuth * elevations + elevation`.
    pub samples: Vec<i16>,
}

pub fn read_asset(bytes: &[u8]) -> Result<Asset, String> {
    if bytes.len() < 16 {
        return Err("HRIR asset shorter than its header".into());
    }
    let u32_at = |o: usize| u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
    let header = HrirHeader { elevations: u32_at(0), azimuths: u32_at(4), ir_length: u32_at(8), rate: f32::from_bits(u32_at(12)) };
    let count = header.directions() * header.ir_length as usize * 2;
    if bytes.len() != 16 + 2 * count {
        return Err(format!("HRIR asset is {} B, expected {}", bytes.len(), 16 + 2 * count));
    }
    let samples = (0..count).map(|i| i16::from_le_bytes([bytes[16 + 2 * i], bytes[17 + 2 * i]])).collect();
    Ok(Asset { header, samples })
}

/// `hrir.ts`'s int16 rounding: `round(x * 32768)`, half away from zero, clamped.
fn quantise(x: f32) -> i16 {
    let v = x as f64 * 32768.0;
    let r = if v < 0.0 { -libm::round(-v) } else { libm::round(v) };
    r.clamp(-32768.0, 32767.0) as i16
}

/// The `format = 2` table at the asset's rate (what main sends a context at 44.1 kHz).
pub fn table_at_asset_rate(asset: &Asset) -> Vec<u8> {
    let h = asset.header;
    let n = h.ir_length as usize;
    let taps = fft_size_for_sample_rate(h.rate) / 2;
    let dirs = h.directions();
    let mut scratch = HrtfScratch::new();
    let mut delays = vec![0.0f32; dirs * 2];
    let mut irs = vec![0i16; dirs * taps * 2];
    let mut response = vec![0.0f32; taps.max(n)];
    for d in 0..dirs {
        for ear in 0..2 {
            response.fill(0.0);
            for f in 0..n {
                response[f] = asset.samples[(d * n + f) * 2 + ear] as f32 / 32768.0;
            }
            delays[d * 2 + ear] = extract_average_group_delay(&mut response[..taps], &mut scratch);
            for f in 0..taps {
                irs[(d * taps + f) * 2 + ear] = quantise(response[f]);
            }
        }
    }
    let out_header = HrirHeader { ir_length: taps as u32, ..h };
    let mut bytes = vec![0u8; out_header.byte_len()];
    encode(&out_header, &delays, &irs, &mut bytes).expect("a valid format 2 table");
    bytes
}
