//! Loop points stored in audio files (ADR 0158 §4): the WAV `smpl` chunk and the Vorbis/Opus
//! `LOOPSTART`/`LOOPLENGTH` comment convention. Pure parsers over bytes and strings: no decoding.
//! Every function returns `(start, end)` in sample frames, `end` exclusive (the first frame after
//! the loop), or `None` when the file has no usable loop. None of them panics on any input.

/// Loop points of a whole RIFF/WAVE file: walks the chunk list (a `smpl` chunk may come before or
/// after `data`) and passes the first `smpl` chunk's body to [`smpl_loop_points`].
///
/// Rules: the file starts `RIFF`, a 4-byte size (ignored), `WAVE`; chunks follow as a 4-byte id, a
/// little-endian `u32` size and the body, padded to an even length. A chunk whose declared size
/// runs past the end of `bytes` ends the walk (a truncated `smpl` is malformed: `None`). Not
/// RIFF/WAVE, no `smpl` chunk, or no usable loop: `None`. Only `RIFF` is read (not `RIFX`/`RF64`).
pub fn wav_loop_points(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.get(0..4)? != b"RIFF" || bytes.get(8..12)? != b"WAVE" {
        return None;
    }
    let mut pos: usize = 12;
    loop {
        let id = bytes.get(pos..pos.checked_add(4)?)?;
        let size = read_u32(bytes, pos.checked_add(4)?)? as usize;
        let body_start = pos.checked_add(8)?;
        let body_end = body_start.checked_add(size)?;
        let body = bytes.get(body_start..body_end)?;
        if id == b"smpl" {
            return smpl_loop_points(body);
        }
        // Odd-sized bodies are followed by one pad byte.
        pos = body_end.checked_add(size & 1)?;
    }
}

/// Reads a little-endian `u32` at `at`, or `None` when the four bytes are not all there.
fn read_u32(bytes: &[u8], at: usize) -> Option<u32> {
    let end = at.checked_add(4)?;
    let raw: [u8; 4] = bytes.get(at..end)?.try_into().ok()?;
    Some(u32::from_le_bytes(raw))
}

/// Parses a decimal sample-frame count: plain ASCII digits only (no sign), within `u32`.
fn parse_frames(text: &str) -> Option<u32> {
    let text = text.trim_matches(|c: char| c.is_ascii_whitespace());
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse::<u32>().ok()
}

/// Loop points from the body of one `smpl` chunk (the bytes after its id and size).
///
/// Layout, all little-endian `u32`: a 36-byte header (manufacturer, product, samplePeriod,
/// midiUnityNote, midiPitchFraction, smpteFormat, smpteOffset, numSampleLoops at offset 28,
/// samplerData), then `numSampleLoops` 24-byte loop records: cuePointId, type, start, end,
/// fraction, playCount.
///
/// Rule: use the first record whose `type` is 0 (forward), and return `(start, end + 1)`, because
/// `end` is inclusive in `smpl` and the result is exclusive (use `checked_add`; overflow: skip
/// that record). Records of other types (1 ping-pong, 2 backward, others) are skipped, and so is a
/// record with `end < start`. Return `None` when the body is shorter than 36 bytes,
/// `numSampleLoops` is 0, or no record qualifies. Stop at the first record that would run past
/// the body (earlier complete records still count).
pub fn smpl_loop_points(body: &[u8]) -> Option<(u32, u32)> {
    if body.len() < 36 {
        return None;
    }
    let count = read_u32(body, 28)?;
    if count == 0 {
        return None;
    }
    // `chunks_exact` drops a trailing partial record; `take` bounds the walk by the header's count.
    let records = body.get(36..)?;
    for record in records.chunks_exact(24).take(count as usize) {
        let kind = read_u32(record, 4)?;
        let start = read_u32(record, 8)?;
        let end = read_u32(record, 12)?;
        if kind != 0 || end < start {
            continue;
        }
        if let Some(exclusive_end) = end.checked_add(1) {
            return Some((start, exclusive_end));
        }
    }
    None
}

/// Loop points from a Vorbis/Opus comment list, as `(key, value)` pairs (the decoder splits each
/// `KEY=value` comment at the first `=`).
///
/// Rule: keys `LOOPSTART` and `LOOPLENGTH` match case-insensitively (ASCII); the first of each
/// wins; values are decimal sample frames (`u32`, surrounding ASCII whitespace trimmed). Result
/// `(start, start + length)` with `checked_add`. `None` when either key is missing, a value is
/// not a plain decimal `u32`, the length is 0, or the sum overflows. Other keys are ignored.
pub fn comment_loop_points(comments: &[(&str, &str)]) -> Option<(u32, u32)> {
    // The first occurrence of each key is the one used, even if its value does not parse.
    let mut start_text: Option<&str> = None;
    let mut length_text: Option<&str> = None;
    for &(key, value) in comments {
        if key.eq_ignore_ascii_case("LOOPSTART") {
            start_text = start_text.or(Some(value));
        } else if key.eq_ignore_ascii_case("LOOPLENGTH") {
            length_text = length_text.or(Some(value));
        }
    }
    let start = parse_frames(start_text?)?;
    let length = parse_frames(length_text?)?;
    if length == 0 {
        return None;
    }
    Some((start, start.checked_add(length)?))
}
