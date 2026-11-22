//! The setup calls: `init` reads the one generated init record (`anim-wire` family `core`) and
//! answers with the memory the core needs for it (ADR 0340, after audio 0327/0328); `source_hash`
//! returns the hash of `native/anim/` the module was built from (the staleness check).

use anim_wire::core::{Init, MemoryNeeded, STATUS_BAD_RECORD, STATUS_OK, STATUS_TOO_LARGE};
use anim_wire::WireRecord;
use wasm_bindgen::prelude::wasm_bindgen;

use crate::{
    assets, debug, evaluate, graph, instances, matching, physics, plugin, retarget, rig, timeline,
    tracks, tweens,
};

/// The source hash `build.rs` embedded.
static SOURCE_HASH: [u8; 16] = *include_bytes!(concat!(env!("OUT_DIR"), "/source_hash.bin"));

/// The bytes of one wasm memory page.
const PAGE_BYTES: u64 = 64 * 1024;

/// Reads an `INIT` record and returns a `MEMORY_NEEDED` record (both `anim-wire` family `core`).
/// Never throws: a malformed record is answered with `STATUS_BAD_RECORD`.
#[wasm_bindgen]
pub fn init(record: &[u8]) -> Vec<u8> {
    memory_needed(record).encode()
}

/// The source hash the module was built from, as 32 lowercase hex digits.
#[wasm_bindgen]
pub fn source_hash() -> String {
    SOURCE_HASH.iter().map(|b| format!("{b:02x}")).collect()
}

/// The reply to an init record.
fn memory_needed(record: &[u8]) -> MemoryNeeded {
    let Ok(init) = Init::decode(record) else {
        return MemoryNeeded {
            status: STATUS_BAD_RECORD,
            bytes: 0,
            pages: 0,
        };
    };
    let total = total_bytes(&init);
    match u32::try_from(total) {
        Ok(bytes) => MemoryNeeded {
            status: STATUS_OK,
            bytes,
            pages: total.div_ceil(PAGE_BYTES) as u32,
        },
        Err(_) => MemoryNeeded {
            status: STATUS_TOO_LARGE,
            bytes: 0,
            pages: 0,
        },
    }
}

/// Every feature's share, saturating (an overflow reads as too large).
fn total_bytes(init: &Init) -> u64 {
    [
        assets::bytes_needed(init),
        instances::bytes_needed(init),
        evaluate::bytes_needed(init),
        tracks::bytes_needed(init),
        graph::bytes_needed(init),
        rig::bytes_needed(init),
        retarget::bytes_needed(init),
        matching::bytes_needed(init),
        tweens::bytes_needed(init),
        timeline::bytes_needed(init),
        physics::bytes_needed(init),
        plugin::bytes_needed(init),
        debug::bytes_needed(init),
    ]
    .iter()
    .fold(0u64, |sum, b| sum.saturating_add(*b))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(init: Init) -> MemoryNeeded {
        MemoryNeeded::decode(&self::init(&init.encode()))
            .expect("init answers with a MEMORY_NEEDED record")
    }

    #[test]
    fn answers_the_memory_needed() {
        let r = reply(Init {
            max_instances: 16,
            max_bones: 64,
            arena_initial_bytes: 1 << 20,
        });
        assert_eq!(r.status, STATUS_OK);
        assert!(r.bytes >= 1 << 20, "at least the arena");
        assert_eq!(r.pages as u64, (r.bytes as u64).div_ceil(PAGE_BYTES));
        let more = reply(Init {
            max_instances: 16,
            max_bones: 128,
            arena_initial_bytes: 1 << 20,
        });
        assert!(more.bytes > r.bytes, "more bones need more memory");
    }

    #[test]
    fn refuses_a_malformed_record() {
        let mut bytes = Init::default().encode();
        bytes[2] ^= 0xff;
        let r = MemoryNeeded::decode(&init(&bytes)).unwrap();
        assert_eq!(
            r,
            MemoryNeeded {
                status: STATUS_BAD_RECORD,
                bytes: 0,
                pages: 0
            }
        );
        let r = MemoryNeeded::decode(&init(&[1, 2, 3])).unwrap();
        assert_eq!(r.status, STATUS_BAD_RECORD);
    }

    #[test]
    fn reports_parameters_past_4_gib() {
        let r = reply(Init {
            max_instances: u32::MAX,
            max_bones: u32::MAX,
            arena_initial_bytes: 0,
        });
        assert_eq!(
            r,
            MemoryNeeded {
                status: STATUS_TOO_LARGE,
                bytes: 0,
                pages: 0
            }
        );
    }

    #[test]
    fn source_hash_is_32_hex_digits() {
        let h = source_hash();
        assert_eq!(h.len(), 32);
        assert!(h
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }
}
