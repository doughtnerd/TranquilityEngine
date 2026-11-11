//! Probes files with the decoder stack M1 ships and prints what symphonia reports and returns.
use std::fs::File;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

fn opus_head(path: &str) -> String {
    let d = std::fs::read(path).unwrap_or_default();
    if d.len() < 60 || &d[..4] != b"OggS" { return String::new(); }
    let n = d[26] as usize;
    let s = 27 + n;
    if &d[s..s + 8] != b"OpusHead" { return String::new(); }
    let ch = d[s + 9];
    let fam = d[s + 18];
    format!(" [OpusHead: {} ch, mapping family {}]", ch, fam)
}

fn main() {
    let mut files: Vec<String> = std::env::args().skip(1).collect();
    files.sort();
    for path in files {
        let name = path.rsplit('/').next().unwrap().to_string();
        let f = File::open(&path).unwrap();
        let mss = MediaSourceStream::new(Box::new(f), Default::default());
        let mut hint = Hint::new();
        if let Some(ext) = path.rsplit('.').next() { hint.with_extension(ext); }
        let probed = symphonia::default::get_probe().probe(&hint, mss, FormatOptions::default(), MetadataOptions::default());
        let mut format = match probed {
            Ok(f) => f,
            Err(e) => { println!("{name}{}: PROBE FAILED: {e}", opus_head(&path)); continue; }
        };
        let Some(track) = format.default_track(TrackType::Audio).or_else(|| format.tracks().first()) else { println!("{name}: no track"); continue; };
        let tid = track.id;
        let params = match &track.codec_params {
            Some(symphonia::core::codecs::CodecParameters::Audio(a)) => a.clone(),
            other => { println!("{name}: not audio params: {:?}", other.is_some()); continue; }
        };
        print!("{name}{}: codec id {:?}, rate {:?}, channels {:?}", opus_head(&path), params.codec, params.sample_rate, params.channels);
        let mut dec = match symphonia::default::get_codecs().make_audio_decoder(&params, &AudioDecoderOptions::default()) {
            Ok(d) => d,
            Err(e) => { println!("\n    DECODER FAILED: {e}"); continue; }
        };
        let mut frames = 0usize;
        let mut first: Option<Vec<f32>> = None;
        let mut spec = String::new();
        loop {
            let pkt = match format.next_packet() { Ok(Some(p)) => p, Ok(None) => break, Err(e) => { println!("\n    packet error: {e}"); break; } };
            if pkt.track_id != tid { continue; }
            match dec.decode(&pkt) {
                Ok(buf) => {
                    frames += buf.frames();
                    if first.is_none() {
                        let mut v = Vec::new();
                        buf.copy_to_vec_interleaved::<f32>(&mut v);
                        let ch = buf.spec().channels().count();
                        spec = format!("{:?}", buf.spec().channels());
                        first = Some(v[..ch.min(v.len())].to_vec());
                    }
                }
                Err(e) => { println!("\n    decode error: {e}"); break; }
            }
        }
        match first {
            Some(v) => {
                let order: Vec<i32> = v.iter().map(|x| (x * 40.0).round() as i32).collect();
                println!("\n    decoded {frames} frames; buffer channels {spec}; first frame x40 (expect 1,2,3...): {:?}", order);
            }
            None => println!("\n    nothing decoded"),
        }
    }
}
