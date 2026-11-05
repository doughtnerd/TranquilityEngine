//! Editor helpers that run the bake's setup without baking (Foxfire's `NavChunkAuthoringEditor` summary and
//! `SurfaceBinsPreview`):
//!
//! * [`bake_plan`]: which navmesh group and flight volume each agent type gets in a chunk, by the bake's own grouping
//!   (`collect_agents`, `named_by_for_walkers`, `group_agents`, `named_by_for_flyers`, `group_flyers`).
//! * [`surface_bin_layout`]: the orientation bins the settings make (`OrientationBinSet`), with their names, normals,
//!   coverage and the surface directions no bin covers (`BinClassifier`).
//! * [`classify_surface_bins`]: the bin each triangle bakes into (the bake's `classify`), -1 when it isn't walkable.
use crate::dto::{parse_id, BakeInputDto, NavigationSettingsDto};
use nav_bake::bins::{BinClassifier, BinSetMetadata, OrientationBinSet};
use nav_bake::classify::{classify, InputTriangle};
use nav_bake::settings::{
    build_tiers, collect_agents, group_agents, group_flyers, named_by_for_flyers, named_by_for_walkers,
};
use nav_bake::volume::flight_resolution_boxes;
use nav_math::{Float3, Hash128};
use serde_json::{json, Value};

/// The bake's grouping for a chunk (see the module doc). `input_json` is the bake input (`BakeInputDto`: settings,
/// chunk, volumes); `walkable_for_json` is every collected walkable mesh's `walkableFor` list (`[["id", ...], ...]`,
/// an empty list = walkable for all). Returns
/// `{ agentTypes: [{ id, name, baked, skipped, walks, flies, walkGroup, flyGroup, flightBaseCell }],
///    walkGroups: [{ members: [id], cellSize, cellHeight }], flyGroups: [{ members: [id], cellSize }], warnings }`
/// (`walkGroup` / `flyGroup` -1 for none; `flightBaseCell` the flight cell the type asks for, before rounding).
pub fn bake_plan(input_json: &str, walkable_for_json: &str) -> Result<String, String> {
    let dto = BakeInputDto::parse(input_json)?;
    let walkable_for: Vec<Vec<String>> = if walkable_for_json.trim().is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(walkable_for_json).map_err(|e| format!("walkable-for lists: {e}"))?
    };
    let settings = dto.to_settings();
    let setup = &settings.setup;
    let collected = collect_agents(setup, &settings.chunk);
    let walkers = &collected.profiles;
    let flyers = &collected.flyers;

    let mesh_lists: Vec<Vec<Hash128>> = walkable_for.iter().map(|l| l.iter().map(|s| parse_id(s)).collect()).collect();
    let named = named_by_for_walkers(walkers, &mesh_lists, &settings.modifier_volumes);
    let walk = group_agents(walkers, &named);
    let res_boxes = flight_resolution_boxes(flyers, &settings.modifier_volumes, &settings.resolution_volumes);
    let tiers = build_tiers(&walk.groups, flyers, &res_boxes);
    let voxel = tiers.tiers.first().map_or(1.0, |t| t.cs);
    let (_, _, fly_named) = named_by_for_flyers(flyers, &settings.modifier_volumes, &settings.resolution_volumes);
    let fly = group_flyers(flyers, &fly_named, voxel);

    let id_of = |h: Hash128| -> String {
        dto.settings.agent_types.iter().find(|t| parse_id(&t.id) == h).map_or_else(|| h.to_hex(), |t| t.id.clone())
    };
    let mut agent_types = Vec::new();
    for t in &dto.settings.agent_types {
        let h = parse_id(&t.id);
        let agent = setup.agents.iter().find(|a| a.id == h);
        let skipped = settings.chunk.skip_agents.contains(&h);
        let walk_group = walkers.iter().position(|w| w.id == h).map_or(-1, |i| walk.agent_group[i] as i32);
        let fly_index = flyers.iter().position(|f| f.id == h);
        let fly_group = fly_index.map_or(-1, |i| fly.agent_group[i] as i32);
        let base = agent.map(|a| nav_bake::settings::to_bake_flyer(Some(setup), a).requested_cell_size()).unwrap_or(0.0);
        agent_types.push(json!({
            "id": t.id,
            "name": t.name,
            "baked": agent.is_some_and(|a| settings.chunk.bakes(setup, a)),
            "skipped": skipped,
            "walks": agent.is_some_and(|a| a.can_walk),
            "flies": agent.is_some_and(|a| a.can_fly),
            "walkGroup": walk_group,
            "flyGroup": fly_group,
            "flightBaseCell": base,
        }));
    }
    let walk_groups: Vec<Value> = walk
        .groups
        .iter()
        .enumerate()
        .map(|(g, p)| {
            let members: Vec<String> = walkers.iter().enumerate().filter(|(i, _)| walk.agent_group[*i] == g).map(|(_, w)| id_of(w.id)).collect();
            json!({ "members": members, "cellSize": p.cell_size, "cellHeight": p.cell_height })
        })
        .collect();
    let fly_groups: Vec<Value> = fly
        .groups
        .iter()
        .enumerate()
        .map(|(g, f)| {
            let members: Vec<String> = flyers.iter().enumerate().filter(|(i, _)| fly.agent_group[*i] == g).map(|(_, x)| id_of(x.id)).collect();
            json!({ "members": members, "cellSize": f.cell_size })
        })
        .collect();
    Ok(json!({
        "agentTypes": agent_types,
        "walkGroups": walk_groups,
        "flyGroups": fly_groups,
        "warnings": collected.warnings,
    })
    .to_string())
}

const COVERAGE_SAMPLES: i32 = 8192;

fn layout_of(settings_json: &str) -> Result<(OrientationBinSet, BinClassifier, nav_bake::bins::OrientationConfig, Vec<nav_bake::bins::SurfaceRing>), String> {
    let setup = NavigationSettingsDto::parse(settings_json)?.to_setup();
    let set = OrientationBinSet::create(&setup.orientation, &setup.surface_rings)?;
    let classifier = BinClassifier::create(&set, &setup.orientation, false);
    Ok((set, classifier, setup.orientation, setup.surface_rings))
}

/// `Layout.Classify`: the bin a surface with unit normal `n` is walkable in, or -1.
fn classify_normal(set: &OrientationBinSet, c: &BinClassifier, n: Float3) -> i32 {
    let bin = c.assign_bin(n);
    if n.y >= c.max_surface_cos && n.dot(set.bins[bin as usize].n) > c.coverage_cos {
        bin
    } else {
        -1
    }
}

/// The settings' orientation bins (`SurfaceBinsPreview.Layout`), as JSON:
/// `{ bins: [{ normal: [x, y, z], name, ring, indexInRing }], ceilingBin, sideBinCount, rings: [{ tiltDeg, count,
/// azimuthOffsetDeg, skipped, firstBin }], coverageDeg, groundCaptureDeg, ceilingCaptureDeg, maxSurfaceDeg,
/// uncoveredShare, unusedBins: [bin] }`, or `{ error }` when the settings make no bin set.
pub fn surface_bin_layout(settings_json: &str) -> String {
    let (set, c, cfg, rings) = match layout_of(settings_json) {
        Ok(l) => l,
        Err(e) => return json!({ "error": e }).to_string(),
    };
    let mut ring_of = vec![-1i32; set.bins.len()];
    let mut index_in_ring = vec![-1i32; set.bins.len()];
    let mut ring_json = Vec::new();
    let mut bin = set.first_side_bin;
    for (r, ring) in rings.iter().enumerate() {
        let skipped = ring.tilt_deg - cfg.coverage_deg > cfg.max_surface_deg;
        let first = if skipped || ring.count <= 0 { -1 } else { bin };
        ring_json.push(json!({ "tiltDeg": ring.tilt_deg, "count": ring.count, "azimuthOffsetDeg": ring.azimuth_offset_deg, "skipped": skipped, "firstBin": first }));
        if skipped || ring.count <= 0 {
            continue;
        }
        for k in 0..ring.count {
            if (bin as usize) < ring_of.len() {
                ring_of[bin as usize] = r as i32;
                index_in_ring[bin as usize] = k;
            }
            bin += 1;
        }
    }

    // Directions spread evenly over the sphere (golden angle): walkable ones no bin covers, and bins nothing reaches.
    let mut hits = vec![0i32; set.bins.len()];
    let (mut walkable, mut uncovered) = (0i32, 0i32);
    for s in 0..COVERAGE_SAMPLES {
        let y = 1.0 - 2.0 * (s as f32 + 0.5) / COVERAGE_SAMPLES as f32;
        let r = (1.0 - y * y).max(0.0).sqrt();
        let phi = s as f32 * 2.399_963_2;
        let n = Float3::new(phi.cos() * r, y, phi.sin() * r);
        if n.y < c.max_surface_cos {
            continue;
        }
        walkable += 1;
        match classify_normal(&set, &c, n) {
            k if k < 0 => uncovered += 1,
            k => hits[k as usize] += 1,
        }
    }
    let bins: Vec<Value> = set
        .bins
        .iter()
        .enumerate()
        .map(|(b, o)| {
            let name = if b == 0 {
                "Floor".to_string()
            } else if b as i32 == set.ceiling_bin {
                "Ceiling".to_string()
            } else {
                format!("Ring {}·{}", ring_of[b] + 1, index_in_ring[b] + 1)
            };
            json!({ "normal": [o.n.x, o.n.y, o.n.z], "name": name, "ring": ring_of[b], "indexInRing": index_in_ring[b] })
        })
        .collect();
    let unused: Vec<usize> = (0..hits.len()).filter(|&k| hits[k] == 0).collect();
    json!({
        "bins": bins,
        "ceilingBin": set.ceiling_bin,
        "sideBinCount": set.side_bin_count,
        "rings": ring_json,
        "coverageDeg": cfg.coverage_deg,
        "groundCaptureDeg": cfg.ground_capture_deg,
        "ceilingCaptureDeg": cfg.ceiling_capture_deg,
        "maxSurfaceDeg": cfg.max_surface_deg,
        "uncoveredShare": if walkable > 0 { uncovered as f32 / walkable as f32 } else { 0.0 },
        "unusedBins": unused,
    })
    .to_string()
}

/// The bin each triangle (`positions`: 9 floats each, world space, walkable side along `cross(b - a, c - a)`) bakes
/// into with these settings, by the bake's own classification; -1 where it isn't walkable in any bin.
pub fn classify_surface_bins(settings_json: &str, positions: &[f32]) -> Result<Vec<i32>, String> {
    let setup = NavigationSettingsDto::parse(settings_json)?.to_setup();
    let set = OrientationBinSet::create(&setup.orientation, &setup.surface_rings)?;
    let p = |i: usize| Float3::new(positions[i], positions[i + 1], positions[i + 2]);
    let triangles: Vec<InputTriangle> = (0..positions.len() / 9).map(|t| InputTriangle::new(p(t * 9), p(t * 9 + 3), p(t * 9 + 6), 1, 1)).collect();
    if triangles.is_empty() {
        return Ok(Vec::new());
    }
    let (mut lo, mut hi) = (Float3::splat(f32::MAX), Float3::splat(f32::MIN));
    for t in &triangles {
        for v in [t.a, t.b, t.c] {
            lo = lo.min_v(v);
            hi = hi.max_v(v);
        }
    }
    let bins = set.bake_bins(lo, hi);
    let meta = BinSetMetadata::new(&set, &setup.orientation);
    Ok(classify(&bins, &meta, &triangles).iter().map(|d| if d.walkable_for != 0 { d.bin } else { -1 }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SETTINGS: &str = r#"{ "agentTypes": [
        { "id": "small", "name": "Small", "canWalk": true, "walk": { "radius": 0.5, "height": 2, "stepHeight": 0.4 } },
        { "id": "twin", "name": "Twin", "canWalk": true, "walk": { "radius": 0.5, "height": 2, "stepHeight": 0.4 } },
        { "id": "big", "name": "Big", "canWalk": true, "walk": { "radius": 1.5, "height": 3, "stepHeight": 0.4 } },
        { "id": "bird", "name": "Bird", "canWalk": false, "canFly": true, "flight": { "radius": 1 } }
    ] }"#;

    #[test]
    fn plan_groups_identical_walkers_and_reports_skips() {
        let input = format!(r#"{{ "settings": {SETTINGS}, "chunk": {{ "skipAgents": ["big"] }} }}"#);
        let plan: Value = serde_json::from_str(&bake_plan(&input, "[]").unwrap()).unwrap();
        let types = plan["agentTypes"].as_array().unwrap();
        assert_eq!(types[0]["walkGroup"], 0);
        assert_eq!(types[1]["walkGroup"], 0, "same voxel settings: one navmesh");
        assert_eq!(types[2]["skipped"], true);
        assert_eq!(types[2]["baked"], false);
        assert_eq!(types[2]["walkGroup"], -1);
        assert_eq!(types[3]["flyGroup"], 0);
        assert_eq!(types[3]["walkGroup"], -1);
        assert_eq!(plan["walkGroups"][0]["members"], json!(["small", "twin"]));
        assert_eq!(plan["flyGroups"][0]["members"], json!(["bird"]));
        assert!(types[3]["flightBaseCell"].as_f64().unwrap() > 0.0);

        // A mesh walkable for only one of the twins splits them.
        let plan: Value = serde_json::from_str(&bake_plan(&input, r#"[["small"]]"#).unwrap()).unwrap();
        assert_eq!(plan["walkGroups"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn bins_classify_floors_walls_and_ceilings() {
        let layout: Value = serde_json::from_str(&surface_bin_layout("{}")).unwrap();
        let bins = layout["bins"].as_array().unwrap();
        assert_eq!(bins[0]["name"], "Floor");
        assert_eq!(layout["sideBinCount"], 4);
        assert_eq!(bins.len(), 6, "floor, four walls, ceiling: {layout}");
        assert_eq!(bins[1]["name"], "Ring 1·1");

        // A floor (normal up), a wall facing +x (normal +x), a ceiling (normal down).
        let tris = [
            0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, // up
            0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, // +x
            0.0, 2.0, 0.0, 1.0, 2.0, 0.0, 0.0, 2.0, 1.0, // down
        ];
        let out = classify_surface_bins("{}", &tris).unwrap();
        assert_eq!(out[0], 0);
        assert!(out[1] >= 1 && out[1] <= 4, "{out:?}");
        assert_eq!(out[2], layout["ceilingBin"].as_i64().unwrap() as i32);
        let normal = &bins[out[1] as usize]["normal"];
        assert!(normal[0].as_f64().unwrap() > 0.9, "wall bin faces +x: {normal}");

        // No walls or ceilings walkable: both are -1.
        let floors = r#"{ "orientation": { "maxSurfaceDeg": 60, "groundCaptureDeg": 45, "ceilingCaptureDeg": 45, "coverageDeg": 60, "maxFoldDeg": 90 }, "surfaceRings": [] }"#;
        let out = classify_surface_bins(floors, &tris).unwrap();
        assert_eq!(out, vec![0, -1, -1]);
        assert!(serde_json::from_str::<Value>(&surface_bin_layout("not json")).unwrap()["error"].is_string());
    }
}
