//! The shape of a byte vector (lead-owned; leaf A0.2-L4 fills `vectors/cases.rs` with these).
//!
//! A vector is a named case: a subject (which record), the field values, and the **expected bytes as
//! hex derived by hand from the section 4 tables** (not from running the writers, or the vectors
//! would only test the generator against itself). The interpretive codec in `gen::codec` encodes
//! `values` for the subject and the test compares with `hex`; `gen_wire` writes all cases to
//! `vectors/wire.json` for the TypeScript round-trip test.
//!
//! Value conventions per subject (computed fields are filled by the codec, so a case never states
//! them: `magic`, `version`, `kind`, `bodyBytes`, `opcode`, `words`, `count`, section counts):
//!
//! * `Opcode(name)`: the whole record, head included. `values`: `voiceId`, `frameOffset`, then the
//!   payload fields in schema order. A fixed array (`p[7]`) is `Value::Arr`. A `Repeat` group
//!   (`buses`, `effects`) is `Value::Arr` of `Value::Rec`.
//! * `Kind(name)`: a whole message, envelope included. `values`: `seq` (the codec uses version 1.0),
//!   then the body's fixed fields; a `Tail::Bytes` body takes `payload` as `Value::Arr` of `U` bytes;
//!   a `Tail::Repeat` body takes its group. Not for BATCH, REPLAY or STATUS.
//! * `Batch(kind)` (`kind` is `"BATCH"` or `"REPLAY"`): a whole message. `values`: `seq`, `firstFrame`,
//!   `flags`, `records`: `Value::Arr` of `Value::Rec` whose first entry is `("op", Value::Str(name))`
//!   followed by the same entries as an `Opcode` case.
//! * `Status`: a whole STATUS message. `values`: `seq`, every header field by name, and one `Value::Arr`
//!   per section by section name (items are `Value::Rec`, or a bare `U` for the single-field sections).
//! * `HrirHeader`: the 16-byte header only. `BlobHeader(name)`: that header's fixed fields only.
//! * A BED_CONFIG-style padded array (`bedSlot`, `hostBus`) is `Value::Arr` of `U`; its count field is
//!   derived and its zero padding filled by the codec.
//! * `Envelope`: the 16 bytes. `values`: `magic`, `version`, `kind`, `seq`, `bodyBytes` (all stated).

use crate::model::Value;

#[derive(Clone, Debug, PartialEq)]
pub enum Subject {
    Envelope,
    Kind(&'static str),
    Opcode(&'static str),
    Batch(&'static str),
    Status,
    HrirHeader,
    /// A blob header of `Schema::blob_headers` by name (ADR 0162: `ZoneKernelHeader`, `MaglsHeader`).
    BlobHeader(&'static str),
}

#[derive(Clone, Debug)]
pub struct VectorCase {
    /// Unique, `SUBJECT_what` style, for example `PLAY_loop_hrtf_spatial`.
    pub name: &'static str,
    pub subject: Subject,
    pub values: Vec<(&'static str, Value)>,
    /// Lower-case hex, no spaces, of the whole encoded subject.
    pub hex: &'static str,
}
