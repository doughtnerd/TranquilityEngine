//! Schema description types (task A0.2, contract K1). Pure data, no logic beyond `const` builders.
//!
//! The transcription files `schema/envelope.rs`, `schema/batch.rs` and `schema/status.rs` fill
//! tables of these types from ADR 0157 section 4 (`docs/design/0157-audio-core/api-and-models.md`).
//! The generator (`gen/`) turns the tables into Rust readers and writers and `wire.generated.ts`.
//! A change to this file changes the schema hash, like a change to any `schema*` file.

/// A primitive wire type. Everything is little-endian (WebAssembly and every target are).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ty {
    U8,
    U16,
    U32,
    I32,
    F32,
    F64,
}

impl Ty {
    pub const fn bytes(self) -> u32 {
        match self {
            Ty::U8 => 1,
            Ty::U16 => 2,
            Ty::U32 | Ty::I32 | Ty::F32 => 4,
            Ty::F64 => 8,
        }
    }
}

/// A named bit range inside an integer field: `Bits::bit("loop", 0, ..)` is bit 0; the `panner`
/// field of PLAY is `Bits::range("panner", 5, 2, ..)`.
#[derive(Clone, Copy, Debug)]
pub struct Bits {
    pub name: &'static str,
    pub lo: u8,
    pub width: u8,
    pub doc: &'static str,
}

impl Bits {
    /// One flag bit.
    pub const fn bit(name: &'static str, bit: u8, doc: &'static str) -> Bits {
        Bits { name, lo: bit, width: 1, doc }
    }
    /// A multi-bit value (`panner`).
    pub const fn range(name: &'static str, lo: u8, width: u8, doc: &'static str) -> Bits {
        Bits { name, lo, width, doc }
    }
}

/// One field of a body, record payload or STATUS header.
///
/// `offset` is `None` for fields laid out in order (the generator assigns the next offset after the
/// previous field, and checks natural alignment); `Some(n)` pins the byte offset **from the start of
/// the enclosing message** (STATUS only, where the spec lists absolute offsets and the envelope is
/// counted). `count > 1` is a fixed array (`p[7]`). `bits` names flag bits and bit ranges.
#[derive(Clone, Copy, Debug)]
pub struct Field {
    pub name: &'static str,
    pub ty: Ty,
    pub count: u32,
    pub offset: Option<u32>,
    pub bits: &'static [Bits],
    pub doc: &'static str,
}

impl Field {
    pub const fn new(name: &'static str, ty: Ty) -> Field {
        Field { name, ty, count: 1, offset: None, bits: &[], doc: "" }
    }
    pub const fn at(self, offset: u32) -> Field {
        Field { offset: Some(offset), ..self }
    }
    pub const fn array(self, count: u32) -> Field {
        Field { count, ..self }
    }
    pub const fn flags(self, bits: &'static [Bits]) -> Field {
        Field { bits, ..self }
    }
    pub const fn doc(self, doc: &'static str) -> Field {
        Field { doc, ..self }
    }
    pub const fn bytes(&self) -> u32 {
        self.ty.bytes() * self.count
    }
}

/// Who sends a kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dir {
    MainToWorklet,
    MainOrWorkerToWorklet,
    WorkerToWorklet,
    WorkletToMain,
    WorkletToWorker,
}

/// A repeated group after a body's fixed fields: `count_field` (a field of the fixed part or of the
/// enclosing group) says how many; `then` is a nested group repeated inside each item (BUS_CONFIG:
/// per bus, per effect).
#[derive(Clone, Copy, Debug)]
pub struct Repeat {
    /// Name of the group in values and generated code (`buses`, `effects`).
    pub name: &'static str,
    pub count_field: &'static str,
    pub item: &'static [Field],
    pub then: Option<&'static Repeat>,
}

/// What follows a body's fixed fields.
#[derive(Clone, Copy, Debug)]
pub enum Tail {
    None,
    /// Opaque payload to the end of the body (CLIP_CHUNK and STREAM_CHUNK samples, HRIR data).
    Bytes,
    /// `Batch.count` command records (BATCH and REPLAY).
    Records,
    /// A counted group (BUS_CONFIG, BUS_MIX).
    Repeat(&'static Repeat),
}

/// A body: fixed fields, then a tail.
#[derive(Clone, Copy, Debug)]
pub struct Body {
    pub fields: &'static [Field],
    pub tail: Tail,
}

impl Body {
    pub const EMPTY: Body = Body { fields: &[], tail: Tail::None };
    pub const fn fixed(fields: &'static [Field]) -> Body {
        Body { fields, tail: Tail::None }
    }
    pub const fn with_tail(fields: &'static [Field], tail: Tail) -> Body {
        Body { fields, tail }
    }
}

/// An envelope kind (section 4.1).
#[derive(Clone, Copy, Debug)]
pub struct Kind {
    pub id: u16,
    pub name: &'static str,
    pub dir: Dir,
    pub body: Body,
    pub doc: &'static str,
}

/// A command opcode (section 4.2). `payload` excludes the 12-byte record head. `total_bytes` is the
/// spec's "Total B" for fixed-size records (head included); the generator asserts it matches the
/// field sizes. Variable records (BUS_CONFIG, BUS_MIX) give `None` and use a `Repeat` tail.
#[derive(Clone, Copy, Debug)]
pub struct Opcode {
    pub id: u16,
    pub name: &'static str,
    pub payload: Body,
    pub total_bytes: Option<u32>,
    /// `false` for LISTENER (0x20): declared and reserved, never sent in M1 (no writer is generated).
    pub sent_in_m1: bool,
    pub doc: &'static str,
}

/// A counted section after the STATUS header (section 4.3). `count_field` names a STATUS header
/// field; `max` is the per-block cap.
#[derive(Clone, Copy, Debug)]
pub struct Section {
    pub name: &'static str,
    pub item: &'static [Field],
    pub count_field: &'static str,
    pub max: u32,
    pub doc: &'static str,
}

/// The STATUS body (kind 9): header fields at absolute offsets (envelope counted), then sections.
#[derive(Clone, Copy, Debug)]
pub struct StatusSpec {
    pub header_bytes: u32,
    pub fields: &'static [Field],
    pub sections: &'static [Section],
}

/// A named integer constant.
#[derive(Clone, Copy, Debug)]
pub struct Const {
    pub name: &'static str,
    pub value: u64,
    pub doc: &'static str,
}

/// An enumeration: `(variant name, value, doc)`.
#[derive(Clone, Copy, Debug)]
pub struct Enum {
    pub name: &'static str,
    pub variants: &'static [(&'static str, i64, &'static str)],
    pub doc: &'static str,
}

/// A negative `i32` result of the C ABI (section 5); `0` is OK and is a separate constant.
#[derive(Clone, Copy, Debug)]
pub struct ErrorCode {
    pub name: &'static str,
    pub value: i32,
    pub doc: &'static str,
}

/// The whole schema, assembled by `schema::schema()`.
#[derive(Clone, Copy, Debug)]
pub struct Schema {
    pub envelope: &'static [Field],
    pub kinds: &'static [Kind],
    pub batch_header: &'static [Field],
    pub record_head: &'static [Field],
    pub opcodes: &'static [Opcode],
    pub status: StatusSpec,
    /// First-chunk header of an HRIR load (CLIP_CHUNK of a `format = 2` clip): fixed fields; the
    /// `f32[elevations * azimuths * 2]` ear-delay table and the int16 responses follow.
    pub hrir_header: &'static [Field],
    pub constants: &'static [Const],
    pub enums: &'static [Enum],
    pub errors: &'static [ErrorCode],
}

/// A value for the interpretive codec and the vectors (`vectors/cases.rs`).
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    U(u64),
    I(i64),
    F(f64),
    /// A fixed array or a counted group's items.
    Arr(Vec<Value>),
    /// A group item: field name to value, in schema order.
    Rec(Vec<(String, Value)>),
    /// An opcode name in a batch record (`("op", Value::Str("PLAY".into()))`).
    Str(String),
}
