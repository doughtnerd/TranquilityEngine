//! The container every format shares: a 32-byte header, a section table, and sections.
//!
//! ```text
//! Header (32 bytes, at 0)
//!    0  [u8; 8]  magic (per format: "MYCOANIM", "MYCOSKEL", "MYCOAGPH", "MYCOPSDB")
//!    8  u32      format version (per format; 1 for every format here)
//!   12  u32      flags (per format; undefined bits must be 0)
//!   16  u32      file length in bytes (must equal the buffer length)
//!   20  u32      section count
//!   24  u32      reserved (0)
//!   28  u32      reserved (0)
//! Section table (section count x 16 bytes, at 32)
//!    0  u32      kind (per format)
//!    4  u32      offset from the file start
//!    8  u32      length in bytes (a multiple of 4)
//!   12  u32      count: elements in the section (per section; see each format)
//! Sections
//!   at their offsets: ascending, non-overlapping, after the table, each aligned to its kind's
//!   alignment (4, or 16 for payloads read with SIMD loads). Writers align every section to 16.
//!   A record section's length is `align4(count * stride)` and its padding bytes are 0.
//! ```
//!
//! Each kind appears at most once; unknown kinds are refused (a reader never skips data it
//! doesn't understand: new sections mean a new format version).

use crate::bytes::{align16, align4, is_aligned, u32_at, Out};
use crate::error::{FormatError, Result};

/// The fixed header's size.
pub const HEADER_LEN: usize = 32;
/// One section-table entry's size.
pub const SECTION_ENTRY_LEN: usize = 16;
/// The highest section kind any format uses, plus one.
pub(crate) const MAX_KINDS: usize = 24;

/// One section-table entry, as stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SectionEntry {
    /// The section kind (per format).
    pub kind: u32,
    /// Byte offset from the file start.
    pub offset: u32,
    /// Byte length (a multiple of 4).
    pub length: u32,
    /// Element count (meaning per section).
    pub count: u32,
}

/// How a section's length follows from its count.
#[derive(Clone, Copy)]
pub(crate) enum Layout {
    /// `count` records of `stride` bytes: `length == align4(count * stride)`.
    Records(usize),
    /// Variable content; the format checks it (string tables).
    Custom,
}

pub(crate) struct SectionSpec {
    pub kind: u32,
    pub name: &'static str,
    pub align: usize,
    pub layout: Layout,
    pub required: bool,
}

pub(crate) struct FormatSpec {
    pub magic: [u8; 8],
    pub version: u32,
    pub known_flags: u32,
    pub sections: &'static [SectionSpec],
}

impl FormatSpec {
    fn spec(&self, kind: u32) -> Option<&'static SectionSpec> {
        self.sections.iter().find(|s| s.kind == kind)
    }
}

/// One located section.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Section<'a> {
    pub entry: SectionEntry,
    /// Exactly `count * stride` bytes for record sections (padding excluded); the whole length
    /// for custom ones.
    pub data: &'a [u8],
}

/// A parsed header and section table.
#[derive(Clone, Copy)]
pub(crate) struct Container<'a> {
    pub flags: u32,
    pub sections: [Option<Section<'a>>; MAX_KINDS],
}

impl<'a> Container<'a> {
    pub(crate) fn get(&self, kind: u32) -> Option<Section<'a>> {
        self.sections.get(kind as usize).copied().flatten()
    }
    pub(crate) fn entry(&self, kind: u32) -> Option<SectionEntry> {
        self.get(kind).map(|s| s.entry)
    }
    /// The section's data, or an empty slice when absent.
    pub(crate) fn data(&self, kind: u32) -> &'a [u8] {
        self.get(kind).map_or(&[], |s| s.data)
    }
    /// The section's count, or 0 when absent.
    pub(crate) fn count(&self, kind: u32) -> usize {
        self.get(kind).map_or(0, |s| s.entry.count as usize)
    }
    pub(crate) fn entries(&self) -> impl Iterator<Item = SectionEntry> + '_ {
        self.sections.iter().flatten().map(|s| s.entry)
    }
}

pub(crate) fn parse<'a>(spec: &FormatSpec, b: &'a [u8]) -> Result<Container<'a>> {
    if b.len() < HEADER_LEN {
        return Err(FormatError::Truncated {
            needed: HEADER_LEN,
            have: b.len(),
        });
    }
    if b[0..8] != spec.magic {
        return Err(FormatError::BadMagic {
            expected: spec.magic,
        });
    }
    let version = u32_at(b, 8);
    if version != spec.version {
        return Err(FormatError::UnsupportedVersion {
            found: version,
            expected: spec.version,
        });
    }
    let flags = u32_at(b, 12);
    if flags & !spec.known_flags != 0 {
        return Err(FormatError::UnknownFlags { flags });
    }
    let file_len = u32_at(b, 16);
    if file_len as usize != b.len() {
        return Err(FormatError::LengthMismatch {
            header: file_len,
            actual: b.len(),
        });
    }
    if u32_at(b, 24) != 0 || u32_at(b, 28) != 0 {
        return Err(FormatError::NonZeroReserved { what: "header" });
    }
    let count = u32_at(b, 20) as usize;
    let table_end = count
        .checked_mul(SECTION_ENTRY_LEN)
        .and_then(|n| n.checked_add(HEADER_LEN))
        .filter(|&n| n <= b.len())
        .ok_or(FormatError::Truncated {
            needed: HEADER_LEN.saturating_add(count.saturating_mul(SECTION_ENTRY_LEN)),
            have: b.len(),
        })?;
    let mut sections: [Option<Section<'a>>; MAX_KINDS] = [None; MAX_KINDS];
    let mut prev_end = table_end;
    for i in 0..count {
        let at = HEADER_LEN + i * SECTION_ENTRY_LEN;
        let entry = SectionEntry {
            kind: u32_at(b, at),
            offset: u32_at(b, at + 4),
            length: u32_at(b, at + 8),
            count: u32_at(b, at + 12),
        };
        let s = spec
            .spec(entry.kind)
            .ok_or(FormatError::UnknownSection { kind: entry.kind })?;
        let slot = sections
            .get_mut(entry.kind as usize)
            .ok_or(FormatError::UnknownSection { kind: entry.kind })?;
        if slot.is_some() {
            return Err(FormatError::DuplicateSection { kind: entry.kind });
        }
        let off = entry.offset as usize;
        let len = entry.length as usize;
        if !is_aligned(off, s.align) {
            return Err(FormatError::MisalignedSection {
                section: s.name,
                offset: entry.offset,
                align: s.align as u32,
            });
        }
        let end = off
            .checked_add(len)
            .filter(|&e| off >= table_end && e <= b.len())
            .ok_or(FormatError::SectionOutOfBounds {
                section: s.name,
                offset: entry.offset,
                length: entry.length,
            })?;
        if off < prev_end {
            return Err(FormatError::OverlappingSections { section: s.name });
        }
        prev_end = end;
        let whole = &b[off..end];
        let data = match s.layout {
            Layout::Records(stride) => {
                let used = (entry.count as u64) * stride as u64;
                let expected = align4(used as usize) as u64;
                if used > u32::MAX as u64 || len as u64 != expected {
                    return Err(FormatError::BadSectionLength {
                        section: s.name,
                        length: entry.length,
                        expected: (used + 3) & !3,
                    });
                }
                let (data, pad) = whole.split_at(used as usize);
                if pad.iter().any(|&p| p != 0) {
                    return Err(FormatError::NonZeroPadding { section: s.name });
                }
                data
            }
            Layout::Custom => {
                if !is_aligned(len, 4) {
                    return Err(FormatError::BadSectionLength {
                        section: s.name,
                        length: entry.length,
                        expected: align4(len) as u64,
                    });
                }
                whole
            }
        };
        *slot = Some(Section { entry, data });
    }
    for s in spec.sections {
        if s.required && sections[s.kind as usize].is_none() {
            return Err(FormatError::MissingSection { section: s.name });
        }
    }
    Ok(Container { flags, sections })
}

/// Builds a container: sections are added in kind order and laid out 16-byte aligned.
pub(crate) struct Writer {
    magic: [u8; 8],
    version: u32,
    flags: u32,
    sections: Vec<(u32, u32, Vec<u8>)>,
}

impl Writer {
    pub(crate) fn new(spec: &FormatSpec, flags: u32) -> Self {
        Writer {
            magic: spec.magic,
            version: spec.version,
            flags,
            sections: Vec::new(),
        }
    }
    /// Adds a section of `count` elements; `data` is padded to 4 bytes with zeros.
    pub(crate) fn section(&mut self, kind: u32, count: usize, mut data: Vec<u8>) -> Result<()> {
        let count = crate::bytes::to_u32("section count", count)?;
        data.resize(align4(data.len()), 0);
        self.sections.push((kind, count, data));
        Ok(())
    }
    pub(crate) fn finish(mut self) -> Result<Vec<u8>> {
        self.sections.sort_by_key(|s| s.0);
        let mut offset = align16(HEADER_LEN + self.sections.len() * SECTION_ENTRY_LEN);
        let mut table = Vec::with_capacity(self.sections.len());
        for (kind, count, data) in &self.sections {
            table.push((*kind, offset, data.len(), *count));
            offset = align16(offset + data.len());
        }
        let total = table.last().map_or(offset, |t| t.1 + t.2);
        let total_u32 = crate::bytes::to_u32("file", total)?;
        let mut o = Out::default();
        o.bytes(&self.magic);
        o.u32(self.version);
        o.u32(self.flags);
        o.u32(total_u32);
        o.u32(self.sections.len() as u32);
        o.u32(0);
        o.u32(0);
        for &(kind, off, len, count) in &table {
            o.u32(kind);
            o.u32(off as u32);
            o.u32(len as u32);
            o.u32(count);
        }
        for ((_, off, _, _), (_, _, data)) in table.iter().zip(&self.sections) {
            o.buf.resize(*off, 0);
            o.bytes(data);
        }
        debug_assert_eq!(o.buf.len(), total);
        Ok(o.buf)
    }
}

/// Iterates the fixed-stride records of a section's data.
pub(crate) fn records(data: &[u8], stride: usize) -> impl Iterator<Item = crate::bytes::Rd<'_>> {
    data.chunks_exact(stride).map(crate::bytes::Rd::new)
}

/// The record at `i`, or `None` past the end.
pub(crate) fn record(data: &[u8], stride: usize, i: usize) -> Option<crate::bytes::Rd<'_>> {
    let a = i.checked_mul(stride)?;
    data.get(a..a.checked_add(stride)?)
        .map(crate::bytes::Rd::new)
}
