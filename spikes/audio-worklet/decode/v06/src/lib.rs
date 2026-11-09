//! symphonia 0.6.1 variant of ../src/lib.rs (decode + stream only).
#![allow(static_mut_refs)]
#![allow(static_mut_refs)]

#[cfg(feature = "dec")]
mod common {
    use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions};
    use symphonia::core::formats::probe::Hint;
    use symphonia::core::formats::{FormatOptions, FormatReader, TrackType};
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;

    pub fn open(bytes: Vec<u8>) -> Result<(Box<dyn FormatReader>, Box<dyn AudioDecoder>, u32, usize, u32), String> {
        let mss = MediaSourceStream::new(Box::new(std::io::Cursor::new(bytes)), Default::default());
        let format = symphonia::default::get_probe()
            .probe(&Hint::new(), mss, FormatOptions::default(), MetadataOptions::default())
            .map_err(|e| format!("probe: {e}"))?;
        let track = format.default_track(TrackType::Audio).ok_or("no track")?;
        let params = track.codec_params.as_ref().and_then(|p| p.audio()).ok_or("no audio params")?;
        let channels = params.channels.as_ref().map_or(2, |c| c.count());
        let rate = params.sample_rate.unwrap_or(44100);
        let id = track.id;
        let mut reg = symphonia::core::codecs::registry::CodecRegistry::new();
        symphonia::default::register_enabled_codecs(&mut reg);
        #[cfg(feature = "sym-opus")]
        reg.register_audio_decoder::<symphonia_adapter_opus_rs::OpusAdapter>();
        let decoder = reg
            .make_audio_decoder(params, &AudioDecoderOptions::default())
            .map_err(|e| format!("codec: {e}"))?;
        Ok((format, decoder, id, channels, rate))
    }
}

#[cfg(feature = "dec")]
pub mod dec {
    pub struct Decoded {
        pub samples: Vec<f32>,
        pub channels: usize,
        pub rate: u32,
    }

    pub fn decode_all(bytes: Vec<u8>) -> Result<Decoded, String> {
        let (mut format, mut decoder, id, mut channels, mut rate) = super::common::open(bytes)?;
        let mut out: Vec<f32> = Vec::new();
        let mut scratch: Vec<f32> = Vec::new();
        loop {
            let packet = match format.next_packet() { Ok(Some(p)) => p, _ => break };
            if packet.track_id != id { continue; }
            match decoder.decode(&packet) {
                Ok(buf) => {
                    channels = buf.spec().channels().count();
                    rate = buf.spec().rate();
                    scratch.resize(buf.samples_interleaved(), 0.0);
                    buf.copy_to_slice_interleaved(&mut scratch);
                    out.extend_from_slice(&scratch);
                }
                Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
                Err(e) => return Err(format!("decode: {e}")),
            }
        }
        Ok(Decoded { samples: out, channels, rate })
    }
}

#[cfg(feature = "dec")]
pub mod stream {
    use symphonia::core::codecs::audio::AudioDecoder;
    use symphonia::core::formats::{FormatReader, SeekMode, SeekTo};
    use symphonia::core::units::Time;

    pub struct Stream {
        format: Box<dyn FormatReader>,
        decoder: Box<dyn AudioDecoder>,
        track_id: u32,
        pub channels: usize,
        pub rate: u32,
        pend: Vec<f32>,
        pos: usize,
        scratch: Vec<f32>,
        eof: bool,
        pub chunk: Vec<f32>,
        pub packets: u64,
    }

    impl Stream {
        pub fn open(bytes: Vec<u8>) -> Result<Stream, String> {
            let (format, decoder, track_id, channels, rate) = super::common::open(bytes)?;
            Ok(Stream { format, decoder, track_id, channels, rate, pend: Vec::new(), pos: 0, scratch: Vec::new(), eof: false, chunk: Vec::new(), packets: 0 })
        }

        pub fn read(&mut self, frames: usize) -> usize {
            let want = frames * self.channels;
            while self.pend.len() - self.pos < want && !self.eof {
                let packet = match self.format.next_packet() { Ok(Some(p)) => p, r => { unsafe { SEEK_ERR = Some(format!("next_packet {:?}", r.as_ref().err())); } self.eof = true; break; } };
                if packet.track_id != self.track_id { continue; }
                self.packets += 1;
                match self.decoder.decode(&packet) {
                    Ok(buf) => {
                        self.channels = buf.spec().channels().count();
                        self.rate = buf.spec().rate();
                        self.scratch.resize(buf.samples_interleaved(), 0.0);
                        buf.copy_to_slice_interleaved(&mut self.scratch);
                        if self.pos > 0 { self.pend.drain(..self.pos); self.pos = 0; }
                        self.pend.extend_from_slice(&self.scratch);
                    }
                    Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
                    Err(e) => { unsafe { SEEK_ERR = Some(format!("decode {e}")); } continue; }
                }
            }
            let n = (self.pend.len() - self.pos).min(want);
            self.chunk.clear();
            self.chunk.extend_from_slice(&self.pend[self.pos..self.pos + n]);
            self.pos += n;
            n / self.channels.max(1)
        }

        pub fn seek(&mut self, secs: f64, mode: u32) -> i64 {
            let m = if mode == 0 { SeekMode::Coarse } else { SeekMode::Accurate };
            let t = Time::from_nanos((secs * 1e9) as i64);
            match self.format.seek(m, SeekTo::Time { time: t, track_id: Some(self.track_id) }) {
                Ok(s) => {
                    self.decoder.reset();
                    self.pend.clear();
                    self.pos = 0;
                    self.eof = false;
                    s.actual_ts.get()
                }
                Err(e) => { unsafe { SEEK_ERR = Some(format!("{e}")); } -1 }
            }
        }
    }
    pub static mut SEEK_ERR: Option<String> = None;
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

