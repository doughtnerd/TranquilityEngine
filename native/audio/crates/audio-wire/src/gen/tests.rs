//! Generator tests against the real schema (lead-owned).

use super::*;
use crate::schema::{schema, schema_hash_hex};

#[test]
fn schema_validates() {
    layout::validate(&schema()).unwrap();
}

#[test]
fn naming_helpers() {
    assert_eq!(layout::snake("arenaUsedKB"), "arena_used_kb");
    assert_eq!(layout::snake("dirX"), "dir_x");
    assert_eq!(layout::snake("SET_PARAMS"), "set_params");
    assert_eq!(layout::pascal("SET_PARAMS"), "SetParams");
    assert_eq!(layout::pascal("buses"), "Buses");
    assert_eq!(layout::screaming("wantsPlayhead"), "WANTS_PLAYHEAD");
}

/// The committed outputs are the ones the current schema and vectors generate (the Rust twin of the
/// TypeScript stale test): run `gen_wire` when this fails.
#[test]
fn committed_outputs_are_current() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let outputs = generate_all().unwrap();
    let stale = write_or_check(&root, &outputs, true).unwrap();
    assert!(stale.is_empty(), "stale generated files {stale:?}: run gen_wire (npm run build:audio)");
}

#[test]
fn generated_hash_matches_the_schema() {
    assert_eq!(crate::generated::SCHEMA_HASH_HEX, schema_hash_hex());
}

#[test]
fn all_opcodes_and_kinds_are_exposed() {
    let s = schema();
    let rust = rust::emit(&s, &schema_hash_hex()).unwrap();
    let ts = ts::emit(&s, &schema_hash_hex()).unwrap();
    for op in s.opcodes.iter().filter(|o| o.sent_in_m1) {
        let name = layout::pascal(op.name);
        assert!(rust.contains(&format!("pub struct {name} ")), "{name}");
        assert!(ts.contains(&format!("export function write{name}(")), "{name}");
    }
    for k in s.kinds {
        assert!(ts.contains(&format!("  {}: {},", k.name, k.id)));
    }
}
