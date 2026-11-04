//! Seams and overlays on real Chunk Bounds bakes (ports of Foxfire's `NavSeamTests`, `NavOverlayTests`, and the seam
//! and overlay parts of `NavChunkTests`): `seams::match_polys` / `match_leaves` on two neighbouring chunks (A: x in
//! [-10, 0], B: x in [0, 10], both z in [-8, 8]), `build_seams` and `SeamSet` creating, keeping and removing seams as
//! chunks load and unload, the overlay planner and manager with `nav_bake::overlay::build_overlay`, and that none of
//! it depends on the order scenes were loaded.
mod w3a_common;

use std::sync::Arc;

use nav_bake::overlay::{build_overlay, OverlayInput as BuildInput, OverlayNeighbour};
use nav_format::NavChunkFace;
use nav_math::{Float3, Hash128};
use nav_query::chunks::{LoadedChunk, NavChunks};
use nav_query::overlay::{overlay_signature, plan_overlays, NavOverlayLink, OverlayBuilt, OverlayManager};
use nav_query::seams::{self, build_seams, build_seams_reported, seam_signature, NavSeamLeafLink, NavSeamPolyLink, SeamSet};
use w3a_common::*;

const MIN_A: Float3 = Float3::new(-10.0, -1.0, -8.0);
const MAX_A: Float3 = Float3::new(0.0, 6.0, 8.0);
const MIN_B: Float3 = Float3::new(0.0, -1.0, -8.0);
const MAX_B: Float3 = Float3::new(10.0, 6.0, 8.0);

fn id(n: u32) -> Hash128 {
    Hash128::new(n, 10, 0, 0)
}

fn no_gates(_: Hash128) -> Option<nav_query::chunks::GateState> {
    None
}

/// A Chunk Bounds bake of a floor (at `floor_y`) across the box.
fn chunk(min: Float3, max: Float3, floor_y: f32) -> TestBake {
    let mut b = TestBake::new(Some(flat_profile()));
    b.add_floor((-20.0, -20.0), (20.0, 20.0), floor_y, &[]);
    b.set_chunk_bounds(min, max, 1, 2);
    b.bake();
    b
}

/// The same with a flight volume that belongs to the walker's agent type (`add_hybrid`).
fn chunk_with_volume(min: Float3, max: Float3) -> TestBake {
    let (walker, flyer) = hybrid(1.0, 0.5, 0.0, 30.0, 1, false);
    let mut b = TestBake::new(None);
    b.add_floor((-20.0, -20.0), (20.0, 20.0), 0.0, &[]);
    b.add_hybrid(walker, flyer);
    b.set_chunk_bounds(min, max, 1, 2);
    b.bake();
    b
}

fn loaded(chunk_id: Hash128, bake: &TestBake) -> LoadedChunk {
    LoadedChunk::new(chunk_id, Arc::new(bake.out.file.clone()))
}

fn gather(chunks: &[LoadedChunk]) -> NavChunks {
    NavChunks::gather(chunks, &no_gates, &[])
}

fn agent() -> Hash128 {
    flat_profile().id
}

// ---------------------------------------------------------------------------------------------- Matching

#[test]
fn shared_face_finds_the_face_and_the_shared_part() {
    let (face, min, max) = seams::shared_face(MIN_A, MAX_A, MIN_B, Float3::new(10.0, 6.0, 20.0)).expect("shared");
    assert_eq!(face, NavChunkFace::X_MAX);
    assert_eq!(min, Float3::new(0.0, -1.0, -8.0));
    assert_eq!(max, Float3::new(0.0, 6.0, 8.0));

    let (face, _, _) = seams::shared_face(MIN_B, MAX_B, MIN_A, MAX_A).expect("from B's side");
    assert_eq!(face, NavChunkFace::X_MIN);

    assert!(seams::shared_face(MIN_A, MAX_A, MIN_B + Float3::new(0.5, 0.0, 0.0), MAX_B).is_none(), "a gap");
    assert!(seams::shared_face(MIN_A, MAX_A, Float3::new(0.0, -1.0, 8.0), Float3::new(10.0, 6.0, 16.0)).is_none(), "corner only");
    assert_eq!(seams::opposite(NavChunkFace::X_MAX), NavChunkFace::X_MIN);
    assert_eq!(seams::opposite(NavChunkFace::Z_MIN), NavChunkFace::Z_MAX);
    assert_eq!((seams::axis(NavChunkFace::X_MIN), seams::axis(NavChunkFace::Z_MAX)), (0, 2));
}

#[test]
fn near_miss_reports_how_far_boxes_are_from_a_shared_face() {
    let (gap, axis) = seams::near_miss(MIN_A, MAX_A, MIN_B + Float3::new(0.5, 0.0, 0.0), MAX_B, f32::MAX).expect("close");
    assert_eq!(axis, 0);
    assert!((gap - 0.5).abs() < 1e-5, "apart by half a metre: {gap}");
    let (gap, _) = seams::near_miss(MIN_A, MAX_A, MIN_B - Float3::new(0.5, 0.0, 0.0), MAX_B, f32::MAX).unwrap();
    assert!((gap - -0.5).abs() < 1e-5, "overlapping: {gap}");
    assert!(seams::near_miss(MIN_A, MAX_A, MIN_B, MAX_B, f32::MAX).is_none(), "they share a face");
}

#[test]
fn match_polys_joins_the_floor_along_the_whole_face() {
    let a = chunk(MIN_A, MAX_A, 0.0);
    let b = chunk(MIN_B, MAX_B, 0.0);
    let (face, min, max) = seams::shared_face(MIN_A, MAX_A, MIN_B, MAX_B).unwrap();
    let mut links: Vec<NavSeamPolyLink> = Vec::new();
    seams::match_polys(a.nav(), b.nav(), face, min, max, &mut links);

    assert!(!links.is_empty(), "no links");
    let mut covered = 0.0;
    for l in &links {
        covered += (l.a1.z - l.a0.z).abs();
        assert_eq!(l.a0.x, 0.0);
        assert_eq!(l.b1.x, 0.0);
        assert!((l.a0.z - l.b0.z).abs() < 1e-5, "B0 pairs with A0 along the face");
        assert!((l.a1.z - l.b1.z).abs() < 1e-5, "B1 pairs with A1 along the face");
        assert!(l.poly_a >= 0 && (l.poly_a as usize) < a.nav().polys.len(), "polygon in A");
        assert!(l.poly_b >= 0 && (l.poly_b as usize) < b.nav().polys.len(), "polygon in B");
    }
    assert!((covered - (MAX_A.z - MIN_A.z)).abs() < 0.01, "the whole face is joined: {covered}");
}

#[test]
fn match_polys_keeps_floors_at_different_heights_apart() {
    let a = chunk(MIN_A, MAX_A, 0.0);
    let b = chunk(MIN_B, MAX_B, 1.5); // well over a step (0.5) higher
    let (face, min, max) = seams::shared_face(MIN_A, MAX_A, MIN_B, MAX_B).unwrap();
    let mut links = Vec::new();
    seams::match_polys(a.nav(), b.nav(), face, min, max, &mut links);
    assert!(links.is_empty());
    let d = seams::diagnose_polys(a.nav(), b.nav(), face, min, max);
    assert!(d.edges_a > 0 && d.edges_b > 0 && d.overlap > 10.0);
    assert!(d.height_gap > seams::tolerance(a.nav(), b.nav()), "heights apart: {d:?}");
    assert!(seams::why_no_poly_links(a.nav(), b.nav(), face, min, max).contains("heights differ"));
}

#[test]
fn match_leaves_joins_the_flight_volumes_through_the_face() {
    let a = chunk_with_volume(MIN_A, MAX_A);
    let b = chunk_with_volume(MIN_B, MAX_B);
    let (face, min, max) = seams::shared_face(MIN_A, MAX_A, MIN_B, MAX_B).unwrap();
    let (va, vb) = (a.volume(), b.volume());
    let mut links: Vec<NavSeamLeafLink> = Vec::new();
    seams::match_leaves(va, vb, face, min, max, &mut links);

    assert!(!links.is_empty(), "no links");
    let mut area = 0.0;
    for l in &links {
        assert_eq!(l.min.x, 0.0, "on the face");
        assert_eq!(l.max.x, 0.0, "on the face");
        assert!(l.min.y >= min.y - 1e-4 && l.min.z >= min.z - 1e-4 && l.max.y <= max.y + 1e-4 && l.max.z <= max.z + 1e-4, "within the shared face");
        let leaf_a = va.leaves[l.leaf_a as usize];
        let leaf_b = vb.leaves[l.leaf_b as usize];
        assert!(leaf_a.min.x + leaf_a.size > va.dims.x - 1, "A's leaf is on its high x face");
        assert_eq!(leaf_b.min.x, 0, "B's leaf is on its low x face");
        area += (l.max.y - l.min.y) * (l.max.z - l.min.z);
    }
    // Free space above the floor, less the flyer's clearance above it: most of the 7 x 16 m face.
    assert!(area > 0.5 * (max.y - min.y) * (max.z - min.z), "joined area {area}");
}

// ------------------------------------------------------------------------------------------ Which pairs

#[test]
fn build_seams_stitches_neighbours_with_navmesh_and_flight_links() {
    let a = chunk_with_volume(MIN_A, MAX_A);
    let b = chunk_with_volume(MIN_B, MAX_B);
    let chunks = gather(&[loaded(id(1), &a), loaded(id(2), &b)]);
    let seams = build_seams(&chunks);
    assert_eq!(seams.len(), 1, "seams after both load");
    let s = &seams[0];
    assert_eq!((s.chunk_a, s.chunk_b), (id(1), id(2)), "A is the lower id");
    assert_eq!(s.face_a, NavChunkFace::X_MAX);
    assert_eq!(s.agent_type, agent());
    assert!(!s.poly_links.is_empty(), "navmesh links");
    assert!(!s.leaf_links.is_empty(), "flight links");
    assert!(!s.overlay_a && !s.overlay_b);
    assert_eq!((s.min.x, s.max.x), (0.0, 0.0), "flat along the face's axis");
    assert_eq!(chunks.entries[s.nav_entry_a].chunk, id(1));
    assert_eq!(chunks.entries[s.base_entry_b].chunk, id(2));
}

#[test]
fn seam_set_keeps_the_seam_and_removes_it_when_one_unloads() {
    let a = chunk(MIN_A, MAX_A, 0.0);
    let b = chunk(MIN_B, MAX_B, 0.0);
    let both = gather(&[loaded(id(1), &a), loaded(id(2), &b)]);
    let mut set = SeamSet::new();
    let up = set.update(&both);
    assert!(up.changed);
    assert_eq!((up.built, up.kept, up.removed), (1, 0, 0));
    assert!(up.poly_links > 0);
    let first = set.seams[0].clone();

    let again = set.update(&both);
    assert!(!again.changed, "nothing changed, the seam stays");
    assert_eq!(set.seams[0], first);

    // A third chunk elsewhere: the A-B seam is kept, not restitched.
    let far = chunk(MIN_B + Float3::new(20.0, 0.0, 0.0), MAX_B + Float3::new(20.0, 0.0, 0.0), 0.0);
    let three = gather(&[loaded(id(1), &a), loaded(id(2), &b), loaded(id(3), &far)]);
    let up = set.update(&three);
    assert!(up.changed);
    assert_eq!((up.built, up.kept, up.removed), (0, 1, 0), "the far chunk touches nothing");
    assert_eq!(set.seams[0].poly_links, first.poly_links);

    let only_a = gather(&[loaded(id(1), &a)]);
    let up = set.update(&only_a);
    assert_eq!((up.built, up.kept, up.removed), (0, 0, 1), "B unloaded");
    assert!(set.seams.is_empty());
}

#[test]
fn seam_set_restitches_when_a_chunk_is_rebaked_differently() {
    let a = chunk(MIN_A, MAX_A, 0.0);
    let b = chunk(MIN_B, MAX_B, 0.0);
    let b_raised = chunk(MIN_B, MAX_B, 1.5);
    let mut set = SeamSet::new();
    set.update(&gather(&[loaded(id(1), &a), loaded(id(2), &b)]));
    assert!(!set.seams[0].poly_links.is_empty());

    let up = set.update(&gather(&[loaded(id(1), &a), loaded(id(2), &b_raised)]));
    assert_eq!((up.built, up.kept, up.removed), (1, 0, 1), "a rebaked chunk gets a new seam");
    assert!(set.seams[0].poly_links.is_empty(), "the raised floor doesn't join");
    assert!(set.report.iter().any(|l| l.contains("heights differ")), "{:?}", set.report);

    // Baking the same thing again is the same chunk: nothing to restitch.
    let b_again = chunk(MIN_B, MAX_B, 1.5);
    let up = set.update(&gather(&[loaded(id(1), &a), loaded(id(2), &b_again)]));
    assert!(!up.changed, "identical rebake, identical signature");
}

#[test]
fn chunks_without_bounds_or_apart_or_of_other_agent_types_get_no_seams() {
    let a = chunk(MIN_A, MAX_A, 0.0);
    let unbounded = {
        let mut b = TestBake::new(Some(flat_profile()));
        b.add_floor_simple(-20.0, 20.0);
        b.bake();
        b
    };
    let c = chunk(MIN_B + Float3::new(20.0, 0.0, 0.0), MAX_B + Float3::new(20.0, 0.0, 0.0), 0.0);
    let chunks = gather(&[loaded(id(1), &a), loaded(id(2), &unbounded), loaded(id(3), &c)]);
    assert!(!chunks.entries.iter().find(|e| e.chunk == id(2)).unwrap().bounded);
    let (seams, report) = build_seams_reported(&chunks);
    assert!(seams.is_empty());
    assert!(report.iter().any(|l| l.contains("apart")), "the far chunk is reported: {report:?}");

    // The same boxes as neighbours, but another agent type: no seam.
    let mut other = TestBake::new(Some(profile(false, false, false, 2)));
    other.add_floor((-20.0, -20.0), (20.0, 20.0), 0.0, &[]);
    other.set_chunk_bounds(MIN_B, MAX_B, 1, 2);
    other.bake();
    let chunks = gather(&[loaded(id(1), &a), loaded(id(2), &other)]);
    let (seams, report) = build_seams_reported(&chunks);
    assert!(seams.is_empty());
    assert!(report.iter().any(|l| l.contains("different agent types")));
}

// --------------------------------------------------------------------------------------- Load order

fn permutations(n: usize) -> Vec<Vec<usize>> {
    fn go(prefix: &mut Vec<usize>, rest: &mut Vec<usize>, out: &mut Vec<Vec<usize>>) {
        if rest.is_empty() {
            out.push(prefix.clone());
            return;
        }
        for i in 0..rest.len() {
            let x = rest.remove(i);
            prefix.push(x);
            go(prefix, rest, out);
            prefix.pop();
            rest.insert(i, x);
        }
    }
    let mut out = Vec::new();
    go(&mut Vec::new(), &mut (0..n).collect(), &mut out);
    out
}

#[test]
fn three_in_a_row_seam_pairwise_whatever_the_load_order() {
    // A, B, C side by side along x: A-B and B-C join, A-C don't touch.
    let boxes = [(MIN_A, MAX_A), (MIN_B, MAX_B), (Float3::new(10.0, -1.0, -8.0), Float3::new(20.0, 6.0, 8.0))];
    let bakes: Vec<TestBake> = boxes.iter().map(|&(min, max)| chunk(min, max, 0.0)).collect();
    let chunks: Vec<LoadedChunk> = bakes.iter().enumerate().map(|(i, b)| loaded(id(i as u32 + 1), b)).collect();

    let reference = gather(&chunks);
    let want = build_seams(&reference);
    assert_eq!(want.len(), 2);
    assert_eq!((want[0].chunk_a, want[0].chunk_b), (id(1), id(2)));
    assert_eq!((want[1].chunk_a, want[1].chunk_b), (id(2), id(3)));
    assert!(want.iter().all(|s| !s.poly_links.is_empty() && s.face_a == NavChunkFace::X_MAX));
    let ref_sig = seam_signature(&reference);

    for perm in permutations(3) {
        let order: Vec<LoadedChunk> = perm.iter().map(|&i| chunks[i].clone()).collect();
        let snapshot = gather(&order);
        let got = build_seams(&snapshot);
        // Same seams, links and keys; the entry indices are into each snapshot (and the snapshots are sorted alike).
        assert_eq!(got, want, "load order {perm:?}");
        assert_eq!(seam_signature(&snapshot), ref_sig, "signature, load order {perm:?}");
    }
}

#[test]
fn entries_in_any_order_give_the_same_seams_and_signature() {
    let a = chunk_with_volume(MIN_A, MAX_A);
    let b = chunk_with_volume(MIN_B, MAX_B);
    let chunks = gather(&[loaded(id(1), &a), loaded(id(2), &b)]);
    let mut shuffled = chunks.clone();
    shuffled.entries.reverse();
    assert_eq!(seam_signature(&chunks), seam_signature(&shuffled));
    let one = build_seams(&chunks);
    let two = build_seams(&shuffled);
    assert_eq!(one.len(), 1);
    assert_eq!(one[0].poly_links, two[0].poly_links);
    assert_eq!(one[0].leaf_links, two[0].leaf_links);
    assert_eq!((one[0].chunk_a, one[0].chunk_b, one[0].source_key), (two[0].chunk_a, two[0].chunk_b, two[0].source_key));
}

#[test]
fn signature_changes_only_when_the_loaded_set_changes() {
    let a = chunk(MIN_A, MAX_A, 0.0);
    let b = chunk(MIN_B, MAX_B, 0.0);
    let b_raised = chunk(MIN_B, MAX_B, 1.5);
    let sig = |chunks: &[LoadedChunk]| seam_signature(&gather(chunks));

    let base = sig(&[loaded(id(1), &a), loaded(id(2), &b)]);
    assert_eq!(base, sig(&[loaded(id(2), &b), loaded(id(1), &a)]), "order");
    assert_eq!(base, sig(&[loaded(id(1), &a), loaded(id(2), &b)]), "again");
    assert_ne!(base, sig(&[loaded(id(1), &a)]), "one unloaded");
    assert_ne!(base, sig(&[loaded(id(1), &a), loaded(id(2), &b), loaded(id(3), &a)]), "one more");
    assert_ne!(base, sig(&[loaded(id(1), &a), loaded(id(2), &b_raised)]), "rebaked differently");
    assert_ne!(base, sig(&[loaded(id(1), &a), loaded(id(9), &b)]), "another id");
}

// ----------------------------------------------------------------------------------------- Overlays

const OMIN_A: Float3 = Float3::new(-40.0, -1.0, -16.0);
const OMAX_A: Float3 = Float3::new(0.0, 6.0, 16.0);
const OMIN_B: Float3 = Float3::new(0.0, -1.0, -16.0);
const OMAX_B: Float3 = Float3::new(40.0, 6.0, 16.0);

fn overlay_chunk_a() -> TestBake {
    let mut b = TestBake::new(Some(flat_profile()));
    b.add_floor((-40.0, -16.0), (-3.0, 16.0), 0.0, &[]);
    b.set_chunk_bounds(OMIN_A, OMAX_A, 1, 2);
    b.bake();
    b
}

fn overlay_chunk_b() -> TestBake {
    let mut b = TestBake::new(Some(flat_profile()));
    b.add_floor((-6.0, -16.0), (40.0, 16.0), 0.0, &[]); // 6 m past its x- face, into A's box
    b.set_chunk_bounds(OMIN_B, OMAX_B, 1, 2);
    b.bake();
    b
}

/// Runs the manager's plan, builds what it schedules with `build_overlay`, and collects: what the runtime wave does
/// across frames. Returns what planning decided.
fn settle(manager: &mut OverlayManager, chunks: &NavChunks) -> (usize, usize) {
    let planning = manager.plan(chunks);
    let scheduled = planning.schedule.len();
    for plan in &planning.schedule {
        let entry = &chunks.entries[plan.entry];
        let border = entry.border.as_deref().unwrap();
        let base = entry.nav.as_deref().unwrap();
        let neighbours: Vec<OverlayNeighbour> = plan
            .neighbours
            .iter()
            .map(|n| OverlayNeighbour { border: chunks.entries[n.entry].border.as_deref().unwrap(), face: n.face, profile: n.profile })
            .collect();
        let out = build_overlay(&BuildInput { border, profile: plan.profile, base, neighbours: &neighbours }).expect("builds");
        let built = OverlayBuilt {
            nav: out.nav,
            tile_origins: out.tile_origins,
            links: out
                .links
                .iter()
                .map(|l| NavOverlayLink { base_poly: l.base_poly, overlay_poly: l.overlay_poly, a0: l.a0, a1: l.a1, b0: l.b0, b1: l.b1 })
                .collect(),
            open_sides: out.open_sides,
        };
        assert!(manager.collect(plan, built, base, 1.0));
    }
    (scheduled, planning.removed)
}

fn coverage_of(nav: &nav_format::NavMeshData, face: NavChunkFace) -> f32 {
    coverage(nav, face)
}

#[test]
fn transition_geometry_lets_a_reach_the_face_and_join_b() {
    let a = overlay_chunk_a();
    let b = overlay_chunk_b();
    assert!(coverage_of(a.nav(), NavChunkFace::X_MAX) < 0.01, "A's own bake can't reach the face");
    let loaded_chunks = [loaded(id(1), &a), loaded(id(2), &b)];

    // Without overlays the two never join: A has no seam edges on the face.
    let plain = gather(&loaded_chunks);
    assert!(build_seams(&plain)[0].poly_links.is_empty());

    let plans = plan_overlays(&plain);
    assert_eq!(plans.len(), 2, "both chunks call for an overlay");
    assert_eq!((plans[0].chunk, plans[0].open_sides), (id(1), 1 << NavChunkFace::X_MAX.0), "A opens its x+ face");
    assert_eq!((plans[1].chunk, plans[1].open_sides), (id(2), 1 << NavChunkFace::X_MIN.0), "B opens its x- face");
    assert_eq!(plans[0].neighbours.len(), 1);

    let mut manager = OverlayManager::new();
    assert_eq!(settle(&mut manager, &plain), (2, 0));
    assert_eq!(manager.pending_count(), 0);
    let overlay_a = manager.overlay(id(1), agent()).expect("A's overlay");
    assert_eq!(overlay_a.open_sides, 1 << NavChunkFace::X_MAX.0);
    assert_eq!(overlay_a.tiles.len(), 2, "one column of tiles (the 32-column last one), 2 deep in z");
    assert!(!overlay_a.links.is_empty(), "joins to A's kept tiles");
    assert!((coverage_of(&overlay_a.nav, NavChunkFace::X_MAX) - 32.0).abs() < 0.01, "A's overlay reaches the face along all of it");
    assert!(overlay_a.switched_off.iter().any(|&s| s) && overlay_a.switched_off.len() == a.nav().polys.len());
    let overlay_b = manager.overlay(id(2), agent()).expect("B's overlay");
    assert_eq!(overlay_b.open_sides, 1 << NavChunkFace::X_MIN.0);

    // Planning again for the same snapshot does nothing.
    assert_eq!(manager.plan(&plain).schedule.len(), 0);

    // The seam across the face now joins the overlays.
    let with = NavChunks::gather(&loaded_chunks, &no_gates, &manager.inputs());
    assert_eq!(with.len(), 4, "two base entries and two overlay entries");
    let seams = build_seams(&with);
    assert_eq!(seams.len(), 1);
    let s = &seams[0];
    assert!(s.overlay_a && s.overlay_b, "the seam uses both overlays");
    assert!(with.entries[s.nav_entry_a].overlay && with.entries[s.nav_entry_b].overlay);
    assert!(!with.entries[s.base_entry_a].overlay);
    let covered: f32 = s.poly_links.iter().map(|l| (l.a1.z - l.a0.z).abs()).sum();
    assert!((covered - 32.0).abs() < 0.01, "A and B join along the whole face: {covered}");
    assert_ne!(seam_signature(&plain), seam_signature(&with), "an overlay changes the seams' inputs");

    // A's base entry has the overlay's tiles switched off.
    let base_a = with.find(id(1), agent(), false).unwrap();
    assert!(with.switched_off_of(base_a).iter().any(|&s| s));
}

#[test]
fn overlay_plans_and_keys_do_not_depend_on_load_order() {
    let a = overlay_chunk_a();
    let b = overlay_chunk_b();
    let one = gather(&[loaded(id(1), &a), loaded(id(2), &b)]);
    let two = gather(&[loaded(id(2), &b), loaded(id(1), &a)]);
    let (p1, p2) = (plan_overlays(&one), plan_overlays(&two));
    assert_eq!(p1, p2);
    assert_eq!(overlay_signature(&one), overlay_signature(&two));
    let mut shuffled = one.clone();
    shuffled.entries.reverse();
    let p3 = plan_overlays(&shuffled);
    let keys = |p: &[nav_query::overlay::OverlayPlan]| p.iter().map(|x| (x.chunk, x.key, x.open_sides)).collect::<Vec<_>>();
    assert_eq!(keys(&p1), keys(&p3), "entries in any order");
}

#[test]
fn neighbour_unloads_and_the_overlay_goes() {
    let a = overlay_chunk_a();
    let b = overlay_chunk_b();
    let mut manager = OverlayManager::new();
    settle(&mut manager, &gather(&[loaded(id(1), &a), loaded(id(2), &b)]));
    assert_eq!(manager.overlays.len(), 2);

    let (scheduled, removed) = settle(&mut manager, &gather(&[loaded(id(1), &a)]));
    assert_eq!((scheduled, removed), (0, 2), "no loaded neighbour, no overlay");
    assert!(manager.overlays.is_empty());
}

#[test]
fn chunk_without_border_data_gets_no_overlay() {
    let a = overlay_chunk_a();
    let b = overlay_chunk_b();
    // A's file without its border, but still a bounded chunk.
    let mut file = a.out.file.clone();
    file.chunk_border = None;
    let bare = LoadedChunk { id: id(1), file: Arc::new(file), bounds_min: OMIN_A, bounds_max: OMAX_A, bounded: true };
    let chunks = gather(&[bare, loaded(id(2), &b)]);
    assert!(chunks.entries.iter().all(|e| e.chunk != id(1) || e.border.is_none()));
    assert!(plan_overlays(&chunks).is_empty(), "B's only neighbour has no border data; A has none of its own");
    let mut manager = OverlayManager::new();
    assert_eq!(settle(&mut manager, &chunks), (0, 0));
}

#[test]
fn a_changed_neighbour_replaces_the_overlay_without_a_gap() {
    let a = overlay_chunk_a();
    let b = overlay_chunk_b();
    let mut manager = OverlayManager::new();
    settle(&mut manager, &gather(&[loaded(id(1), &a), loaded(id(2), &b)]));
    let first_key = manager.overlay(id(1), agent()).unwrap().key;

    // B rebaked with transition geometry reaching further: A's key changes. The old overlay stays until the new
    // one is collected.
    let mut b2 = TestBake::new(Some(flat_profile()));
    b2.add_floor((-9.0, -16.0), (40.0, 16.0), 0.0, &[]);
    b2.set_chunk_bounds(OMIN_B, OMAX_B, 1, 2);
    b2.bake();
    let chunks = gather(&[loaded(id(1), &a), loaded(id(2), &b2)]);
    let planning = manager.plan(&chunks);
    assert!(planning.schedule.iter().any(|p| p.chunk == id(1)), "A's overlay is rebuilt");
    assert_eq!(planning.removed, 0, "both chunks still call for overlays, so none goes yet");
    assert!(manager.overlay(id(1), agent()).is_some(), "the old overlay stands while the new one builds");
    assert_eq!(manager.overlay(id(1), agent()).unwrap().key, first_key);
    // A superseded build is dropped: cancel the new plan for A and plan again with B as before.
    let stale = planning.schedule.iter().find(|p| p.chunk == id(1)).unwrap().clone();
    let back = gather(&[loaded(id(1), &a), loaded(id(2), &b)]);
    manager.plan(&back);
    let dummy = OverlayBuilt::default();
    assert!(!manager.collect(&stale, dummy, a.nav(), 2.0), "its key isn't wanted any more");
    assert_eq!(manager.overlay(id(1), agent()).unwrap().key, first_key);
}
