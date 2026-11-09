//! A0.2-L1: the envelope and the kinds (ADR 0157 section 4.1). Transcribe the spec tables into the
//! `const` tables below, using the `crate::model` types. Fill the tables marked A0.2-L1 and the
//! ignored tests.
//!
//! Layout rules: fields without `.at()` follow each other in order; the generator checks natural
//! alignment and that sizes add up. Kind ids: STREAM_OPEN is 5 (the spec table lost its number; the
//! HRIR row is a layout note for CLIP_CHUNK of a `format = 2` clip, modelled by `HRIR_HEADER`).

use crate::model::*;

/// Envelope, 16 bytes: `u32 magic; u16 version; u16 kind; u32 seq; u32 bodyBytes`, at offsets 0, 4,
/// 6, 8, 12. A0.2-L1: fill.
pub const ENVELOPE: &[Field] = &[];

/// Every kind 1..=12 with its body (fixed fields and tail), in id order. A0.2-L1: fill.
pub const KINDS: &[Kind] = &[];

/// First-chunk header of a `format = 2` HRIR clip: `u32 elevations; u32 azimuths; u32 irLength;
/// f32 rate;`. A0.2-L1: fill.
pub const HRIR_HEADER: &[Field] = &[];

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "A0.2-L1"]
    fn envelope_is_16_bytes_at_the_spec_offsets() {
        todo!("A0.2-L1");
    }

    #[test]
    #[ignore = "A0.2-L1"]
    fn kinds_are_1_to_12_with_unique_names() {
        todo!("A0.2-L1");
    }

    #[test]
    #[ignore = "A0.2-L1"]
    fn bodies_match_the_spec_layouts() {
        todo!("A0.2-L1");
    }

    #[test]
    #[ignore = "A0.2-L1"]
    fn hrir_header_is_16_bytes() {
        todo!("A0.2-L1");
    }
}
