//! A0.2-L4: the byte vectors against the generator's codec and the generated Rust writers.

use audio_wire::cases::cases;
use audio_wire::gen::codec::{encode, to_hex};
use audio_wire::schema::schema;
use audio_wire::vector::Subject;
use std::collections::HashSet;

#[test]
fn every_vector_encodes_to_its_hand_derived_bytes() {
    let s = schema();
    for case in cases() {
        let bytes = encode(&s, &case).unwrap_or_else(|e| panic!("{}: encode failed: {e}", case.name));
        assert_eq!(to_hex(&bytes), case.hex, "{}", case.name);
    }
}

#[test]
fn vector_names_are_unique_and_cover_every_kind_and_opcode() {
    let s = schema();
    let all = cases();

    let mut names = HashSet::new();
    for c in &all {
        assert!(names.insert(c.name), "duplicate vector name {}", c.name);
    }

    let covered = |pred: &dyn Fn(&Subject) -> bool| all.iter().any(|c| pred(&c.subject));
    for k in s.kinds {
        let ok = if k.name == "STATUS" {
            covered(&|x| matches!(x, Subject::Status))
        } else {
            covered(&|x| match x {
                Subject::Kind(n) | Subject::Batch(n) => *n == k.name,
                _ => false,
            })
        };
        assert!(ok, "kind {} ({}) has no vector", k.name, k.id);
    }

    for op in s.opcodes.iter().filter(|o| o.sent_in_m1) {
        assert!(
            covered(&|x| matches!(x, Subject::Opcode(n) if *n == op.name)),
            "opcode {} ({:#x}) has no vector",
            op.name,
            op.id
        );
    }
}
