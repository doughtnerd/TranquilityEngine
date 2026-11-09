//! A0.2-L3: the STATUS body (ADR 0157 section 4.3). Transcribe the 112-byte header (absolute offsets,
//! envelope counted: use `.at(off)` on every field) and the sections. Fill the tables marked
//! A0.2-L3 and the ignored tests.

use crate::model::*;

/// Header fields at the spec's offsets (16..=111), `flags` with its six named bits. A0.2-L3: fill.
pub const HEADER_FIELDS: &[Field] = &[];

/// Sections in order: ended, demoted, starved, playheads, clipEvents, streamEvents, peaks. A0.2-L3: fill.
pub const SECTIONS: &[Section] = &[];

pub const STATUS: StatusSpec = StatusSpec { header_bytes: 112, fields: HEADER_FIELDS, sections: SECTIONS };

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "A0.2-L3"]
    fn header_fields_sit_at_the_spec_offsets_without_overlap() {
        todo!("A0.2-L3");
    }

    #[test]
    #[ignore = "A0.2-L3"]
    fn flags_bits_0_to_5() {
        todo!("A0.2-L3");
    }

    #[test]
    #[ignore = "A0.2-L3"]
    fn sections_and_caps() {
        todo!("A0.2-L3");
    }

    #[test]
    #[ignore = "A0.2-L3"]
    fn worst_case_is_15728_bytes() {
        todo!("A0.2-L3");
    }
}
