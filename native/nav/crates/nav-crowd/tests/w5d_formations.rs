//! Foxfire's `NavFormationsTests` (31), ported: formation presets, rotation, painted masks, layers, squeezing,
//! flocking, avoidance tie-breaks between groups, bending columns, falling in, turning in place and flying home.
//! Pure functions: no world needed.
use nav_crowd::avoidance::{responsibility, BodyKind, NeighborBody};
use nav_crowd::components::{NavFormationPreset, NavGroup, NavGroupMode};
use nav_crowd::formations::{self, trail, turn};
use nav_crowd::groups::{flight, squeeze};
use nav_math::{Float2, Float3, Hash128};
use nav_query::chunks::ChunkEntry;
use std::collections::{BTreeMap, HashSet};

const MAX_COUNT: i32 = 40;
const TOLERANCE: f32 = 1e-4;
const SPACINGS: [f32; 2] = [1.0, 3.0];
const PRESETS: [NavFormationPreset; 6] =
    [NavFormationPreset::Box, NavFormationPreset::Line, NavFormationPreset::Column, NavFormationPreset::Wedge, NavFormationPreset::Circle, NavFormationPreset::Mask];

fn v3(x: f32, y: f32, z: f32) -> Float3 {
    Float3::new(x, y, z)
}

fn offsets_of(preset: NavFormationPreset, spacing: f32, count: i32) -> Vec<Float3> {
    (0..count).map(|slot| formations::preset_offset(preset, spacing, slot, count)).collect()
}

fn assert_near(expected: Float3, actual: Float3, what: &str) {
    assert!(expected.distance(actual) < 1e-4, "{what}: expected {expected:?}, was {actual:?}");
}

#[test]
fn offsets_are_level() {
    for preset in PRESETS {
        for spacing in SPACINGS {
            for count in 1..=MAX_COUNT {
                for (slot, o) in offsets_of(preset, spacing, count).iter().enumerate() {
                    assert_eq!(o.y, 0.0, "{preset:?} spacing {spacing} count {count} slot {slot}: y");
                }
            }
        }
    }
}

#[test]
fn slot_zero_is_at_the_front() {
    for preset in PRESETS {
        for spacing in SPACINGS {
            for count in 1..=MAX_COUNT {
                let o = offsets_of(preset, spacing, count);
                for slot in 1..count as usize {
                    assert!(o[0].z >= o[slot].z - TOLERANCE, "{preset:?} spacing {spacing} count {count}: slot {slot} is ahead of slot 0");
                }
            }
        }
    }
}

#[test]
fn slots_keep_their_distance() {
    for preset in [NavFormationPreset::Wedge, NavFormationPreset::Line, NavFormationPreset::Column, NavFormationPreset::Box] {
        for spacing in SPACINGS {
            for count in 1..=MAX_COUNT {
                let o = offsets_of(preset, spacing, count);
                for i in 0..o.len() {
                    for j in i + 1..o.len() {
                        assert!(o[i].distance(o[j]) >= spacing - TOLERANCE, "{preset:?} spacing {spacing} count {count}: slots {i} and {j}");
                    }
                }
            }
        }
    }
}

#[test]
fn circle_neighbours_are_a_chord_apart_and_no_slots_closer_than_that() {
    for spacing in SPACINGS {
        for count in 2..=MAX_COUNT {
            let radius = (spacing * count as f32 / (2.0 * std::f32::consts::PI)).max(0.5 * spacing);
            let chord = 2.0 * radius * (std::f32::consts::PI / count as f32).sin();
            assert!(chord >= 0.86 * spacing, "spacing {spacing} count {count}: the ring is not much tighter than the spacing");
            let o = offsets_of(NavFormationPreset::Circle, spacing, count);
            for i in 0..o.len() {
                assert!((radius - o[i].length()).abs() <= 1e-3, "spacing {spacing} count {count} slot {i}: on the ring");
                for j in i + 1..o.len() {
                    assert!(o[i].distance(o[j]) >= chord - TOLERANCE, "spacing {spacing} count {count}: slots {i} and {j}");
                }
            }
        }
    }
}

#[test]
fn circle_one_member_stands_on_the_pivot() {
    assert_eq!(formations::preset_offset(NavFormationPreset::Circle, 3.0, 0, 1), Float3::default());
}

#[test]
fn box_rows_are_at_most_a_square_wide_filled_from_the_front_and_centred_on_x() {
    for spacing in SPACINGS {
        for count in 1..=MAX_COUNT {
            let columns = (count as f32).sqrt().ceil() as usize;
            let offsets = offsets_of(NavFormationPreset::Box, spacing, count);
            let mut rows: BTreeMap<i32, Vec<f32>> = BTreeMap::new();
            for o in &offsets {
                let row = (-o.z / spacing).round() as i32;
                assert!((-(row as f32) * spacing - o.z).abs() <= TOLERANCE, "spacing {spacing} count {count}: z is a whole number of rows");
                rows.entry(row).or_default().push(o.x);
            }
            assert_eq!(rows.len(), (count as usize).div_ceil(columns), "spacing {spacing} count {count}: rows");
            let n_rows = rows.len() as i32;
            let mut sum = 0.0;
            for (expected_row, (row, xs)) in rows.iter().enumerate() {
                assert_eq!(expected_row as i32, *row, "rows are consecutive from the front");
                assert!(xs.len() <= columns, "at most ceil(sqrt(count)) wide");
                if *row < n_rows - 1 {
                    assert_eq!(xs.len(), columns, "spacing {spacing} count {count} row {row}: only the last row is short");
                }
                let row_sum: f32 = xs.iter().sum();
                assert!((row_sum / xs.len() as f32).abs() <= TOLERANCE, "spacing {spacing} count {count} row {row}: centred");
                sum += row_sum;
            }
            assert!((sum / count as f32).abs() <= TOLERANCE, "the whole formation is centred on x");
        }
    }
}

#[test]
fn rotate_forward_plus_x_maps_local_forward_to_world_x_and_local_right_to_minus_z() {
    let forward = v3(1.0, 0.0, 0.0);
    assert_near(v3(1.0, 0.0, 0.0), formations::rotate(v3(0.0, 0.0, 1.0), forward), "local +z (front)");
    assert_near(v3(0.0, 0.0, -1.0), formations::rotate(v3(1.0, 0.0, 0.0), forward), "local +x (right)");
    assert_near(v3(-3.0, 0.0, -2.0), formations::rotate(v3(2.0, 0.0, -3.0), forward), "2 right (-z), 3 back (-x)");
}

#[test]
fn rotate_forward_plus_z_changes_nothing() {
    let offset = v3(1.5, 0.0, -2.5);
    assert_near(offset, formations::rotate(offset, v3(0.0, 0.0, 1.0)), "facing +z is the formation's own frame");
}

#[test]
fn rotate_forward_minus_z_flips_both() {
    assert_near(v3(-1.5, 0.0, 2.5), formations::rotate(v3(1.5, 0.0, -2.5), v3(0.0, 0.0, -1.0)), "facing -z");
}

#[test]
fn rotate_ignores_height_and_length_of_forward_and_keeps_the_offsets_height() {
    let offset = v3(1.0, 0.5, 2.0);
    let level = formations::rotate(offset, v3(1.0, 0.0, 0.0));
    assert_near(level, formations::rotate(offset, v3(7.0, 4.0, 0.0)), "forward's y and length don't matter");
    assert!((level.y - 0.5).abs() <= TOLERANCE, "the offset's own y is kept");
}

#[test]
fn rotate_zero_forward_falls_back_to_plus_z() {
    let offset = v3(1.5, 0.0, -2.5);
    assert_near(offset, formations::rotate(offset, Float3::default()), "no heading: unrotated");
    assert_near(offset, formations::rotate(offset, v3(0.0, 3.0, 0.0)), "straight up has no level heading either");
}

#[test]
fn rotate_keeps_lengths_and_distances_between_slots() {
    let forwards = [v3(1.0, 0.0, 0.0), v3(0.0, 0.0, 1.0), v3(-1.0, 0.0, 1.0), v3(0.3, 0.0, -0.9), v3(-5.0, 2.0, -0.1)];
    for preset in PRESETS {
        for forward in forwards {
            let o = offsets_of(preset, 3.0, 13);
            let w: Vec<Float3> = o.iter().map(|&x| formations::rotate(x, forward)).collect();
            for i in 0..o.len() {
                assert!((o[i].length() - w[i].length()).abs() <= 1e-3, "{preset:?} {forward:?} slot {i}: length");
                for j in i + 1..o.len() {
                    assert!((o[i].distance(o[j]) - w[i].distance(w[j])).abs() <= 1e-3, "{preset:?} {forward:?}: slots {i} and {j}");
                }
            }
        }
    }
}

// ------------------------------------------------------------------------------------------ G5: masks, layers, squeeze

/// A width x height bit grid with the cells (x, row) set.
fn grid(width: i32, height: i32, cells: &[(i32, i32)]) -> Vec<u64> {
    let mut bits = vec![0u64; ((width * height + 63) / 64) as usize];
    for &(x, y) in cells {
        let i = y * width + x;
        bits[(i >> 6) as usize] |= 1u64 << (i & 63);
    }
    bits
}

fn block(x0: i32, row0: i32, columns: i32, rows: i32) -> Vec<(i32, i32)> {
    let mut cells = Vec::new();
    for r in 0..rows {
        for x in 0..columns {
            cells.push((x0 + x, row0 + r));
        }
    }
    cells
}

fn mask_group(spacing: f32) -> NavGroup {
    NavGroup { formation: NavFormationPreset::Mask, spacing, ..NavGroup::default() }
}

#[test]
fn mask_fills_front_centre_first_then_out_then_the_rows_behind() {
    let mask = formations::create_mask(&grid(5, 2, &block(0, 0, 5, 2)), 5, 2);
    let group = mask_group(2.0);
    let expected = [
        v3(0.0, 0.0, 0.0),
        v3(2.0, 0.0, 0.0),
        v3(-2.0, 0.0, 0.0),
        v3(4.0, 0.0, 0.0),
        v3(-4.0, 0.0, 0.0),
        v3(0.0, 0.0, -2.0),
        v3(2.0, 0.0, -2.0),
        v3(-2.0, 0.0, -2.0),
        v3(4.0, 0.0, -2.0),
        v3(-4.0, 0.0, -2.0),
    ];
    assert_eq!(mask.slots.len(), 10);
    assert_eq!(mask.width, 5);
    assert_eq!(mask.depth, 2);
    for (i, e) in expected.iter().enumerate() {
        assert_near(*e, formations::offset(&group, Some(&mask), i as i32, 10), &format!("slot {i}"));
    }
}

#[test]
fn mask_pivot_is_the_front_rows_centre_wherever_the_shape_is_painted() {
    let a = formations::create_mask(&grid(4, 2, &block(0, 0, 4, 2)), 4, 2);
    let b = formations::create_mask(&grid(16, 16, &block(7, 9, 4, 2)), 16, 16);
    let group = mask_group(1.0);
    assert_near(v3(0.5, 0.0, 0.0), formations::offset(&group, Some(&a), 0, 8), "slot 0: right of the centre line");
    assert_near(v3(-0.5, 0.0, 0.0), formations::offset(&group, Some(&a), 1, 8), "slot 1: left of it");
    for i in 0..8 {
        assert_near(formations::offset(&group, Some(&a), i, 8), formations::offset(&group, Some(&b), i, 8), &format!("slot {i}: same shape, painted elsewhere"));
    }
}

#[test]
fn mask_members_past_its_slots_stand_in_rows_behind_it() {
    let mask = formations::create_mask(&grid(3, 1, &block(0, 0, 3, 1)), 3, 1);
    let group = mask_group(2.0);
    let mut xs = HashSet::new();
    for i in 3..6 {
        let o = formations::offset(&group, Some(&mask), i, 6);
        assert!((o.z + 2.0).abs() <= 1e-4, "slot {i}: a row behind the shape");
        xs.insert(o.x.to_bits());
    }
    assert_eq!(xs.len(), 3, "the extra row is abreast, not stacked");
}

#[test]
fn mask_empty_or_missing_stands_as_a_box() {
    let empty = formations::create_mask(&grid(4, 4, &[]), 4, 4);
    let group = mask_group(3.0);
    assert!(empty.slots.is_empty());
    for i in 0..7 {
        let b = formations::preset_offset(NavFormationPreset::Box, 3.0, i, 7);
        assert_near(b, formations::offset(&group, Some(&empty), i, 7), &format!("empty mask, slot {i}"));
        assert_near(b, formations::offset(&group, None, i, 7), &format!("no mask, slot {i}"));
    }
}

#[test]
fn layers_stack_each_column_centre_then_above_then_below() {
    let mut group = NavGroup { formation: NavFormationPreset::Line, spacing: 3.0, layers: 3, layer_spacing: 2.0, ..NavGroup::default() };
    assert_near(v3(0.0, 0.0, 0.0), formations::offset(&group, None, 0, 6), "slot 0: front centre");
    assert_near(v3(0.0, 2.0, 0.0), formations::offset(&group, None, 1, 6), "slot 1: above it");
    assert_near(v3(0.0, -2.0, 0.0), formations::offset(&group, None, 2, 6), "slot 2: below it");
    assert_near(v3(3.0, 0.0, 0.0), formations::offset(&group, None, 3, 6), "slot 3: the next column");
    assert_near(v3(3.0, 2.0, 0.0), formations::offset(&group, None, 4, 6), "slot 4: above that");
    group.layer_spacing = 0.0;
    assert!((formations::offset(&group, None, 1, 6).y - 3.0).abs() <= 1e-4, "LayerSpacing 0: Spacing");
}

#[test]
fn squeezed_stands_in_rows_that_many_abreast_centred_on_shift() {
    for preset in PRESETS {
        let mut group = NavGroup { formation: preset, spacing: 2.0, columns: 1, shift: 0.5, ..NavGroup::default() };
        for i in 0..5 {
            assert_near(v3(0.5, 0.0, -2.0 * i as f32), formations::offset(&group, None, i, 5), &format!("{preset:?} single file, slot {i}"));
        }
        group.columns = 2;
        group.shift = 0.0;
        assert_near(v3(1.0, 0.0, 0.0), formations::offset(&group, None, 0, 5), "two abreast, slot 0");
        assert_near(v3(-1.0, 0.0, 0.0), formations::offset(&group, None, 1, 5), "two abreast, slot 1");
        assert_near(v3(0.0, 0.0, -4.0), formations::offset(&group, None, 4, 5), "the odd one out, centred behind");
    }
}

#[test]
fn squeeze_narrow_room_squeezes_to_what_fits_and_reforms_only_with_room_to_spare() {
    // A 3 x 3 Box 3 m apart reaches 3 m each side; with half a spacing for the bodies it needs 4.5 m each side.
    let mut group = NavGroup { spacing: 3.0, ..NavGroup::default() };
    let far = 100.0; // gone far enough since the gap to widen
    let r = |a: f32, b: f32| Float2::new(a, b);
    squeeze::apply(&mut group, None, 9, r(5.0, 5.0), far, false);
    assert_eq!(group.columns, 0, "room for the shape: unsqueezed");

    squeeze::apply(&mut group, None, 9, r(2.0, 2.0), 0.0, false); // 4 m wide: 1 m for centres
    assert_eq!(group.columns, 1, "a 4 m gap: single file, at once");
    assert!(group.shift.abs() <= 1e-4, "centred");

    squeeze::apply(&mut group, None, 9, r(1.0, 3.0), 0.0, false);
    assert!((group.shift - 1.0).abs() <= 1e-4, "rows centred in the room, right of the pivot");

    // Single file, nine deep: 27 m long. It widens only once it has gone that far past the gap.
    squeeze::apply(&mut group, None, 9, r(6.1, 6.1), 20.0, false);
    assert_eq!(group.columns, 1, "room again, but the rear isn't through the gap yet (20 of 27 m)");
    squeeze::apply(&mut group, None, 9, r(4.6, 4.6), 8.0, false);
    assert_eq!(group.columns, 2, "28 m on: wider, by what fits less half a spacing");
    squeeze::apply(&mut group, None, 9, r(2.0, 2.0), 0.0, false);
    squeeze::apply(&mut group, None, 9, r(6.1, 6.1), 20.0, false);
    assert_eq!(group.columns, 1, "narrow again on the way: the distance counts from there");

    squeeze::apply(&mut group, None, 9, r(6.1, 6.1), far, false);
    assert_eq!(group.columns, 0, "half a spacing to spare each side, the rear through: its own shape again");
    assert_eq!(group.shift, 0.0);

    squeeze::apply(&mut group, None, 9, r(4.6, 4.6), 0.0, false);
    assert_eq!(group.columns, 0, "unsqueezed, it stays so while the shape fits");
}

#[test]
fn squeeze_off_or_alone_stands_as_its_own_shape() {
    let mut group = NavGroup { columns: 2, squeeze: false, ..NavGroup::default() };
    assert!(!squeeze::due(&mut group, 9, 100.0));
    assert_eq!(group.columns, 0, "squeeze off");
    group.squeeze = true;
    group.columns = 2;
    assert!(!squeeze::due(&mut group, 1, 100.0));
    assert_eq!(group.columns, 0, "one member");
    assert!(squeeze::due(&mut group, 9, 100.0), "due");
    assert!(!squeeze::due(&mut group, 9, 100.0 + 0.5 * squeeze::INTERVAL as f64), "not again within Interval");
}

#[test]
fn flock_target_is_the_member_within_the_radius_else_the_nearest_point_on_it() {
    let mut group = NavGroup { mode: NavGroupMode::Flock, flock_radius: 5.0, ..NavGroup::default() };
    let up = v3(0.0, 1.0, 0.0);
    let pivot = v3(10.0, 0.0, 10.0);
    let inside = pivot + v3(3.0, 0.0, 0.0);
    assert_near(inside, formations::target(&group, None, pivot, 0, 8, inside, up), "inside: no pull");
    let outside = pivot + v3(0.0, 0.0, 9.0);
    assert_near(pivot + v3(0.0, 0.0, 5.0), formations::target(&group, None, pivot, 0, 8, outside, up), "outside: the radius's edge");
    let above = pivot + v3(3.0, 7.0, 0.0);
    assert_near(above, formations::target(&group, None, pivot, 0, 8, above, up), "level (walkers): height doesn't count");
    assert!(formations::target(&group, None, pivot, 0, 8, above, Float3::default()).distance(above) > 1.0, "3D (flyers): it does");

    group.flock_radius = 0.0;
    group.spacing = 3.0;
    assert!(formations::leash(&group, 16) > formations::leash(&group, 4), "sized to the group");
    group.mode = NavGroupMode::Formation;
    assert_near(formations::slot(&group, None, pivot, 2, 8), formations::target(&group, None, pivot, 2, 8, outside, up), "formation mode: the slot");
}

#[test]
fn groups_meeting_at_equal_priority_the_older_goes_first() {
    let own = 20;
    let mut other = NeighborBody { kind: BodyKind::Steering, priority: 20, ..NeighborBody::default() };
    assert!((responsibility(own, 0, &other, 0) - 0.5).abs() <= 1e-4, "two agents on their own: half each");
    other.group = 3;
    assert!((responsibility(own, 3, &other, 0) - 0.5).abs() <= 1e-4, "one group: half each");
    let older = responsibility(own, 2, &other, 0);
    let younger = responsibility(own, 5, &other, 0);
    assert!(older < 0.5, "the older group (lower index) avoids less");
    assert!(younger > 0.5, "the younger gives way");
    assert!((older + younger - 1.0).abs() <= 1e-4, "between them, the whole of it");
    assert!((responsibility(own, 0, &other, 0) - 0.5).abs() <= 1e-4, "a lone agent and a member: half each");
    other.priority = 10;
    assert!(responsibility(own, 2, &other, 0) > 0.5, "priority still comes first");
}

#[test]
fn members_of_one_group_meeting_the_one_bound_for_the_front_slot_goes_first() {
    let own = 20;
    let mut other = NeighborBody { kind: BodyKind::Steering, priority: 20, group: 3, rank: 6, ..NeighborBody::default() }; // slot 5
    let front = responsibility(own, 3, &other, 2); // self bound for slot 1
    assert!(front < 0.5, "bound for the slot nearer the front: it avoids less");
    other.rank = 1; // slot 0
    let back = responsibility(own, 3, &other, 2);
    assert!(back > 0.5, "bound further back: it gives way");
    assert!((front + back - 1.0).abs() <= 1e-4, "the same split either way round");
    assert!((responsibility(own, 3, &other, 0) - 0.5).abs() <= 1e-4, "no rank of its own: half each");
    other.priority = 10;
    assert!(responsibility(own, 3, &other, 1) > 0.5, "priority still comes first");
}

// ------------------------------------------------------------------------------------ bending columns (trail)

/// Within 0.15 m: trail points fall every half metre, give or take a 0.1 m step of the walk.
fn assert_within(expected: Float3, actual: Float3, what: &str) {
    assert!(expected.distance(actual) < 0.15, "{what}: expected {expected:?}, was {actual:?}");
}

fn column_group(bend: bool) -> NavGroup {
    NavGroup { formation: NavFormationPreset::Column, spacing: 2.0, bend_columns: bend, ..NavGroup::default() }
}

/// Walks the pivot along the points in 0.1 m steps, recording the trail as the pace step does.
fn walk(trail_pts: &mut Vec<Float3>, group: &NavGroup, count: i32, points: &[Float3]) -> Float3 {
    let mut at = points[0];
    trail::record(trail_pts, at, group, count);
    for i in 1..points.len() {
        let length = points[i - 1].distance(points[i]);
        let steps = (length / 0.1).ceil() as i32;
        for k in 1..=steps {
            at = points[i - 1].lerp(points[i], k as f32 / steps as f32);
            trail::record(trail_pts, at, group, count);
        }
    }
    at
}

#[test]
fn bending_column_round_a_corner_slots_stand_along_the_way_the_group_came() {
    let mut t = Vec::new();
    let mut group = column_group(true);
    group.forward = v3(0.0, 0.0, 1.0);
    // East along z = 0 to the corner at the origin, then north 4 m.
    let pivot = walk(&mut t, &group, 6, &[v3(-12.0, 0.0, 0.0), Float3::default(), v3(0.0, 0.0, 4.0)]);

    assert_within(v3(0.0, 0.0, 2.0), formations::slot_on_trail(&group, None, pivot, 1, 6, &t, true), "slot 1, 2 m back: up the north leg");
    assert_within(Float3::default(), formations::slot_on_trail(&group, None, pivot, 2, 6, &t, true), "slot 2, 4 m back: the corner");
    assert_within(v3(-2.0, 0.0, 0.0), formations::slot_on_trail(&group, None, pivot, 3, 6, &t, true), "slot 3, 6 m back: round the corner");
    assert_within(v3(-6.0, 0.0, 0.0), formations::slot_on_trail(&group, None, pivot, 5, 6, &t, true), "slot 5, 10 m back");

    let mut straight = column_group(false);
    straight.forward = group.forward;
    assert_within(v3(0.0, 0.0, -2.0), formations::slot_on_trail(&straight, None, pivot, 3, 6, &t, true), "BendColumns off: straight behind");
    assert_within(v3(0.0, 0.0, -2.0), formations::slot_on_trail(&group, None, pivot, 3, 6, &t, false), "no trail: straight behind");

    // Kept only as long as the deepest single file needs: (6 + 2) x 2 m.
    let mut length = pivot.distance(*t.last().unwrap());
    for i in (1..t.len()).rev() {
        length += t[i].distance(t[i - 1]);
    }
    assert!(length <= 16.0 + 2.0 * trail::STEP, "the trail is trimmed to what the column can use ({length})");
    assert!(length >= 16.0 - trail::STEP, "and keeps that much ({length})");
}

#[test]
fn bending_column_past_the_trails_end_carries_on_straight() {
    let mut t = Vec::new();
    let group = column_group(true);
    let pivot = walk(&mut t, &group, 6, &[v3(0.0, 0.0, -3.0), Float3::default()]); // only 3 m of trail, heading north
    assert_within(v3(0.0, 0.0, -8.0), formations::slot_on_trail(&group, None, pivot, 4, 6, &t, true), "8 m back: on past the trail's start, straight");
}

#[test]
fn bending_column_turning_back_starts_the_trail_again() {
    let mut t = Vec::new();
    let group = column_group(true);
    walk(&mut t, &group, 6, &[v3(0.0, 0.0, -10.0), Float3::default()]);
    assert!(t.len() > 10, "setup: a trail");
    walk(&mut t, &group, 6, &[Float3::default(), v3(0.0, 0.0, -0.6)]); // straight back the way it came
    assert!(t.len() <= 2, "turned back: the old trail would fold the column over, so it starts again");
}

#[test]
fn falling_in_a_member_ahead_of_its_place_in_the_column_waits_one_behind_it_comes_on() {
    let mut t = Vec::new();
    let mut group = column_group(true); // Spacing 2, Slack 4
    let pivot = walk(&mut t, &group, 10, &[v3(0.0, 0.0, -30.0), Float3::default()]);
    group.velocity = v3(0.0, 0.0, 2.0); // on the move
    let up = v3(0.0, 1.0, 0.0);

    let slot = formations::slot_on_trail(&group, None, pivot, 8, 10, &t, true);
    assert_within(v3(0.0, 0.0, -16.0), slot, "setup: slot 8");
    let waits = |at: Float3| trail::waits(&group, None, 8, 10, pivot, at, slot - at, up, &t, true);

    assert!(waits(v3(1.0, 0.0, -1.0)), "by the pivot, 15 m ahead of its slot: it waits for the column to come past");
    let at = v3(1.5, 0.0, -1.0);
    let (w, in_line) = trail::waits_place(&group, None, 8, 10, pivot, at, slot - at, up, &t, true);
    assert!(w);
    assert_within(v3(0.0, 0.0, -1.0), in_line, "meanwhile it steps into the column's line where it is");
    assert!(!waits(v3(0.0, 0.0, -14.5)), "near its slot: no waiting");
    assert!(!waits(v3(0.0, 0.0, -26.0)), "behind its slot: it comes on");
    assert!(!trail::waits(&group, None, 1, 10, pivot, v3(5.0, 0.0, 0.0), v3(-5.0, 0.0, -2.0), up, &t, true), "slot 1, a spacing back: never waits");

    let mut stopped = group;
    stopped.velocity = Float3::default();
    let at = v3(1.0, 0.0, -1.0);
    assert!(!trail::waits(&stopped, None, 8, 10, pivot, at, slot - at, up, &t, true), "the group stopped: it goes to its slot");

    let boxed = NavGroup::default(); // in the open, unsqueezed
    assert!(!trail::waits(&boxed, None, 8, 10, pivot, at, v3(0.0, 0.0, -15.0), up, &t, true), "not a column: no waiting");
}

#[test]
fn falling_in_place_in_the_column_is_measured_along_the_trail() {
    let mut t = Vec::new();
    let group = column_group(true);
    let pivot = walk(&mut t, &group, 10, &[v3(-12.0, 0.0, 0.0), Float3::default(), v3(0.0, 0.0, 4.0)]); // round a corner
    let up = v3(0.0, 1.0, 0.0);
    assert!((trail::back(&t, true, pivot, group.forward, v3(-2.0, 0.0, 0.5), up) - 6.0).abs() <= 0.15, "2 m down the first leg past the corner: 6 m back");
    assert!((trail::back(&t, true, pivot, group.forward, v3(-15.0, 0.0, 0.0), up) - 19.0).abs() <= 0.15, "3 m past the trail's start: straight on");
}

#[test]
fn turning_in_place_moves_back_only_as_far_as_its_members_stand() {
    let mut t = Vec::new();
    let mut group = column_group(true);
    group.forward = v3(0.0, 0.0, 1.0);
    let pivot = walk(&mut t, &group, 10, &[v3(0.0, 0.0, -30.0), Float3::default()]);
    group.previous_position = pivot;

    let mut t1 = t.clone();
    let front = turn::check(&mut group, &mut t1, None, 10, 4.0, 1.0).expect("turns");
    assert_within(v3(0.0, 0.0, -4.0), front, "back as far as its rearmost member, not its column's length");
    assert_within(v3(0.0, 0.0, -1.0), group.forward, "facing the other way");

    let mut bunched = column_group(true);
    bunched.forward = v3(0.0, 0.0, 1.0);
    bunched.previous_position = pivot;
    let mut t2 = t.clone();
    assert!(turn::check(&mut bunched, &mut t2, None, 10, 1.0, 1.0).is_none(), "all within a spacing of the pivot: it swings round");
}

#[test]
fn flyer_outside_every_loaded_chunk_heads_back_into_its_own() {
    // Two loaded boxes side by side (x -10..0 and 0..10, z -5..5).
    let ty = Hash128::new(1, 2, 3, 4);
    let chunks = vec![
        ChunkEntry { agent_type: ty, bounded: true, bounds_min: v3(-10.0, -4.0, -5.0), bounds_max: v3(0.0, 20.0, 5.0), ..ChunkEntry::default() },
        ChunkEntry { agent_type: ty, bounded: true, bounds_min: v3(0.0, -4.0, -5.0), bounds_max: v3(10.0, 20.0, 5.0), ..ChunkEntry::default() },
    ];
    let home = flight::home(&chunks, 0, v3(-4.0, 6.0, 12.0)).expect("7 m past the far side of its box: out of loaded space");
    assert_near(v3(-4.0, 6.0, 4.0), home, "home: straight back in, a metre inside its face");
    assert!(flight::home(&chunks, 0, v3(5.0, 6.0, 0.0)).is_none(), "in the neighbour's box");
    assert!(flight::home(&chunks, 0, v3(-5.0, 6.0, 0.0)).is_none(), "in its own box");
    assert_eq!(flight::box_holding(&chunks, ty, v3(5.0, 0.0, 0.0)), 1, "the neighbour's box holds it");
}

#[test]
fn bending_column_only_while_squeezed_or_a_column() {
    let mut group = NavGroup::default(); // a Box
    assert!(!trail::bends(&group), "a Box in the open stands as its shape");
    group.columns = 2;
    assert!(trail::bends(&group), "squeezed: along the trail");
    group.mode = NavGroupMode::Flock;
    assert!(!trail::bends(&group), "a flock has no rows");
    assert!(trail::bends(&column_group(true)), "a Column: along the trail");
    assert!(!trail::bends(&column_group(false)), "BendColumns off");
}
