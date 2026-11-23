//! Fixed-ratio rate conversion with rubato's synchronous FFT resampler (ADR 0359 §2: ≈300× realtime in wasm against
//! ≈86× for the asynchronous sinc resampler, at equal or better quality for a fixed ratio). Whole clip in, whole clip
//! out; rubato trims its own delay, so the output starts aligned with the input.

use rubato::audioadapter_buffers::direct::SequentialSliceOfVecs;
use rubato::{Fft, FixedSync, Resampler};

/// Frames per FFT chunk on the input side.
const CHUNK: usize = 1024;

/// `samples` (interleaved, `channels` channels) from `from` to `to` Hz.
pub fn fft(samples: &[f32], channels: usize, from: u32, to: u32) -> Result<Vec<f32>, String> {
    if from == to {
        return Ok(samples.to_vec());
    }
    let frames = samples.len() / channels;
    let planar: Vec<Vec<f32>> = (0..channels).map(|c| samples.iter().skip(c).step_by(channels).copied().collect()).collect();
    let input = SequentialSliceOfVecs::new(&planar, channels, frames).map_err(|e| format!("resampler input: {e}"))?;
    let mut r = Fft::<f32>::new(from as usize, to as usize, CHUNK, channels, FixedSync::Input).map_err(|e| format!("resampler {from} -> {to} Hz: {e}"))?;
    let out_len = r.process_all_needed_output_len(frames);
    let mut out = vec![vec![0f32; out_len]; channels];
    let (_, n) = {
        let mut output = SequentialSliceOfVecs::new_mut(&mut out, channels, out_len).map_err(|e| format!("resampler output: {e}"))?;
        r.process_all_into_buffer(&input, &mut output, frames, None).map_err(|e| format!("resampling: {e}"))?
    };
    drop(planar);
    let mut inter = vec![0f32; n * channels];
    for (c, plane) in out.iter().enumerate() {
        for (i, &s) in plane[..n].iter().enumerate() {
            inter[i * channels + c] = s;
        }
    }
    Ok(inter)
}
