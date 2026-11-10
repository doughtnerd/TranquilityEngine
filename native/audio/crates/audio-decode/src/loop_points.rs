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
    let _ = bytes;
    None // L4.1a
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
    let _ = body;
    None // L4.1a
}

/// Loop points from a Vorbis/Opus comment list, as `(key, value)` pairs (the decoder splits each
/// `KEY=value` comment at the first `=`).
///
/// Rule: keys `LOOPSTART` and `LOOPLENGTH` match case-insensitively (ASCII); the first of each
/// wins; values are decimal sample frames (`u32`, surrounding ASCII whitespace trimmed). Result
/// `(start, start + length)` with `checked_add`. `None` when either key is missing, a value is
/// not a plain decimal `u32`, the length is 0, or the sum overflows. Other keys are ignored.
pub fn comment_loop_points(comments: &[(&str, &str)]) -> Option<(u32, u32)> {
    let _ = comments;
    None // L4.1a
}
