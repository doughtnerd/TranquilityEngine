//! Family `core`: the init parameters, the memory-needed reply (ADR 0340, after audio 0327/0328),
//! and later the per-frame calls (`write_inputs`, `evaluate`, output views; T13r).

use crate::record::{Const, FamilyDesc, WireRecord};
use crate::vector::Vector;
use crate::wire_record;

/// The family id (the opcodes' high byte).
pub const ID: u8 = 1;
/// The family version. Bump it when a record's layout changes.
pub const VERSION: u16 = 1;

/// [`MemoryNeeded::status`]: the core can run with the memory reported.
pub const STATUS_OK: u32 = 0;
/// [`MemoryNeeded::status`]: the init record was short, or of another opcode or version.
pub const STATUS_BAD_RECORD: u32 = 1;
/// [`MemoryNeeded::status`]: the parameters need more than 4 GiB, the most a wasm32 memory holds.
pub const STATUS_TOO_LARGE: u32 = 2;

wire_record! {
    /// The init parameters: the one record the boundary's `init` call reads.
    pub struct Init: family(ID, VERSION), kind(1) {
        /// The most Animator instances alive at once, over every World.
        max_instances: u32,
        /// The most bones in one skeleton.
        max_bones: u32,
        /// The asset arena's first size in bytes; it grows only in load calls.
        arena_initial_bytes: u32,
    }
}

wire_record! {
    /// The core's reply to `init`: how much memory it needs for those parameters.
    pub struct MemoryNeeded: family(ID, VERSION), kind(2) {
        /// `STATUS_OK`, `STATUS_BAD_RECORD` or `STATUS_TOO_LARGE`.
        status: u32,
        /// The bytes needed (0 unless the status is `STATUS_OK`).
        bytes: u32,
        /// The same in 64 KiB wasm pages, rounded up.
        pages: u32,
    }
}

/// The family's vectors.
fn vectors() -> Vec<Vector> {
    vec![
        Vector::of(
            "init_typical",
            &Init {
                max_instances: 256,
                max_bones: 128,
                arena_initial_bytes: 4 << 20,
            },
        ),
        Vector::of(
            "init_limits",
            &Init {
                max_instances: u32::MAX,
                max_bones: 0,
                arena_initial_bytes: 0x0102_0304,
            },
        ),
        Vector::of(
            "memory_needed_ok",
            &MemoryNeeded {
                status: STATUS_OK,
                bytes: 9_000_000,
                pages: 138,
            },
        ),
        Vector::of(
            "memory_needed_too_large",
            &MemoryNeeded {
                status: STATUS_TOO_LARGE,
                bytes: 0,
                pages: 0,
            },
        ),
    ]
}

/// The family.
pub const FAMILY: FamilyDesc = FamilyDesc {
    name: "core",
    id: ID,
    version: VERSION,
    doc: "Wire family `core`: the init parameters and the memory-needed reply (ADR 0340), then the per-frame calls.",
    records: &[Init::DESC, MemoryNeeded::DESC],
    consts: &[
        Const { name: "STATUS_OK", value: STATUS_OK, doc: "`MEMORY_NEEDED.status`: the core can run with the memory reported." },
        Const { name: "STATUS_BAD_RECORD", value: STATUS_BAD_RECORD, doc: "`MEMORY_NEEDED.status`: the init record was short, or of another opcode or version." },
        Const { name: "STATUS_TOO_LARGE", value: STATUS_TOO_LARGE, doc: "`MEMORY_NEEDED.status`: the parameters need more than 4 GiB." },
    ],
    vectors,
};
