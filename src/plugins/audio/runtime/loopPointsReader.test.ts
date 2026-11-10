// Mirrors native/audio/crates/audio-decode/tests/loop_points.rs (fixtures built in code), plus the Ogg reader.
import { describe, it } from "vitest";
// import { commentLoopPoints, oggComments, readLoopPoints, smplLoopPoints, wavLoopPoints } from "./loopPointsReader";

describe("wavLoopPoints", () => {
  it.skip("wav_smpl_after_data", () => {}); // L4.2a
  it.skip("wav_smpl_before_data", () => {});
  it.skip("wav_without_smpl_or_loops", () => {});
  it.skip("wav_not_riff_or_empty", () => {});
  it.skip("wav_odd_sized_chunk_before_smpl_is_padded", () => {});
  it.skip("wav_truncated_smpl_chunk_is_none", () => {});
});

describe("smplLoopPoints", () => {
  it.skip("smpl_first_forward_loop_wins", () => {});
  it.skip("smpl_skips_non_forward_loops", () => {});
  it.skip("smpl_end_before_start_or_overflow_is_skipped", () => {});
  it.skip("smpl_malformed_short_chunk", () => {});
});

describe("commentLoopPoints", () => {
  it.skip("comments_start_and_length", () => {});
  it.skip("comments_mixed_case_keys_and_other_keys", () => {});
  it.skip("comments_missing_length_or_start", () => {});
  it.skip("comments_non_numeric_zero_or_overflow", () => {});
});

describe("oggComments", () => {
  it.skip("vorbis_comment_header_in_one_page", () => {});
  it.skip("opus_tags_in_one_page", () => {});
  it.skip("comment_packet_spanning_two_pages", () => {});
  it.skip("other_serial_pages_are_ignored", () => {});
  it.skip("not_ogg_truncated_or_malformed_gives_no_comments", () => {});
});

describe("readLoopPoints", () => {
  it.skip("dispatches_wav_and_ogg_and_ignores_other_formats", () => {});
  it.skip("never_throws_on_truncations_of_a_valid_file", () => {});
});
