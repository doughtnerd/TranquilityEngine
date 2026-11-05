//! Recast's span filters over a linked-list heightfield (`RcFilters`).
use crate::constants::{get_dir_offset_x, get_dir_offset_y, RC_NULL_AREA, RC_SPAN_MAX_HEIGHT};
use crate::types::{heightfield_filters, Heightfield, SpanPool, NULL_SPAN};

/// Runs the filters selected by `filters` ([`heightfield_filters`] bits), in Recast's order here:
/// walkable low height, ledge, low hanging obstacles (`FilterHeightfield`).
pub fn filter_heightfield(
    filters: u8,
    heightfield: &Heightfield,
    pool: &mut SpanPool,
    height: i32,
    width: i32,
    walkable_height: i32,
    walkable_climb: i32,
) {
    if (filters & heightfield_filters::WALKABLE_LOW_HEIGHT) == heightfield_filters::WALKABLE_LOW_HEIGHT {
        filter_walkable_low_height_spans(heightfield, pool, width, height, walkable_height);
    }

    if (filters & heightfield_filters::LEDGE) == heightfield_filters::LEDGE {
        filter_ledge_spans(heightfield, pool, width, height, walkable_climb, walkable_height);
    }

    if (filters & heightfield_filters::LOW_HANGING_OBSTACLES) == heightfield_filters::LOW_HANGING_OBSTACLES {
        filter_low_hanging_obstacles_job(heightfield, pool, width, height, walkable_climb);
    }
}

/// The top of a span's open space: the next span's smin, or the heightfield's limit.
#[inline]
fn ceiling_of(pool: &SpanPool, next: u32) -> i32 {
    if next != NULL_SPAN {
        pool.get(next).smin
    } else {
        RC_SPAN_MAX_HEIGHT
    }
}

/// Marks spans with less than `walkable_height` of open space above them unwalkable
/// (`FilterWalkableLowHeightSpans`).
pub fn filter_walkable_low_height_spans(
    heightfield: &Heightfield,
    pool: &mut SpanPool,
    width: i32,
    height: i32,
    walkable_height: i32,
) {
    let x_size = width;
    let z_size = height;

    // Remove walkable flag from spans which do not have enough
    // space above them for the agent to stand there.
    for z in 0..z_size {
        for x in 0..x_size {
            let mut span = heightfield.spans[(x + z * x_size) as usize];
            while span != NULL_SPAN {
                let s = *pool.get(span);
                let floor = s.smax;
                let ceiling = ceiling_of(pool, s.next);
                if ceiling - floor < walkable_height {
                    pool.get_mut(span).area = RC_NULL_AREA;
                }
                span = s.next;
            }
        }
    }
}

/// Marks spans next to a drop of more than `walkable_climb` (ledges), or on too steep a slope,
/// unwalkable (`FilterLedgeSpans`).
pub fn filter_ledge_spans(
    heightfield: &Heightfield,
    pool: &mut SpanPool,
    width: i32,
    height: i32,
    walkable_climb: i32,
    walkable_height: i32,
) {
    let x_size = width;
    let z_size = height;
    for z in 0..z_size {
        for x in 0..x_size {
            let mut span = heightfield.spans[(x + z * x_size) as usize];
            while span != NULL_SPAN {
                let s = *pool.get(span);
                let next_span = s.next;

                // Skip non-walkable spans.
                if s.area == 0 {
                    span = next_span;
                    continue;
                }

                let floor = s.smax;
                let ceiling = ceiling_of(pool, s.next);

                // The difference between this walkable area and the lowest neighbor walkable area.
                // This is the difference between the current span and all neighbor spans that have
                // enough space for an agent to move between, but not accounting at all for surface slope.
                let mut lowest_neighbor_floor_difference = RC_SPAN_MAX_HEIGHT;

                // Min and max height of accessible neighbours.
                let mut lowest_traversable_neighbor_floor = s.smax;
                let mut highest_traversable_neighbor_floor = s.smax;

                for direction in 0..4 {
                    let neighbor_x = x + get_dir_offset_x(direction);
                    let neighbor_z = z + get_dir_offset_y(direction);

                    // Skip neighbours which are out of Bounds.
                    if neighbor_x < 0 || neighbor_z < 0 || neighbor_x >= x_size || neighbor_z >= z_size {
                        lowest_neighbor_floor_difference = -walkable_climb - 1;
                        break;
                    }

                    let mut neighbor_span = heightfield.spans[(neighbor_x + neighbor_z * x_size) as usize];

                    // The most we can step down to the neighbor is the walkableClimb distance.
                    // Start with the area under the neighbor span
                    let mut neighbor_ceiling =
                        if neighbor_span != NULL_SPAN { pool.get(neighbor_span).smin } else { RC_SPAN_MAX_HEIGHT };

                    // Skip neightbour if the gap between the spans is too small.
                    if ceiling.min(neighbor_ceiling) - floor >= walkable_height {
                        lowest_neighbor_floor_difference = -walkable_climb - 1;
                        break;
                    }

                    // For each span in the neighboring column...
                    while neighbor_span != NULL_SPAN {
                        let ns = *pool.get(neighbor_span);
                        let neighbor_floor = ns.smax;
                        neighbor_ceiling = ceiling_of(pool, ns.next);

                        // Only consider neighboring areas that have enough overlap to be potentially traversable.
                        if ceiling.min(neighbor_ceiling) - floor.max(neighbor_floor) < walkable_height {
                            // No space to traverse between them.
                            neighbor_span = ns.next;
                            continue;
                        }

                        let neighbor_floor_difference = neighbor_floor - floor;
                        lowest_neighbor_floor_difference = lowest_neighbor_floor_difference.min(neighbor_floor_difference);

                        // Find min/max accessible neighbor height.
                        // Only consider neighbors that are at most walkableClimb away.
                        if (neighbor_floor_difference as f32).abs() <= walkable_climb as f32 {
                            // There is space to move to the neighbor cell and the slope isn't too much.
                            lowest_traversable_neighbor_floor = lowest_traversable_neighbor_floor.min(neighbor_floor);
                            highest_traversable_neighbor_floor = highest_traversable_neighbor_floor.max(neighbor_floor);
                        } else if neighbor_floor_difference < -walkable_climb {
                            // We already know this will be considered a ledge span so we can early-out
                            break;
                        }
                        neighbor_span = ns.next;
                    }
                }

                // The current span is close to a ledge if the magnitude of the drop to any neighbour span is greater than the walkableClimb distance.
                // That is, there is a gap that is large enough to let an agent move between them, but the drop (surface slope) is too large to allow it.
                // (If this is the case, then biggestNeighborStepDown will be negative, so compare against the negative walkableClimb as a means of checking
                // the magnitude of the delta)
                if lowest_neighbor_floor_difference < -walkable_climb {
                    pool.get_mut(span).area = RC_NULL_AREA;
                }
                // If the difference between all neighbor floors is too large, this is a steep slope, so mark the span as an unwalkable ledge.
                else if highest_traversable_neighbor_floor - lowest_traversable_neighbor_floor > walkable_climb + 1 {
                    // a cell for rounding, as RcFlatHeightfield's
                    pool.get_mut(span).area = RC_NULL_AREA;
                }

                span = next_span;
            }
        }
    }
}

/// Marks an unwalkable span walkable (with the area below it) when it sits at most `walkable_climb`
/// above a walkable span, so low obstacles like curbs don't cut the walkable surface
/// (`FilterLowHangingObstaclesJob`).
pub fn filter_low_hanging_obstacles_job(
    heightfield: &Heightfield,
    pool: &mut SpanPool,
    width: i32,
    height: i32,
    walkable_climb: i32,
) {
    let x_size = width;
    let z_size = height;

    for z in 0..z_size {
        for x in 0..x_size {
            let mut previous_smax = 0; // previousRcSpan = default
            let mut previous_was_walkable = false;
            let mut previous_area_id = 0;

            // For each span in the column...
            let mut span = heightfield.spans[(x + z * x_size) as usize];
            while span != NULL_SPAN {
                let s = *pool.get(span);
                let walkable = s.area != 0;
                // If current span is not walkable, but there is walkable span just below it and the height difference
                // is small enough for the agent to walk over, mark the current span as walkable too.
                if !walkable && previous_was_walkable && s.smax - previous_smax <= walkable_climb {
                    pool.get_mut(span).area = previous_area_id;
                }

                // Copy the original walkable value regardless of whether we changed it.
                // This prevents multiple consecutive non-walkable spans from being erroneously marked as walkable.
                previous_was_walkable = walkable;
                previous_area_id = pool.get(span).area;

                previous_smax = s.smax;
                span = s.next;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rasterization::add_span;

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

    fn areas(hf: &Heightfield, pool: &SpanPool) -> Vec<Vec<i32>> {
        hf.spans
            .iter()
            .map(|&h| {
                let mut v = vec![];
                let mut s = h;
                while s != NULL_SPAN {
                    v.push(pool.get(s).area);
                    s = pool.get(s).next;
                }
                v
            })
            .collect()
    }

    #[test]
    fn low_height_spans_removed() {
        // Floor at 0..1, a ceiling slab at 3..4: 2 cells of space, agent needs 3.
        let (hf, mut pool) = make(&[&[(0, 1, 63), (3, 4, 63)]], 1);
        filter_walkable_low_height_spans(&hf, &mut pool, 1, 1, 3);
        assert_eq!(areas(&hf, &pool), vec![vec![0, 63]]);
        let (hf, mut pool) = make(&[&[(0, 1, 63), (4, 5, 63)]], 1);
        filter_walkable_low_height_spans(&hf, &mut pool, 1, 1, 3);
        assert_eq!(areas(&hf, &pool), vec![vec![63, 63]]);
    }

    #[test]
    fn ledge_spans_removed() {
        // 3x1 field: a tall middle (floor 10) beside lower sides (floor 0), climb 2: the high span
        // has a neighbour more than a climb below it, so it's a ledge; the border columns touch the edge.
        let (hf, mut pool) = make(&[&[(0, 1, 63)], &[(9, 10, 63)], &[(0, 1, 63)]], 3);
        filter_ledge_spans(&hf, &mut pool, 3, 1, 2, 3);
        assert_eq!(areas(&hf, &pool), vec![vec![0], vec![0], vec![0]]);
        // A flat 3x3 field keeps only its interior span.
        let flat: Vec<&[(i32, i32, i32)]> = (0..9).map(|_| &[(0, 1, 63)][..]).collect();
        let (hf, mut pool) = make(&flat, 3);
        filter_ledge_spans(&hf, &mut pool, 3, 3, 2, 3);
        let a = areas(&hf, &pool);
        for (i, col) in a.iter().enumerate() {
            assert_eq!(col[0], if i == 4 { 63 } else { 0 }, "column {i}");
        }
    }

    #[test]
    fn low_hanging_obstacle_becomes_walkable() {
        // A walkable floor with an unwalkable span 1 cell above its top (a curb): within climb.
        let (hf, mut pool) = make(&[&[(0, 1, 63), (2, 3, 0), (10, 11, 0)]], 1);
        filter_low_hanging_obstacles_job(&hf, &mut pool, 1, 1, 2);
        // The curb (smax 3 vs 1) is within climb 2; the one at 10 isn't.
        assert_eq!(areas(&hf, &pool), vec![vec![63, 63, 0]]);
    }

    #[test]
    fn filter_heightfield_runs_selected_filters_deterministically() {
        let run = || {
            let (hf, mut pool) = make(&[&[(0, 1, 63), (3, 4, 63)]], 1);
            filter_heightfield(heightfield_filters::WALKABLE_LOW_HEIGHT, &hf, &mut pool, 1, 1, 3, 1);
            areas(&hf, &pool)
        };
        assert_eq!(run(), run());
        assert_eq!(run(), vec![vec![0, 63]]);
    }
}
