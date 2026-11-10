//! Gapless trimming for AAC in MP4/M4A (task B4). symphonia 0.6.1's isomp4 reader parses the edit list
//! but doesn't apply it, and its AAC decoder trims nothing, so a decode keeps the encoder's priming
//! frames (1,024 from ffmpeg, 2,112 from Apple's encoders) and the last frame's padding. This reads
//! what the file says to trim, from the audio track's edit list (`moov/trak/edts/elst`) or, failing
//! that, iTunes' `iTunSMPB` comment, so the decoder can drop the priming and stop at the real end.
//!
//! Only the boxes needed are walked, over the raw bytes; anything malformed means "no trim info".

/// What to trim, in output frames at the track's sample rate.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Gapless {
    /// Leading frames to drop (encoder priming).
    pub delay: u64,
    /// Playable frames after the delay, when the file states it.
    pub frames: Option<u64>,
    /// How far `frames` may be from the truth: an edit list states its duration in the movie
    /// timescale (ffmpeg writes 1/1000 s), coarser than a frame, so it can be up to one movie tick
    /// short or long; 0 for `iTunSMPB`, which counts frames.
    pub slack: u64,
}

/// A box: its type and payload (after the 8- or 16-byte header).
struct Mp4Box<'a> {
    kind: [u8; 4],
    body: &'a [u8],
}

/// The boxes in `data`, in order; stops at the first malformed header.
fn boxes(data: &[u8]) -> impl Iterator<Item = Mp4Box<'_>> {
    let mut at = 0usize;
    std::iter::from_fn(move || {
        if at + 8 > data.len() {
            return None;
        }
        let size32 = u32::from_be_bytes(data[at..at + 4].try_into().ok()?);
        let kind: [u8; 4] = data[at + 4..at + 8].try_into().ok()?;
        let (header, size) = match size32 {
            0 => (8usize, data.len() - at),
            1 => {
                let big = u64::from_be_bytes(data.get(at + 8..at + 16)?.try_into().ok()?);
                (16usize, usize::try_from(big).ok()?)
            }
            n => (8usize, n as usize),
        };
        if size < header || at.checked_add(size)? > data.len() {
            return None;
        }
        let b = Mp4Box { kind, body: &data[at + header..at + size] };
        at += size;
        Some(b)
    })
}

fn child<'a>(data: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(data).find(|b| &b.kind == kind).map(|b| b.body)
}

fn be_u32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn be_u64(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(b.get(at..at + 8)?.try_into().ok()?))
}

/// The timescale of an `mvhd` or `mdhd` body (version 0 or 1).
fn timescale(body: &[u8]) -> Option<u32> {
    let at = if *body.first()? == 1 { 20 } else { 12 };
    be_u32(body, at).filter(|&t| t > 0)
}

/// `value` ticks of `from` per second as frames of `to` per second, rounded.
fn rescale(value: u64, from: u32, to: u32) -> u64 {
    let n = u128::from(value) * u128::from(to);
    let d = u128::from(from.max(1));
    u64::try_from((n + d / 2) / d).unwrap_or(u64::MAX)
}

/// The first edit with media (`media_time` >= 0) of an `elst` body: (segment duration in the movie
/// timescale, media time in the media timescale).
fn first_edit(elst: &[u8]) -> Option<(u64, u64)> {
    let version = *elst.first()?;
    let count = be_u32(elst, 4)? as usize;
    let entry = if version == 1 { 20 } else { 12 };
    for k in 0..count.min(64) {
        let at = 8 + k * entry;
        let (duration, media_time) = if version == 1 {
            (be_u64(elst, at)?, be_u64(elst, at + 8)? as i64)
        } else {
            (u64::from(be_u32(elst, at)?), i64::from(be_u32(elst, at + 4)? as i32))
        };
        if media_time >= 0 {
            return Some((duration, media_time as u64));
        }
    }
    None
}

/// The audio track's edit list as frames at `rate`.
fn from_edit_list(moov: &[u8], rate: u32) -> Option<Gapless> {
    let movie_ts = timescale(child(moov, b"mvhd")?)?;
    for trak in boxes(moov).filter(|b| &b.kind == b"trak") {
        let Some(mdia) = child(trak.body, b"mdia") else { continue };
        let is_sound = child(mdia, b"hdlr").and_then(|h| h.get(8..12)) == Some(b"soun".as_slice());
        if !is_sound {
            continue;
        }
        let media_ts = timescale(child(mdia, b"mdhd")?)?;
        let elst = child(child(trak.body, b"edts")?, b"elst")?;
        let (duration, media_time) = first_edit(elst)?;
        let frames = if duration > 0 { Some(rescale(duration, movie_ts, rate)) } else { None };
        let slack = u64::from(rate.div_ceil(movie_ts));
        return Some(Gapless { delay: rescale(media_time, media_ts, rate), frames, slack });
    }
    None
}

/// iTunes' `iTunSMPB` comment: " 00000000 DDDDDDDD PPPPPPPP LLLLLLLLLLLLLLLL ..." in hex: delay,
/// padding, then the original length in frames.
pub fn parse_itunsmpb(text: &[u8]) -> Option<Gapless> {
    let text = std::str::from_utf8(text).ok()?;
    let mut fields = text.split_ascii_whitespace();
    let _ = fields.next()?;
    let delay = u64::from_str_radix(fields.next()?, 16).ok()?;
    let _padding = u64::from_str_radix(fields.next()?, 16).ok()?;
    let length = u64::from_str_radix(fields.next()?, 16).ok()?;
    Some(Gapless { delay, frames: (length > 0).then_some(length), slack: 0 })
}

/// Finds `iTunSMPB` in `moov` (under `udta/meta/ilst/----`) and parses the `data` box after it.
fn from_itunsmpb(moov: &[u8]) -> Option<Gapless> {
    let name = moov.windows(8).position(|w| w == b"iTunSMPB")?;
    let rest = &moov[name + 8..];
    let data = rest.windows(4).take(64).position(|w| w == b"data")?;
    // `data` box: size (4, before the type), type, then a 4-byte type indicator and a 4-byte locale.
    let size_at = name + 8 + data - 4;
    let size = be_u32(moov, size_at)? as usize;
    let body = moov.get(size_at + 16..size_at + size)?;
    parse_itunsmpb(body)
}

/// What an MP4/M4A file says to trim from its audio track at `rate`, or `None` when it says nothing
/// (or isn't MP4: an ADTS `.aac` stream carries no such information).
pub fn mp4_gapless(file: &[u8], rate: u32) -> Option<Gapless> {
    if rate == 0 {
        return None;
    }
    let moov = child(file, b"moov")?;
    from_edit_list(moov, rate).or_else(|| from_itunsmpb(moov))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A box of `kind` around `body`.
    fn mk(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut b = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        b.extend_from_slice(kind);
        b.extend_from_slice(body);
        b
    }

    #[test]
    fn itunsmpb_fields() {
        let g = parse_itunsmpb(b" 00000000 00000840 000001CA 00000000000F4240 00000000 00000000").unwrap();
        assert_eq!(g, Gapless { delay: 0x840, frames: Some(1_000_000), slack: 0 });
        assert_eq!(parse_itunsmpb(b"junk"), None);
    }

    #[test]
    fn itunsmpb_in_a_moov() {
        let text = b" 00000000 00000840 00000154 0000000000015888";
        let data = mk(b"data", &[&[0, 0, 0, 1, 0, 0, 0, 0], text.as_slice()].concat());
        let mean = mk(b"mean", b"\0\0\0\0com.apple.iTunes");
        let name = mk(b"name", b"\0\0\0\0iTunSMPB");
        let free = mk(b"----", &[mean, name, data].concat());
        let ilst = mk(b"ilst", &free);
        let meta = mk(b"meta", &[&[0u8, 0, 0, 0][..], &ilst].concat());
        let udta = mk(b"udta", &meta);
        let moov = mk(b"moov", &udta);
        let file = [mk(b"ftyp", b"M4A \0\0\0\0"), moov].concat();
        assert_eq!(mp4_gapless(&file, 44_100), Some(Gapless { delay: 0x840, frames: Some(0x15888), slack: 0 }));
    }

    #[test]
    fn edit_list_v0_and_v1() {
        for version in [0u8, 1] {
            let mvhd = mk(b"mvhd", &{
                let mut b = vec![version, 0, 0, 0];
                b.extend(vec![0u8; if version == 1 { 16 } else { 8 }]);
                b.extend(1000u32.to_be_bytes());
                b.extend(vec![0u8; 80]);
                b
            });
            let mdhd = mk(b"mdhd", &{
                let mut b = vec![version, 0, 0, 0];
                b.extend(vec![0u8; if version == 1 { 16 } else { 8 }]);
                b.extend(48_000u32.to_be_bytes());
                b.extend(vec![0u8; 12]);
                b
            });
            let hdlr = mk(b"hdlr", &[&[0u8; 8][..], b"soun", &[0u8; 13]].concat());
            let mdia = mk(b"mdia", &[mdhd, hdlr].concat());
            let elst = mk(b"elst", &{
                let mut b = vec![version, 0, 0, 0];
                b.extend(2u32.to_be_bytes());
                // An empty edit (media_time -1) first, then the real one: 1,000 ms from frame 1,024.
                if version == 1 {
                    b.extend(5u64.to_be_bytes());
                    b.extend((-1i64).to_be_bytes());
                    b.extend([0, 1, 0, 0]);
                    b.extend(1000u64.to_be_bytes());
                    b.extend(1024i64.to_be_bytes());
                } else {
                    b.extend(5u32.to_be_bytes());
                    b.extend((-1i32).to_be_bytes());
                    b.extend([0, 1, 0, 0]);
                    b.extend(1000u32.to_be_bytes());
                    b.extend(1024i32.to_be_bytes());
                }
                b.extend([0, 1, 0, 0]);
                b
            });
            let edts = mk(b"edts", &elst);
            let trak = mk(b"trak", &[edts, mdia].concat());
            let moov = mk(b"moov", &[mvhd, trak].concat());
            assert_eq!(mp4_gapless(&moov, 48_000), Some(Gapless { delay: 1024, frames: Some(48_000), slack: 48 }), "version {version}");
        }
    }

    #[test]
    fn nothing_to_say() {
        assert_eq!(mp4_gapless(b"", 48_000), None);
        assert_eq!(mp4_gapless(&[0xff, 0xf1, 0x50, 0x80, 0, 0, 0, 0, 0], 48_000), None);
        assert_eq!(mp4_gapless(&mk(b"moov", b""), 48_000), None);
        // A box that claims more bytes than the file has.
        assert_eq!(mp4_gapless(&[0, 0, 1, 0, b'm', b'o', b'o', b'v'], 48_000), None);
    }
}
