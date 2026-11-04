//! Building the compact heightfield (`RcCompactHeightfield.Build`, `BuildFromFlat`,
//! `BuildConnections`). The struct itself lives in `types.rs`.
use crate::constants::RC_NULL_AREA;
use crate::types::{FlatSpan, Heightfield, RcCompactCell, RcCompactHeightfield, RcCompactSpan, SpanPool, NULL_SPAN};
use nav_math::math::{clamp, max, min};
use nav_math::Float3;

const MAX_HEIGHT: i32 = RcCompactHeightfield::MAX_HEIGHT;

/// Port of rcBuildCompactHeightfield, reading from the linked-list heightfield. Returns `None` if
/// some column has more than `MAX_LAYERS` connected layers. Run erosion on the list first; spans with
/// area == 0 are not carried over.
#[allow(clippy::too_many_arguments)]
pub fn build(
    heightfield: &Heightfield,
    pool: &SpanPool,
    width: i32,
    height: i32,
    walkable_height: i32,
    walkable_climb: i32,
    border_size: i32,
    bmin: Float3,
    bmax: Float3,
    cs: f32,
    ch: f32,
) -> Option<RcCompactHeightfield> {
    let column_count = (width * height) as usize;

    let mut span_count = 0;
    for col in 0..column_count {
        let mut s = heightfield.spans[col];
        while s != NULL_SPAN {
            if pool.get(s).area != RC_NULL_AREA {
                span_count += 1;
            }
            s = pool.get(s).next;
        }
    }

    let mut chf = RcCompactHeightfield {
        width,
        height,
        span_count,
        walkable_height,
        walkable_climb,
        border_size,
        bmin,
        bmax,
        cs,
        ch,
        cells: vec![RcCompactCell::default(); column_count],
        spans: vec![RcCompactSpan::default(); span_count as usize],
        areas: vec![0; span_count as usize],
        dist: vec![0; span_count as usize],
        ..RcCompactHeightfield::default()
    };

    // Fill in cells and spans.
    let mut idx: i32 = 0;
    for z in 0..height {
        for x in 0..width {
            let col = (x + z * width) as usize;
            let mut cell = RcCompactCell { index: idx, count: 0 };

            let mut s = heightfield.spans[col];
            while s != NULL_SPAN {
                let sp = *pool.get(s);
                if sp.area == RC_NULL_AREA {
                    s = sp.next;
                    continue;
                }

                let bot = sp.smax;
                let top = if sp.next != NULL_SPAN { pool.get(sp.next).smin } else { MAX_HEIGHT };

                chf.spans[idx as usize] = RcCompactSpan {
                    y: clamp(bot, 0, 0xffff),
                    h: clamp(top - bot, 0, 0xff),
                    reg: 0,
                    con: 0,
                };
                chf.areas[idx as usize] = sp.area;
                idx += 1;
                cell.count += 1;
                s = sp.next;
            }

            chf.cells[col] = cell;
        }
    }

    if build_connections(&mut chf, width, height, walkable_height, walkable_climb) {
        Some(chf)
    } else {
        None
    }
}

/// Same as [`build`], but from a flattened solid heightfield shared between profiles, with the
/// walkability of each span taken from one profile's filtered areas (one entry per span). Returns
/// `None` as [`build`] does.
#[allow(clippy::too_many_arguments)]
pub fn build_from_flat(
    columns: &[RcCompactCell],
    solid_spans: &[FlatSpan],
    span_areas: &[i32],
    width: i32,
    height: i32,
    walkable_height: i32,
    walkable_climb: i32,
    border_size: i32,
    bmin: Float3,
    bmax: Float3,
    cs: f32,
    ch: f32,
) -> Option<RcCompactHeightfield> {
    let column_count = (width * height) as usize;

    let mut span_count = 0;
    for i in 0..solid_spans.len() {
        if span_areas[i] != RC_NULL_AREA {
            span_count += 1;
        }
    }

    let mut chf = RcCompactHeightfield {
        width,
        height,
        span_count,
        walkable_height,
        walkable_climb,
        border_size,
        bmin,
        bmax,
        cs,
        ch,
        cells: vec![RcCompactCell::default(); column_count],
        spans: vec![RcCompactSpan::default(); span_count as usize],
        areas: vec![0; span_count as usize],
        dist: vec![0; span_count as usize],
        ..RcCompactHeightfield::default()
    };

    // Fill in cells and spans. The open space above a span ends at the next solid span, walkable or not.
    let mut idx: i32 = 0;
    for col in 0..column_count {
        let column = columns[col];
        let mut cell = RcCompactCell { index: idx, count: 0 };

        let end = column.index + column.count;
        for i in column.index..end {
            if span_areas[i as usize] == RC_NULL_AREA {
                continue;
            }

            let bot = solid_spans[i as usize].smax;
            let top = if i + 1 < end { solid_spans[(i + 1) as usize].smin } else { MAX_HEIGHT };

            chf.spans[idx as usize] = RcCompactSpan {
                y: clamp(bot, 0, 0xffff),
                h: clamp(top - bot, 0, 0xff),
                reg: 0,
                con: 0,
            };
            chf.areas[idx as usize] = span_areas[i as usize];
            idx += 1;
            cell.count += 1;
        }

        chf.cells[col] = cell;
    }

    if build_connections(&mut chf, width, height, walkable_height, walkable_climb) {
        Some(chf)
    } else {
        None
    }
}

/// Finds the 4-neighbour connections of every span. Returns false if some neighbour layer index
/// exceeds `MAX_LAYERS` (the caller drops the heightfield).
fn build_connections(
    chf: &mut RcCompactHeightfield,
    width: i32,
    height: i32,
    walkable_height: i32,
    walkable_climb: i32,
) -> bool {
    let max_layers = RcCompactHeightfield::MAX_LAYERS;
    // Find neighbour connections.
    let mut too_high_neighbour = 0;
    for z in 0..height {
        for x in 0..width {
            let c = chf.cells[(x + z * width) as usize];
            for i in c.index..c.index + c.count {
                let mut s = chf.spans[i as usize];

                for dir in 0..4 {
                    RcCompactHeightfield::set_con(&mut s, dir, RcCompactHeightfield::RC_NOT_CONNECTED);

                    let nx = x + RcCompactHeightfield::dir_offset_x(dir);
                    let nz = z + RcCompactHeightfield::dir_offset_y(dir);
                    if nx < 0 || nz < 0 || nx >= width || nz >= height {
                        continue;
                    }

                    let nc = chf.cells[(nx + nz * width) as usize];
                    for k in nc.index..nc.index + nc.count {
                        let ns = chf.spans[k as usize];
                        let bot = max(s.y, ns.y);
                        let top = min(s.y + s.h, ns.y + ns.h);

                        if top - bot >= walkable_height && (ns.y - s.y).abs() <= walkable_climb {
                            let lidx = k - nc.index;
                            if lidx < 0 || lidx > max_layers {
                                too_high_neighbour = max(too_high_neighbour, lidx);
                                continue;
                            }

                            RcCompactHeightfield::set_con(&mut s, dir, lidx);
                            break;
                        }
                    }
                }

                chf.spans[i as usize] = s;
            }
        }
    }

    too_high_neighbour <= max_layers
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rasterization::add_span;

    /// Builds a heightfield from per-column (smin, smax, area) lists.
    fn make(cols: &[&[(i32, i32, i32)]], w: i32) -> (Heightfield, SpanPool) {
        let mut hf = Heightfield::new(cols.len());
        let mut pool = SpanPool::new();
        for (c, spans) in cols.iter().enumerate() {
            for &(a, b, area) in spans.iter() {
                add_span(&mut hf, &mut pool, c as i32 % w, c as i32 / w, a, b, w, 1, area, 0, false, 0);
            }
        }
        (hf, pool)
    }

    fn b() -> (Float3, Float3) {
        (Float3::splat(0.0), Float3::new(2.0, 10.0, 1.0))
    }

    #[test]
    fn two_level_column_connectivity() {
        // Column 0: floor (0..2) and an upper floor (10..12), 8 cells of space between.
        // Column 1: one floor at 0..2. Only the lower layer is connected across (the upper floor is
        // 10 above column 1's floor, more than the climb), and its open space is 8 -> 0xff clamp.
        let (hf, pool) = make(&[&[(0, 2, 63), (10, 12, 63)], &[(0, 2, 63)]], 2);
        let (bmin, bmax) = b();
        let chf = build(&hf, &pool, 2, 1, 3, 2, 0, bmin, bmax, 1.0, 1.0).unwrap();
        assert_eq!(chf.span_count, 3);
        assert_eq!(chf.cells[0], RcCompactCell { index: 0, count: 2 });
        assert_eq!(chf.cells[1], RcCompactCell { index: 2, count: 1 });
        assert_eq!(chf.spans[0].y, 2);
        assert_eq!(chf.spans[0].h, 8);
        assert_eq!(chf.spans[1].y, 12);
        assert_eq!(chf.spans[1].h, 0xff);
        // Direction 2 = (+1, 0): column 0's floor connects to column 1's layer 0; the upper doesn't.
        assert_eq!(RcCompactHeightfield::get_con(&chf.spans[0], 2), 0);
        assert_eq!(RcCompactHeightfield::get_con(&chf.spans[1], 2), RcCompactHeightfield::RC_NOT_CONNECTED);
        // And back: direction 0 = (-1, 0).
        assert_eq!(RcCompactHeightfield::get_con(&chf.spans[2], 0), 0);
        // No neighbour in other directions.
        assert_eq!(RcCompactHeightfield::get_con(&chf.spans[0], 1), RcCompactHeightfield::RC_NOT_CONNECTED);
    }

    #[test]
    fn unwalkable_spans_are_dropped_but_still_bound_open_space() {
        let (hf, pool) = make(&[&[(0, 2, 63), (5, 6, 0)]], 1);
        let (bmin, bmax) = b();
        let chf = build(&hf, &pool, 1, 1, 3, 2, 0, bmin, bmax, 1.0, 1.0).unwrap();
        assert_eq!(chf.span_count, 1);
        assert_eq!(chf.spans[0].h, 3); // open space ends at the unwalkable span's smin
        assert_eq!(chf.areas, vec![63]);
    }

    #[test]
    fn from_flat_matches_linked_build() {
        let cols_in: [&[(i32, i32, i32)]; 2] = [&[(0, 2, 63), (10, 12, 63)], &[(0, 2, 63)]];
        let (hf, pool) = make(&cols_in, 2);
        let (bmin, bmax) = b();
        let a = build(&hf, &pool, 2, 1, 3, 2, 0, bmin, bmax, 1.0, 1.0).unwrap();
        let columns = [RcCompactCell { index: 0, count: 2 }, RcCompactCell { index: 2, count: 1 }];
        let solid = [
            FlatSpan { smin: 0, smax: 2, mask: 1, area: 63 },
            FlatSpan { smin: 10, smax: 12, mask: 1, area: 63 },
            FlatSpan { smin: 0, smax: 2, mask: 1, area: 63 },
        ];
        let c = build_from_flat(&columns, &solid, &[63, 63, 63], 2, 1, 3, 2, 0, bmin, bmax, 1.0, 1.0).unwrap();
        assert_eq!(a.cells, c.cells);
        assert_eq!(a.spans, c.spans);
        assert_eq!(a.areas, c.areas);
        // Deterministic.
        let c2 = build_from_flat(&columns, &solid, &[63, 63, 63], 2, 1, 3, 2, 0, bmin, bmax, 1.0, 1.0).unwrap();
        assert_eq!(c.spans, c2.spans);
    }

    #[test]
    fn too_many_layers_fails() {
        // Column 1 has 70 closely stacked layers that all line up with column 0's single span... each
        // neighbour layer within climb and with room, so the first match (layer 0) connects; to force a
        // layer index above MAX_LAYERS only layers past 62 may match: use floors that descend away.
        let mut col1: Vec<(i32, i32, i32)> = vec![];
        for i in 0..70 {
            col1.push((i * 10, i * 10 + 2, 63));
        }
        // Column 0's span sits at layer 65's height.
        let col0 = [(650, 652, 63)];
        let (hf, pool) = make(&[&col0, &col1], 2);
        let (bmin, bmax) = b();
        assert!(build(&hf, &pool, 2, 1, 3, 2, 0, bmin, bmax, 1.0, 1.0).is_none());
    }
}
