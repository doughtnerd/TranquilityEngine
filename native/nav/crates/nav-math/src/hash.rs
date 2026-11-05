//! Foxfire's `NavHash` and the hashing in `NavMeshFingerprint`: xxHash3-64 over raw bytes, chained
//! through a seed (the length first, then the contents), plus Unity's `Hash128`.
//!
//! # Compatibility with Unity's `xxHash3`
//! `NavHash.Bytes` calls `xxHash3.Hash64(ptr, len, seed)` and joins the returned `uint2` as
//! `(y << 32) | x`, i.e. `x` is the low word. Unity's `xxHash3` is a port of the reference
//! implementation (`XXH3_64bits_withSeed`) and returns the same 64-bit digest, so
//! [`hash_bytes`] is `xxh3_64_with_seed`. The Unity source is not in this checkout (the packages
//! only hold type forwarders), so this was not diffed against it: it rests on Unity's port being
//! the reference algorithm. The tests check the reference vector for the empty input
//! (`XXH3_64bits("") = 0x2D06800538D394C2`) and the chaining structure.
//!
//! Foxfire's baked data hashes raw bytes, so structs with padding hash their padding. Myco's
//! layouts have none (`repr(C)`, no padding), which [`Pod`] requires.
use crate::vec::{Double2, Double3, Float2, Float3, Float4, Int2, Int3, Int4};
use core::fmt;
use xxhash_rust::xxh3::{xxh3_128, xxh3_64_with_seed};

/// The seed every fingerprint chain starts from (`0x5EED`).
pub const FINGERPRINT_SEED: u64 = 0x5EED;
/// Seed Foxfire's chunk-id hash starts from (`0xC4C4`).
pub const CHUNK_SEED: u64 = 0xC4C4;
/// Seed of the chunk id's second half (`0x5EC7`).
pub const CHUNK_SEED_HI: u64 = 0x5EC7;

/// Plain old data: every bit pattern is valid, there are no pointers, and the type has **no
/// padding bytes** (so viewing it as bytes reads only initialised memory).
///
/// # Safety
/// Implement only for `#[repr(C)]` (or primitive) types made entirely of other `Pod` fields laid
/// out with no padding.
pub unsafe trait Pod: Copy + 'static {}

macro_rules! pod { ($($t:ty),+) => { $(unsafe impl Pod for $t {})+ }; }
pod!(u8, u16, u32, u64, i8, i16, i32, i64, f32, f64);
pod!(Float2, Float3, Float4, Double2, Double3, Int2, Int3, Int4);
// SAFETY: arrays of Pod have no padding between elements.
unsafe impl<T: Pod, const N: usize> Pod for [T; N] {}

/// The bytes of a slice of plain values (little-endian on every Myco target).
#[inline]
pub fn as_bytes<T: Pod>(slice: &[T]) -> &[u8] {
    // SAFETY: T is Pod (initialised, no padding), the pointer and length come from a valid slice,
    // u8 has alignment 1, and the byte length is exactly size_of_val.
    unsafe { core::slice::from_raw_parts(slice.as_ptr() as *const u8, core::mem::size_of_val(slice)) }
}

/// `NavHash.Bytes`: xxHash3-64 of the bytes with the seed.
#[inline]
pub fn hash_bytes(data: &[u8], seed: u64) -> u64 {
    xxh3_64_with_seed(data, seed)
}

/// `NavHash.Value`: the value's bytes.
#[inline]
pub fn hash_value<T: Pod>(value: T, seed: u64) -> u64 {
    hash_bytes(as_bytes(core::slice::from_ref(&value)), seed)
}

/// `NavHash.Buffer`: the contents only (no length).
#[inline]
pub fn hash_buffer<T: Pod>(items: &[T], seed: u64) -> u64 {
    hash_bytes(as_bytes(items), seed)
}

/// `NavHash.Array`: the length (as an `i32`) then the contents, so arrays that differ only in how
/// bytes split between them differ. An empty array hashes the length alone.
pub fn hash_array<T: Pod>(items: &[T], seed: u64) -> u64 {
    let seed = hash_value(items.len() as i32, seed);
    if items.is_empty() {
        seed
    } else {
        hash_bytes(as_bytes(items), seed)
    }
}

/// Chains values and arrays the way `NavMeshFingerprint.Hash` does, starting from `0x5EED`.
/// The blob-specific orderings (which arrays, which optional sections) live with the blob types.
#[derive(Clone, Copy, Debug)]
pub struct FingerprintHasher {
    seed: u64,
}

impl Default for FingerprintHasher {
    fn default() -> Self {
        Self::new()
    }
}

impl FingerprintHasher {
    pub fn new() -> Self {
        Self { seed: FINGERPRINT_SEED }
    }
    pub fn with_seed(seed: u64) -> Self {
        Self { seed }
    }
    pub fn value<T: Pod>(&mut self, v: T) -> &mut Self {
        self.seed = hash_value(v, self.seed);
        self
    }
    pub fn array<T: Pod>(&mut self, items: &[T]) -> &mut Self {
        self.seed = hash_array(items, self.seed);
        self
    }
    pub fn buffer<T: Pod>(&mut self, items: &[T]) -> &mut Self {
        self.seed = hash_buffer(items, self.seed);
        self
    }
    pub fn finish(&self) -> u64 {
        self.seed
    }
}

/// `NavMeshFingerprint.AppendHex`: 16 upper-case hex digits, most significant first.
pub fn fingerprint_hex(value: u64) -> String {
    format!("{value:016X}")
}

/// `Unity.Entities.Hash128`: four `u32` words (`Value.x..w`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Hash128 {
    pub x: u32,
    pub y: u32,
    pub z: u32,
    pub w: u32,
}
// SAFETY: four u32 fields, repr(C), no padding.
unsafe impl Pod for Hash128 {}

impl Hash128 {
    pub const fn new(x: u32, y: u32, z: u32, w: u32) -> Self {
        Self { x, y, z, w }
    }
    pub fn is_valid(self) -> bool {
        self != Self::default()
    }
    pub fn to_array(self) -> [u32; 4] {
        [self.x, self.y, self.z, self.w]
    }
    pub fn from_array(a: [u32; 4]) -> Self {
        Self::new(a[0], a[1], a[2], a[3])
    }

    /// Two 64-bit hashes as Foxfire builds a chunk id: `(uint)h0, (uint)(h0 >> 32), (uint)h1,
    /// (uint)(h1 >> 32)`.
    pub const fn from_u64_pair(h0: u64, h1: u64) -> Self {
        Self::new(h0 as u32, (h0 >> 32) as u32, h1 as u32, (h1 >> 32) as u32)
    }

    /// Foxfire's chunk id (`NavBakeOutputSystem.OutputContext`), from the hash `h0` of the chunk's
    /// scene and node: `h1 = hash(h0, 0x5EC7)`. The caller builds `h0` by chaining
    /// `hash_value(.., CHUNK_SEED)` over the scene identity, then the chunk key.
    pub fn from_chunk_hash(h0: u64) -> Self {
        Self::from_u64_pair(h0, hash_value(h0, CHUNK_SEED_HI))
    }

    /// The 128-bit XXH3 digest of the bytes as a `Hash128` (low half in `x, y`, high half in
    /// `z, w`). Foxfire's chunk ids don't use it (see [`Hash128::from_chunk_hash`]); it is for
    /// Myco code that wants a content id. The word split assumes Unity's `xxHash3.Hash128`
    /// returns `uint4(low.lo, low.hi, high.lo, high.hi)`, unverified.
    pub fn of_bytes(data: &[u8]) -> Self {
        let h = xxh3_128(data);
        Self::from_u64_pair(h as u64, (h >> 64) as u64)
    }

    /// 32 lower-case hex digits, `x` first, each word as 8 digits (most significant first).
    pub fn to_hex(self) -> String {
        format!("{:08x}{:08x}{:08x}{:08x}", self.x, self.y, self.z, self.w)
    }

    /// Parses [`Hash128::to_hex`] output (32 hex digits, either case).
    pub fn from_hex(s: &str) -> Option<Self> {
        if s.len() != 32 || !s.is_ascii() {
            return None;
        }
        let w = |i: usize| u32::from_str_radix(&s[i * 8..i * 8 + 8], 16).ok();
        Some(Self::new(w(0)?, w(1)?, w(2)?, w(3)?))
    }
}

impl fmt::Display for Hash128 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xxh3_reference_vector_empty() {
        // XXH3_64bits("") from the xxHash reference implementation (seed 0).
        assert_eq!(hash_bytes(&[], 0), 0x2D06800538D394C2);
    }

    #[test]
    fn seed_and_length_sensitivity() {
        let data: Vec<u8> = (1..=20).collect();
        let mut seen = std::collections::HashSet::new();
        for len in [0usize, 1, 3, 4, 8, 9, 16, 17, 20] {
            for seed in [0u64, 0x5EED] {
                assert_eq!(hash_bytes(&data[..len], seed), hash_bytes(&data[..len], seed));
                assert!(seen.insert((len, seed, hash_bytes(&data[..len], seed))));
            }
        }
        let long: Vec<u8> = (0..5000u32).map(|i| (i * 31 + 7) as u8).collect();
        assert_ne!(hash_bytes(&long, 0), hash_bytes(&long, 1));
        assert_ne!(hash_bytes(&long, 0), hash_bytes(&long[..4999], 0));
    }

    #[test]
    fn pod_bytes_are_little_endian_raw() {
        assert_eq!(as_bytes(&[1u32, 2]), &[1, 0, 0, 0, 2, 0, 0, 0]);
        assert_eq!(as_bytes(&[Float3::new(1.0, 0.0, 0.0)]), &[0, 0, 0x80, 0x3F, 0, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(as_bytes::<Int4>(&[]).len(), 0);
        assert_eq!(as_bytes(&[Hash128::new(1, 2, 3, 4)]).len(), 16);
    }

    #[test]
    fn value_and_array_chain_like_nav_hash() {
        let items = [Float3::new(1.0, 2.0, 3.0), Float3::new(4.0, 5.0, 6.0)];
        let expect = hash_bytes(as_bytes(&items), hash_bytes(&2i32.to_le_bytes(), 0x5EED));
        assert_eq!(hash_array(&items, 0x5EED), expect);
        assert_eq!(hash_array::<Float3>(&[], 0x5EED), hash_bytes(&0i32.to_le_bytes(), 0x5EED));
        assert_eq!(hash_value(7u64, 1), hash_bytes(&7u64.to_le_bytes(), 1));
        assert_eq!(hash_buffer(&items, 3), hash_bytes(as_bytes(&items), 3));
    }

    #[test]
    fn arrays_are_order_and_split_sensitive() {
        let a = [1i32, 2, 3];
        let b = [3i32, 2, 1];
        assert_ne!(hash_array(&a, 0x5EED), hash_array(&b, 0x5EED));
        let split1 = hash_array(&[1i32, 2][..], hash_array(&[3i32][..], 0x5EED));
        let split2 = hash_array(&[1i32][..], hash_array(&[2i32, 3][..], 0x5EED));
        assert_ne!(split1, split2);
        let x = FingerprintHasher::new().array(&a).array(&b).finish();
        let y = FingerprintHasher::new().array(&b).array(&a).finish();
        assert_ne!(x, y);
        assert_eq!(x, hash_array(&b, hash_array(&a, 0x5EED)));
        assert_ne!(FingerprintHasher::new().array::<i32>(&[]).finish(), FINGERPRINT_SEED);
    }

    #[test]
    fn fingerprint_hex_format() {
        assert_eq!(fingerprint_hex(0xABC), "0000000000000ABC");
        assert_eq!(fingerprint_hex(u64::MAX), "FFFFFFFFFFFFFFFF");
    }

    #[test]
    fn hash128_hex_round_trip() {
        let h = Hash128::new(0x0123_4567, 0x89AB_CDEF, 0xDEAD_BEEF, 1);
        assert_eq!(h.to_hex(), "0123456789abcdefdeadbeef00000001");
        assert_eq!(Hash128::from_hex(&h.to_hex()), Some(h));
        assert_eq!(Hash128::from_hex("0123456789ABCDEFDEADBEEF00000001"), Some(h));
        assert_eq!(Hash128::from_hex("zz"), None);
        assert_eq!(Hash128::from_hex(&"g".repeat(32)), None);
        assert_eq!(format!("{h}"), h.to_hex());
        assert!(!Hash128::default().is_valid());
        let r = Hash128::of_bytes(b"chunk");
        assert_eq!(Hash128::from_hex(&r.to_hex()), Some(r));
    }

    #[test]
    fn chunk_id_construction() {
        let h0 = 0x1122_3344_5566_7788u64;
        let id = Hash128::from_chunk_hash(h0);
        assert_eq!((id.x, id.y), (0x5566_7788, 0x1122_3344));
        let h1 = hash_value(h0, 0x5EC7);
        assert_eq!((id.z, id.w), (h1 as u32, (h1 >> 32) as u32));
        assert_ne!(id, Hash128::from_chunk_hash(h0 + 1));
        let scene = Hash128::new(1, 2, 3, 4);
        let mut h = hash_value(scene, CHUNK_SEED);
        h = hash_value(Int2::new(0, 0), h);
        h = hash_value(Hash128::new(9, 9, 9, 9), h);
        assert_ne!(Hash128::from_chunk_hash(h), id);
    }
}
