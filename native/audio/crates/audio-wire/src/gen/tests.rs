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
    for op in s.opcodes.iter().filter(|o| o.sent) {
        let name = layout::pascal(op.name);
        assert!(rust.contains(&format!("pub struct {name} ")), "{name}");
        assert!(ts.contains(&format!("export function write{name}(")), "{name}");
    }
    for k in s.kinds {
        assert!(ts.contains(&format!("  {}: {},", k.name, k.id)));
    }
}

#[test]
fn generated_rust_round_trips() {
    use crate::generated::*;
    let mut buf = vec![0u8; 4096];
    let play = Play { voice_id: 7, frame_offset: ASAP, clip: 3, bus: 1, flags: PLAY_FLAGS_LOOP | (1 << PLAY_FLAGS_PANNER_SHIFT), gain: 0.5, ..Default::default() };
    let n = play.write(&mut buf, 8).unwrap();
    assert_eq!(n, 56);
    let (back, used) = Play::read(&buf, 8).unwrap();
    assert_eq!((back, used), (play, 56));
    // truncated and wrong-opcode records are refused
    assert_eq!(Play::read(&buf[..40], 8).unwrap_err(), ERR_TRUNCATED);
    assert_eq!(Stop::read(&buf, 8).unwrap_err(), ERR_MALFORMED);

    let cfg = BusConfig { voice_id: 0, frame_offset: ASAP, buses: vec![BusConfigBuses { parent: 0xFFFF, effects: vec![BusConfigBusesEffects { type_: 2, p: [1.0; 7] }] }, BusConfigBuses { parent: 0, effects: vec![] }] };
    let n = cfg.write(&mut buf, 0).unwrap();
    assert_eq!(BusConfig::read(&buf, 0).unwrap(), (cfg, n));
    assert_eq!(BusConfig::read(&buf[..n - 4], 0).unwrap_err(), ERR_TRUNCATED);

    let st = StatusBlock { current_frame: 1.5, min_slack_frames: -3, flags: STATUS_FLAGS_READY, ended: vec![1, 2], peaks: vec![StatusPeaksItem { l: 0.25, r: 0.5 }], ..Default::default() };
    let n = st.write(&mut buf, 0, 9).unwrap();
    assert_eq!(StatusBlock::read(&buf[..n], 0).unwrap(), (st, n));
}

/// A STATUS whose envelope's `bodyBytes` is shorter than the header is refused, never a panic
/// (L-A1a found `limit - cur` underflowing; the TypeScript `readStatus` already refused it).
#[test]
fn status_with_a_short_body_is_refused() {
    use crate::generated::*;
    let mut buf = vec![0u8; STATUS_BUFFER_BYTES as usize];
    let n = StatusBlock::default().write(&mut buf, 0, 1).unwrap();
    assert_eq!(n, STATUS_HEADER_BYTES as usize);
    for body in [0u32, 1, 95, 127, STATUS_HEADER_BYTES - 17] {
        buf[12..16].copy_from_slice(&body.to_le_bytes());
        assert_eq!(StatusBlock::read(&buf, 0).unwrap_err(), ERR_TRUNCATED, "bodyBytes {body}");
    }
    buf[12..16].copy_from_slice(&(STATUS_HEADER_BYTES - 16).to_le_bytes());
    assert!(StatusBlock::read(&buf, 0).is_ok());
}
