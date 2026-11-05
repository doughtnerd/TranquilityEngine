//! Area marking and filtering on the compact heightfield (`RcAreas`, from DotRecast's RcAreas):
//! erosion, the median filter, and marking boxes, convex polygons and cylinders. `RcAreaModification`
//! lives in `types.rs`. Polygon vertices are `Float3` (xz used), not flat float arrays.
use crate::types::{RcAreaModification, RcCompactHeightfield, RcCompactSpan};
use nav_math::math::{max, min};
use nav_math::Float3;

const EPSILON: f32 = 1e-6;

/// The compact span index of `s`'s neighbour in `dir` (s sits at column `x`, `z`), or -1.
fn nei(chf: &RcCompactHeightfield, x: i32, z: i32, dir: i32, s: &RcCompactSpan) -> i32 {
    let con = RcCompactHeightfield::get_con(s, dir);
    if con == RcCompactHeightfield::RC_NOT_CONNECTED {
        return -1;
    }

    chf.cells[(x + RcCompactHeightfield::dir_offset_x(dir) + (z + RcCompactHeightfield::dir_offset_y(dir)) * chf.width) as usize]
        .index
        + con
}

#[allow(clippy::too_many_arguments)]
fn relax_erode(
    chf: &RcCompactHeightfield,
    x: i32,
    z: i32,
    i: i32,
    span: &RcCompactSpan,
    dir_a: i32,
    dir_b: i32,
    dist: &mut [i32],
) {
    let a = nei(chf, x, z, dir_a, span);
    if a < 0 {
        return;
    }

    let mut new_distance = min(dist[a as usize] + 2, 255);
    if new_distance < dist[i as usize] {
        dist[i as usize] = new_distance;
    }

    let a_span = chf.spans[a as usize];
    let b = nei(
        chf,
        x + RcCompactHeightfield::dir_offset_x(dir_a),
        z + RcCompactHeightfield::dir_offset_y(dir_a),
        dir_b,
        &a_span,
    );
    if b >= 0 {
        new_distance = min(dist[b as usize] + 3, 255);
        if new_distance < dist[i as usize] {
            dist[i as usize] = new_distance;
        }
    }
}

/// Erodes the walkable area by `erosion_radius` voxels [0 < value < 255]. Spans closer to a boundary
/// or obstruction than the radius get area = RC_NULL_AREA. Usually called right after the compact
/// heightfield is built.
pub fn erode_walkable_area(erosion_radius: i32, chf: &mut RcCompactHeightfield) {
    let x_size = chf.width;
    let z_size = chf.height;

    let mut distance_to_boundary = vec![255i32; chf.span_count as usize];

    // Mark boundary cells.
    for z in 0..z_size {
        for x in 0..x_size {
            let cell = chf.cells[(x + z * x_size) as usize];
            for span_index in cell.index..cell.index + cell.count {
                if chf.areas[span_index as usize] == RcCompactHeightfield::RC_NULL_AREA {
                    distance_to_boundary[span_index as usize] = 0;
                    continue;
                }

                let span = chf.spans[span_index as usize];

                // Check that there is a non-null adjacent span in each of the 4 cardinal directions.
                let mut neighbor_count = 0;
                for direction in 0..4 {
                    let neighbor_span_index = nei(chf, x, z, direction, &span);
                    if neighbor_span_index < 0 {
                        break;
                    }

                    if chf.areas[neighbor_span_index as usize] == RcCompactHeightfield::RC_NULL_AREA {
                        break;
                    }

                    neighbor_count += 1;
                }

                // At least one missing neighbour, so this is a boundary cell.
                if neighbor_count != 4 {
                    distance_to_boundary[span_index as usize] = 0;
                }
            }
        }
    }

    // Pass 1
    for z in 0..z_size {
        for x in 0..x_size {
            let cell = chf.cells[(x + z * x_size) as usize];
            for i in cell.index..cell.index + cell.count {
                let span = chf.spans[i as usize];
                relax_erode(chf, x, z, i, &span, 0, 3, &mut distance_to_boundary); // (-1,0), (-1,-1)
                relax_erode(chf, x, z, i, &span, 3, 2, &mut distance_to_boundary); // (0,-1), (1,-1)
            }
        }
    }

    // Pass 2
    for z in (0..z_size).rev() {
        for x in (0..x_size).rev() {
            let cell = chf.cells[(x + z * x_size) as usize];
            for i in cell.index..cell.index + cell.count {
                let span = chf.spans[i as usize];
                relax_erode(chf, x, z, i, &span, 2, 1, &mut distance_to_boundary); // (1,0), (1,1)
                relax_erode(chf, x, z, i, &span, 1, 0, &mut distance_to_boundary); // (0,1), (-1,1)
            }
        }
    }

    let min_boundary_distance = erosion_radius * 2;
    for span_index in 0..chf.span_count as usize {
        if distance_to_boundary[span_index] < min_boundary_distance {
            chf.areas[span_index] = RcCompactHeightfield::RC_NULL_AREA;
        }
    }
}

fn insert_sort(a: &mut [i32], n: usize) {
    for i in 1..n {
        let v = a[i];
        let mut j = i as i32 - 1;
        while j >= 0 && a[j as usize] > v {
            a[(j + 1) as usize] = a[j as usize];
            j -= 1;
        }

        a[(j + 1) as usize] = v;
    }
}

/// Applies a median filter to walkable area ids, removing noise. Returns true.
pub fn median_filter_walkable_area(chf: &mut RcCompactHeightfield) -> bool {
    let x_size = chf.width;
    let z_size = chf.height;

    let mut areas = vec![0i32; chf.span_count as usize];
    let mut neighbor_areas = [0i32; 9];

    for z in 0..z_size {
        for x in 0..x_size {
            let cell = chf.cells[(x + z * x_size) as usize];
            for span_index in cell.index..cell.index + cell.count {
                let si = span_index as usize;
                let span = chf.spans[si];
                if chf.areas[si] == RcCompactHeightfield::RC_NULL_AREA {
                    areas[si] = chf.areas[si];
                    continue;
                }

                for n in 0..9 {
                    neighbor_areas[n] = chf.areas[si];
                }

                for dir in 0..4 {
                    let a_index = nei(chf, x, z, dir, &span);
                    if a_index < 0 {
                        continue;
                    }

                    if chf.areas[a_index as usize] != RcCompactHeightfield::RC_NULL_AREA {
                        neighbor_areas[(dir * 2) as usize] = chf.areas[a_index as usize];
                    }

                    let a_span = chf.spans[a_index as usize];
                    let dir2 = (dir + 1) & 0x3;
                    let b_index = nei(
                        chf,
                        x + RcCompactHeightfield::dir_offset_x(dir),
                        z + RcCompactHeightfield::dir_offset_y(dir),
                        dir2,
                        &a_span,
                    );
                    if b_index >= 0 && chf.areas[b_index as usize] != RcCompactHeightfield::RC_NULL_AREA {
                        neighbor_areas[(dir * 2 + 1) as usize] = chf.areas[b_index as usize];
                    }
                }

                insert_sort(&mut neighbor_areas, 9);
                areas[si] = neighbor_areas[4];
            }
        }
    }

    for i in 0..chf.span_count as usize {
        chf.areas[i] = areas[i];
    }

    true
}

/// Applies an area id to all spans within the given world-space AABB.
pub fn mark_box_area(
    box_min_bounds: Float3,
    box_max_bounds: Float3,
    area_id: RcAreaModification,
    chf: &mut RcCompactHeightfield,
) {
    let x_size = chf.width;
    let z_size = chf.height;

    // Find the footprint of the box area in grid cell coordinates.
    let mut min_x = ((box_min_bounds.x - chf.bmin.x) / chf.cs) as i32;
    let min_y = ((box_min_bounds.y - chf.bmin.y) / chf.ch) as i32;
    let mut min_z = ((box_min_bounds.z - chf.bmin.z) / chf.cs) as i32;
    let mut max_x = ((box_max_bounds.x - chf.bmin.x) / chf.cs) as i32;
    let max_y = ((box_max_bounds.y - chf.bmin.y) / chf.ch) as i32;
    let mut max_z = ((box_max_bounds.z - chf.bmin.z) / chf.cs) as i32;

    if max_x < 0 || min_x >= x_size || max_z < 0 || min_z >= z_size {
        return;
    }

    min_x = max(min_x, 0);
    max_x = min(max_x, x_size - 1);
    min_z = max(min_z, 0);
    max_z = min(max_z, z_size - 1);

    for z in min_z..=max_z {
        for x in min_x..=max_x {
            let cell = chf.cells[(x + z * x_size) as usize];
            for span_index in cell.index..cell.index + cell.count {
                let si = span_index as usize;
                let span = chf.spans[si];

                // Skip if the span is outside the box extents.
                if span.y < min_y || span.y > max_y {
                    continue;
                }

                // Skip if the span has been removed.
                if chf.areas[si] == RcCompactHeightfield::RC_NULL_AREA {
                    continue;
                }

                chf.areas[si] = area_id.apply(chf.areas[si]);
            }
        }
    }
}

/// Applies the area id to all spans within the convex polygon (xz projection of `verts`, extruded
/// from `min_y` to `max_y`). World units. Does nothing for an empty polygon.
pub fn mark_convex_poly_area(
    verts: &[Float3],
    min_y: f32,
    max_y: f32,
    area_id: RcAreaModification,
    chf: &mut RcCompactHeightfield,
) {
    if verts.is_empty() {
        return;
    }
    let x_size = chf.width;
    let z_size = chf.height;

    // Compute the bounding box of the polygon
    let mut bmin = verts[0];
    let mut bmax = verts[0];
    for v in &verts[1..] {
        bmin = bmin.min_v(*v);
        bmax = bmax.max_v(*v);
    }

    bmin.y = min_y;
    bmax.y = max_y;

    // Compute the grid footprint of the polygon
    let mut minx = ((bmin.x - chf.bmin.x) / chf.cs) as i32;
    let miny = ((bmin.y - chf.bmin.y) / chf.ch) as i32;
    let mut minz = ((bmin.z - chf.bmin.z) / chf.cs) as i32;
    let mut maxx = ((bmax.x - chf.bmin.x) / chf.cs) as i32;
    let maxy = ((bmax.y - chf.bmin.y) / chf.ch) as i32;
    let mut maxz = ((bmax.z - chf.bmin.z) / chf.cs) as i32;

    // Early-out if the polygon lies entirely outside the grid.
    if maxx < 0 || minx >= x_size || maxz < 0 || minz >= z_size {
        return;
    }

    // Clamp the polygon footprint to the grid
    minx = max(minx, 0);
    maxx = min(maxx, x_size - 1);
    minz = max(minz, 0);
    maxz = min(maxz, z_size - 1);

    for z in minz..=maxz {
        for x in minx..=maxx {
            let cell = chf.cells[(x + z * x_size) as usize];
            for span_index in cell.index..cell.index + cell.count {
                let si = span_index as usize;
                let span = chf.spans[si];

                // Skip if span is removed.
                if chf.areas[si] == RcCompactHeightfield::RC_NULL_AREA {
                    continue;
                }

                // Skip if y extents don't overlap.
                if span.y < miny || span.y > maxy {
                    continue;
                }

                let point = Float3::new(
                    chf.bmin.x + (x as f32 + 0.5) * chf.cs,
                    0.0,
                    chf.bmin.z + (z as f32 + 0.5) * chf.cs,
                );

                if point_in_poly(verts, point) {
                    chf.areas[si] = area_id.apply(chf.areas[si]);
                }
            }
        }
    }
}

/// Applies the area id to all spans within the given y-axis-aligned cylinder. World units.
pub fn mark_cylinder_area(
    position: Float3,
    radius: f32,
    height: f32,
    area_id: RcAreaModification,
    chf: &mut RcCompactHeightfield,
) {
    let x_size = chf.width;
    let z_size = chf.height;

    // Compute the bounding box of the cylinder
    let cylinder_bb_min = Float3::new(position.x - radius, position.y, position.z - radius);
    let cylinder_bb_max = Float3::new(position.x + radius, position.y + height, position.z + radius);

    // Compute the grid footprint of the cylinder
    let mut minx = ((cylinder_bb_min.x - chf.bmin.x) / chf.cs) as i32;
    let miny = ((cylinder_bb_min.y - chf.bmin.y) / chf.ch) as i32;
    let mut minz = ((cylinder_bb_min.z - chf.bmin.z) / chf.cs) as i32;
    let mut maxx = ((cylinder_bb_max.x - chf.bmin.x) / chf.cs) as i32;
    let maxy = ((cylinder_bb_max.y - chf.bmin.y) / chf.ch) as i32;
    let mut maxz = ((cylinder_bb_max.z - chf.bmin.z) / chf.cs) as i32;

    // Early-out if the cylinder is completely outside the grid Bounds.
    if maxx < 0 || minx >= x_size || maxz < 0 || minz >= z_size {
        return;
    }

    // Clamp the cylinder Bounds to the grid.
    minx = max(minx, 0);
    maxx = min(maxx, x_size - 1);
    minz = max(minz, 0);
    maxz = min(maxz, z_size - 1);

    let radius_sq = radius * radius;
    for z in minz..=maxz {
        for x in minx..=maxx {
            let cell = chf.cells[(x + z * x_size) as usize];

            let cell_x = chf.bmin.x + (x as f32 + 0.5) * chf.cs;
            let cell_z = chf.bmin.z + (z as f32 + 0.5) * chf.cs;
            let delta_x = cell_x - position.x;
            let delta_z = cell_z - position.z;

            // Skip this column if it's too far from the center point of the cylinder.
            if delta_x * delta_x + delta_z * delta_z >= radius_sq {
                continue;
            }

            // Mark all overlapping spans
            for span_index in cell.index..cell.index + cell.count {
                let si = span_index as usize;
                let span = chf.spans[si];

                // Skip if span is removed.
                if chf.areas[si] == RcCompactHeightfield::RC_NULL_AREA {
                    continue;
                }

                // Mark if y extents overlap.
                if span.y >= miny && span.y <= maxy {
                    chf.areas[si] = area_id.apply(chf.areas[si]);
                }
            }
        }
    }
}

/// Checks if a point is inside a polygon (xz plane).
pub fn point_in_poly(verts: &[Float3], point: Float3) -> bool {
    let mut in_poly = false;
    let n = verts.len();
    if n == 0 {
        return false;
    }
    let mut j = n - 1;
    for i in 0..n {
        let vi = verts[i];
        let vj = verts[j];
        j = i;
        if (vi.z > point.z) == (vj.z > point.z) {
            continue;
        }

        if point.x >= (vj.x - vi.x) * (point.z - vi.z) / (vj.z - vi.z) + vi.x {
            continue;
        }

        in_poly = !in_poly;
    }

    in_poly
}

fn safe_normalize(v: Float3) -> Float3 {
    let sq_mag = v.length_sq();
    if sq_mag > EPSILON {
        // not rsqrt: Burst and managed code may round it differently
        let s = sq_mag.sqrt();
        return Float3::new(v.x / s, v.y / s, v.z / s);
    }
    v
}

/// Expands a convex polygon along its vertex normals by `offset`, beveling sharp corners.
/// `out_verts` should hold up to `2 * num_verts` entries. Returns the number of output vertices, or
/// 0 if `max_out_verts` is too small.
pub fn offset_poly(verts: &[Float3], num_verts: i32, offset: f32, out_verts: &mut [Float3], max_out_verts: i32) -> i32 {
    // Defines the limit at which a miter becomes a bevel.
    const MITER_LIMIT: f32 = 1.20;

    let mut num_out_verts: i32 = 0;

    for vert_index in 0..num_verts {
        let vert_index_a = ((vert_index + num_verts - 1) % num_verts) as usize;
        let vert_index_b = vert_index as usize;
        let vert_index_c = ((vert_index + 1) % num_verts) as usize;

        let vert_a = verts[vert_index_a];
        let vert_b = verts[vert_index_b];
        let vert_c = verts[vert_index_c];

        // From A to B on the x/z plane
        let mut prev_segment_dir = vert_b - vert_a;
        prev_segment_dir.y = 0.0; // Squash onto x/z plane
        prev_segment_dir = safe_normalize(prev_segment_dir);

        // From B to C on the x/z plane
        let mut curr_segment_dir = vert_c - vert_b;
        curr_segment_dir.y = 0.0; // Squash onto x/z plane
        curr_segment_dir = safe_normalize(curr_segment_dir);

        // The y component of the cross product of the two normalized segment directions.
        let cross = curr_segment_dir.x * prev_segment_dir.z - prev_segment_dir.x * curr_segment_dir.z;

        // CCW perpendicular vectors to AB and BC. The segment normals.
        let prev_segment_norm_x = -prev_segment_dir.z;
        let prev_segment_norm_z = prev_segment_dir.x;
        let curr_segment_norm_x = -curr_segment_dir.z;
        let curr_segment_norm_z = curr_segment_dir.x;

        // Average the two segment normals to get the proportional miter offset for B.
        let mut corner_miter_x = (prev_segment_norm_x + curr_segment_norm_x) * 0.5;
        let mut corner_miter_z = (prev_segment_norm_z + curr_segment_norm_z) * 0.5;
        let corner_miter_sq_mag = corner_miter_x * corner_miter_x + corner_miter_z * corner_miter_z;

        // If the magnitude of the segment normal average is less than about .69444,
        // the corner is an acute enough angle that the result should be beveled.
        let bevel = corner_miter_sq_mag * MITER_LIMIT * MITER_LIMIT < 1.0;

        // Scale the corner miter so it's proportional to how much the corner should be offset.
        if corner_miter_sq_mag > EPSILON {
            let scale = 1.0 / corner_miter_sq_mag;
            corner_miter_x *= scale;
            corner_miter_z *= scale;
        }

        if bevel && cross < 0.0 {
            // If the corner is convex and an acute enough angle, generate a bevel.
            if num_out_verts + 2 > max_out_verts {
                return 0;
            }

            // Generate two bevel vertices at distances from B proportional to the angle between the two segments.
            let d = (1.0 - (prev_segment_dir.x * curr_segment_dir.x + prev_segment_dir.z * curr_segment_dir.z)) * 0.5;

            out_verts[num_out_verts as usize] = Float3::new(
                vert_b.x + (-prev_segment_norm_x + prev_segment_dir.x * d) * offset,
                vert_b.y,
                vert_b.z + (-prev_segment_norm_z + prev_segment_dir.z * d) * offset,
            );
            num_out_verts += 1;

            out_verts[num_out_verts as usize] = Float3::new(
                vert_b.x + (-curr_segment_norm_x - curr_segment_dir.x * d) * offset,
                vert_b.y,
                vert_b.z + (-curr_segment_norm_z - curr_segment_dir.z * d) * offset,
            );
            num_out_verts += 1;
        } else {
            if num_out_verts + 1 > max_out_verts {
                return 0;
            }

            // Move B along the miter direction by the specified offset.
            out_verts[num_out_verts as usize] =
                Float3::new(vert_b.x - corner_miter_x * offset, vert_b.y, vert_b.z - corner_miter_z * offset);
            num_out_verts += 1;
        }
    }

    num_out_verts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{RcCompactCell, RcCompactSpan};

    /// A `w` x `h` single-layer chf (floor y = 0), cs = ch = 1, bmin = 0, all connected, area 63.
    fn grid(w: i32, h: i32) -> RcCompactHeightfield {
        let n = (w * h) as usize;
        let mut chf = RcCompactHeightfield {
            width: w,
            height: h,
            span_count: n as i32,
            walkable_height: 3,
            walkable_climb: 2,
            bmin: Float3::splat(0.0),
            bmax: Float3::new(w as f32, 10.0, h as f32),
            cs: 1.0,
            ch: 1.0,
            cells: (0..n as i32).map(|i| RcCompactCell { index: i, count: 1 }).collect(),
            spans: vec![RcCompactSpan { y: 0, reg: 0, con: 0, h: 255 }; n],
            areas: vec![63; n],
            dist: vec![0; n],
            ..RcCompactHeightfield::default()
        };
        for z in 0..h {
            for x in 0..w {
                let i = (x + z * w) as usize;
                for dir in 0..4 {
                    let nx = x + RcCompactHeightfield::dir_offset_x(dir);
                    let nz = z + RcCompactHeightfield::dir_offset_y(dir);
                    let c = if nx < 0 || nz < 0 || nx >= w || nz >= h { RcCompactHeightfield::RC_NOT_CONNECTED } else { 0 };
                    let mut s = chf.spans[i];
                    RcCompactHeightfield::set_con(&mut s, dir, c);
                    chf.spans[i] = s;
                }
            }
        }
        chf
    }

    fn area_at(chf: &RcCompactHeightfield, x: i32, z: i32) -> i32 {
        chf.areas[(x + z * chf.width) as usize]
    }

    #[test]
    fn erode_one_voxel_keeps_interior() {
        let mut chf = grid(5, 5);
        erode_walkable_area(1, &mut chf);
        for z in 0..5 {
            for x in 0..5 {
                let border = x == 0 || z == 0 || x == 4 || z == 4;
                assert_eq!(area_at(&chf, x, z), if border { 0 } else { 63 }, "{x},{z}");
            }
        }
        // The centre is 2 steps (distance 4) from the border: radius 3 (6) removes it, radius 2 (4) doesn't.
        let mut chf = grid(5, 5);
        erode_walkable_area(2, &mut chf);
        assert_eq!(area_at(&chf, 2, 2), 63);
        let mut chf = grid(5, 5);
        erode_walkable_area(3, &mut chf);
        assert_eq!(area_at(&chf, 2, 2), 0);
    }

    #[test]
    fn erode_is_deterministic_and_respects_holes() {
        let run = || {
            let mut chf = grid(7, 7);
            chf.areas[(3 + 3 * 7) as usize] = 0; // a hole
            erode_walkable_area(1, &mut chf);
            chf.areas
        };
        let a = run();
        assert_eq!(a, run());
        // Spans next to the hole are boundary spans (distance 0) and go; its diagonals (distance 2) stay.
        assert_eq!(a[(3 + 2 * 7) as usize], 0);
        assert_eq!(a[(2 + 2 * 7) as usize], 63);
        assert_eq!(a[(3 + 3 * 7) as usize], 0);
    }

    #[test]
    fn median_filter_removes_single_noise() {
        let mut chf = grid(3, 3);
        chf.areas[4] = 5; // a different area in the centre, surrounded by 63
        assert!(median_filter_walkable_area(&mut chf));
        assert_eq!(chf.areas[4], 63);
        // An unwalkable span stays unwalkable.
        let mut chf = grid(3, 3);
        chf.areas[0] = 0;
        median_filter_walkable_area(&mut chf);
        assert_eq!(chf.areas[0], 0);
    }

    #[test]
    fn mark_box_area_marks_footprint_and_respects_mask() {
        let mut chf = grid(5, 5);
        mark_box_area(Float3::new(1.0, -1.0, 1.0), Float3::new(3.5, 2.0, 2.5), RcAreaModification::new(10), &mut chf);
        for z in 0..5 {
            for x in 0..5 {
                let inside = (1..=3).contains(&x) && (1..=2).contains(&z);
                assert_eq!(area_at(&chf, x, z), if inside { 10 } else { 63 }, "{x},{z}");
            }
        }
        // Spans removed stay removed; a partial mask only changes its bits.
        let mut chf = grid(2, 1);
        chf.areas[1] = 0;
        mark_box_area(Float3::new(0.0, 0.0, 0.0), Float3::new(2.0, 1.0, 1.0), RcAreaModification::with_mask(0b000_001, 0b000_001), &mut chf);
        assert_eq!(chf.areas, vec![63, 0]);
        // Outside the grid: nothing.
        let mut chf = grid(2, 2);
        mark_box_area(Float3::new(10.0, 0.0, 10.0), Float3::new(12.0, 1.0, 12.0), RcAreaModification::new(1), &mut chf);
        assert_eq!(chf.areas, vec![63; 4]);
    }

    #[test]
    fn mark_convex_poly_area_marks_cell_centres_inside() {
        let mut chf = grid(6, 6);
        // A square from (1,1) to (4,4): cell centres at .5 offsets, so cells 1..=3 are inside.
        let poly = [Float3::new(1.0, 0.0, 1.0), Float3::new(1.0, 0.0, 4.0), Float3::new(4.0, 0.0, 4.0), Float3::new(4.0, 0.0, 1.0)];
        mark_convex_poly_area(&poly, -1.0, 1.0, RcAreaModification::new(7), &mut chf);
        for z in 0..6 {
            for x in 0..6 {
                let inside = (1..=3).contains(&x) && (1..=3).contains(&z);
                assert_eq!(area_at(&chf, x, z), if inside { 7 } else { 63 }, "{x},{z}");
            }
        }
        assert!(point_in_poly(&poly, Float3::new(2.0, 0.0, 2.0)));
        assert!(!point_in_poly(&poly, Float3::new(5.0, 0.0, 2.0)));
    }

    #[test]
    fn mark_cylinder_area_marks_cells_within_radius() {
        let mut chf = grid(7, 7);
        mark_cylinder_area(Float3::new(3.5, 0.0, 3.5), 1.2, 2.0, RcAreaModification::new(9), &mut chf);
        // Centre (3,3) and its 4-neighbours (distance 1 < 1.2) are marked; diagonals (1.41) aren't.
        for z in 0..7 {
            for x in 0..7 {
                let d = (x - 3i32).abs() + (z - 3i32).abs();
                assert_eq!(area_at(&chf, x, z), if d <= 1 { 9 } else { 63 }, "{x},{z}");
            }
        }
        // Too high: the cylinder starts above the floor span (y = 0 < miny).
        let mut chf = grid(3, 3);
        mark_cylinder_area(Float3::new(1.5, 5.0, 1.5), 1.0, 2.0, RcAreaModification::new(9), &mut chf);
        assert_eq!(chf.areas, vec![63; 9]);
    }

    #[test]
    fn offset_poly_expands_a_square() {
        let sq = [Float3::new(0.0, 1.0, 0.0), Float3::new(2.0, 1.0, 0.0), Float3::new(2.0, 1.0, 2.0), Float3::new(0.0, 1.0, 2.0)];
        let mut out = [Float3::default(); 8];
        // Right-angle corners are sharper than the miter limit (1.2): each is beveled into two vertices.
        let n = offset_poly(&sq, 4, 0.5, &mut out, 8);
        assert_eq!(n, 8);
        for v in &out[..8] {
            assert_eq!(v.y, 1.0);
        }
        let minx = out[..8].iter().map(|v| v.x).fold(f32::MAX, f32::min);
        let maxx = out[..8].iter().map(|v| v.x).fold(f32::MIN, f32::max);
        assert_eq!((minx, maxx), (-0.5, 2.5));
        // Too small an output buffer gives 0.
        assert_eq!(offset_poly(&sq, 4, 0.5, &mut out, 7), 0);
        // Deterministic.
        let mut out2 = [Float3::default(); 8];
        offset_poly(&sq, 4, 0.5, &mut out2, 8);
        assert_eq!(out, out2);
        // Gentle corners (a regular octagon's 45-degree turns) get a single mitered vertex each.
        let oct: Vec<Float3> = (0..8)
            .map(|i| {
                let a = i as f32 * std::f32::consts::FRAC_PI_4;
                Float3::new(a.cos(), 0.0, a.sin())
            })
            .collect();
        let mut out3 = [Float3::default(); 16];
        assert_eq!(offset_poly(&oct, 8, 0.25, &mut out3, 16), 8);
    }

    #[test]
    fn offset_poly_bevels_acute_corner() {
        // A thin triangle has acute corners; the sharpest gets two vertices.
        let tri = [Float3::new(0.0, 0.0, 0.0), Float3::new(1.0, 0.0, 0.0), Float3::new(0.0, 0.0, 10.0)];
        let mut out = [Float3::default(); 6];
        let n = offset_poly(&tri, 3, 0.5, &mut out, 6);
        assert!(n > 3 && n <= 6, "{n}");
    }
}
