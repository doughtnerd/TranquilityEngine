//! The status writer (`audio_core::status`) against the wire schema (contract K1): every field the
//! writer puts down is read back by `audio-wire`'s generated `StatusBlock::read`. A drift between
//! the writer's offsets and the schema fails here.

#[test]
#[ignore = "A0.3 core: needs A0.3-L2's counters"]
fn every_counter_reads_back_through_the_generated_reader() {}

#[test]
#[ignore = "A0.3 core: needs A0.3-L2's counters"]
fn full_sections_read_back_in_order() {}
