//! Little-endian reads and writes, alignment helpers, and zero-copy views of `f32`/`u32` arrays.
//!
//! No `unsafe`: values are decoded with `from_le_bytes`, so a buffer needn't be aligned in host
//! memory for the Rust readers (TypeScript's typed-array views do need the file to start on a
//! 16-byte boundary; every section offset is aligned relative to the file start).

use crate::error::{FormatError, Result};

/// Rounds `n` up to a multiple of `align` (a power of two).
pub const fn align_up(n: usize, align: usize) -> usize {
    (n + align - 1) & !(align - 1)
}

/// Rounds `n` up to a multiple of 4.
pub const fn align4(n: usize) -> usize {
    align_up(n, 4)
}

/// Rounds `n` up to a multiple of 16.
pub const fn align16(n: usize) -> usize {
    align_up(n, 16)
}

/// Whether `n` is a multiple of `align` (a power of two).
pub const fn is_aligned(n: usize, align: usize) -> bool {
    n & (align - 1) == 0
}

/// A cursor over one fixed-stride record. The section was bounds-checked against
/// `count * stride`, so every read is in range; an out-of-range read would yield zero rather than
/// panic.
#[derive(Clone, Copy)]
pub(crate) struct Rd<'a> {
    b: &'a [u8],
    o: usize,
}

impl<'a> Rd<'a> {
    pub(crate) fn new(b: &'a [u8]) -> Self {
        Rd { b, o: 0 }
    }
    fn take<const N: usize>(&mut self) -> [u8; N] {
        let mut a = [0u8; N];
        if let Some(s) = self.b.get(self.o..self.o + N) {
            a.copy_from_slice(s);
        }
        self.o += N;
        a
    }
    pub(crate) fn u8(&mut self) -> u8 {
        self.take::<1>()[0]
    }
    pub(crate) fn u16(&mut self) -> u16 {
        u16::from_le_bytes(self.take())
    }
    pub(crate) fn u32(&mut self) -> u32 {
        u32::from_le_bytes(self.take())
    }
    pub(crate) fn f32(&mut self) -> f32 {
        f32::from_le_bytes(self.take())
    }
    pub(crate) fn f32s<const N: usize>(&mut self) -> [f32; N] {
        let mut a = [0f32; N];
        for v in &mut a {
            *v = self.f32();
        }
        a
    }
    pub(crate) fn u32s<const N: usize>(&mut self) -> [u32; N] {
        let mut a = [0u32; N];
        for v in &mut a {
            *v = self.u32();
        }
        a
    }
}

/// Reads the `u32` at byte `o` (zero past the end).
pub(crate) fn u32_at(b: &[u8], o: usize) -> u32 {
    let mut r = Rd::new(b);
    r.o = o;
    r.u32()
}

/// A growing little-endian buffer.
#[derive(Default)]
pub(crate) struct Out {
    pub(crate) buf: Vec<u8>,
}

impl Out {
    pub(crate) fn u8(&mut self, v: u8) {
        self.buf.push(v);
    }
    pub(crate) fn u16(&mut self, v: u16) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    pub(crate) fn u32(&mut self, v: u32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    pub(crate) fn f32(&mut self, v: f32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    pub(crate) fn f32s(&mut self, v: &[f32]) {
        for &x in v {
            self.f32(x);
        }
    }
    pub(crate) fn u32s(&mut self, v: &[u32]) {
        for &x in v {
            self.u32(x);
        }
    }
    pub(crate) fn bytes(&mut self, v: &[u8]) {
        self.buf.extend_from_slice(v);
    }
    pub(crate) fn pad_to(&mut self, align: usize) {
        self.buf.resize(align_up(self.buf.len(), align), 0);
    }
    pub(crate) fn finish(mut self) -> Vec<u8> {
        self.pad_to(4);
        self.buf
    }
}

/// A zero-copy view of a little-endian `f32` array inside a file.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct F32s<'a> {
    bytes: &'a [u8],
}

impl<'a> F32s<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Self {
        F32s {
            bytes: &bytes[..bytes.len() / 4 * 4],
        }
    }
    /// The number of values.
    pub fn len(&self) -> usize {
        self.bytes.len() / 4
    }
    /// Whether there are no values.
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
    /// The value at `i`, or `None` past the end.
    pub fn get(&self, i: usize) -> Option<f32> {
        let a = i.checked_mul(4)?;
        let s = self.bytes.get(a..a.checked_add(4)?)?;
        Some(f32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    /// The values `[start, start + len)` as a sub-view, or `None` if out of range.
    pub fn slice(&self, start: usize, len: usize) -> Option<F32s<'a>> {
        let a = start.checked_mul(4)?;
        let b = a.checked_add(len.checked_mul(4)?)?;
        Some(F32s {
            bytes: self.bytes.get(a..b)?,
        })
    }
    /// Copies the values into `out` (which must be exactly `len()` long), returning `false` (and
    /// copying nothing) on a length mismatch.
    pub fn copy_to(&self, out: &mut [f32]) -> bool {
        if out.len() != self.len() {
            return false;
        }
        for (o, c) in out.iter_mut().zip(self.bytes.as_chunks::<4>().0) {
            *o = f32::from_le_bytes(*c);
        }
        true
    }
    /// The values, decoded.
    pub fn iter(&self) -> impl Iterator<Item = f32> + 'a {
        self.bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| f32::from_le_bytes(*c))
    }
    /// The values as an owned vector.
    pub fn to_vec(&self) -> Vec<f32> {
        self.iter().collect()
    }
    /// The underlying little-endian bytes (for a bulk copy into wasm memory).
    pub fn bytes(&self) -> &'a [u8] {
        self.bytes
    }
}

/// A zero-copy view of a little-endian `u32` array inside a file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct U32s<'a> {
    bytes: &'a [u8],
}

impl<'a> U32s<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Self {
        U32s {
            bytes: &bytes[..bytes.len() / 4 * 4],
        }
    }
    /// The number of values.
    pub fn len(&self) -> usize {
        self.bytes.len() / 4
    }
    /// Whether there are no values.
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
    /// The value at `i`, or `None` past the end.
    pub fn get(&self, i: usize) -> Option<u32> {
        let a = i.checked_mul(4)?;
        let s = self.bytes.get(a..a.checked_add(4)?)?;
        Some(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    /// The values `[start, start + len)` as a sub-view, or `None` if out of range.
    pub fn slice(&self, start: usize, len: usize) -> Option<U32s<'a>> {
        let a = start.checked_mul(4)?;
        let b = a.checked_add(len.checked_mul(4)?)?;
        Some(U32s {
            bytes: self.bytes.get(a..b)?,
        })
    }
    /// The values, decoded.
    pub fn iter(&self) -> impl Iterator<Item = u32> + 'a {
        self.bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| u32::from_le_bytes(*c))
    }
    /// The values as an owned vector.
    pub fn to_vec(&self) -> Vec<u32> {
        self.iter().collect()
    }
    /// The underlying little-endian bytes.
    pub fn bytes(&self) -> &'a [u8] {
        self.bytes
    }
}

// ---------------------------------------------------------------------------------------------
// Validation helpers shared by the formats.
// ---------------------------------------------------------------------------------------------

/// `NONE` (`u32::MAX`): the "no index / no string" value of every `u32` reference field.
pub const NONE: u32 = u32::MAX;

pub(crate) fn check_index(what: &'static str, index: u32, len: usize) -> Result<()> {
    if (index as usize) < len {
        Ok(())
    } else {
        Err(FormatError::IndexOutOfRange {
            what,
            index,
            len: len_u32(len),
        })
    }
}

pub(crate) fn check_opt_index(what: &'static str, index: u32, len: usize) -> Result<()> {
    if index == NONE {
        Ok(())
    } else {
        check_index(what, index, len)
    }
}

pub(crate) fn check_range(what: &'static str, first: u32, count: u32, len: usize) -> Result<()> {
    match (first as u64).checked_add(count as u64) {
        Some(end) if end <= len as u64 => Ok(()),
        _ => Err(FormatError::RangeOutOfBounds {
            what,
            first,
            count,
            len: len_u32(len),
        }),
    }
}

pub(crate) fn check_finite(what: &'static str, v: f32) -> Result<()> {
    if v.is_finite() {
        Ok(())
    } else {
        Err(FormatError::BadFloat { what })
    }
}

pub(crate) fn check_all_finite(what: &'static str, v: &[f32]) -> Result<()> {
    v.iter().try_for_each(|&x| check_finite(what, x))
}

pub(crate) fn check_zero(what: &'static str, v: u32) -> Result<()> {
    if v == 0 {
        Ok(())
    } else {
        Err(FormatError::NonZeroReserved { what })
    }
}

pub(crate) fn len_u32(len: usize) -> u32 {
    u32::try_from(len).unwrap_or(u32::MAX)
}

/// `len` as a `u32` for a writer, or `TooLarge`.
pub(crate) fn to_u32(what: &'static str, len: usize) -> Result<u32> {
    u32::try_from(len).map_err(|_| FormatError::TooLarge { what })
}
