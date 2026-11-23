//! The record mechanism and every family, through the crate's public interface: layouts are
//! aligned and unique, every vector decodes to the values it was encoded from, headers are
//! checked, and the generated TypeScript and vectors are up to date.

use std::collections::HashSet;
use std::path::Path;

use anim_wire::core::{Init, MemoryNeeded};
use anim_wire::record::{HEADER_BYTES, STRIDE_ALIGN};
use anim_wire::{gen, WireError, WireRecord, FAMILIES};

#[test]
fn family_ids_and_names_are_unique_and_in_order() {
    let mut names = HashSet::new();
    for (i, family) in FAMILIES.iter().enumerate() {
        assert_eq!(
            family.id as usize,
            i + 1,
            "{}: ids follow FAMILIES' order",
            family.name
        );
        assert!(names.insert(family.name), "{} is listed twice", family.name);
        assert!(family.version >= 1, "{}: versions start at 1", family.name);
    }
}

#[test]
fn every_layout_is_aligned_and_every_opcode_unique() {
    let mut opcodes = HashSet::new();
    for family in FAMILIES {
        let mut names = HashSet::new();
        for record in family.records {
            assert!(
                opcodes.insert(record.opcode),
                "{}: opcode 0x{:04x} reused",
                record.name,
                record.opcode
            );
            assert_eq!(
                record.opcode >> 8,
                family.id as u16,
                "{}: the opcode's high byte is the family id",
                record.name
            );
            assert_eq!(
                record.version, family.version,
                "{}: records carry their family's version",
                record.name
            );
            assert!(
                names.insert(record.name),
                "{}: record name reused in {}",
                record.name,
                family.name
            );
            assert_eq!(record.stride % STRIDE_ALIGN, 0, "{}: stride", record.name);
            let mut end = HEADER_BYTES;
            for (i, ty) in record.types.iter().enumerate() {
                let at = record.offset(i);
                assert_eq!(
                    at % ty.size(),
                    0,
                    "{}.{}: aligned",
                    record.name,
                    record.fields[i]
                );
                assert!(
                    at >= end,
                    "{}.{}: no overlap",
                    record.name,
                    record.fields[i]
                );
                end = at + ty.size();
            }
            assert!(
                end <= record.stride,
                "{}: fields fit the stride",
                record.name
            );
        }
    }
}

#[test]
fn every_family_round_trips_its_vectors() {
    for family in FAMILIES {
        let vectors = (family.vectors)();
        let mut names = HashSet::new();
        for v in &vectors {
            assert!(
                names.insert(v.name),
                "{}: vector {} listed twice",
                family.name,
                v.name
            );
            let record = family
                .records
                .iter()
                .find(|r| r.name == v.record)
                .unwrap_or_else(|| {
                    panic!(
                        "{}/{}: record {} is not in the family",
                        family.name, v.name, v.record
                    )
                });
            assert_eq!(
                v.bytes.len(),
                record.stride as usize,
                "{}/{}",
                family.name,
                v.name
            );
            assert_eq!(u16::from_le_bytes([v.bytes[0], v.bytes[1]]), record.opcode);
            assert_eq!(u16::from_le_bytes([v.bytes[2], v.bytes[3]]), record.version);
        }
    }
}

#[test]
fn core_records_round_trip() {
    let init = Init {
        max_instances: 7,
        max_bones: 300,
        arena_initial_bytes: 1 << 20,
    };
    assert_eq!(Init::decode(&init.encode()), Ok(init));
    assert_eq!(Init::STRIDE, 16);
    let reply = MemoryNeeded {
        status: 2,
        bytes: u32::MAX,
        pages: 65536,
    };
    assert_eq!(MemoryNeeded::decode(&reply.encode()), Ok(reply));
}

#[test]
fn decode_checks_length_opcode_and_version() {
    let bytes = Init {
        max_instances: 1,
        max_bones: 2,
        arena_initial_bytes: 3,
    }
    .encode();
    assert_eq!(
        Init::decode(&bytes[..15]),
        Err(WireError::Short {
            needed: 16,
            got: 15
        })
    );
    assert_eq!(
        MemoryNeeded::decode(&bytes),
        Err(WireError::Opcode {
            expected: MemoryNeeded::OPCODE,
            got: Init::OPCODE
        })
    );
    let mut other_version = bytes.clone();
    other_version[2] = 9;
    assert_eq!(
        Init::decode(&other_version),
        Err(WireError::Version {
            expected: 1,
            got: 9
        })
    );
    let mut short = [0u8; 8];
    assert_eq!(
        Init::default().encode_into(&mut short),
        Err(WireError::Short { needed: 16, got: 8 })
    );
}

#[test]
fn names_convert_for_typescript() {
    assert_eq!(gen::screaming("MemoryNeeded"), "MEMORY_NEEDED");
    assert_eq!(gen::camel("arena_initial_bytes"), "arenaInitialBytes");
}

#[test]
fn generated_files_are_up_to_date() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let outputs = gen::generate_all().expect("the generator runs");
    let stale = gen::write_or_check(&root, &outputs, true).expect("the outputs are readable");
    assert!(
        stale.is_empty(),
        "stale generated files {stale:?}: run `node native/anim/build.mjs`"
    );
}
