//! Triangle rasterization into a linked-list heightfield (`RcRasterization`): Recast's
//! `rcRasterizeTriangle` and `rcAddSpan`, with the clipping in doubles exactly as Foxfire has it.
use crate::types::{FFBounds, Heightfield, RcSpan, SpanPool, NULL_SPAN};
use nav_math::math::{clamp, max, min};
use nav_math::Double3;

/// Receives the spans [`rasterize_triangle`] produces (`ISpanSink`).
pub trait SpanSink {
    /// One span of a column: `x`, `z` is the column, `smin..smax` its height range in cells.
    fn add(&mut self, x: i32, z: i32, smin: i32, smax: i32, area: i32, area_id: i32);
}

/// Adds spans straight into a linked-list heightfield, merging as Recast's `rcAddSpan` does
/// (`HeightfieldSpanSink`).
pub struct HeightfieldSpanSink<'a> {
    pub heightfield: &'a mut Heightfield,
    pub pool: &'a mut SpanPool,
    pub width: i32,
    pub height: i32,
    pub flag_merge_threshold: i32,
    /// Areas are profile bitmasks: merge with OR, not max.
    pub areas_are_masks: bool,
}

impl SpanSink for HeightfieldSpanSink<'_> {
    fn add(&mut self, x: i32, z: i32, smin: i32, smax: i32, area: i32, area_id: i32) {
        add_span(
            self.heightfield,
            self.pool,
            x,
            z,
            smin,
            smax,
            self.width,
            self.height,
            area,
            self.flag_merge_threshold,
            self.areas_are_masks,
            area_id,
        );
    }
}

/// Recast's span height limit (13-bit field in C++). Foxfire's `RcSpan` uses ints, but keeps parity.
pub const RC_RASTER_SPAN_MAX_HEIGHT: i32 = 0x1fff;

/// Rasterizes one triangle (world positions): every span it covers goes to the sink, at most one per
/// column.
///
/// The clipping runs in doubles: every value that decides which cell or span height a point lands in is
/// then computed the same way everywhere (float expressions with several steps can round differently),
/// so an import's rasterization matches the live bake exactly.
///
/// `w` and `h` are the heightfield's width and height in cells. Always returns true.
#[allow(clippy::too_many_arguments)]
pub fn rasterize_triangle<S: SpanSink>(
    sink: &mut S,
    tri_v0: Double3,
    tri_v1: Double3,
    tri_v2: Double3,
    cell_size: f32,
    cell_height: f32,
    w: i32,
    h: i32,
    area: i32,
    area_id: i32,
    world_bounds: &FFBounds,
) -> bool {
    let tri_bb_min = Double3::new(
        min(min(tri_v0.x, tri_v1.x), tri_v2.x),
        min(min(tri_v0.y, tri_v1.y), tri_v2.y),
        min(min(tri_v0.z, tri_v1.z), tri_v2.z),
    );
    let tri_bb_max = Double3::new(
        max(max(tri_v0.x, tri_v1.x), tri_v2.x),
        max(max(tri_v0.y, tri_v1.y), tri_v2.y),
        max(max(tri_v0.z, tri_v1.z), tri_v2.z),
    );

    let bounds_min = world_bounds.min.to_double();
    let bounds_max = world_bounds.max.to_double();
    if bounds_min.x > tri_bb_max.x
        || bounds_min.y > tri_bb_max.y
        || bounds_min.z > tri_bb_max.z
        || bounds_max.x < tri_bb_min.x
        || bounds_max.y < tri_bb_min.y
        || bounds_max.z < tri_bb_min.z
    {
        return true;
    }

    let by = bounds_max.y - bounds_min.y;

    let inverse_cell_size = 1.0 / cell_size as f64;
    let inverse_cell_height = 1.0 / cell_height as f64;

    let mut z0 = ((tri_bb_min.z - bounds_min.z) * inverse_cell_size) as i32;
    let mut z1 = ((tri_bb_max.z - bounds_min.z) * inverse_cell_size) as i32;

    // use -1 rather than 0 to cut the polygon properly at the start of the tile
    z0 = clamp(z0, -1, h - 1);
    z1 = clamp(z1, 0, h - 1);

    let mut buf = [Double3::default(); 7 * 4];
    let mut inn: usize = 0;
    let mut in_row: usize = 7;
    let mut p1: usize = in_row + 7;
    let mut p2: usize = p1 + 7;
    let mut nv_in: usize = 3;

    buf[0] = tri_v0;
    buf[1] = tri_v1;
    buf[2] = tri_v2;
    let mut z = z0;
    while z <= z1 {
        let cell_z = bounds_min.z + z as f64 * cell_size as f64;
        let (nv_row, n_in) = divide_poly(&mut buf, inn, nv_in, in_row, p1, cell_z + cell_size as f64, 2);
        nv_in = n_in;
        std::mem::swap(&mut inn, &mut p1);

        if nv_row < 3 || z < 0 {
            z += 1;
            continue;
        }

        // find X-axis Bounds of the row
        let mut min_x = buf[in_row].x;
        let mut max_x = buf[in_row].x;
        for i in 1..nv_row {
            let v = buf[in_row + i].x;
            min_x = min(min_x, v);
            max_x = max(max_x, v);
        }

        let mut x0 = ((min_x - bounds_min.x) * inverse_cell_size) as i32;
        let mut x1 = ((max_x - bounds_min.x) * inverse_cell_size) as i32;
        if x1 < 0 || x0 >= w {
            z += 1;
            continue;
        }

        x0 = clamp(x0, -1, w - 1);
        x1 = clamp(x1, 0, w - 1);

        let mut nv2 = nv_row;
        let mut x = x0;
        while x <= x1 {
            // Clip polygon to column. store the remaining polygon as well
            let cx = bounds_min.x + x as f64 * cell_size as f64;
            let (nv, n2) = divide_poly(&mut buf, in_row, nv2, p1, p2, cx + cell_size as f64, 0);
            nv2 = n2;
            std::mem::swap(&mut in_row, &mut p2);

            if nv < 3 || x < 0 {
                x += 1;
                continue;
            }

            // Calculate min and max of the span.
            let mut span_min = buf[p1].y;
            let mut span_max = buf[p1].y;
            for i in 1..nv {
                span_min = min(span_min, buf[p1 + i].y);
                span_max = max(span_max, buf[p1 + i].y);
            }

            span_min -= bounds_min.y;
            span_max -= bounds_min.y;

            // Skip the span if it is outside the heightfield bbox
            if span_max < 0.0 || span_min > by {
                x += 1;
                continue;
            }

            // Clamp the span to the heightfield bbox.
            span_min = max(span_min, 0.0);
            span_max = min(span_max, by);

            // Snap the span to the heightfield height grid.
            // FIX: heights are in units of cell HEIGHT, not cell size (matters whenever cs != ch).
            // FIX: clamp to RC_RASTER_SPAN_MAX_HEIGHT, not 256. In a wall bin, local Y is depth through
            //      the level along the wall normal, which easily exceeds 256 cells.
            let span_min_cell_index = clamp((span_min * inverse_cell_height).floor() as i32, 0, RC_RASTER_SPAN_MAX_HEIGHT);
            let span_max_cell_index = clamp(
                (span_max * inverse_cell_height).ceil() as i32,
                span_min_cell_index + 1,
                RC_RASTER_SPAN_MAX_HEIGHT,
            );

            // FIX: merge threshold is a parameter (Recast passes walkableClimb), not a constant 8.
            sink.add(x, z, span_min_cell_index, span_max_cell_index, area, area_id);
            x += 1;
        }
        z += 1;
    }

    true
}

/// Splits the polygon at `buf[in_offset..in_offset + in_count]` by the plane `axis == axis_offset`:
/// the part on the low side goes to `out1`, the rest to `out2`. Returns the two vertex counts.
fn divide_poly(
    buf: &mut [Double3; 28],
    in_offset: usize,
    in_count: usize,
    out1: usize,
    out2: usize,
    axis_offset: f64,
    axis: usize,
) -> (usize, usize) {
    // Signed distance of each input vertex from the splitting plane
    let mut delta = [0.0f64; 12];
    for i in 0..in_count {
        delta[i] = axis_offset - buf[in_offset + i][axis];
    }

    let mut n1 = 0usize;
    let mut n2 = 0usize;
    let mut b = in_count.wrapping_sub(1);
    for a in 0..in_count {
        let same_side = (delta[a] >= 0.0) == (delta[b] >= 0.0);
        if !same_side {
            // Edge b->a crosses the plane: compute the intersection point
            let s = delta[b] / (delta[b] - delta[a]);
            let pb = buf[in_offset + b];
            let pa = buf[in_offset + a];
            // math.lerp(pb, pa, s): x + s * (y - x)
            let cut = Double3::new(pb.x + s * (pa.x - pb.x), pb.y + s * (pa.y - pb.y), pb.z + s * (pa.z - pb.z));

            // The intersection belongs to both polygons
            buf[out1 + n1] = cut;
            n1 += 1;
            buf[out2 + n2] = cut;
            n2 += 1;

            // Don't add vertices that lie exactly on the plane; the cut point already covers them
            if delta[a] > 0.0 {
                buf[out1 + n1] = pa;
                n1 += 1;
            } else if delta[a] < 0.0 {
                buf[out2 + n2] = pa;
                n2 += 1;
            }
        } else {
            // Same side: add to the matching polygon. Points exactly on the plane go to both.
            let mut to_both = true;
            if delta[a] >= 0.0 {
                buf[out1 + n1] = buf[in_offset + a];
                n1 += 1;
                if delta[a] != 0.0 {
                    to_both = false;
                }
            }

            if to_both {
                buf[out2 + n2] = buf[in_offset + a];
                n2 += 1;
            }
        }
        b = a;
    }

    (n1, n2)
}

/// Adds a span to a column (`rcAddSpan`), merging it with every span it overlaps. `min`/`max` are the
/// span's cell heights, `area_id_` its area (a profile bitmask when `areas_are_masks`) and `area_id`
/// the navmesh area. Spans within `flag_merge_threshold` of the merged top merge their areas: OR for
/// masks, else the higher id wins. Returns true.
#[allow(clippy::too_many_arguments)]
pub fn add_span(
    heightfield: &mut Heightfield,
    pool: &mut SpanPool,
    x: i32,
    z: i32,
    min: i32,
    max: i32,
    width: i32,
    _height: i32,
    area_id_: i32,
    flag_merge_threshold: i32,
    areas_are_masks: bool,
    area_id: i32,
) -> bool {
    let new_span = pool.alloc();
    *pool.get_mut(new_span) = RcSpan { smin: min, smax: max, area: area_id_, area_id, next: NULL_SPAN };

    let column_index = (x + z * width) as usize;

    if heightfield.spans[column_index] == NULL_SPAN {
        heightfield.spans[column_index] = new_span;
        return true;
    }

    let mut previous_span = NULL_SPAN;
    let mut current_span = heightfield.spans[column_index];

    // Insert the new span, possibly merging it with existing spans.
    while current_span != NULL_SPAN {
        let cur = *pool.get(current_span);
        let ns = *pool.get(new_span);
        if cur.smin > ns.smax {
            // Current span is further than the new span, break.
            break;
        }

        if cur.smax < ns.smin {
            // Current span is completely before the new span. Keep going.
            previous_span = current_span;
            current_span = cur.next;
        } else {
            // The new span overlaps with an existing span. Merge them.
            let n = pool.get_mut(new_span);
            if cur.smin < n.smin {
                n.smin = cur.smin;
            }

            if cur.smax > n.smax {
                n.smax = cur.smax;
            }

            // Merge flags.
            if (n.smax - cur.smax).abs() <= flag_merge_threshold {
                // Higher area ID numbers indicate higher resolution priority. With masks, a span is walkable
                // for every profile either side was walkable for.
                n.area = if areas_are_masks { n.area | cur.area } else { n.area.max(cur.area) };
                n.area_id = n.area_id.max(cur.area_id);
            }

            // Remove the current span since it's now merged with newSpan.
            let next = cur.next;
            if previous_span != NULL_SPAN {
                pool.get_mut(previous_span).next = next;
            } else {
                heightfield.spans[column_index] = next;
            }

            current_span = next;
        }
    }

    // Insert new span after prev
    if previous_span != NULL_SPAN {
        let pnext = pool.get(previous_span).next;
        pool.get_mut(new_span).next = pnext;
        pool.get_mut(previous_span).next = new_span;
    } else {
        pool.get_mut(new_span).next = heightfield.spans[column_index];
        heightfield.spans[column_index] = new_span;
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use nav_math::Float3;

    fn bounds(w: f32, h: f32, d: f32) -> FFBounds {
        FFBounds { center: Float3::new(w / 2.0, h / 2.0, d / 2.0), min: Float3::splat(0.0), max: Float3::new(w, h, d) }
    }

    fn column(hf: &Heightfield, pool: &SpanPool, x: i32, z: i32, w: i32) -> Vec<(i32, i32, i32)> {
        let mut v = vec![];
        let mut s = hf.spans[(x + z * w) as usize];
        while s != NULL_SPAN {
            let sp = pool.get(s);
            v.push((sp.smin, sp.smax, sp.area));
            s = sp.next;
        }
        v
    }

    fn quad(hf: &mut Heightfield, pool: &mut SpanPool, y: f64, area: i32, order_rev: bool) {
        let b = bounds(4.0, 4.0, 4.0);
        let mut sink = HeightfieldSpanSink {
            heightfield: hf,
            pool,
            width: 4,
            height: 4,
            flag_merge_threshold: 1,
            areas_are_masks: false,
        };
        let a = Double3::new(0.0, y, 0.0);
        let bb = Double3::new(4.0, y, 0.0);
        let c = Double3::new(4.0, y, 4.0);
        let d = Double3::new(0.0, y, 4.0);
        if order_rev {
            assert!(rasterize_triangle(&mut sink, a, c, d, 1.0, 0.5, 4, 4, area, 0, &b));
            assert!(rasterize_triangle(&mut sink, a, bb, c, 1.0, 0.5, 4, 4, area, 0, &b));
        } else {
            assert!(rasterize_triangle(&mut sink, a, bb, c, 1.0, 0.5, 4, 4, area, 0, &b));
            assert!(rasterize_triangle(&mut sink, a, c, d, 1.0, 0.5, 4, 4, area, 0, &b));
        }
    }

    #[test]
    fn flat_quad_gives_one_span_per_column() {
        let mut hf = Heightfield::new(16);
        let mut pool = SpanPool::new();
        quad(&mut hf, &mut pool, 1.0, 63, false);
        for z in 0..4 {
            for x in 0..4 {
                // Height 1.0 / 0.5 = cell 2; min = floor(2) = 2, max = max(ceil(2), min + 1) = 3.
                assert_eq!(column(&hf, &pool, x, z, 4), vec![(2, 3, 63)], "column {x},{z}");
            }
        }
    }

    #[test]
    fn sloped_triangle_spans_cover_height_range() {
        let mut hf = Heightfield::new(16);
        let mut pool = SpanPool::new();
        let b = bounds(4.0, 4.0, 4.0);
        let mut sink = HeightfieldSpanSink {
            heightfield: &mut hf,
            pool: &mut pool,
            width: 4,
            height: 4,
            flag_merge_threshold: 1,
            areas_are_masks: false,
        };
        // A ramp rising along x from 0 to 4 over a strip z in [0, 1].
        rasterize_triangle(
            &mut sink,
            Double3::new(0.0, 0.0, 0.0),
            Double3::new(4.0, 4.0, 0.0),
            Double3::new(4.0, 4.0, 1.0),
            1.0,
            1.0,
            4,
            4,
            1,
            0,
            &b,
        );
        let c0 = column(&hf, &pool, 0, 0, 4);
        let c3 = column(&hf, &pool, 3, 0, 4);
        assert_eq!(c0.len(), 1);
        assert_eq!(c3.len(), 1);
        assert!(c0[0].0 == 0 && c3[0].0 >= 2 && c3[0].1 == 4);
        assert!(column(&hf, &pool, 0, 2, 4).is_empty());
    }

    #[test]
    fn outside_bounds_is_skipped() {
        let mut hf = Heightfield::new(16);
        let mut pool = SpanPool::new();
        let b = bounds(4.0, 4.0, 4.0);
        let mut sink = HeightfieldSpanSink {
            heightfield: &mut hf,
            pool: &mut pool,
            width: 4,
            height: 4,
            flag_merge_threshold: 1,
            areas_are_masks: false,
        };
        let p = |x: f64| Double3::new(x, 1.0, 10.0);
        assert!(rasterize_triangle(&mut sink, p(0.0), p(1.0), p(2.0), 1.0, 0.5, 4, 4, 1, 0, &b));
        assert!(pool.spans.is_empty());
    }

    #[test]
    fn add_span_merge_rules() {
        let mut hf = Heightfield::new(1);
        let mut pool = SpanPool::new();
        add_span(&mut hf, &mut pool, 0, 0, 10, 12, 1, 1, 1, 1, false, 5);
        add_span(&mut hf, &mut pool, 0, 0, 0, 2, 1, 1, 2, 1, false, 0);
        add_span(&mut hf, &mut pool, 0, 0, 20, 22, 1, 1, 3, 1, false, 0);
        assert_eq!(column(&hf, &pool, 0, 0, 1), vec![(0, 2, 2), (10, 12, 1), (20, 22, 3)]);
        // Overlapping the middle one with the same top: the areas merge (higher wins).
        add_span(&mut hf, &mut pool, 0, 0, 11, 12, 1, 1, 0, 1, false, 0);
        assert_eq!(column(&hf, &pool, 0, 0, 1), vec![(0, 2, 2), (10, 12, 1), (20, 22, 3)]);
        assert_eq!(pool.get(hf.spans[0]).area_id, 0);
        // Bridging everything: the merged top (30) is far from every existing top, so the new area stays.
        add_span(&mut hf, &mut pool, 0, 0, 1, 30, 1, 1, 7, 1, false, 0);
        assert_eq!(column(&hf, &pool, 0, 0, 1), vec![(0, 30, 7)]);
    }

    #[test]
    fn add_span_area_masks_or_merge() {
        let mut hf = Heightfield::new(1);
        let mut pool = SpanPool::new();
        add_span(&mut hf, &mut pool, 0, 0, 0, 5, 1, 1, 0b01, 2, true, 0);
        add_span(&mut hf, &mut pool, 0, 0, 3, 5, 1, 1, 0b10, 2, true, 0);
        assert_eq!(column(&hf, &pool, 0, 0, 1), vec![(0, 5, 0b11)]);
        let mut hf2 = Heightfield::new(1);
        let mut pool2 = SpanPool::new();
        add_span(&mut hf2, &mut pool2, 0, 0, 0, 5, 1, 1, 0b01, 2, false, 0);
        add_span(&mut hf2, &mut pool2, 0, 0, 3, 5, 1, 1, 0b10, 2, false, 0);
        assert_eq!(column(&hf2, &pool2, 0, 0, 1), vec![(0, 5, 0b10)]);
    }

    #[test]
    fn triangle_order_independent_and_deterministic() {
        let run = |rev: bool| {
            let mut hf = Heightfield::new(16);
            let mut pool = SpanPool::new();
            quad(&mut hf, &mut pool, 1.3, 5, rev);
            (0..16).map(|c| column(&hf, &pool, c % 4, c / 4, 4)).collect::<Vec<_>>()
        };
        assert_eq!(run(false), run(false));
        assert_eq!(run(false), run(true));
    }
}
