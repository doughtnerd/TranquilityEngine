//! Recast's span filters over a flattened heightfield (`RcFlatHeightfield`): columns index into
//! spans, bottom to top. The geometry is shared between profiles and never modified; each profile
//! filters its own areas array, one entry per span. Same rules and order as
//! rcFilterLowHangingWalkableObstacles, rcFilterLedgeSpans, rcFilterWalkableLowHeightSpans.
use crate::constants::{get_dir_offset_x, get_dir_offset_y, RC_NULL_AREA, RC_SPAN_MAX_HEIGHT};
use crate::types::{FlatSpan, RcCompactCell};
use nav_math::math::{max, min};

/// Areas for one profile: the span's navmesh area where its mask has the profile's bit, else 0.
/// Returns the number of walkable spans, so callers can skip a tile with nothing for this profile.
/// `areas` must hold at least one entry per span.
pub fn init_areas(spans: &[FlatSpan], profile_bit: i32, areas: &mut [i32]) -> i32 {
    let bit = 1u32 << profile_bit;
    let mut walkable = 0;
    for i in 0..spans.len() {
        let w = (spans[i].mask & bit) != 0;
        areas[i] = if w { max(spans[i].area, 1) } else { RC_NULL_AREA }; // 1 = plain walkable
        if w {
            walkable += 1;
        }
    }

    walkable
}

/// Runs the three filters over one profile's `areas`, in order: low hanging obstacles, ledges, low
/// height (`Filter`).
pub fn filter(
    columns: &[RcCompactCell],
    spans: &[FlatSpan],
    areas: &mut [i32],
    width: i32,
    height: i32,
    walkable_height: i32,
    walkable_climb: i32,
) {
    filter_low_hanging_walkable_obstacles(columns, columns.len(), spans, areas, walkable_climb);
    filter_ledge_spans(columns, spans, areas, width, height, walkable_height, walkable_climb);
    filter_walkable_low_height_spans(columns, columns.len(), spans, areas, walkable_height);
}

fn ceiling(column: &RcCompactCell, spans: &[FlatSpan], i: i32) -> i32 {
    if i + 1 < column.index + column.count {
        spans[(i + 1) as usize].smin
    } else {
        RC_SPAN_MAX_HEIGHT
    }
}

fn filter_low_hanging_walkable_obstacles(
    columns: &[RcCompactCell],
    column_count: usize,
    spans: &[FlatSpan],
    areas: &mut [i32],
    walkable_climb: i32,
) {
    for c in 0..column_count {
        let column = columns[c];
        let mut previous_was_walkable = false;
        let mut previous_area = RC_NULL_AREA;
        let mut previous_smax = 0;

        for i in column.index..column.index + column.count {
            let iu = i as usize;
            let walkable = areas[iu] != RC_NULL_AREA;
            if !walkable && previous_was_walkable && spans[iu].smax - previous_smax <= walkable_climb {
                areas[iu] = previous_area;
            }

            // Uses the span's original walkability, like Recast, so changes don't cascade up the column.
            previous_was_walkable = walkable;
            previous_area = areas[iu];
            previous_smax = spans[iu].smax;
        }
    }
}

fn filter_ledge_spans(
    columns: &[RcCompactCell],
    spans: &[FlatSpan],
    areas: &mut [i32],
    width: i32,
    height: i32,
    walkable_height: i32,
    walkable_climb: i32,
) {
    for z in 0..height {
        for x in 0..width {
            let column = columns[(x + z * width) as usize];
            for i in column.index..column.index + column.count {
                let iu = i as usize;
                if areas[iu] == RC_NULL_AREA {
                    continue;
                }

                let floor = spans[iu].smax;
                let ceil = ceiling(&column, spans, i);

                let mut lowest_neighbor_floor_difference = RC_SPAN_MAX_HEIGHT;
                let mut lowest_traversable_neighbor_floor = floor;
                let mut highest_traversable_neighbor_floor = floor;

                for direction in 0..4 {
                    let nx = x + get_dir_offset_x(direction);
                    let nz = z + get_dir_offset_y(direction);
                    if nx < 0 || nz < 0 || nx >= width || nz >= height {
                        lowest_neighbor_floor_difference = -walkable_climb - 1;
                        break;
                    }

                    let neighbor = columns[(nx + nz * width) as usize];

                    // The space below the neighbour's first span.
                    let mut neighbor_ceiling =
                        if neighbor.count > 0 { spans[neighbor.index as usize].smin } else { RC_SPAN_MAX_HEIGHT };
                    if min(ceil, neighbor_ceiling) - floor >= walkable_height {
                        lowest_neighbor_floor_difference = -walkable_climb - 1;
                        break;
                    }

                    for k in neighbor.index..neighbor.index + neighbor.count {
                        let neighbor_floor = spans[k as usize].smax;
                        neighbor_ceiling = ceiling(&neighbor, spans, k);

                        if min(ceil, neighbor_ceiling) - max(floor, neighbor_floor) < walkable_height {
                            continue;
                        }

                        let neighbor_floor_difference = neighbor_floor - floor;
                        lowest_neighbor_floor_difference = min(lowest_neighbor_floor_difference, neighbor_floor_difference);

                        if neighbor_floor_difference.abs() <= walkable_climb {
                            lowest_traversable_neighbor_floor = min(lowest_traversable_neighbor_floor, neighbor_floor);
                            highest_traversable_neighbor_floor = max(highest_traversable_neighbor_floor, neighbor_floor);
                        } else if neighbor_floor_difference < -walkable_climb {
                            break;
                        }
                    }
                }

                // Steep slope: the floors either side differ by more than a step. One cell more than Recast allows,
                // for rounding: span tops round up and the step rounds down (0.5 m in 0.2 m cells is 2), so on an even
                // slope just under the step (40 degrees in 0.25 m columns rises 0.42 m over two) the range comes out
                // a cell over every few metres, and a false ledge band cut across the slope.
                if lowest_neighbor_floor_difference < -walkable_climb
                    || highest_traversable_neighbor_floor - lowest_traversable_neighbor_floor > walkable_climb + 1
                {
                    areas[iu] = RC_NULL_AREA;
                }
            }
        }
    }
}

fn filter_walkable_low_height_spans(
    columns: &[RcCompactCell],
    column_count: usize,
    spans: &[FlatSpan],
    areas: &mut [i32],
    walkable_height: i32,
) {
    for c in 0..column_count {
        let column = columns[c];
        for i in column.index..column.index + column.count {
            if ceiling(&column, spans, i) - spans[i as usize].smax < walkable_height {
                areas[i as usize] = RC_NULL_AREA;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fs(smin: i32, smax: i32, mask: u32, area: i32) -> FlatSpan {
        FlatSpan { smin, smax, mask, area }
    }

    #[test]
    fn init_areas_picks_profile_bit() {
        let spans = [fs(0, 1, 0b01, 5), fs(2, 3, 0b10, 0), fs(4, 5, 0b11, 7), fs(6, 7, 0, 9)];
        let mut a = [-1; 4];
        assert_eq!(init_areas(&spans, 0, &mut a), 2);
        assert_eq!(a, [5, 0, 7, 0]);
        assert_eq!(init_areas(&spans, 1, &mut a), 2);
        assert_eq!(a, [0, 1, 7, 0]); // area 0 becomes plain walkable (1)
    }

    #[test]
    fn low_height_and_low_hanging() {
        // One column: floor 0..1, curb 2..3 (unwalkable), ceiling slab at 10.
        let cols = [RcCompactCell { index: 0, count: 3 }];
        let spans = [fs(0, 1, 1, 1), fs(2, 3, 0, 1), fs(10, 11, 1, 1)];
        let mut areas = [1, 0, 1];
        filter_low_hanging_walkable_obstacles(&cols, 1, &spans, &mut areas, 2);
        assert_eq!(areas, [1, 1, 1]);
        let mut areas = [1, 1, 1];
        filter_walkable_low_height_spans(&cols, 1, &spans, &mut areas, 5);
        // Span 0's open space ends at the next span's smin (2): 2 - 1 = 1 < 5. Span 1 has 10 - 3 = 7.
        assert_eq!(areas, [0, 1, 1]);
    }

    #[test]
    fn ledge_flat_field_keeps_interior_only_and_is_deterministic() {
        let cols: Vec<RcCompactCell> = (0..9).map(|i| RcCompactCell { index: i, count: 1 }).collect();
        let spans: Vec<FlatSpan> = (0..9).map(|_| fs(0, 1, 1, 1)).collect();
        let run = || {
            let mut areas = vec![1; 9];
            filter(&cols, &spans, &mut areas, 3, 3, 3, 2);
            areas
        };
        let a = run();
        assert_eq!(a, run());
        assert_eq!(a, vec![0, 0, 0, 0, 1, 0, 0, 0, 0]);
    }

    #[test]
    fn ledge_drop_is_removed() {
        // 3x1: high centre between low sides.
        let cols: Vec<RcCompactCell> = (0..3).map(|i| RcCompactCell { index: i, count: 1 }).collect();
        let spans = vec![fs(0, 1, 1, 1), fs(9, 10, 1, 1), fs(0, 1, 1, 1)];
        let mut areas = vec![1; 3];
        filter_ledge_spans(&cols, &spans, &mut areas, 3, 1, 3, 2);
        assert_eq!(areas, vec![0, 0, 0]);
    }
}
