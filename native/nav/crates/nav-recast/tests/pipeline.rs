//! The whole Recast pipeline end to end (W1 integration): triangles → heightfield → filters →
//! compact heightfield → erosion → distance field → regions → contours → poly mesh → detail mesh,
//! on small scenes like Foxfire's TestNavBake (agent radius 0.5, height 2, step 0.5; cells 0.25 × 0.2).
use nav_math::{Double3, Float3};
use nav_recast::constants::{RC_NULL_AREA, RC_WALKABLE_AREA};
use nav_recast::rasterization::{rasterize_triangle, HeightfieldSpanSink};
use nav_recast::types::build_contours_flags::RC_CONTOUR_TESS_WALL_EDGES;
use nav_recast::types::heightfield_filters::{LEDGE, LOW_HANGING_OBSTACLES, WALKABLE_LOW_HEIGHT};
use nav_recast::{areas, compact, contours, filters, mesh_details, meshes, regions};
use nav_recast::{FFBounds, Heightfield, RcContourSet, RcContourStatus, RcDetailStatus, RcPolyMesh, RcPolyMeshDetail, RcPolyMeshStatus, SpanPool};

const CS: f32 = 0.25;
const CH: f32 = 0.2;
const WALKABLE_HEIGHT: i32 = 10; // 2 m / 0.2
const WALKABLE_CLIMB: i32 = 2; // 0.5 m / 0.2
const RADIUS: i32 = 2; // 0.5 m / 0.25
const NVP: i32 = 6;

type Tri = [Float3; 3];

/// Two triangles of an axis-aligned quad at height `y`, wound so the normal faces up.
fn quad(x0: f32, z0: f32, x1: f32, z1: f32, y: f32) -> [Tri; 2] {
    let (a, b, c, d) = (Float3::new(x0, y, z0), Float3::new(x0, y, z1), Float3::new(x1, y, z1), Float3::new(x1, y, z0));
    [[a, b, c], [a, c, d]]
}

/// The 12 triangles of a box (all faces; only the top is walkable).
fn boxed(min: Float3, max: Float3) -> Vec<Tri> {
    let p = |x: bool, y: bool, z: bool| Float3::new(if x { max.x } else { min.x }, if y { max.y } else { min.y }, if z { max.z } else { min.z });
    let face = |a: Float3, b: Float3, c: Float3, d: Float3| [[a, b, c], [a, c, d]];
    let mut t = Vec::new();
    t.extend(face(p(false, true, false), p(false, true, true), p(true, true, true), p(true, true, false))); // top
    t.extend(face(p(false, false, false), p(true, false, false), p(true, false, true), p(false, false, true))); // bottom
    t.extend(face(p(false, false, false), p(false, false, true), p(false, true, true), p(false, true, false)));
    t.extend(face(p(true, false, false), p(true, true, false), p(true, true, true), p(true, false, true)));
    t.extend(face(p(false, false, false), p(false, true, false), p(true, true, false), p(true, false, false)));
    t.extend(face(p(false, false, true), p(true, false, true), p(true, true, true), p(false, true, true)));
    t
}

struct Baked {
    mesh: RcPolyMesh,
    detail: RcPolyMeshDetail,
    regions: i32,
}

fn bake(tris: &[Tri], bmin: Float3, bmax: Float3) -> Baked {
    let width = ((bmax.x - bmin.x) / CS).ceil() as i32;
    let height = ((bmax.z - bmin.z) / CS).ceil() as i32;
    let bounds = FFBounds { center: (bmin + bmax) * 0.5, min: bmin, max: bmax };
    let mut hf = Heightfield::new((width * height) as usize);
    let mut pool = SpanPool::new();
    {
        let mut sink = HeightfieldSpanSink { heightfield: &mut hf, pool: &mut pool, width, height, flag_merge_threshold: WALKABLE_CLIMB, areas_are_masks: false };
        for t in tris {
            // Walkable if the slope is under 45° (Foxfire classifies by orientation bins at bake time; W2).
            let n = (t[1] - t[0]).cross(t[2] - t[0]);
            let area = if n.y > 0.0 && n.y / n.length() > 0.7071 { RC_WALKABLE_AREA } else { RC_NULL_AREA };
            rasterize_triangle(&mut sink, t[0].to_double(), t[1].to_double(), t[2].to_double(), CS, CH, width, height, area, 1, &bounds);
        }
    }
    filters::filter_heightfield(LOW_HANGING_OBSTACLES | LEDGE | WALKABLE_LOW_HEIGHT, &hf, &mut pool, height, width, WALKABLE_HEIGHT, WALKABLE_CLIMB);
    let mut chf = compact::build(&hf, &pool, width, height, WALKABLE_HEIGHT, WALKABLE_CLIMB, 0, bmin, bmax, CS, CH).expect("compact heightfield");
    areas::erode_walkable_area(RADIUS, &mut chf);
    regions::build_distance_field(&mut chf);
    regions::build_regions(&mut chf, 2, 8);
    let regions = chf.max_regions;
    let mut cset = RcContourSet::default();
    assert_eq!(contours::build_contours(&chf, 1.3, 12, RC_CONTOUR_TESS_WALL_EDGES, &mut cset), RcContourStatus::Success);
    let (status, mesh) = meshes::build_poly_mesh(&cset, NVP);
    assert_eq!(status, RcPolyMeshStatus::Success);
    let (status, detail) = mesh_details::build_poly_mesh_detail(&mesh, &chf, 6.0 * CS, CH);
    assert!(mesh.npolys == 0 || status == RcDetailStatus::Success, "{status:?}");
    Baked { mesh, detail, regions }
}

/// Each polygon's centre in world space.
fn poly_centres(m: &RcPolyMesh) -> Vec<Float3> {
    (0..m.npolys as usize)
        .map(|p| {
            let base = p * (m.nvp as usize) * 2;
            let idx: Vec<usize> = (0..m.nvp as usize).map(|j| m.polys[base + j]).take_while(|&v| v != 0xffff).map(|v| v as usize).collect();
            let mut c = Float3::default();
            for &v in &idx {
                let q = m.verts[v];
                c += Float3::new(m.bmin.x + q.x as f32 * m.cs, m.bmin.y + q.y as f32 * m.ch, m.bmin.z + q.z as f32 * m.cs);
            }
            c * (1.0 / idx.len() as f32)
        })
        .collect()
}

fn same(a: &Baked, b: &Baked) -> bool {
    let m = |x: &RcPolyMesh| (x.nverts, x.npolys, x.verts[..x.nverts as usize].to_vec(), x.polys[..(x.npolys * x.nvp * 2) as usize].to_vec());
    m(&a.mesh) == m(&b.mesh) && a.detail.verts == b.detail.verts && a.detail.tris == b.detail.tris && a.detail.meshes == b.detail.meshes
}

#[test]
fn a_flat_floor_becomes_walkable_polygons_inset_by_the_agent_radius() {
    let floor = quad(0.0, 0.0, 10.0, 10.0, 0.0);
    let baked = bake(&floor, Float3::new(-1.0, -1.0, -1.0), Float3::new(11.0, 3.0, 11.0));
    assert!(baked.mesh.npolys >= 1);
    assert_eq!(baked.detail.nmeshes(), baked.mesh.npolys as usize);
    for c in poly_centres(&baked.mesh) {
        assert!(c.x > 0.4 && c.x < 9.6 && c.z > 0.4 && c.z < 9.6, "polygon centre {c:?} outside the eroded floor");
        assert!(c.y.abs() < 0.5, "polygon at height {}", c.y);
    }
    // Every vertex is inset by about the radius: nothing walkable closer than 0.5 m to the edge.
    let m = &baked.mesh;
    for v in &m.verts[..m.nverts as usize] {
        let x = m.bmin.x + v.x as f32 * m.cs;
        assert!((0.25..=9.75).contains(&x), "vertex x {x}");
    }
}

#[test]
fn a_box_on_the_floor_leaves_a_hole_and_its_top_is_an_island() {
    let mut tris: Vec<Tri> = quad(0.0, 0.0, 10.0, 10.0, 0.0).to_vec();
    tris.extend(boxed(Float3::new(4.0, 0.0, 4.0), Float3::new(6.0, 1.5, 6.0)));
    let baked = bake(&tris, Float3::new(-1.0, -1.0, -1.0), Float3::new(11.0, 3.0, 11.0));
    assert!(baked.mesh.npolys >= 2, "the hole splits the floor into several polygons");
    let centres = poly_centres(&baked.mesh);
    for c in centres.iter().filter(|c| c.y.abs() < 0.5) {
        let beside = c.x > 3.6 && c.x < 6.4 && c.z > 3.6 && c.z < 6.4;
        assert!(!beside, "a floor polygon centre {c:?} is within the agent radius of the box");
    }
    // Too high to step onto (1.5 m), but 2 m wide: after erosion its top is a 1 m walkable island, as in Recast.
    assert!(centres.iter().any(|c| (c.y - 1.6).abs() < 0.3 && c.x > 4.0 && c.x < 6.0), "no island on the box top: {centres:?}");
}

#[test]
fn separate_floors_become_separate_regions() {
    let mut tris: Vec<Tri> = quad(0.0, 0.0, 4.0, 4.0, 0.0).to_vec();
    tris.extend(quad(6.0, 0.0, 10.0, 4.0, 0.0));
    let baked = bake(&tris, Float3::new(-1.0, -1.0, -1.0), Float3::new(11.0, 3.0, 5.0));
    let m = &baked.mesh;
    let regs: std::collections::BTreeSet<i32> = m.regs[..m.npolys as usize].iter().copied().collect();
    assert!(regs.len() >= 2, "regions {regs:?} (max {})", baked.regions);
    let centres = poly_centres(m);
    assert!(centres.iter().any(|c| c.x < 5.0) && centres.iter().any(|c| c.x > 5.0));
}

#[test]
fn a_raised_platform_is_walkable_at_its_own_height() {
    let mut tris: Vec<Tri> = quad(0.0, 0.0, 10.0, 10.0, 0.0).to_vec();
    tris.extend(boxed(Float3::new(2.0, 0.0, 2.0), Float3::new(8.0, 1.0, 8.0)));
    let baked = bake(&tris, Float3::new(-1.0, -1.0, -1.0), Float3::new(11.0, 4.0, 11.0));
    let centres = poly_centres(&baked.mesh);
    assert!(centres.iter().any(|c| (c.y - 1.0).abs() < 0.3), "no polygon on the platform: {centres:?}");
    assert!(centres.iter().any(|c| c.y.abs() < 0.3), "no polygon on the floor: {centres:?}");
}

#[test]
fn bakes_are_deterministic_and_independent_of_triangle_order() {
    let mut tris: Vec<Tri> = quad(0.0, 0.0, 10.0, 10.0, 0.0).to_vec();
    tris.extend(boxed(Float3::new(4.0, 0.0, 4.0), Float3::new(6.0, 1.5, 6.0)));
    tris.extend(boxed(Float3::new(1.0, 0.0, 7.0), Float3::new(3.0, 0.8, 9.0)));
    let (bmin, bmax) = (Float3::new(-1.0, -1.0, -1.0), Float3::new(11.0, 3.0, 11.0));
    let a = bake(&tris, bmin, bmax);
    assert!(same(&a, &bake(&tris, bmin, bmax)), "the same input baked twice differs");
    let mut reversed = tris.clone();
    reversed.reverse();
    assert!(same(&a, &bake(&reversed, bmin, bmax)), "reversing the triangle order changed the bake");
}

#[test]
fn rasterization_uses_double_precision_triangles() {
    // Guards the input type: rasterize_triangle takes Double3, as Foxfire clips in doubles.
    let _: fn(Double3) -> Float3 = Double3::to_float;
}
