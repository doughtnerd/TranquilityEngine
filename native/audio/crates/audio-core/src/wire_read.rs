//! Little-endian reads of wire record fields, shared by the record parsers (`automation`, `bed`,
//! `bus`, `zones`). One copy instead of one per module: each copy carried its own bounds checks.
//! Out-of-range offsets panic as slice indexing does; callers check the record's extent first.

pub(crate) fn u16_at(msg: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([msg[off], msg[off + 1]])
}

pub(crate) fn u32_at(msg: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([msg[off], msg[off + 1], msg[off + 2], msg[off + 3]])
}
