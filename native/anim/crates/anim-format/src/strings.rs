//! The string table every format carries (section kind 1 in each).
//!
//! ```text
//! entry count = n (strings)
//!    0       u32 x (n + 1)  end offsets: offsets[0] = 0, offsets[i + 1] = end of string i, in bytes
//!                           from the start of the character data; non-decreasing
//!    4(n+1)  u8 x offsets[n] UTF-8 character data, then zero padding to 4
//! length = align4(4(n + 1) + offsets[n])
//! ```
//!
//! A string id is the string's index; [`NONE`](crate::NONE) means "no string". Every string is
//! checked to be UTF-8 when the file is parsed.

use std::collections::HashMap;

use crate::bytes::{align4, u32_at, Out};
use crate::error::{FormatError, Result};

/// A zero-copy view of a parsed string table.
#[derive(Clone, Copy, Debug)]
pub struct StringTable<'a> {
    count: usize,
    offsets: &'a [u8],
    data: &'a [u8],
}

impl<'a> StringTable<'a> {
    /// The number of strings.
    pub fn len(&self) -> usize {
        self.count
    }
    /// Whether the table is empty.
    pub fn is_empty(&self) -> bool {
        self.count == 0
    }
    /// The string with id `id`, or `None` for [`NONE`](crate::NONE) or an id past the end.
    pub fn get(&self, id: u32) -> Option<&'a str> {
        let i = id as usize;
        if i >= self.count {
            return None;
        }
        let a = u32_at(self.offsets, i * 4) as usize;
        let b = u32_at(self.offsets, i * 4 + 4) as usize;
        // Validated at parse time, so this never fails; a failure would read as "no string".
        core::str::from_utf8(self.data.get(a..b)?).ok()
    }
    /// Every string, in id order.
    pub fn iter(&self) -> impl Iterator<Item = &'a str> + '_ {
        (0..self.count as u32).map(|i| self.get(i).unwrap_or(""))
    }
    /// The strings as owned values.
    pub fn to_vec(&self) -> Vec<String> {
        self.iter().map(str::to_owned).collect()
    }

    pub(crate) fn parse(count: u32, b: &'a [u8]) -> Result<Self> {
        let n = count as usize;
        let head = n
            .checked_add(1)
            .and_then(|m| m.checked_mul(4))
            .filter(|&h| h <= b.len())
            .ok_or(FormatError::BadCount {
                what: "string table entries",
                count: count as u64,
                expected: (b.len() / 4).saturating_sub(1) as u64,
            })?;
        let (offsets, rest) = b.split_at(head);
        let total = u32_at(offsets, n * 4) as usize;
        if u32_at(offsets, 0) != 0 || total > rest.len() || align4(head + total) != b.len() {
            return Err(FormatError::BadString { index: 0 });
        }
        if rest[total..].iter().any(|&p| p != 0) {
            return Err(FormatError::NonZeroPadding { section: "strings" });
        }
        let data = &rest[..total];
        let mut prev = 0usize;
        for i in 0..n {
            let end = u32_at(offsets, i * 4 + 4) as usize;
            if end < prev || end > total || core::str::from_utf8(&data[prev..end]).is_err() {
                return Err(FormatError::BadString { index: i as u32 });
            }
            prev = end;
        }
        Ok(StringTable {
            count: n,
            offsets,
            data,
        })
    }

    /// Checks `id` is `NONE` or a string in this table.
    pub(crate) fn check(&self, what: &'static str, id: u32) -> Result<()> {
        crate::bytes::check_opt_index(what, id, self.count)
    }
}

pub(crate) fn write(strings: &[String]) -> Result<Vec<u8>> {
    let mut o = Out::default();
    let mut end = 0u32;
    o.u32(0);
    for s in strings {
        end = end
            .checked_add(crate::bytes::to_u32("string", s.len())?)
            .ok_or(FormatError::TooLarge {
                what: "string table",
            })?;
        o.u32(end);
    }
    for s in strings {
        o.bytes(s.as_bytes());
    }
    Ok(o.finish())
}

/// Collects strings for a writer, giving each distinct string one id.
#[derive(Clone, Debug, Default)]
pub struct StringInterner {
    strings: Vec<String>,
    ids: HashMap<String, u32>,
}

impl StringInterner {
    /// An empty interner.
    pub fn new() -> Self {
        Self::default()
    }
    /// The id of `s`, adding it if new.
    pub fn intern(&mut self, s: &str) -> u32 {
        if let Some(&id) = self.ids.get(s) {
            return id;
        }
        let id = self.strings.len() as u32;
        self.strings.push(s.to_owned());
        self.ids.insert(s.to_owned(), id);
        id
    }
    /// The strings, in id order (what a model's `strings` field takes).
    pub fn into_strings(self) -> Vec<String> {
        self.strings
    }
}
