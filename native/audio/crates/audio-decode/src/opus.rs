//! Opus decoding (ADR 0351 A7, 0359 §4): libopus 1.5.2 (vendored in `native/audio/third_party/opus`, BSD-3-Clause),
//! **fixed point**, compiled by `build.rs` with every external symbol renamed (`opus/rename.h`, so the encoder's float
//! libopus can share a native test binary) and, on wasm32, against stub libc headers (`opus/cstub/`) with no imports:
//! the decoder's state lives in Rust memory (`opus_decoder_get_size`, `opus_decoder_init`), so libopus never calls
//! `malloc`.
//!
//! symphonia's Ogg demuxer already reads Ogg Opus (RFC 7845): it parses OpusHead, sets the track's delay to the
//! pre-skip and marks each packet's `trim_start` / `trim_end` from the granule positions (the pre-skip at the start, the
//! last page's end trimming), and it seeks. [`OpusDecoder`] is the symphonia `AudioDecoder` it lacks: it decodes each
//! packet with libopus at 48 kHz and drops the trimmed frames, so an Opus file's frames are exactly the encoder's input
//! (pre-skip and end padding excluded), as a Vorbis file's are. Mono and stereo (mapping family 0) only; the OpusHead
//! output gain is applied by libopus.

use symphonia::core::audio::{AsGenericAudioBufferRef, AudioBuffer, AudioMut, AudioSpec, GenericAudioBufferRef};
use symphonia::core::codecs::audio::well_known::CODEC_ID_OPUS;
use symphonia::core::codecs::audio::{AudioCodecParameters, AudioDecoder, AudioDecoderOptions, FinalizeResult};
use symphonia::core::codecs::registry::{RegisterableAudioDecoder, SupportedAudioCodec};
use symphonia::core::codecs::CodecInfo;
use symphonia::core::errors::{decode_error, unsupported_error, Result};
use symphonia::core::packet::PacketRef;

/// Opus always decodes at 48 kHz here.
pub const OPUS_RATE: u32 = 48_000;
/// The longest Opus packet: 120 ms at 48 kHz.
const MAX_PACKET_FRAMES: usize = 5_760;
/// libopus's `OPUS_RESET_STATE`.
const OPUS_RESET_STATE: i32 = 4028;
/// libopus's `OPUS_SET_GAIN_REQUEST` (Q8 dB).
const OPUS_SET_GAIN_REQUEST: i32 = 4034;

extern "C" {
    fn myco_opusdec_opus_decoder_get_size(channels: i32) -> i32;
    fn myco_opusdec_opus_decoder_init(st: *mut u8, fs: i32, channels: i32) -> i32;
    fn myco_opusdec_opus_decode(st: *mut u8, data: *const u8, len: i32, pcm: *mut i16, frame_size: i32, decode_fec: i32) -> i32;
    fn myco_opusdec_opus_decoder_ctl(st: *mut u8, request: i32, ...) -> i32;
}

/// libopus's `abs`, the one libc function its fixed-point decoder calls that the stub headers declare (wasm32 only;
/// natively the C library has it).
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn abs(x: i32) -> i32 {
    x.wrapping_abs()
}

/// What an OpusHead (RFC 7845 §5.1) says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpusHead {
    pub channels: u8,
    pub pre_skip: u16,
    /// Q7.8 dB.
    pub output_gain: i16,
    pub mapping_family: u8,
}

impl OpusHead {
    /// Parses the identification header; `None` when it isn't one.
    pub fn parse(b: &[u8]) -> Option<OpusHead> {
        if b.len() < 19 || &b[..8] != b"OpusHead" || b[8] & 0xf0 != 0 {
            return None;
        }
        Some(OpusHead { channels: b[9], pre_skip: u16::from_le_bytes([b[10], b[11]]), output_gain: i16::from_le_bytes([b[16], b[17]]), mapping_family: b[18] })
    }
}

/// The symphonia decoder for `CODEC_ID_OPUS` (module comment).
pub struct OpusDecoder {
    opts: AudioDecoderOptions,
    params: AudioCodecParameters,
    channels: usize,
    /// libopus's decoder state, 8-aligned.
    state: Vec<u64>,
    /// One packet's interleaved int16 output.
    pcm: Vec<i16>,
    buf: AudioBuffer<f32>,
}

// SAFETY: the state is plain memory owned by this value; libopus keeps no pointers into it between calls.
unsafe impl Send for OpusDecoder {}
unsafe impl Sync for OpusDecoder {}

impl OpusDecoder {
    pub fn try_new(params: &AudioCodecParameters, opts: &AudioDecoderOptions) -> Result<OpusDecoder> {
        if params.codec != CODEC_ID_OPUS {
            return unsupported_error("opus: invalid codec");
        }
        let Some(head) = params.extra_data.as_deref().and_then(OpusHead::parse) else {
            return unsupported_error("opus: missing or malformed OpusHead");
        };
        if head.mapping_family != 0 || !(1..=2).contains(&head.channels) {
            return unsupported_error("opus: only mono and stereo Opus (channel mapping family 0) is supported");
        }
        let Some(channels) = params.channels.clone() else { return unsupported_error("opus: no channel layout") };
        let ch = head.channels as usize;
        // SAFETY: a plain query.
        let size = unsafe { myco_opusdec_opus_decoder_get_size(ch as i32) };
        if size <= 0 {
            return unsupported_error("opus: libopus refused the channel count");
        }
        let mut state = vec![0u64; (size as usize).div_ceil(8)];
        // SAFETY: `state` holds `size` bytes, 8-aligned, owned by the decoder for its life.
        let err = unsafe { myco_opusdec_opus_decoder_init(state.as_mut_ptr().cast(), OPUS_RATE as i32, ch as i32) };
        if err != 0 {
            return unsupported_error("opus: libopus could not initialise a decoder");
        }
        if head.output_gain != 0 {
            // SAFETY: a valid, initialised state; OPUS_SET_GAIN takes one int.
            unsafe { myco_opusdec_opus_decoder_ctl(state.as_mut_ptr().cast(), OPUS_SET_GAIN_REQUEST, head.output_gain as i32) };
        }
        Ok(OpusDecoder { opts: *opts, params: params.clone(), channels: ch, state, pcm: vec![0; MAX_PACKET_FRAMES * ch], buf: AudioBuffer::new(AudioSpec::new(OPUS_RATE, channels), MAX_PACKET_FRAMES) })
    }

    fn decode_inner(&mut self, packet: &PacketRef<'_>) -> Result<()> {
        let data = packet.data;
        if data.is_empty() || data.len() > i32::MAX as usize {
            return decode_error("opus: empty packet");
        }
        // SAFETY: the state is initialised; `pcm` holds MAX_PACKET_FRAMES frames of `channels`.
        let n = unsafe { myco_opusdec_opus_decode(self.state.as_mut_ptr().cast(), data.as_ptr(), data.len() as i32, self.pcm.as_mut_ptr(), MAX_PACKET_FRAMES as i32, 0) };
        if n < 0 {
            return decode_error("opus: corrupt packet");
        }
        let n = n as usize;
        self.buf.clear();
        self.buf.render_uninit(Some(n));
        for c in 0..self.channels {
            let Some(plane) = self.buf.plane_mut(c) else { return decode_error("opus: missing audio plane") };
            for (i, s) in plane.iter_mut().enumerate() {
                *s = self.pcm[i * self.channels + c] as f32 / 32768.0;
            }
        }
        if self.opts.gapless {
            self.buf.trim(packet.trim_start.get() as usize, packet.trim_end.get() as usize);
        }
        Ok(())
    }
}

impl AudioDecoder for OpusDecoder {
    fn reset(&mut self) {
        // SAFETY: a valid, initialised state.
        unsafe { myco_opusdec_opus_decoder_ctl(self.state.as_mut_ptr().cast(), OPUS_RESET_STATE) };
    }

    fn codec_info(&self) -> &CodecInfo {
        &Self::supported_codecs()[0].info
    }

    fn codec_params(&self) -> &AudioCodecParameters {
        &self.params
    }

    fn decode_ref(&mut self, packet: &PacketRef<'_>) -> Result<GenericAudioBufferRef<'_>> {
        if let Err(e) = self.decode_inner(packet) {
            self.buf.clear();
            return Err(e);
        }
        Ok(self.buf.as_generic_audio_buffer_ref())
    }

    fn finalize(&mut self) -> FinalizeResult {
        FinalizeResult::default()
    }

    fn last_decoded(&self) -> GenericAudioBufferRef<'_> {
        self.buf.as_generic_audio_buffer_ref()
    }
}

static SUPPORTED: [SupportedAudioCodec; 1] = [SupportedAudioCodec { id: CODEC_ID_OPUS, info: CodecInfo { short_name: "opus", long_name: "Opus (libopus, fixed point)", profiles: &[] } }];

impl RegisterableAudioDecoder for OpusDecoder {
    fn try_registry_new(params: &AudioCodecParameters, opts: &AudioDecoderOptions) -> Result<Box<dyn AudioDecoder>> {
        Ok(Box::new(OpusDecoder::try_new(params, opts)?))
    }

    fn supported_codecs() -> &'static [SupportedAudioCodec] {
        &SUPPORTED
    }
}
