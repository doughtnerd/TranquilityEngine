//! Spike: symphonia decode + fundsp block cost, exposed as plain extern "C" (no wasm-bindgen).
#![allow(static_mut_refs)]

#[cfg(feature = "dec")]
pub mod dec {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    pub struct Decoded {
        pub samples: Vec<f32>,
        pub channels: usize,
        pub rate: u32,
    }

    /// Decode a whole file to interleaved f32. Format is detected from the bytes.
    pub fn decode_all(bytes: Vec<u8>) -> Result<Decoded, String> {
        let mss = MediaSourceStream::new(Box::new(std::io::Cursor::new(bytes)), MediaSourceStreamOptions::default());
        let probed = symphonia::default::get_probe()
            .format(&Hint::new(), mss, &FormatOptions::default(), &MetadataOptions::default())
            .map_err(|e| format!("probe: {e}"))?;
        let mut format = probed.format;
        let track = format.default_track().ok_or("no track")?;
        let id = track.id;
        let mut decoder = symphonia::default::get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())
            .map_err(|e| format!("codec: {e}"))?;
        let mut out = Vec::new();
        let (mut channels, mut rate) = (0usize, 0u32);
        let mut sbuf: Option<SampleBuffer<f32>> = None;
        loop {
            let packet = match format.next_packet() {
                Ok(p) => p,
                Err(_) => break, // EOF (or unrecoverable)
            };
            if packet.track_id() != id {
                continue;
            }
            match decoder.decode(&packet) {
                Ok(buf) => {
                    let spec = *buf.spec();
                    channels = spec.channels.count();
                    rate = spec.rate;
                    if sbuf.as_ref().map_or(true, |s| s.capacity() < buf.capacity() * channels) {
                        sbuf = Some(SampleBuffer::<f32>::new(buf.capacity() as u64, spec));
                    }
                    let s = sbuf.as_mut().unwrap();
                    s.copy_interleaved_ref(buf);
                    out.extend_from_slice(s.samples());
                }
                Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
                Err(e) => return Err(format!("decode: {e}")),
            }
        }
        Ok(Decoded { samples: out, channels, rate })
    }
}

/// Incremental decode: packet by packet into a pending buffer, handed out in fixed-size chunks; plus seek.
#[cfg(feature = "dec")]
pub mod stream {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::{Decoder, DecoderOptions};
    use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
    use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;
    use symphonia::core::units::Time;

    pub struct Stream {
        format: Box<dyn FormatReader>,
        decoder: Box<dyn Decoder>,
        track_id: u32,
        pub channels: usize,
        pub rate: u32,
        pend: Vec<f32>,
        pos: usize,
        sbuf: Option<SampleBuffer<f32>>,
        eof: bool,
        pub chunk: Vec<f32>,
        pub packets: u64,
    }

    impl Stream {
        pub fn open(bytes: Vec<u8>) -> Result<Stream, String> {
            let mss = MediaSourceStream::new(Box::new(std::io::Cursor::new(bytes)), MediaSourceStreamOptions::default());
            let probed = symphonia::default::get_probe()
                .format(&Hint::new(), mss, &FormatOptions::default(), &MetadataOptions::default())
                .map_err(|e| format!("probe: {e}"))?;
            let format = probed.format;
            let track = format.default_track().ok_or("no track")?;
            let track_id = track.id;
            let channels = track.codec_params.channels.map_or(2, |c| c.count());
            let rate = track.codec_params.sample_rate.unwrap_or(44100);
            let decoder = symphonia::default::get_codecs()
                .make(&track.codec_params, &DecoderOptions::default())
                .map_err(|e| format!("codec: {e}"))?;
            Ok(Stream { format, decoder, track_id, channels, rate, pend: Vec::new(), pos: 0, sbuf: None, eof: false, chunk: Vec::new(), packets: 0 })
        }

        /// Produce up to `frames` interleaved frames into `self.chunk`; returns frames produced (0 at EOF).
        pub fn read(&mut self, frames: usize) -> usize {
            let want = frames * self.channels;
            while self.pend.len() - self.pos < want && !self.eof {
                let packet = match self.format.next_packet() {
                    Ok(p) => p,
                    Err(_) => { self.eof = true; break; }
                };
                if packet.track_id() != self.track_id { continue; }
                self.packets += 1;
                match self.decoder.decode(&packet) {
                    Ok(buf) => {
                        let spec = *buf.spec();
                        self.channels = spec.channels.count();
                        self.rate = spec.rate;
                        if self.sbuf.as_ref().map_or(true, |s| s.capacity() < buf.capacity() * self.channels) {
                            self.sbuf = Some(SampleBuffer::<f32>::new(buf.capacity() as u64, spec));
                        }
                        let s = self.sbuf.as_mut().unwrap();
                        s.copy_interleaved_ref(buf);
                        if self.pos > 0 { self.pend.drain(..self.pos); self.pos = 0; }
                        self.pend.extend_from_slice(s.samples());
                    }
                    Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
                    Err(_) => { self.eof = true; break; }
                }
            }
            let n = (self.pend.len() - self.pos).min(want);
            self.chunk.clear();
            self.chunk.extend_from_slice(&self.pend[self.pos..self.pos + n]);
            self.pos += n;
            n / self.channels.max(1)
        }

        /// Seek to `secs`; mode 0 = coarse, 1 = accurate. Returns the landed timestamp in frames, or -1.
        pub fn seek(&mut self, secs: f64, mode: u32) -> i64 {
            let m = if mode == 0 { SeekMode::Coarse } else { SeekMode::Accurate };
            let t = Time::new(secs.trunc() as u64, secs.fract());
            match self.format.seek(m, SeekTo::Time { time: t, track_id: Some(self.track_id) }) {
                Ok(s) => {
                    self.decoder.reset();
                    self.pend.clear();
                    self.pos = 0;
                    self.eof = false;
                    s.actual_ts as i64
                }
                Err(_) => -1,
            }
        }
    }
}

#[cfg(feature = "fx")]
pub mod fx {
    use fundsp::prelude32::*;

    pub const SR: f64 = 48000.0;
    pub const BLOCK: usize = 128;

    pub struct Bench {
        unit: Box<dyn AudioUnit>,
        input: BufferArray<U2>,
        output: BufferArray<U2>,
        pub checksum: f32,
    }

    pub fn build(kind: u32) -> Box<dyn AudioUnit> {
        let mut u: Box<dyn AudioUnit> = match kind {
            0 => Box::new(reverb_stereo(20.0, 2.5, 0.5)),
            1 => Box::new(moog_hz(1200.0, 0.6) | moog_hz(1200.0, 0.6)),
            2 => Box::new(lowpass_hz(1200.0, 0.7) | lowpass_hz(1200.0, 0.7)),
            // small chain: lowpass -> dry + 30% reverb -> peak limiter
            _ => Box::new(
                (lowpass_hz(8000.0, 0.7) | lowpass_hz(8000.0, 0.7))
                    >> (multipass::<U2>() & 0.3 * reverb_stereo(20.0, 2.5, 0.5))
                    >> limiter_stereo(0.002, 0.05),
            ),
        };
        u.set_sample_rate(SR);
        u.allocate();
        u
    }

    impl Bench {
        pub fn new(kind: u32) -> Self {
            let mut input = BufferArray::<U2>::new();
            // deterministic noise at -12 dB, built once
            let mut s: u32 = 12345;
            for c in 0..2 {
                for i in 0..MAX_BUFFER_SIZE {
                    s = s.wrapping_mul(1664525).wrapping_add(1013904223);
                    input.buffer_mut().set_f32(c, i, ((s >> 8) as f32 / 8388608.0 - 1.0) * 0.25);
                }
            }
            Bench { unit: build(kind), input, output: BufferArray::<U2>::new(), checksum: 0.0 }
        }
        /// Process `blocks` blocks of 128 stereo frames (two 64-frame fundsp calls each).
        pub fn run(&mut self, blocks: u32) -> f32 {
            for _ in 0..blocks {
                for _ in 0..BLOCK / MAX_BUFFER_SIZE {
                    self.unit.process(MAX_BUFFER_SIZE, &self.input.buffer_ref(), &mut self.output.buffer_mut());
                }
                self.checksum += self.output.buffer_ref().at_f32(0, 3);
            }
            self.checksum
        }
    }
}

// ---- C ABI -------------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}
#[no_mangle]
pub unsafe extern "C" fn dealloc(p: *mut u8, n: usize) {
    drop(Vec::from_raw_parts(p, 0, n));
}

#[cfg(feature = "dec")]
mod abi_dec {
    use super::dec::*;
    static mut LAST: Option<Decoded> = None;
    /// Returns frames decoded (>=0) or -1 on error. Consumes (ptr,len) which came from `alloc(len)`.
    #[no_mangle]
    pub unsafe extern "C" fn decode(ptr: *mut u8, len: usize) -> i64 {
        let bytes = Vec::from_raw_parts(ptr, len, len);
        match decode_all(bytes) {
            Ok(d) => {
                let frames = (d.samples.len() / d.channels.max(1)) as i64;
                LAST = Some(d);
                frames
            }
            Err(_) => -1,
        }
    }
    #[no_mangle]
    pub unsafe extern "C" fn out_ptr() -> *const f32 {
        LAST.as_ref().map_or(std::ptr::null(), |d| d.samples.as_ptr())
    }
    #[no_mangle]
    pub unsafe extern "C" fn out_channels() -> u32 {
        LAST.as_ref().map_or(0, |d| d.channels as u32)
    }
    #[no_mangle]
    pub unsafe extern "C" fn out_rate() -> u32 {
        LAST.as_ref().map_or(0, |d| d.rate)
    }
    #[no_mangle]
    pub unsafe extern "C" fn out_free() {
        LAST = None;
    }
}

#[cfg(feature = "dec")]
mod abi_stream {
    use super::stream::*;
    static mut S: Option<Stream> = None;
    /// 0 = ok, -1 = error. Consumes (ptr,len) from `alloc(len)`.
    #[no_mangle]
    pub unsafe extern "C" fn stream_open(ptr: *mut u8, len: usize) -> i32 {
        match Stream::open(Vec::from_raw_parts(ptr, len, len)) { Ok(s) => { S = Some(s); 0 } Err(_) => -1 }
    }
    #[no_mangle]
    pub unsafe extern "C" fn stream_read(frames: u32) -> u32 { S.as_mut().unwrap().read(frames as usize) as u32 }
    #[no_mangle]
    pub unsafe extern "C" fn stream_chunk_ptr() -> *const f32 { S.as_ref().unwrap().chunk.as_ptr() }
    #[no_mangle]
    pub unsafe extern "C" fn stream_seek(secs: f64, mode: u32) -> i64 { S.as_mut().unwrap().seek(secs, mode) }
    #[no_mangle]
    pub unsafe extern "C" fn stream_channels() -> u32 { S.as_ref().unwrap().channels as u32 }
    #[no_mangle]
    pub unsafe extern "C" fn stream_rate() -> u32 { S.as_ref().unwrap().rate }
    #[no_mangle]
    pub unsafe extern "C" fn stream_packets() -> u32 { S.as_ref().unwrap().packets as u32 }
    #[no_mangle]
    pub unsafe extern "C" fn stream_close() { S = None; }
}

#[cfg(feature = "fx")]
mod abi_fx {
    use super::fx::*;
    static mut B: Option<Bench> = None;
    #[no_mangle]
    pub unsafe extern "C" fn fx_init(kind: u32) {
        B = Some(Bench::new(kind));
    }
    #[no_mangle]
    pub unsafe extern "C" fn fx_run(blocks: u32) -> f32 {
        B.as_mut().unwrap().run(blocks)
    }
}
