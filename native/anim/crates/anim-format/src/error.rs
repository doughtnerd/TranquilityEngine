//! The one error type every reader and writer returns. Readers refuse a buffer with the first
//! problem they find; they never panic and never return a partly-read value.

use core::fmt;

/// Why a buffer was refused (or why a writer refused its model).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FormatError {
    /// The buffer is shorter than the fixed header, or than its section table.
    Truncated { needed: usize, have: usize },
    /// The first 8 bytes aren't this format's magic.
    BadMagic { expected: [u8; 8] },
    /// The format version isn't the one this build reads.
    UnsupportedVersion { found: u32, expected: u32 },
    /// The header's file length isn't the buffer's length.
    LengthMismatch { header: u32, actual: usize },
    /// Header flag bits this version doesn't define are set.
    UnknownFlags { flags: u32 },
    /// A reserved field or reserved byte isn't zero.
    NonZeroReserved { what: &'static str },
    /// A section kind this format doesn't define.
    UnknownSection { kind: u32 },
    /// A section kind appears twice.
    DuplicateSection { kind: u32 },
    /// A section the format requires is absent, or a section group is incomplete.
    MissingSection { section: &'static str },
    /// A section's offset isn't a multiple of its alignment.
    MisalignedSection {
        section: &'static str,
        offset: u32,
        align: u32,
    },
    /// A section starts inside the header or table, or ends past the buffer.
    SectionOutOfBounds {
        section: &'static str,
        offset: u32,
        length: u32,
    },
    /// Sections aren't in ascending offset order, or overlap.
    OverlappingSections { section: &'static str },
    /// A section's length doesn't match its element count.
    BadSectionLength {
        section: &'static str,
        length: u32,
        expected: u64,
    },
    /// The padding at the end of a section isn't zero.
    NonZeroPadding { section: &'static str },
    /// A count that disagrees with another count (header against table, table against section).
    BadCount {
        what: &'static str,
        count: u64,
        expected: u64,
    },
    /// The string table's offsets are inconsistent or a string isn't UTF-8.
    BadString { index: u32 },
    /// An index (bone, node, string, key, …) outside its table.
    IndexOutOfRange {
        what: &'static str,
        index: u32,
        len: u32,
    },
    /// A range `[first, first + count)` outside its table.
    RangeOutOfBounds {
        what: &'static str,
        first: u32,
        count: u32,
        len: u32,
    },
    /// An enum value, flag bit or other field outside its defined set.
    InvalidValue { what: &'static str, value: u32 },
    /// A float that must be finite isn't (or is outside its documented range).
    BadFloat { what: &'static str },
    /// Fields that must agree don't (ordering, sortedness, required pairings).
    Inconsistent { what: &'static str },
    /// A graph (node inputs, skeleton parents) that must be acyclic has a cycle.
    Cycle { what: &'static str },
    /// A nested structure deeper than the format allows.
    TooDeep { what: &'static str, limit: u32 },
    /// A writer's model is too large for 32-bit offsets.
    TooLarge { what: &'static str },
}

impl fmt::Display for FormatError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        use FormatError::*;
        match self {
            Truncated { needed, have } => write!(f, "truncated: need {needed} bytes, have {have}"),
            BadMagic { expected } => {
                write!(
                    f,
                    "bad magic, expected {:?}",
                    String::from_utf8_lossy(expected)
                )
            }
            UnsupportedVersion { found, expected } => {
                write!(f, "format version {found}, this build reads {expected}")
            }
            LengthMismatch { header, actual } => {
                write!(f, "header says {header} bytes, buffer has {actual}")
            }
            UnknownFlags { flags } => write!(f, "unknown header flags {flags:#x}"),
            NonZeroReserved { what } => write!(f, "reserved field not zero: {what}"),
            UnknownSection { kind } => write!(f, "unknown section kind {kind}"),
            DuplicateSection { kind } => write!(f, "duplicate section kind {kind}"),
            MissingSection { section } => write!(f, "missing section {section}"),
            MisalignedSection {
                section,
                offset,
                align,
            } => {
                write!(
                    f,
                    "section {section} at {offset} is not {align}-byte aligned"
                )
            }
            SectionOutOfBounds {
                section,
                offset,
                length,
            } => {
                write!(f, "section {section} ({offset}+{length}) is out of bounds")
            }
            OverlappingSections { section } => {
                write!(f, "section {section} overlaps or is out of order")
            }
            BadSectionLength {
                section,
                length,
                expected,
            } => {
                write!(
                    f,
                    "section {section} is {length} bytes, expected {expected}"
                )
            }
            NonZeroPadding { section } => write!(f, "section {section} has non-zero padding"),
            BadCount {
                what,
                count,
                expected,
            } => {
                write!(f, "{what}: count {count}, expected {expected}")
            }
            BadString { index } => write!(f, "string {index} is malformed"),
            IndexOutOfRange { what, index, len } => {
                write!(f, "{what} index {index} out of range (len {len})")
            }
            RangeOutOfBounds {
                what,
                first,
                count,
                len,
            } => {
                write!(f, "{what} range {first}+{count} out of bounds (len {len})")
            }
            InvalidValue { what, value } => write!(f, "invalid {what}: {value}"),
            BadFloat { what } => write!(f, "{what} is not finite or out of range"),
            Inconsistent { what } => write!(f, "inconsistent: {what}"),
            Cycle { what } => write!(f, "cycle in {what}"),
            TooDeep { what, limit } => write!(f, "{what} nests deeper than {limit}"),
            TooLarge { what } => write!(f, "{what} too large for 32-bit offsets"),
        }
    }
}

impl std::error::Error for FormatError {}

/// Result alias for this crate.
pub type Result<T> = core::result::Result<T, FormatError>;
