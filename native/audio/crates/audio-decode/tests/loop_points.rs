//! Loop-point parsers (E4.1, ADR 0158 §4). Fixtures are built in code.

use myco_audio_decode::{comment_loop_points, smpl_loop_points, wav_loop_points};

fn chunk(id: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut v = id.to_vec();
    v.extend_from_slice(&(body.len() as u32).to_le_bytes());
    v.extend_from_slice(body);
    if body.len() % 2 == 1 {
        v.push(0);
    }
    v
}

fn fmt_chunk() -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(&1u16.to_le_bytes()); // PCM
    b.extend_from_slice(&1u16.to_le_bytes()); // mono
    b.extend_from_slice(&8000u32.to_le_bytes());
    b.extend_from_slice(&16000u32.to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    chunk(b"fmt ", &b)
}

fn data_chunk() -> Vec<u8> {
    chunk(b"data", &[0u8; 400])
}

/// `smpl` body with the given `(type, start, end)` loops.
fn smpl_body(loops: &[(u32, u32, u32)]) -> Vec<u8> {
    let mut b = vec![0u8; 28];
    b.extend_from_slice(&(loops.len() as u32).to_le_bytes());
    b.extend_from_slice(&0u32.to_le_bytes()); // samplerData
    for (i, &(ty, start, end)) in loops.iter().enumerate() {
        for v in [i as u32, ty, start, end, 0, 0] {
            b.extend_from_slice(&v.to_le_bytes());
        }
    }
    b
}

fn riff(chunks: &[Vec<u8>]) -> Vec<u8> {
    let mut body = b"WAVE".to_vec();
    for c in chunks {
        body.extend_from_slice(c);
    }
    let mut v = b"RIFF".to_vec();
    v.extend_from_slice(&(body.len() as u32).to_le_bytes());
    v.extend(body);
    v
}

#[test]
#[ignore = "L4.1a"]
fn wav_smpl_after_data() {
    let f = riff(&[fmt_chunk(), data_chunk(), chunk(b"smpl", &smpl_body(&[(0, 10, 99)]))]);
    assert_eq!(wav_loop_points(&f), Some((10, 100)));
}

#[test]
#[ignore = "L4.1a"]
fn wav_smpl_before_data() {
    let f = riff(&[fmt_chunk(), chunk(b"smpl", &smpl_body(&[(0, 5, 149)])), data_chunk()]);
    assert_eq!(wav_loop_points(&f), Some((5, 150)));
}

#[test]
#[ignore = "L4.1a"]
fn wav_without_smpl_or_loops() {
    assert_eq!(wav_loop_points(&riff(&[fmt_chunk(), data_chunk()])), None);
    let f = riff(&[fmt_chunk(), data_chunk(), chunk(b"smpl", &smpl_body(&[]))]);
    assert_eq!(wav_loop_points(&f), None);
}

#[test]
#[ignore = "L4.1a"]
fn wav_not_riff_or_empty() {
    assert_eq!(wav_loop_points(&[]), None);
    assert_eq!(wav_loop_points(b"RIFF"), None);
    assert_eq!(wav_loop_points(b"OggS0000000000000000"), None);
}

#[test]
#[ignore = "L4.1a"]
fn wav_odd_sized_chunk_before_smpl_is_padded() {
    let f = riff(&[fmt_chunk(), chunk(b"junk", &[1, 2, 3]), data_chunk(), chunk(b"smpl", &smpl_body(&[(0, 1, 2)]))]);
    assert_eq!(wav_loop_points(&f), Some((1, 3)));
}

#[test]
#[ignore = "L4.1a"]
fn wav_truncated_smpl_chunk_is_none() {
    let mut f = riff(&[fmt_chunk(), data_chunk(), chunk(b"smpl", &smpl_body(&[(0, 10, 99)]))]);
    f.truncate(f.len() - 10);
    assert_eq!(wav_loop_points(&f), None);
}

#[test]
#[ignore = "L4.1a"]
fn smpl_first_forward_loop_wins() {
    assert_eq!(smpl_loop_points(&smpl_body(&[(0, 100, 199), (0, 300, 399)])), Some((100, 200)));
}

#[test]
#[ignore = "L4.1a"]
fn smpl_skips_non_forward_loops() {
    assert_eq!(smpl_loop_points(&smpl_body(&[(1, 0, 50)])), None);
    assert_eq!(smpl_loop_points(&smpl_body(&[(2, 0, 50)])), None);
    assert_eq!(smpl_loop_points(&smpl_body(&[(1, 0, 50), (0, 7, 8)])), Some((7, 9)));
}

#[test]
#[ignore = "L4.1a"]
fn smpl_end_before_start_or_overflow_is_skipped() {
    assert_eq!(smpl_loop_points(&smpl_body(&[(0, 50, 10)])), None);
    assert_eq!(smpl_loop_points(&smpl_body(&[(0, 0, u32::MAX), (0, 1, 2)])), Some((1, 3)));
}

#[test]
#[ignore = "L4.1a"]
fn smpl_malformed_short_chunk() {
    assert_eq!(smpl_loop_points(&[]), None);
    assert_eq!(smpl_loop_points(&[0u8; 35]), None);
    // Header says 2 loops but only 1 complete record follows: the complete one still counts.
    let mut b = smpl_body(&[(0, 4, 9)]);
    b[28..32].copy_from_slice(&2u32.to_le_bytes());
    b.extend_from_slice(&[0u8; 10]);
    assert_eq!(smpl_loop_points(&b), Some((4, 10)));
    // Header says 1 loop, the record is cut short.
    let mut b = smpl_body(&[(0, 4, 9)]);
    b.truncate(36 + 20);
    assert_eq!(smpl_loop_points(&b), None);
}

#[test]
#[ignore = "L4.1a"]
fn comments_start_and_length() {
    assert_eq!(comment_loop_points(&[("LOOPSTART", "1000"), ("LOOPLENGTH", "500")]), Some((1000, 1500)));
}

#[test]
#[ignore = "L4.1a"]
fn comments_mixed_case_keys_and_other_keys() {
    let c = [("TITLE", "x"), ("LoopLength", " 40 "), ("loopstart", "10")];
    assert_eq!(comment_loop_points(&c), Some((10, 50)));
}

#[test]
#[ignore = "L4.1a"]
fn comments_missing_length_or_start() {
    assert_eq!(comment_loop_points(&[("LOOPSTART", "10")]), None);
    assert_eq!(comment_loop_points(&[("LOOPLENGTH", "10")]), None);
    assert_eq!(comment_loop_points(&[]), None);
}

#[test]
#[ignore = "L4.1a"]
fn comments_non_numeric_zero_or_overflow() {
    assert_eq!(comment_loop_points(&[("LOOPSTART", "abc"), ("LOOPLENGTH", "5")]), None);
    assert_eq!(comment_loop_points(&[("LOOPSTART", "5"), ("LOOPLENGTH", "-1")]), None);
    assert_eq!(comment_loop_points(&[("LOOPSTART", "5"), ("LOOPLENGTH", "0")]), None);
    assert_eq!(comment_loop_points(&[("LOOPSTART", "4294967295"), ("LOOPLENGTH", "1")]), None);
}
