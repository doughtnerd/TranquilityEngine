//! The WebAssembly boundary of Myco's navigation (ADR 0065). The TypeScript side loads this module
//! on demand (`src/engine/nav/`) and talks to it in bulk through typed-array views of its memory.
//!
//! * [`runtime::NavRuntime`]: a World's crowd (agents, chunks, commands, the tick, zero-copy buffers), queries and
//!   debug geometry.
//! * [`baker::NavBaker`]: a chunk's bake, incremental across calls.
//! * Free functions: [`version`], [`bake_info`], [`nav_id`], [`chunk_id`], and debug geometry straight from bake bytes.
//! * Editor helpers ([`plan`]): the bake's agent grouping, orientation bins and per-triangle bins, without baking.
//! * [`dto`]: the JSON shapes the TS side sends.
pub mod baker;
pub mod debug;
pub mod dto;
pub mod plan;
pub mod queries;
pub mod runtime;

use nav_format::file::{read, read_header, SectionKind};
use nav_math::hash::fingerprint_hex;
use wasm_bindgen::prelude::*;

/// The crate's version, for the loader to check against the TypeScript side.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// A summary of a `myco.nav@1` bake file as JSON (for the editor's asset inspector and tests):
/// `{ "packageVersion", "signature", "sections": [{ "kind", "group", "group2", "length", "fingerprint" }] }`,
/// or `{ "error" }`. With `verify`, the whole file is parsed and every section's fingerprint checked.
#[wasm_bindgen(js_name = bakeInfo)]
pub fn bake_info(bytes: &[u8], verify: bool) -> String {
    let header = match read_header(bytes) {
        Ok(h) => h,
        Err(e) => return error_json(&e.to_string()),
    };
    if verify {
        if let Err(e) = read(bytes) {
            return error_json(&e.to_string());
        }
    }
    let [a, b, c] = header.package_version;
    let sections: Vec<String> = header
        .sections
        .iter()
        .map(|s| {
            format!(
                r#"{{"kind":"{}","group":{},"group2":{},"length":{},"fingerprint":"{}"}}"#,
                kind_name(s.kind),
                s.group,
                s.group2,
                s.length,
                fingerprint_hex(s.fingerprint)
            )
        })
        .collect();
    format!(
        r#"{{"packageVersion":"{a}.{b}.{c}","signature":"{}","sections":[{}]}}"#,
        header.signature.to_hex(),
        sections.join(",")
    )
}

/// A string id as the runtime and bakes see it (32 hex digits; see `dto::parse_id`).
#[wasm_bindgen(js_name = navId)]
pub fn nav_id(id: &str) -> String {
    dto::parse_id(id).to_hex()
}

/// A chunk's id (hex) from its scene's project path (forward slashes) and the chunk node's id.
#[wasm_bindgen(js_name = chunkId)]
pub fn chunk_id(scene_path: &str, chunk_node_id: &str) -> String {
    nav_bake::output::chunk_id(scene_path, chunk_node_id).to_hex()
}

fn bake_navmesh(bytes: &[u8], group: u32) -> Result<nav_format::NavMeshData, JsError> {
    let file = read(bytes).map_err(|e| JsError::new(&e.to_string()))?;
    file.navmeshes.into_iter().find(|n| n.group == group).map(|n| n.data).ok_or_else(|| JsError::new(&format!("no navmesh group {group}")))
}

/// A bake's navmesh (section `group`) as line segments, without a runtime (the editor's scene view): stride 7, see
/// `debug::navmesh_lines`.
#[wasm_bindgen(js_name = debugBakeLines)]
pub fn debug_bake_lines(bytes: &[u8], group: u32) -> Result<Vec<f32>, JsError> {
    Ok(debug::navmesh_lines(&bake_navmesh(bytes, group)?))
}

/// Which navmesh and flight volume sections (`[walk group, fly group]`, -1 for none) a bake holds for an agent type
/// (its id as in project settings): the groups the `debugBake*` functions take.
#[wasm_bindgen(js_name = bakeAgentGroups)]
pub fn bake_agent_groups(bytes: &[u8], agent_type: &str) -> Result<Vec<i32>, JsError> {
    let file = read(bytes).map_err(|e| JsError::new(&e.to_string()))?;
    let id = dto::parse_id(agent_type);
    let entry = file.agent_table.as_ref().and_then(|t| t.entries.iter().find(|e| e.id == id));
    Ok(entry.map_or(vec![-1, -1], |e| vec![e.walk_group, e.fly_group]))
}

/// A bake's navmesh polygons as triangles: stride 11 (a, b, c, bin, area).
#[wasm_bindgen(js_name = debugBakeTriangles)]
pub fn debug_bake_triangles(bytes: &[u8], group: u32) -> Result<Vec<f32>, JsError> {
    Ok(debug::navmesh_triangles(&bake_navmesh(bytes, group)?))
}

/// A bake's flight volume (section `group`) leaves: stride 5 (min xyz, size, area).
#[wasm_bindgen(js_name = debugBakeLeaves)]
pub fn debug_bake_leaves(bytes: &[u8], group: u32) -> Result<Vec<f32>, JsError> {
    let file = read(bytes).map_err(|e| JsError::new(&e.to_string()))?;
    let v = file.volumes.into_iter().find(|v| v.group == group).ok_or_else(|| JsError::new(&format!("no flight volume group {group}")))?;
    Ok(debug::volume_leaves(&v.data))
}

/// A bake's flight volume (section `group`) leaves, filtered: stride 5 as [`debug_bake_leaves`]. With `area` (an area
/// id as in project settings) only leaves in that area (none if the volume doesn't know it); with `refined_only` only
/// leaves inside a resolution region (their cell is smaller than the volume's base cell). The editor's previews of the
/// selected modifier and resolution volumes.
#[wasm_bindgen(js_name = debugBakeFlightLeaves)]
pub fn debug_bake_flight_leaves(bytes: &[u8], group: u32, area: &str, refined_only: bool) -> Result<Vec<f32>, JsError> {
    let file = read(bytes).map_err(|e| JsError::new(&e.to_string()))?;
    let v = file.volumes.into_iter().find(|v| v.group == group).ok_or_else(|| JsError::new(&format!("no flight volume group {group}")))?;
    Ok(debug::filtered_volume_leaves(&v.data, if area.is_empty() { None } else { Some(dto::parse_id(area)) }, refined_only))
}

/// What a chunk bakes for each agent type (`plan::bake_plan`), as JSON.
#[wasm_bindgen(js_name = bakePlan)]
pub fn bake_plan(input_json: &str, walkable_for_json: &str) -> Result<String, JsError> {
    plan::bake_plan(input_json, walkable_for_json).map_err(|e| JsError::new(&e))
}

/// The orientation bins the navigation settings make (`plan::surface_bin_layout`), as JSON.
#[wasm_bindgen(js_name = surfaceBinLayout)]
pub fn surface_bin_layout(settings_json: &str) -> String {
    plan::surface_bin_layout(settings_json)
}

/// The bin each triangle (9 floats each) bakes into, -1 where it isn't walkable (`plan::classify_surface_bins`).
#[wasm_bindgen(js_name = classifySurfaceBins)]
pub fn classify_surface_bins(settings_json: &str, positions: &[f32]) -> Result<Vec<i32>, JsError> {
    plan::classify_surface_bins(settings_json, positions).map_err(|e| JsError::new(&e))
}

fn kind_name(kind: SectionKind) -> &'static str {
    match kind {
        SectionKind::NavMesh => "navmesh",
        SectionKind::Volume => "volume",
        SectionKind::LandingLinks => "landingLinks",
        SectionKind::GateTable => "gateTable",
        SectionKind::ChunkBorder => "chunkBorder",
        SectionKind::Formation => "formation",
        SectionKind::AgentTable => "agentTable",
        SectionKind::ChunkInfo => "chunkInfo",
    }
}

fn error_json(message: &str) -> String {
    let escaped: String = message.chars().flat_map(|c| match c {
        '"' => vec!['\\', '"'],
        '\\' => vec!['\\', '\\'],
        c if c.is_control() => vec![' '],
        c => vec![c],
    }).collect();
    format!(r#"{{"error":"{escaped}"}}"#)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nav_format::file::{write, BakeFile};

    #[test]
    fn summarises_a_bake_and_reports_errors() {
        let bytes = write(&BakeFile::default());
        let info = bake_info(&bytes, true);
        assert!(info.starts_with(r#"{"packageVersion":"#), "{info}");
        assert!(info.contains(r#""sections":[]"#), "{info}");
        assert!(bake_info(b"not a bake", false).starts_with(r#"{"error":"#));
    }
}
