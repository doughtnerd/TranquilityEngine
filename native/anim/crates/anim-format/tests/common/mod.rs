//! Shared test helpers: a seeded generator for arbitrary small inputs and container-level
//! corruption checks that apply to every format.
#![allow(dead_code)]

use anim_format::container::{HEADER_LEN, SECTION_ENTRY_LEN};

/// xorshift64*: deterministic, seedable.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    /// In `[0, n)` (n > 0).
    pub fn below(&mut self, n: u32) -> u32 {
        (self.next() % n as u64) as u32
    }
    /// In `[lo, hi]`.
    pub fn range(&mut self, lo: u32, hi: u32) -> u32 {
        lo + self.below(hi - lo + 1)
    }
    pub fn bool(&mut self) -> bool {
        self.next() & 1 == 1
    }
    /// In `[lo, hi)`.
    pub fn f32(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (self.next() >> 40) as f32 / (1u64 << 24) as f32 * (hi - lo)
    }
    pub fn pick<T: Copy>(&mut self, v: &[T]) -> T {
        v[self.below(v.len() as u32) as usize]
    }
    /// A string id in `[0, n)` or NONE.
    pub fn opt_id(&mut self, n: usize) -> u32 {
        if n == 0 || self.below(4) == 0 {
            anim_format::NONE
        } else {
            self.below(n as u32)
        }
    }
}

pub fn strings(rng: &mut Rng, min: u32) -> Vec<String> {
    let n = rng.range(min, min + 6);
    (0..n)
        .map(|i| format!("s{i}_{}", "é".repeat(rng.below(3) as usize)))
        .collect()
}

pub fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}

pub fn set_u32(b: &mut [u8], o: usize, v: u32) {
    b[o..o + 4].copy_from_slice(&v.to_le_bytes());
}

/// (entry offset in the table, kind, offset, length, count) of every section.
pub fn entries(b: &[u8]) -> Vec<(usize, u32, u32, u32, u32)> {
    (0..u32_at(b, 20) as usize)
        .map(|i| {
            let at = HEADER_LEN + i * SECTION_ENTRY_LEN;
            (
                at,
                u32_at(b, at),
                u32_at(b, at + 4),
                u32_at(b, at + 8),
                u32_at(b, at + 12),
            )
        })
        .collect()
}

/// Checks the container invariants of a writer's output.
pub fn check_layout(b: &[u8]) {
    assert_eq!(u32_at(b, 16) as usize, b.len());
    let mut prev = 0;
    for (_, _, off, len, _) in entries(b) {
        assert_eq!(off % 16, 0, "writers align every section to 16");
        assert_eq!(len % 4, 0);
        assert!(off >= prev);
        prev = off + len;
    }
}

/// Every container-level corruption must be refused, and no corruption may panic.
pub fn check_refusals<T>(
    valid: &[u8],
    parse: impl Fn(&[u8]) -> Result<T, anim_format::FormatError>,
    rng: &mut Rng,
) {
    assert!(parse(valid).is_ok());
    // Every truncation.
    for len in 0..valid.len() {
        assert!(parse(&valid[..len]).is_err(), "truncated to {len} accepted");
    }
    // A trailing byte (the header length no longer matches).
    let mut longer = valid.to_vec();
    longer.extend_from_slice(&[0; 4]);
    assert!(parse(&longer).is_err());
    // Header fields.
    for (at, v) in [
        (0usize, 0x5858_5858u32),
        (8, 2),
        (12, 0x8000_0000),
        (16, valid.len() as u32 + 4),
        (20, 1000),
        (24, 1),
        (28, 1),
    ] {
        let mut b = valid.to_vec();
        set_u32(&mut b, at, v);
        assert!(parse(&b).is_err(), "header field {at} = {v} accepted");
    }
    // Every section bound.
    let es = entries(valid);
    for &(at, kind, off, len, count) in &es {
        let tweaks: [(usize, u32); 7] = [
            (at, 200),                        // unknown kind
            (at + 4, valid.len() as u32), // starts at the end with a non-zero length, or past it
            (at + 4, off + 1),            // misaligned
            (at + 4, u32::MAX - 3),       // offset overflow
            (at + 8, len + 4),            // length mismatch / past the end
            (at + 8, u32::MAX - 3),       // length overflow
            (at + 12, count.wrapping_add(1)), // count disagrees with the length or content
        ];
        for (field, v) in tweaks {
            if field == at + 4 && v == valid.len() as u32 && len == 0 {
                continue; // an empty section at the end is in bounds
            }
            let mut b = valid.to_vec();
            set_u32(&mut b, field, v);
            assert!(
                parse(&b).is_err(),
                "section {kind}: field {} = {v} accepted",
                field - at
            );
        }
        // Duplicate kind.
        if es.len() > 1 {
            let other = es.iter().find(|e| e.1 != kind).unwrap();
            let mut b = valid.to_vec();
            set_u32(&mut b, other.0, kind);
            assert!(parse(&b).is_err(), "duplicate section {kind} accepted");
        }
    }
    // Random corruption: never a panic.
    for _ in 0..2000 {
        let mut b = valid.to_vec();
        for _ in 0..rng.range(1, 4) {
            let i = rng.below(b.len() as u32) as usize;
            b[i] ^= 1 << rng.below(8);
        }
        let _ = parse(&b);
    }
}
