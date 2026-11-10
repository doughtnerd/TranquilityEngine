//! One open decoder: a symphonia format reader and audio decoder over an in-memory file, read in
//! frames into caller buffers, with sample-accurate seeks.
//!
//! Positions are output frames at the file's own rate, counted from the first playable frame, so a
//! loop wraps with no gap (task B4). symphonia's decoders trim MP3's encoder delay and padding (the
//! LAME/Info tag, plus the 529-frame decoder delay it implies) and Vorbis' (granule positions); AAC
//! in MP4 is trimmed here, from the edit list or `iTunSMPB` (`mp4_gapless.rs`), because symphonia
//! 0.6.1 ignores both. WAV and FLAC are exact. Files that state nothing (an MP3 without a LAME tag,
//! an ADTS `.aac`) keep what the encoder added.

use std::sync::Arc;

use symphonia::core::codecs::audio::well_known::{
    CODEC_ID_AAC, CODEC_ID_FLAC, CODEC_ID_MP1, CODEC_ID_MP2, CODEC_ID_MP3, CODEC_ID_PCM_S32LE,
    CODEC_ID_VORBIS,
};
use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo, TrackType};
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::units::{Time, TimeBase, Timestamp};

/// Errors the ABI reports as negative `i32` codes (see `lib.rs`).
#[derive(Debug)]
pub enum DecodeError {
    /// The bytes are not a container this build reads (probe failed).
    Format(String),
    /// No audio track, or a codec this build doesn't include (AAC without the `aac` feature).
    Codec(String),
    /// A fatal error in the middle of the stream (not a skipped corrupt packet).
    Decode(String),
    /// The container refused the seek.
    Seek(String),
}

impl DecodeError {
    pub fn message(&self) -> &str {
        match self {
            DecodeError::Format(m) | DecodeError::Codec(m) | DecodeError::Decode(m) | DecodeError::Seek(m) => m,
        }
    }
}

/// The codec of the opened track, as the ABI reports it (`info.codec`).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Codec {
    Other = 0,
    Pcm = 1,
    Flac = 2,
    Mp3 = 3,
    Vorbis = 4,
    Aac = 5,
}

/// A container hint (the file extension's meaning); `Hint::None` lets the probe decide alone.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum FormatHint {
    None,
    Wav,
    Flac,
    Mp3,
    Ogg,
    Mp4,
    Adts,
}

impl FormatHint {
    /// The ABI's `hint` argument: 0 none, 1 wav, 2 flac, 3 mp3, 4 ogg, 5 mp4/m4a, 6 aac (ADTS).
    /// Unknown values mean none.
    pub fn from_code(code: u32) -> FormatHint {
        match code {
            1 => FormatHint::Wav,
            2 => FormatHint::Flac,
            3 => FormatHint::Mp3,
            4 => FormatHint::Ogg,
            5 => FormatHint::Mp4,
            6 => FormatHint::Adts,
            _ => FormatHint::None,
        }
    }

    fn extension(self) -> Option<&'static str> {
        match self {
            FormatHint::None => None,
            FormatHint::Wav => Some("wav"),
            FormatHint::Flac => Some("flac"),
            FormatHint::Mp3 => Some("mp3"),
            FormatHint::Ogg => Some("ogg"),
            FormatHint::Mp4 => Some("m4a"),
            FormatHint::Adts => Some("aac"),
        }
    }
}

/// The encoded file, shared between the reader and later reopens (seeks after end of stream).
pub type Bytes = Arc<dyn AsRef<[u8]> + Send + Sync>;

/// `Bytes` as a `Cursor` target (symphonia reads any `Cursor<impl AsRef<[u8]>>`).
struct Shared(Bytes);

impl AsRef<[u8]> for Shared {
    fn as_ref(&self) -> &[u8] {
        (*self.0).as_ref()
    }
}

/// Format facts known after open.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Info {
    pub sample_rate: u32,
    pub channels: u32,
    /// The exact playable frame count, or `None` when the container doesn't state it (an MP3
    /// without a Xing, Info or VBRI header: symphonia only estimates it from the bitrate).
    pub frames: Option<u64>,
    /// The best available count: `frames`, else symphonia's estimate, else `None`.
    pub frames_estimate: Option<u64>,
    pub codec: Codec,
}

struct Opened {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track_id: u32,
    time_base: Option<TimeBase>,
    lead: u64,
}

pub struct Decoder {
    bytes: Bytes,
    hint: FormatHint,
    format: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track_id: u32,
    time_base: Option<TimeBase>,
    info: Info,
    /// Decoded interleaved samples of the current packet, at `info.channels`; `pend[pend_pos..]`
    /// is still unread. Grows to the largest packet, then is reused (no allocation per read).
    pend: Vec<f32>,
    pend_pos: usize,
    /// The packet's own samples when its channel count differs from `info.channels`.
    remap: Vec<f32>,
    /// Frames still to drop before the next output frame (a seek lands on a packet boundary).
    skip: u64,
    /// The frame index of the next frame `read_*` returns.
    pos: u64,
    /// The reader returned end of stream (or an error at the end): the next seek reopens.
    eof: bool,
    /// Packets skipped as corrupt since open.
    pub skipped_packets: u32,
    /// Leading decoded frames that are encoder priming, dropped at open and after each reopen; output
    /// frame `f` is decoded frame `f + lead` (AAC in MP4).
    lead: u64,
}

fn classify(codec: symphonia::core::codecs::audio::AudioCodecId) -> Codec {
    if codec == CODEC_ID_FLAC {
        Codec::Flac
    } else if codec == CODEC_ID_MP3 || codec == CODEC_ID_MP2 || codec == CODEC_ID_MP1 {
        Codec::Mp3
    } else if codec == CODEC_ID_VORBIS {
        Codec::Vorbis
    } else if codec == CODEC_ID_AAC {
        Codec::Aac
    } else if codec >= CODEC_ID_PCM_S32LE && codec < CODEC_ID_VORBIS {
        // 0x100..0x1000: the PCM family (and ADPCM, which this build doesn't include).
        Codec::Pcm
    } else {
        Codec::Other
    }
}

fn open_reader(bytes: &Bytes, hint: FormatHint) -> Result<(Opened, Info), DecodeError> {
    let cursor = std::io::Cursor::new(Shared(bytes.clone()));
    let mss = MediaSourceStream::new(Box::new(cursor), MediaSourceStreamOptions::default());
    let mut h = Hint::new();
    if let Some(ext) = hint.extension() {
        h.with_extension(ext);
    }
    let format = symphonia::default::get_probe()
        .probe(&h, mss, FormatOptions::default(), MetadataOptions::default())
        .map_err(|e| DecodeError::Format(format!("unrecognised audio container: {e}")))?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| DecodeError::Codec("no audio track".into()))?;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or_else(|| DecodeError::Codec("the audio track has no codec parameters".into()))?;
    let codec = classify(params.codec);
    let decoder = symphonia::default::get_codecs()
        .make_audio_decoder(params, &AudioDecoderOptions::default())
        .map_err(|e| {
            let feature = if codec == Codec::Aac { " (AAC needs the decoder's `aac` build)" } else { "" };
            DecodeError::Codec(format!("unsupported codec {}{feature}: {e}", params.codec))
        })?;
    let sample_rate = params.sample_rate.unwrap_or(0);
    let channels = params.channels.as_ref().map_or(0, |c| c.count()) as u32;
    let mut frames = track.num_frames;
    let frames_estimate = frames;
    if codec == Codec::Mp3 && !mp3_has_length_header((**bytes).as_ref()) {
        frames = None;
    }
    #[allow(unused_mut)] // changed only by the `aac` build
    let mut opened = Opened { track_id: track.id, time_base: track.time_base, format, decoder, lead: 0 };
    #[allow(unused_mut)]
    let mut info = Info { sample_rate, channels, frames, frames_estimate, codec };
    #[cfg(feature = "aac")]
    if codec == Codec::Aac {
        if let Some(g) = crate::mp4_gapless::mp4_gapless((**bytes).as_ref(), sample_rate) {
            let total = info.frames;
            if total.map_or(true, |t| g.delay < t) {
                // The track's own length (exact, in the media timescale) less the priming, unless the
                // edit says the playable part is shorter than that by more than its own rounding.
                let after = total.map(|t| t - g.delay);
                let n = match (g.frames, after) {
                    (Some(f), Some(a)) if f + g.slack >= a => Some(a),
                    (Some(f), Some(_)) => Some(f),
                    (f, a) => f.or(a),
                };
                opened.lead = g.delay;
                info.frames = n;
                info.frames_estimate = n;
            }
        }
    }
    Ok((opened, info))
}

/// Whether an MP3's first frame carries a Xing, Info or VBRI header (so symphonia's frame count is
/// exact rather than estimated from the bitrate). Skips a leading ID3v2 tag.
pub fn mp3_has_length_header(file: &[u8]) -> bool {
    let mut start = 0usize;
    if file.len() >= 10 && &file[0..3] == b"ID3" {
        let size = file[6..10].iter().fold(0usize, |acc, b| (acc << 7) | usize::from(b & 0x7f));
        let footer = if file[5] & 0x10 != 0 { 10 } else { 0 };
        start = 10 + size + footer;
    }
    // The first frame sync at or after the tag, within 64 KB.
    let end = file.len().min(start.saturating_add(64 * 1024));
    let mut sync = None;
    let mut i = start;
    while i + 1 < end {
        if file[i] == 0xff && file[i + 1] & 0xe0 == 0xe0 {
            sync = Some(i);
            break;
        }
        i += 1;
    }
    let Some(sync) = sync else { return false };
    // Xing/Info sit after the side info (offset 13, 21 or 36 from the sync); VBRI at 36.
    let window = &file[sync..file.len().min(sync + 64)];
    window.windows(4).any(|w| w == b"Xing" || w == b"Info" || w == b"VBRI")
}

impl Decoder {
    /// Probes `bytes` and opens its default audio track.
    pub fn open(bytes: Bytes, hint: FormatHint) -> Result<Decoder, DecodeError> {
        let (o, info) = open_reader(&bytes, hint)?;
        if info.channels == 0 || info.sample_rate == 0 {
            return Err(DecodeError::Codec("the audio track states no sample rate or channel count".into()));
        }
        Ok(Decoder {
            bytes,
            hint,
            format: o.format,
            decoder: o.decoder,
            track_id: o.track_id,
            time_base: o.time_base,
            info,
            pend: Vec::new(),
            pend_pos: 0,
            remap: Vec::new(),
            pos: 0,
            eof: false,
            skipped_packets: 0,
            lead: o.lead,
            skip: o.lead,
        })
    }

    pub fn info(&self) -> Info {
        self.info
    }

    /// The frame index the next read starts at.
    pub fn position(&self) -> u64 {
        self.pos
    }

    /// Decodes up to `out.len() / channels` frames into `out` (interleaved). Returns the frames
    /// written; fewer than asked only at the end of the stream (0 once it has ended).
    pub fn read_f32(&mut self, out: &mut [f32]) -> Result<usize, DecodeError> {
        self.read_with(out, |dst, src| dst.copy_from_slice(src))
    }

    /// As `read_f32`, converted to int16 (rounded, clamped; exact for 16-bit sources).
    pub fn read_i16(&mut self, out: &mut [i16]) -> Result<usize, DecodeError> {
        self.read_with(out, |dst, src| {
            for (d, s) in dst.iter_mut().zip(src) {
                *d = (s * 32768.0).round().clamp(-32768.0, 32767.0) as i16;
            }
        })
    }

    fn read_with<T>(&mut self, out: &mut [T], copy: impl Fn(&mut [T], &[f32])) -> Result<usize, DecodeError> {
        let ch = self.info.channels as usize;
        let mut want = out.len() / ch;
        // A stated length is a promise: never return frames past it (an M4A's decode runs on into
        // the last AAC frame's padding).
        if let Some(n) = self.info.frames {
            want = want.min(n.saturating_sub(self.pos).min(usize::MAX as u64) as usize);
        }
        let mut done = 0usize;
        while done < want {
            let avail = (self.pend.len() - self.pend_pos) / ch;
            if avail == 0 {
                if !self.fill()? {
                    break;
                }
                continue;
            }
            if self.skip > 0 {
                let n = (avail as u64).min(self.skip) as usize;
                self.pend_pos += n * ch;
                self.skip -= n as u64;
                continue;
            }
            let n = avail.min(want - done);
            copy(&mut out[done * ch..(done + n) * ch], &self.pend[self.pend_pos..self.pend_pos + n * ch]);
            self.pend_pos += n * ch;
            done += n;
        }
        self.pos += done as u64;
        Ok(done)
    }

    /// Decodes the next packet of the track into `pend`. Returns false at the end of the stream.
    fn fill(&mut self) -> Result<bool, DecodeError> {
        Ok(self.fill_packet()?.is_some())
    }

    /// As `fill`; `Some(start)` carries the packet's first output frame (after the decoder's
    /// trim), when its timestamp is known.
    fn fill_packet(&mut self) -> Result<Option<Option<u64>>, DecodeError> {
        let ch = self.info.channels as usize;
        loop {
            if self.eof {
                return Ok(None);
            }
            let packet = match self.format.next_packet() {
                Ok(Some(p)) => p,
                Ok(None) => {
                    self.eof = true;
                    return Ok(None);
                }
                // A truncated file ends where its data ends.
                Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    self.eof = true;
                    return Ok(None);
                }
                Err(SymError::ResetRequired) => {
                    self.decoder.reset();
                    continue;
                }
                Err(e) => {
                    self.eof = true;
                    return Err(DecodeError::Decode(format!("reading the stream: {e}")));
                }
            };
            if packet.track_id != self.track_id {
                continue;
            }
            let start = self.ts_to_frames(packet.pts).map(|f| f + self.dur_to_frames(packet.trim_start.get()));
            let buf = match self.decoder.decode(&packet) {
                Ok(buf) => buf,
                Err(SymError::DecodeError(_)) => {
                    self.skipped_packets = self.skipped_packets.saturating_add(1);
                    continue;
                }
                Err(SymError::ResetRequired) => {
                    self.decoder.reset();
                    continue;
                }
                Err(e) => return Err(DecodeError::Decode(format!("decoding: {e}"))),
            };
            let frames = buf.frames();
            if frames == 0 {
                continue;
            }
            let src_ch = buf.spec().channels().count();
            self.pend_pos = 0;
            if src_ch == ch {
                self.pend.resize(frames * ch, 0.0);
                buf.copy_to_slice_interleaved(&mut self.pend[..]);
            } else if src_ch > 0 {
                // A packet with another channel count (a mono frame in a stereo MP3): channel c
                // takes the packet's channel c % src_ch.
                self.remap.resize(frames * src_ch, 0.0);
                buf.copy_to_slice_interleaved(&mut self.remap[..]);
                self.pend.resize(frames * ch, 0.0);
                for f in 0..frames {
                    for c in 0..ch {
                        self.pend[f * ch + c] = self.remap[f * src_ch + c % src_ch];
                    }
                }
            } else {
                continue;
            }
            return Ok(Some(start));
        }
    }

    /// Timestamp (track time base) to output frames; `None` before frame 0 or without a time base.
    fn ts_to_frames(&self, ts: Timestamp) -> Option<u64> {
        let ts = ts.get();
        let frames = self.scale_to_frames(ts.unsigned_abs())?;
        if ts < 0 {
            // Encoder-delay frames have negative timestamps; the trim moves them back to 0.
            return if frames == 0 { Some(0) } else { None };
        }
        Some(frames)
    }

    fn dur_to_frames(&self, dur: u64) -> u64 {
        self.scale_to_frames(dur).unwrap_or(0)
    }

    fn scale_to_frames(&self, ticks: u64) -> Option<u64> {
        let rate = u128::from(self.info.sample_rate);
        match self.time_base {
            Some(tb) => {
                let n = u128::from(ticks) * u128::from(tb.numer.get()) * rate;
                let d = u128::from(tb.denom.get());
                u64::try_from((n + d / 2) / d).ok()
            }
            None => Some(ticks),
        }
    }

    /// Reopens the file from its bytes (the reader is back at frame 0).
    fn reopen(&mut self) -> Result<(), DecodeError> {
        let (o, _) = open_reader(&self.bytes, self.hint)?;
        self.format = o.format;
        self.decoder = o.decoder;
        self.track_id = o.track_id;
        self.time_base = o.time_base;
        self.pend_pos = self.pend.len();
        self.lead = o.lead;
        self.skip = o.lead;
        self.pos = 0;
        self.eof = false;
        Ok(())
    }

    /// Moves so the next read starts at `frame` (clamped to the known length). Returns that frame.
    ///
    /// Frame 0, and any seek after the end of the stream, reopens the file: a loop restarts
    /// bit-identically, and `isomp4`'s failing seek after EOF (symphonia 0.6.1) is avoided. Other
    /// seeks ask the container for the packet at or before `frame`, then drop the leading frames.
    pub fn seek(&mut self, frame: u64) -> Result<u64, DecodeError> {
        let target = match self.info.frames {
            Some(n) => frame.min(n),
            None => frame,
        };
        if target == 0 || self.eof {
            self.reopen()?;
            if target == 0 {
                return Ok(0);
            }
        }
        if Some(target) == self.info.frames {
            // At the end: nothing to read (containers refuse a seek to the end itself).
            self.pend_pos = self.pend.len();
            self.skip = 0;
            self.pos = target;
            return Ok(target);
        }
        let rate = u64::from(self.info.sample_rate);
        // The container's frames include the priming the output drops.
        let raw = target + self.lead;
        let secs = raw / rate;
        let nanos = ((raw % rate) * 1_000_000_000 / rate) as u32;
        let time = Time::try_new(secs as i64, nanos).ok_or_else(|| DecodeError::Seek("seek target out of range".into()))?;
        let seeked = self.format.seek(SeekMode::Accurate, SeekTo::Time { time, track_id: Some(self.track_id) });
        if let Err(e) = seeked {
            // (A seek past the end of an unknown-length stream, say.) Leave the decoder usable,
            // back at frame 0.
            self.reopen()?;
            return Err(DecodeError::Seek(format!("seek to frame {target} failed: {e}")));
        }
        self.decoder.reset();
        self.pend_pos = self.pend.len();
        self.skip = 0;
        self.eof = false;
        // Where the first decoded packet starts decides how much to drop.
        match self.fill_packet()? {
            None => {
                self.pos = target;
                Ok(target)
            }
            Some(start) => {
                let start = start.unwrap_or(raw);
                if start < raw {
                    self.skip = raw - start;
                    self.pos = target;
                } else {
                    self.pos = start.saturating_sub(self.lead);
                }
                Ok(self.pos)
            }
        }
    }
}
