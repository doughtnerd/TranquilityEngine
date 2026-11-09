//! A0.2-L2: the command batch and REPLAY (ADR 0157 section 4.2). Transcribe the batch header, the
//! record head and every opcode into the tables below. Fill the tables marked A0.2-L2 and the
//! ignored tests.

use crate::model::*;

/// Body header, 16 bytes: `f64 firstFrame` (0), `u32 count` (8), `u32 flags` (12; bit0 overflowed,
/// bit1 first chunk, bit2 last chunk of a REPLAY). A0.2-L2: fill, with `.flags(..)` on `flags`.
pub const BATCH_HEADER: &[Field] = &[];

/// Record head, 12 bytes: `u16 opcode; u16 words; u32 voiceId; u32 frameOffset`. A0.2-L2: fill.
pub const RECORD_HEAD: &[Field] = &[];

/// Every opcode of the section 4.2 table, including LISTENER (0x20, `sent_in_m1: false`) and RESET
/// (0x30), in id order, with `total_bytes` from the table's "Total B" column. A0.2-L2: fill.
pub const OPCODES: &[Opcode] = &[];

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "A0.2-L2"]
    fn header_and_head_sizes() {
        todo!("A0.2-L2");
    }

    #[test]
    #[ignore = "A0.2-L2"]
    fn opcode_ids_are_unique_and_sorted() {
        todo!("A0.2-L2");
    }

    #[test]
    #[ignore = "A0.2-L2"]
    fn fixed_totals_match_the_spec_column() {
        todo!("A0.2-L2");
    }

    #[test]
    #[ignore = "A0.2-L2"]
    fn play_and_set_params_carry_the_panner_bits() {
        todo!("A0.2-L2");
    }
}
