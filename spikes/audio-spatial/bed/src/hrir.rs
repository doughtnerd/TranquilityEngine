//! M1's HRIR table as main would send it (`format = 2`): delays extracted, responses at the
//! context rate (linear-interpolated here; `hrir.ts` does Chromium's sinc resample).
use audio_dsp::hrtf::database::{encode, HrirHeader};
use audio_dsp::hrtf::HrtfScratch;

pub const RATE: f32 = 48000.0;

pub fn build_table(asset: &[u8], rate: f32) -> Vec<u8> {
    let header = HrirHeader::read(asset).unwrap();
    let n = header.ir_length as usize;
    let dirs = header.directions();
    let ratio = rate / header.rate;
    let out_len = (n as f32 * ratio).ceil() as usize;
    let mut scratch = HrtfScratch::new();
    let mut delays = vec![0.0f32; dirs * 2];
    let mut irs = vec![0i16; dirs * out_len * 2];
    let mut ir = vec![0.0f32; n];
    for d in 0..dirs {
        for ear in 0..2 {
            for (f, s) in ir.iter_mut().enumerate() {
                let at = 16 + ((d * n + f) * 2 + ear) * 2;
                *s = i16::from_le_bytes([asset[at], asset[at + 1]]) as f32 / 32768.0;
            }
            delays[d * 2 + ear] = audio_dsp::hrtf::kernel::extract_average_group_delay(&mut ir, &mut scratch) * ratio;
            for f in 0..out_len {
                let p = f as f32 / ratio;
                let i = p as usize;
                let t = p - i as f32;
                let a = ir.get(i).copied().unwrap_or(0.0);
                let b = ir.get(i + 1).copied().unwrap_or(0.0);
                let s = a + (b - a) * t;
                irs[(d * out_len + f) * 2 + ear] = (s * 32767.0).round().clamp(-32768.0, 32767.0) as i16;
            }
        }
    }
    let out_header = HrirHeader { ir_length: out_len as u32, rate, ..header };
    let mut bytes = vec![0u8; out_header.byte_len()];
    encode(&out_header, &delays, &irs, &mut bytes).unwrap();
    bytes
}
