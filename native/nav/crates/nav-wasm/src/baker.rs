//! `NavBaker`: one chunk's bake (`nav_bake::bake::bake_chunk`) behind `wasm-bindgen`, keeping the tile and build
//! caches between calls so rebakes in an editor session are incremental. Keep one per chunk.
//!
//! Input: the bake input JSON (`BakeInputDto`: settings, chunk, volumes, scene path and chunk node id), every mesh's
//! world-space vertices in one `Float32Array` (xyz) and indices in one `Uint32Array`, and a table of meshes
//! (`MeshEntryDto`: vertex range, index range, kind, area, walkable-for). Output: the `myco.nav@1` bytes, and the
//! report of the last bake as JSON.
use crate::dto::{bake_meshes, BakeInputDto};
use nav_bake::bake::{bake_chunk, BakeCaches, BakeInput, BakeOutput};
use nav_math::Float3;
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

/// The baker core, without `wasm-bindgen` types.
#[derive(Default)]
pub struct BakerCore {
    caches: BakeCaches,
    report: String,
}

fn v(p: Float3) -> Value {
    json!([p.x, p.y, p.z])
}

fn bounds(b: (Float3, Float3)) -> Value {
    json!({ "min": v(b.0), "max": v(b.1) })
}

/// The report of a bake as JSON (see `bake.ts`'s `NavBakeReport`).
pub fn report_json(out: &BakeOutput, input: &BakeInput) -> String {
    let r = &out.report;
    let members = |list: &[nav_bake::bake::GroupMember]| -> Value {
        Value::Array(list.iter().map(|m| json!({ "id": m.id.to_hex(), "name": m.name, "group": m.group })).collect())
    };
    json!({
        "chunkId": out.chunk_id.to_hex(),
        "signature": out.file.signature.to_hex(),
        "scenePath": input.scene_path,
        "chunkNodeId": input.chunk_node_id,
        "chunkBounds": out.chunk_bounds.map(bounds),
        "navmeshBounds": out.navmesh_bounds.iter().copied().map(bounds).collect::<Vec<_>>(),
        "agents": members(&out.agents),
        "flyers": members(&out.flyers),
        "landingPairs": out.landing_pairs.iter().map(|p| json!([p.0, p.1])).collect::<Vec<_>>(),
        "fingerprints": out.fingerprints,
        "details": out.details,
        "warnings": out.warnings,
        "navmeshes": out.file.navmeshes.iter().map(|n| json!({ "group": n.group, "polys": n.data.polys.len(), "links": n.data.links.len() })).collect::<Vec<_>>(),
        "volumes": out.file.volumes.iter().map(|s| json!({ "group": s.group, "leaves": s.data.leaves.len() })).collect::<Vec<_>>(),
        "report": {
            "triangles": r.triangles,
            "tiers": r.tiers,
            "tiles": r.tiles,
            "reusedTiles": r.reused_tiles,
            "tasks": r.tasks,
            "builtTasks": r.built_tasks,
            "reusedTasks": r.reused_tasks,
            "stitch": r.stitch.iter().map(|s| json!({
                "polys": s.polys, "internalLinks": s.internal_links, "seamLinks": s.seam_links, "foldLinks": s.fold_links,
                "jumpLinks": s.jump_links, "boundaryEdges": s.boundary_edges, "seamEdges": s.seam_edges
            })).collect::<Vec<_>>(),
            "flightLeaves": r.flight_leaves,
            "stageTimes": r.stage_times.iter().map(|t| json!({ "stage": format!("{:?}", t.stage), "ms": t.ticks as f64 / 1e6 })).collect::<Vec<_>>(),
            "totalMs": r.total_ms(),
        },
        "summary": r.summary(out.agents.len() + out.flyers.len(), out.file.navmeshes.len()),
    })
    .to_string()
}

impl BakerCore {
    pub fn bake(&mut self, input_json: &str, positions: &[f32], indices: &[u32], table_json: &str) -> Result<Vec<u8>, String> {
        let dto = BakeInputDto::parse(input_json)?;
        let input = BakeInput {
            meshes: bake_meshes(positions, indices, table_json)?,
            settings: dto.to_settings(),
            scene_path: dto.scene_path.clone(),
            chunk_node_id: dto.chunk_node_id.clone(),
        };
        let out = bake_chunk(&input, &mut self.caches);
        self.report = report_json(&out, &input);
        Ok(nav_format::write(&out.file))
    }

    pub fn report(&self) -> &str {
        &self.report
    }
}

/// A chunk's baker (see the module doc).
#[wasm_bindgen]
pub struct NavBaker {
    core: BakerCore,
}

#[wasm_bindgen]
impl NavBaker {
    #[wasm_bindgen(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> NavBaker {
        NavBaker { core: BakerCore::default() }
    }

    /// Bakes the chunk; returns its `myco.nav@1` bytes.
    #[wasm_bindgen(js_name = bakeChunk)]
    pub fn bake_chunk(&mut self, input_json: &str, positions: &[f32], indices: &[u32], mesh_table_json: &str) -> Result<Vec<u8>, JsError> {
        self.core.bake(input_json, positions, indices, mesh_table_json).map_err(|e| JsError::new(&e))
    }

    /// The last bake's report as JSON (empty before the first bake).
    #[wasm_bindgen(js_name = lastBakeReport)]
    pub fn last_bake_report(&self) -> String {
        self.core.report().to_string()
    }

    /// Drops the caches (the next bake is a full one).
    #[wasm_bindgen(js_name = clearCaches)]
    pub fn clear_caches(&mut self) {
        self.core.caches.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::RuntimeCore;

    const SETTINGS: &str = r#"{ "agentTypes": [{ "id": "walker", "name": "Walker",
        "walk": { "radius": 0.5, "height": 2, "stepHeight": 0.4, "pivotOffset": 0, "speed": 4, "maxSnapDistance": 2 } }] }"#;

    fn floor() -> (Vec<f32>, Vec<u32>) {
        (vec![-10.0, 0.0, -10.0, 10.0, 0.0, -10.0, 10.0, 0.0, 10.0, -10.0, 0.0, 10.0], vec![0, 2, 1, 0, 3, 2])
    }

    #[test]
    fn bakes_a_floor_and_a_runtime_walks_it() {
        let (p, i) = floor();
        let input = format!(r#"{{ "settings": {SETTINGS}, "scenePath": "scenes/a.json", "chunkNodeId": "root" }}"#);
        let table = r#"[{ "vertexStart": 0, "vertexCount": 4, "indexStart": 0, "indexCount": 6 }]"#;
        let mut baker = BakerCore::default();
        let bytes = baker.bake(&input, &p, &i, table).unwrap();
        let report: Value = serde_json::from_str(baker.report()).unwrap();
        assert!(report["navmeshes"][0]["polys"].as_u64().unwrap() > 0, "{report}");
        let chunk = report["chunkId"].as_str().unwrap().to_string();
        // A rebake reuses everything.
        let again = baker.bake(&input, &p, &i, table).unwrap();
        assert_eq!(again, bytes);
        let report: Value = serde_json::from_str(baker.report()).unwrap();
        assert_eq!(report["report"]["reusedTiles"], report["report"]["tiles"]);

        let mut rt = RuntimeCore::new(SETTINGS).unwrap();
        rt.load_chunk(&chunk, &bytes).unwrap();
        let path = rt.find_path("walker", Float3::new(-8.0, 0.0, -8.0), Float3::new(8.0, 0.0, 8.0));
        assert_eq!(path[0], 0.0, "{path:?}");
        assert!(path.len() > 14);
        let near = rt.nearest_point("walker", Float3::new(0.0, 1.0, 0.0), 3.0);
        assert!((near[1]).abs() < 0.3, "{near:?}");
        let hit = rt.raycast("walker", Float3::new(0.0, 0.0, 0.0), Float3::new(30.0, 0.0, 0.0));
        assert_eq!(hit[1], 0.0, "blocked by the edge: {hit:?}");
        assert!(hit[2] > 8.0 && hit[2] < 10.1, "{hit:?}");
        let a = rt.add_agent(r#"{ "agentType": "walker", "position": [-8, 0, -8] }"#).unwrap();
        rt.crowd.set_destination(nav_crowd::ids::AgentId(crate::runtime::unpack(a)), Float3::new(8.0, 0.0, 8.0));
        for t in 0..600 {
            rt.tick(1.0 / 30.0, t as f64 / 30.0);
        }
        let s = rt.crowd.agent_state(nav_crowd::ids::AgentId(crate::runtime::unpack(a))).unwrap();
        assert_eq!(s.path_state, nav_crowd::NavPathState::Arrived, "{s:?}");
    }
}
