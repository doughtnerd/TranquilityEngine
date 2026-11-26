//! The record-definition mechanism, defined once for every family.
//!
//! A **record** is a fixed-stride row of little-endian scalars:
//!
//! | Bytes | Content |
//! |---|---|
//! | 0..2 | opcode (`u16`): the family id in the high byte, the record's kind in the low byte |
//! | 2..4 | the family's version (`u16`) |
//! | 4.. | the fields, in declaration order, each aligned to its own size |
//!
//! The stride is rounded up to 4 bytes, so records pack back to back in a buffer and every field
//! stays aligned. A reader refuses a record whose opcode or version isn't the one it was built
//! for ([`WireError`]); a family bumps its version whenever a record's layout changes.
//!
//! Records are declared with [`wire_record!`](crate::wire_record), which writes the Rust struct, its
//! encoder and decoder, and the [`RecordDesc`] the generator turns into TypeScript.

use alloc::vec::Vec;

/// The bytes of the header every record starts with (opcode, then version).
pub const HEADER_BYTES: u32 = 4;
/// The header's opcode offset.
pub const HEADER_OPCODE: u32 = 0;
/// The header's version offset.
pub const HEADER_VERSION: u32 = 2;
/// Every stride is a multiple of this.
pub const STRIDE_ALIGN: u32 = 4;

/// A field's scalar type. Little-endian on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scalar {
    U8,
    I8,
    U16,
    I16,
    U32,
    I32,
    F32,
}

impl Scalar {
    /// Its size in bytes (also its alignment).
    pub const fn size(self) -> u32 {
        match self {
            Scalar::U8 | Scalar::I8 => 1,
            Scalar::U16 | Scalar::I16 => 2,
            Scalar::U32 | Scalar::I32 | Scalar::F32 => 4,
        }
    }

    /// Its name in the generated TypeScript (`DataView` getter suffixes, lower case).
    pub const fn ts_name(self) -> &'static str {
        match self {
            Scalar::U8 => "u8",
            Scalar::I8 => "i8",
            Scalar::U16 => "u16",
            Scalar::I16 => "i16",
            Scalar::U32 => "u32",
            Scalar::I32 => "i32",
            Scalar::F32 => "f32",
        }
    }
}

/// A field value, as vectors carry it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Value {
    Int(i64),
    Float(f32),
}

/// A Rust type that can be a record field.
pub trait WireScalar: Copy {
    /// Its wire type.
    const SCALAR: Scalar;
    /// Writes `self` little-endian at `out[at..]`. The caller has checked the length.
    fn put(self, out: &mut [u8], at: usize);
    /// Reads a value little-endian from `bytes[at..]`. The caller has checked the length.
    fn get(bytes: &[u8], at: usize) -> Self;
    /// The value for a vector.
    fn value(self) -> Value;
}

macro_rules! scalar {
    ($ty:ty, $scalar:ident, $n:literal, $value:ident, $as:ty) => {
        impl WireScalar for $ty {
            const SCALAR: Scalar = Scalar::$scalar;
            #[inline]
            fn put(self, out: &mut [u8], at: usize) {
                out[at..at + $n].copy_from_slice(&self.to_le_bytes());
            }
            #[inline]
            fn get(bytes: &[u8], at: usize) -> Self {
                let mut b = [0u8; $n];
                b.copy_from_slice(&bytes[at..at + $n]);
                <$ty>::from_le_bytes(b)
            }
            fn value(self) -> Value {
                Value::$value(self as $as)
            }
        }
    };
}

scalar!(u8, U8, 1, Int, i64);
scalar!(i8, I8, 1, Int, i64);
scalar!(u16, U16, 2, Int, i64);
scalar!(i16, I16, 2, Int, i64);
scalar!(u32, U32, 4, Int, i64);
scalar!(i32, I32, 4, Int, i64);
scalar!(f32, F32, 4, Float, f32);

/// The opcode of record `kind` in family `family_id`.
pub const fn opcode(family_id: u8, kind: u8) -> u16 {
    ((family_id as u16) << 8) | kind as u16
}

/// The offset of field `index` in a record whose fields have `types`: after the header and the
/// fields before it, aligned to its own size.
pub const fn offset(types: &[Scalar], index: usize) -> u32 {
    let mut at = HEADER_BYTES;
    let mut i = 0;
    while i < index {
        at = align(at, types[i].size()) + types[i].size();
        i += 1;
    }
    align(at, types[index].size())
}

/// The stride of a record whose fields have `types`.
#[inline]
pub const fn stride(types: &[Scalar]) -> u32 {
    let mut at = HEADER_BYTES;
    let mut i = 0;
    while i < types.len() {
        at = align(at, types[i].size()) + types[i].size();
        i += 1;
    }
    align(at, STRIDE_ALIGN)
}

#[inline]
const fn align(at: u32, to: u32) -> u32 {
    at.div_ceil(to) * to
}

/// Why a record couldn't be read or written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WireError {
    /// The buffer is shorter than the record's stride.
    Short { needed: u32, got: usize },
    /// The header names another record.
    Opcode { expected: u16, got: u16 },
    /// The header names another version of the family.
    Version { expected: u16, got: u16 },
}

/// One record's layout, for the generator and for tests.
#[derive(Clone, Copy, Debug)]
pub struct RecordDesc {
    /// The Rust struct's name (`MemoryNeeded`); TypeScript uses it in SCREAMING_SNAKE_CASE.
    pub name: &'static str,
    /// Its doc comment.
    pub doc: &'static str,
    pub opcode: u16,
    /// The family's version, written in every header.
    pub version: u16,
    pub stride: u32,
    /// The fields' names (snake_case; TypeScript uses camelCase), docs and types, in order.
    pub fields: &'static [&'static str],
    pub docs: &'static [&'static str],
    pub types: &'static [Scalar],
}

impl RecordDesc {
    /// The offset of field `index`.
    pub const fn offset(&self, index: usize) -> u32 {
        offset(self.types, index)
    }
}

/// A record declared with [`wire_record!`](crate::wire_record).
pub trait WireRecord: Sized {
    /// Its layout.
    const DESC: RecordDesc;

    /// Writes the record at the start of `out`.
    fn encode_into(&self, out: &mut [u8]) -> Result<(), WireError>;

    /// Reads the record at the start of `bytes`, checking the header.
    fn decode(bytes: &[u8]) -> Result<Self, WireError>;

    /// The fields' values in declaration order (for vectors; allocates).
    fn values(&self) -> Vec<(&'static str, Value)>;

    /// The record's bytes (allocates).
    fn encode(&self) -> Vec<u8> {
        let mut out = alloc::vec![0u8; Self::DESC.stride as usize];
        // The buffer is exactly one stride long, so this can't fail.
        let _ = self.encode_into(&mut out);
        out
    }
}

/// Checks a record's header and length before reading it.
///
/// `#[inline]` (ADR 0420 spike): called from every record's decoder in other crates; outlined, it
/// takes `&DESC`, which keeps every record's descriptor (names and field docs, ~25 KB) in the module.
#[inline]
pub fn check_header(desc: &RecordDesc, bytes: &[u8]) -> Result<(), WireError> {
    if bytes.len() < desc.stride as usize {
        return Err(WireError::Short {
            needed: desc.stride,
            got: bytes.len(),
        });
    }
    let opcode = u16::get(bytes, HEADER_OPCODE as usize);
    if opcode != desc.opcode {
        return Err(WireError::Opcode {
            expected: desc.opcode,
            got: opcode,
        });
    }
    let version = u16::get(bytes, HEADER_VERSION as usize);
    if version != desc.version {
        return Err(WireError::Version {
            expected: desc.version,
            got: version,
        });
    }
    Ok(())
}

/// Writes a record's header after checking the buffer's length. `#[inline]`, as [`check_header`].
#[inline]
pub fn put_header(desc: &RecordDesc, out: &mut [u8]) -> Result<(), WireError> {
    if out.len() < desc.stride as usize {
        return Err(WireError::Short {
            needed: desc.stride,
            got: out.len(),
        });
    }
    out[..desc.stride as usize].fill(0);
    desc.opcode.put(out, HEADER_OPCODE as usize);
    desc.version.put(out, HEADER_VERSION as usize);
    Ok(())
}

/// Declares a wire record: a struct of scalar fields, its [`WireRecord`] implementation and its
/// layout.
///
/// ```
/// use myco_wire::wire_record;
/// const ID: u8 = 0x7f;
/// const VERSION: u16 = 1;
/// wire_record! {
///     /// An example.
///     pub struct Example: family(ID, VERSION), kind(1) {
///         /// A count.
///         count: u32,
///         /// A weight.
///         weight: f32,
///     }
/// }
/// assert_eq!(<Example as myco_wire::WireRecord>::DESC.stride, 12);
/// ```
#[macro_export]
macro_rules! wire_record {
    (
        $(#[doc = $doc:literal])*
        $vis:vis struct $name:ident : family($fid:expr, $fver:expr), kind($kind:expr) {
            $( $(#[doc = $fdoc:literal])* $field:ident : $ty:ty ),* $(,)?
        }
    ) => {
        $(#[doc = $doc])*
        #[derive(Clone, Copy, Debug, Default, PartialEq)]
        $vis struct $name {
            $( $(#[doc = $fdoc])* pub $field: $ty, )*
        }

        impl $name {
            const TYPES: &'static [$crate::Scalar] = &[$(<$ty as $crate::WireScalar>::SCALAR),*];
            /// The record's opcode.
            pub const OPCODE: u16 = $crate::opcode($fid, $kind);
            /// The record's stride in bytes.
            pub const STRIDE: u32 = $crate::record::stride(Self::TYPES);
        }

        impl $crate::WireRecord for $name {
            const DESC: $crate::RecordDesc = $crate::RecordDesc {
                name: stringify!($name),
                doc: concat!($($doc, "\n"),*),
                opcode: $crate::opcode($fid, $kind),
                version: $fver,
                stride: $crate::record::stride(Self::TYPES),
                fields: &[$(stringify!($field)),*],
                docs: &[$(concat!($($fdoc, "\n"),*)),*],
                types: Self::TYPES,
            };

            #[allow(unused_assignments, unused_mut, unused_variables)]
            fn encode_into(&self, out: &mut [u8]) -> ::core::result::Result<(), $crate::WireError> {
                $crate::record::put_header(&Self::DESC, out)?;
                let mut i = 0usize;
                $(
                    $crate::WireScalar::put(self.$field, out, $crate::record::offset(Self::TYPES, i) as usize);
                    i += 1;
                )*
                Ok(())
            }

            #[allow(unused_assignments, unused_mut, unused_variables)]
            fn decode(bytes: &[u8]) -> ::core::result::Result<Self, $crate::WireError> {
                $crate::record::check_header(&Self::DESC, bytes)?;
                let mut i = 0usize;
                $(
                    let $field = <$ty as $crate::WireScalar>::get(bytes, $crate::record::offset(Self::TYPES, i) as usize);
                    i += 1;
                )*
                Ok(Self { $($field),* })
            }

            fn values(&self) -> $crate::__alloc::vec::Vec<(&'static str, $crate::Value)> {
                $crate::__alloc::vec![$((stringify!($field), $crate::WireScalar::value(self.$field))),*]
            }
        }
    };
}

/// A named constant of a family (a status code, an enum value), emitted into its TypeScript.
#[derive(Clone, Copy, Debug)]
pub struct Const {
    /// SCREAMING_SNAKE_CASE, unique within its family.
    pub name: &'static str,
    pub value: u32,
    pub doc: &'static str,
}

/// One wire family: its records, constants and test vectors. Every family module defines one
/// `FAMILY`, listed once in its core's family table (`anim_wire::FAMILIES`).
#[derive(Clone, Copy, Debug)]
pub struct FamilyDesc {
    /// The family's name: its module, its TypeScript file (`wire/<name>.ts`) and its vector file.
    pub name: &'static str,
    /// The high byte of its records' opcodes. Unique; never reused.
    pub id: u8,
    /// Written in every record's header. Bump it when any record's layout changes.
    pub version: u16,
    /// One paragraph for the generated file's header.
    pub doc: &'static str,
    pub records: &'static [RecordDesc],
    pub consts: &'static [Const],
    /// The family's byte vectors (the round-trip tests' cases).
    pub vectors: fn() -> Vec<crate::Vector>,
}
