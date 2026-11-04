//! Formations (Foxfire's `Runtime/Lib/NavFormations.cs`): where a group's slots are, bending columns along the
//! group's trail ([`trail`], `NavGroupTrail`) and turning in place ([`turn`], `NavGroupTurn`). Pure functions of a
//! [`NavGroup`], its painted shape ([`NavFormationData`], formation `Mask`) and its trail (`GroupData::trail`, oldest
//! point first).
//!
//! Slots are offsets in the formation's frame: x to the right, z forward, y up. Slot 0 is front centre, and slots fill
//! outward and backward, so a group of n uses the first n and a partial group still looks right. A group squeezed
//! into a passage (`NavGroup::columns`) stands in rows that many abreast instead, whatever its shape. Nothing is
//! stored per slot.
//!
//! Same float operation order as the C#; `sincos` is `std`'s (`nav_math` doesn't port it: runtime steering needn't be
//! bit-exact with Unity).
use crate::components::{NavFormationPreset, NavGroup, NavGroupMode};
use nav_format::blob::NavFormationData;
use nav_math::math::{self, PI};
use nav_math::{Float2, Float3};

const FORWARD: Float3 = Float3::new(0.0, 0.0, 1.0);

/// `Offset(in NavGroup, mask, slot, count)`: the slot's offset in the formation's frame, for a group of `count`
/// members: its shape (preset, or the mask if the formation is `Mask` and the mask has slots), squeezed to `columns`
/// abreast while that's above 0, stacked `layers` deep.
pub fn offset(group: &NavGroup, mask: Option<&NavFormationData>, slot: i32, count: i32) -> Float3 {
    // Layers: each column fills its layers (centre, above, below, ...) before the next column.
    let layers = group.layers.max(1);
    let cell = slot / layers;
    let cells = (count.max(1) + layers - 1) / layers;
    let spacing = group.spacing;

    let mut offset = if group.columns > 0 {
        rows(cell, cells, group.columns) * spacing + Float3::new(group.shift, 0.0, 0.0)
    } else if let Some(m) = mask.filter(|m| group.formation == NavFormationPreset::Mask && !m.slots.is_empty()) {
        mask_offset(m, cell, cells) * spacing
    } else {
        preset_offset(group.formation, spacing, cell, cells)
    };

    if layers > 1 {
        offset.y = centre_out(slot - cell * layers) * if group.layer_spacing > 0.0 { group.layer_spacing } else { spacing };
    }
    offset
}

/// `Slot` without a trail: the pivot plus the slot's offset turned to the group's forward.
pub fn slot(group: &NavGroup, mask: Option<&NavFormationData>, pivot: Float3, slot: i32, count: i32) -> Float3 {
    pivot + rotate(offset(group, mask, slot, count), group.forward)
}

/// `Slot` with a trail: bent along the group's trail when it bends ([`trail::bends`]): the row stands as far back
/// along the way the pivot came as its offset is behind the pivot, across the trail's heading there. Otherwise (or
/// with no trail) as [`slot`].
pub fn slot_on_trail(group: &NavGroup, mask: Option<&NavFormationData>, pivot: Float3, slot: i32, count: i32, trail_points: &[Float3], has_trail: bool) -> Float3 {
    let offset = offset(group, mask, slot, count);
    if !has_trail || offset.z >= 0.0 || !trail::bends(group) {
        return pivot + rotate(offset, group.forward);
    }
    let (at, heading) = trail::at(trail_points, pivot, -offset.z, group.forward);
    at + rotate(Float3::new(offset.x, offset.y, 0.0), heading)
}

/// `Target` with a trail: as [`target`], with slots bent along the trail ([`slot_on_trail`]).
#[allow(clippy::too_many_arguments)]
pub fn target_on_trail(
    group: &NavGroup,
    mask: Option<&NavFormationData>,
    pivot: Float3,
    slot: i32,
    count: i32,
    member: Float3,
    up: Float3,
    trail_points: &[Float3],
    has_trail: bool,
) -> Float3 {
    if group.mode == NavGroupMode::Flock {
        return target(group, mask, pivot, slot, count, member, up);
    }
    slot_on_trail(group, mask, pivot, slot, count, trail_points, has_trail)
}

/// `Target`: where a member aims. Formation mode: its slot. Flock mode: the nearest point to `member` within the
/// flock radius of the pivot ([`leash`]), so a member inside it is pulled nowhere. Measured across `up` (level for
/// walkers: up their surface normal) or in 3D (`up` zero, flyers).
pub fn target(group: &NavGroup, mask: Option<&NavFormationData>, pivot: Float3, slot_index: i32, count: i32, member: Float3, up: Float3) -> Float3 {
    if group.mode != NavGroupMode::Flock {
        return slot(group, mask, pivot, slot_index, count);
    }
    let mut away = member - pivot;
    away = away - up * away.dot(up);
    let distance = away.length();
    let leash = leash(group, count);
    if distance > leash { member - away * (1.0 - leash / distance) } else { member }
}

/// `Leash`: flock mode, how far members may roam from the pivot: `flock_radius`, or if that's 0 a disc that holds
/// `count` members `spacing` apart, with half a spacing to spare.
pub fn leash(group: &NavGroup, count: i32) -> f32 {
    if group.flock_radius > 0.0 { group.flock_radius } else { group.spacing * (0.6 * (count.max(1) as f32).sqrt() + 0.5) }
}

/// `Reach`: how far left (x) and right (y) of the pivot the first `count` slots of the group's own shape reach
/// (unsqueezed), in metres.
pub fn reach(group: &NavGroup, mask: Option<&NavFormationData>, count: i32) -> Float2 {
    let mut own = *group;
    own.columns = 0;
    let mut reach = Float2::default();
    for i in 0..count {
        let x = offset(&own, mask, i, count).x;
        reach = Float2::new(math::max(reach.x, -x), math::max(reach.y, x));
    }
    reach
}

/// `Offset(preset, spacing, slot, count)`: a preset slot's offset in the formation's frame (y 0).
pub fn preset_offset(preset: NavFormationPreset, spacing: f32, slot: i32, count: i32) -> Float3 {
    let count = count.max(1);
    match preset {
        NavFormationPreset::Line => Float3::new(centre_out(slot) * spacing, 0.0, 0.0),
        NavFormationPreset::Column => Float3::new(0.0, 0.0, -(slot as f32) * spacing),
        NavFormationPreset::Wedge => {
            // The point, then a pair a row further back on each side.
            if slot == 0 {
                return Float3::default();
            }
            let row = (slot + 1) / 2;
            let side = if slot & 1 == 1 { -1.0 } else { 1.0 };
            Float3::new(side * row as f32 * spacing, 0.0, -(row as f32) * spacing)
        }
        NavFormationPreset::Circle => {
            if count == 1 {
                return Float3::default();
            }
            let radius = math::max(spacing * count as f32 / (2.0 * PI), 0.5 * spacing);
            let (s, c) = (slot as f32 * (2.0 * PI / count as f32)).sin_cos();
            Float3::new(s * radius, 0.0, c * radius) // slot 0 at the front
        }
        // Box (and Mask with no shape): as wide as it is deep.
        NavFormationPreset::Box | NavFormationPreset::Mask => rows(slot, count, (count as f32).sqrt().ceil() as i32) * spacing,
    }
}

/// `Rows`: slot `k` of `count` in rows `columns` wide from the front, each row centre out (the last row can be
/// shorter, and is centred too), in units of spacing.
pub fn rows(k: i32, count: i32, columns: i32) -> Float3 {
    let columns = columns.max(1);
    let row = k / columns;
    let in_row = (count - row * columns).clamp(1, columns);
    let k = k - row * columns;
    let x = if in_row & 1 == 1 {
        centre_out(k) // odd: one on the centre line, then out
    } else {
        ((k >> 1) as f32 + 0.5) * if k & 1 == 0 { 1.0 } else { -1.0 } // even: straddling it
    };
    Float3::new(x, 0.0, -(row as f32))
}

/// `Rotate`: an offset turned into the world by the formation's forward direction (level).
pub fn rotate(offset: Float3, forward: Float3) -> Float3 {
    let f = Float3::new(forward.x, 0.0, forward.z).normalize_safe(FORWARD);
    let right = Float3::new(f.z, 0.0, -f.x);
    right * offset.x + f * offset.z + Float3::new(0.0, offset.y, 0.0)
}

/// A painted slot, in units of spacing; past the shape's last slot, rows as wide as the shape behind it.
fn mask_offset(mask: &NavFormationData, k: i32, count: i32) -> Float3 {
    let n = mask.slots.len() as i32;
    if k < n {
        let s = mask.slots[k as usize];
        return Float3::new(s.x, 0.0, s.y);
    }
    let extra = rows(k - n, count - n, mask.width);
    extra - Float3::new(0.0, 0.0, mask.depth as f32)
}

/// `CentreOut`: 0, 1, -1, 2, -2, ...: index k's place counted out from the centre, alternately right and left.
fn centre_out(k: i32) -> f32 {
    let step = (k + 1) / 2;
    if k & 1 == 1 { step as f32 } else { -step as f32 }
}

// ------------------------------------------------------------------------------------------------- painted shapes

/// `MaxMaskSize`: the largest mask side, 128 x 128 cells.
pub const MAX_MASK_SIZE: i32 = 128;

/// `Get`: whether cell (x, row) of a width-wide bit grid is set: bit `row * width + x`, 64 to a `u64`.
pub fn get(bits: &[u64], width: i32, x: i32, row: i32) -> bool {
    let i = row * width + x;
    ((i >> 6) as usize) < bits.len() && (bits[(i >> 6) as usize] & (1u64 << (i & 63))) != 0
}

/// `CreateMask`: a mask formation from a width x height bit grid ([`get`]; row 0 is the front, x grows to the right):
/// a slot per set cell, ordered front row first, each row from the centre out, right before left. The pivot is the
/// front row's centre (the middle of the set cells' columns), so the shape can be painted anywhere on the grid. An
/// empty grid gives an empty shape (the group then stands as a Box).
pub fn create_mask(bits: &[u64], width: i32, height: i32) -> NavFormationData {
    let width = width.clamp(1, MAX_MASK_SIZE);
    let height = height.clamp(1, MAX_MASK_SIZE);
    let mut cells: Vec<i32> = Vec::with_capacity(64);
    let (mut min_x, mut max_x, mut front, mut back) = (i32::MAX, i32::MIN, i32::MAX, i32::MIN);
    for row in 0..height {
        for x in 0..width {
            if !get(bits, width, x, row) {
                continue;
            }
            cells.push(row * width + x);
            min_x = min_x.min(x);
            max_x = max_x.max(x);
            front = front.min(row);
            back = back.max(row);
        }
    }

    let centre2 = min_x.wrapping_add(max_x); // twice the centre column, so a centre between columns stays whole
    // Front row first; in a row nearest the centre first; right of it before left.
    cells.sort_by(|&a, &b| {
        let (row_a, row_b) = (a / width, b / width);
        if row_a != row_b {
            return row_a.cmp(&row_b);
        }
        let (d_a, d_b) = (2 * (a - row_a * width) - centre2, 2 * (b - row_b * width) - centre2);
        d_a.abs().cmp(&d_b.abs()).then(d_b.cmp(&d_a)) // right (positive) first
    });

    let slots = cells
        .iter()
        .map(|&c| {
            let row = c / width;
            let x = c - row * width;
            Float2::new(0.5 * (2 * x - centre2) as f32, (front - row) as f32)
        })
        .collect::<Vec<_>>();
    let any = !slots.is_empty();
    NavFormationData { slots, width: if any { max_x - min_x + 1 } else { 1 }, depth: if any { back - front + 1 } else { 0 } }
}

// ------------------------------------------------------------------------------------------------- bending columns

/// Bending columns (`NavGroupTrail`, `NavGroup::bend_columns`): the group keeps where its pivot has been (a point
/// every [`trail::STEP`] metres, as long as the group could be deep in single file), and while it's squeezed, or in
/// the Column formation, each row stands that far back along it ([`slot_on_trail`]). A long column then bends round
/// corners with the passage. Past the trail's end, rows carry on straight. The trail starts again when the pivot turns
/// back on itself or jumps.
pub mod trail {
    use super::*;

    /// Metres between trail points.
    pub const STEP: f32 = 0.5;
    /// Members fall in ([`waits`]) only while the group moves faster than this (m/s).
    pub const MOVING_SPEED: f32 = 0.3;
    /// A move this far in one go is a jump (teleport, respawn): the trail starts again.
    pub const JUMP: f32 = 10.0;

    /// `Columnar`: whether the group stands in a column now: squeezed into rows, or the Column formation.
    pub fn columnar(group: &NavGroup) -> bool {
        group.mode == NavGroupMode::Formation && (group.columns > 0 || group.formation == NavFormationPreset::Column)
    }

    /// `Bends`: whether the group's rows stand along its trail now.
    pub fn bends(group: &NavGroup) -> bool {
        group.bend_columns && columnar(group)
    }

    /// `Record`: adds the pivot to the trail once it's [`STEP`] from the last point, and drops points past the depth
    /// `count` members could stand in single file (plus two spacings). Starts again after a turn back or a jump.
    pub fn record(trail: &mut Vec<Float3>, pivot: Float3, group: &NavGroup, count: i32) {
        if !group.bend_columns || group.mode != NavGroupMode::Formation {
            trail.clear();
            return;
        }

        if let Some(&last) = trail.last() {
            let step = pivot - last;
            let length = step.length();
            if length > JUMP {
                trail.clear();
            } else {
                if length < STEP {
                    return;
                }
                if trail.len() > 1 && step.dot(last - trail[trail.len() - 2]) < 0.0 {
                    trail.clear(); // turned back
                }
            }
        }

        trail.push(pivot);

        // Keep as much as the deepest single file needs, measured back from the newest point.
        let keep = (count.max(1) + 2) as f32 * group.spacing;
        let mut length2 = 0.0f32;
        let mut i = trail.len() - 1;
        while i > 0 {
            length2 += trail[i].distance(trail[i - 1]);
            if length2 >= keep {
                trail.drain(0..i - 1);
                break;
            }
            i -= 1;
        }
    }

    /// `Waits` (falling in): whether a member of a column stands ahead of its slot, nearer the front along the way the
    /// group came than its slot is by more than a spacing. It then steps into the line where it is and lets the column
    /// come past it. A member within `slack` of its slot doesn't wait, nor does any while the group is (nearly)
    /// stopped ([`MOVING_SPEED`]).
    #[allow(clippy::too_many_arguments)]
    pub fn waits(
        group: &NavGroup,
        mask: Option<&NavFormationData>,
        slot: i32,
        count: i32,
        pivot: Float3,
        member: Float3,
        gap: Float3,
        up: Float3,
        trail: &[Float3],
        has_trail: bool,
    ) -> bool {
        if !columnar(group) {
            return false;
        }
        if group.velocity.length_sq() < MOVING_SPEED * MOVING_SPEED {
            return false; // stopped: the column won't come, so go to it
        }
        if gap.length_sq() <= group.slack * group.slack {
            return false;
        }
        let back_of_slot = -offset(group, mask, slot, count).z;
        if back_of_slot <= group.spacing {
            return false;
        }
        back(trail, has_trail && bends(group), pivot, group.forward, member, up) < back_of_slot - group.spacing
    }

    /// `Waits` with `place`: as [`waits`], and where a waiting member stands meanwhile: in the column's line where it
    /// is, across it as far as its slot is. `(false, member)` if it doesn't wait.
    #[allow(clippy::too_many_arguments)]
    pub fn waits_place(
        group: &NavGroup,
        mask: Option<&NavFormationData>,
        slot: i32,
        count: i32,
        pivot: Float3,
        member: Float3,
        gap: Float3,
        up: Float3,
        trail: &[Float3],
        has_trail: bool,
    ) -> (bool, Float3) {
        if !waits(group, mask, slot, count, pivot, member, gap, up, trail, has_trail) {
            return (false, member);
        }
        let bends_now = has_trail && bends(group);
        let along = back(trail, bends_now, pivot, group.forward, member, up);
        let mut heading = Float3::new(group.forward.x, 0.0, group.forward.z).normalize_safe(FORWARD);
        let at_point = if bends_now {
            let (p, h) = at(trail, pivot, along, group.forward);
            heading = h;
            p
        } else {
            pivot - heading * along
        };
        let offset = offset(group, mask, slot, count);
        (true, at_point + rotate(Float3::new(offset.x, offset.y, 0.0), heading))
    }

    /// `Back`: how far back from `pivot` along the trail (then straight on past its end; straight back along forward
    /// without one) the point nearest `p` is: p's place in the column. Ahead of the pivot it's negative. Distances
    /// across `up` (level for walkers; 3D if up is 0).
    pub fn back(trail: &[Float3], has_trail: bool, pivot: Float3, forward: Float3, p: Float3, up: Float3) -> f32 {
        let mut from = pivot;
        let mut along = 0.0f32;
        let mut best = f32::MAX;
        let mut back = 0.0f32;
        let mut heading = Float3::new(forward.x, 0.0, forward.z).normalize_safe(FORWARD);

        // Ahead of the pivot: negative.
        let ahead = (p - pivot).dot(heading);
        if ahead > 0.0 {
            best = across(p - (pivot + heading * ahead), up);
            back = -ahead;
        }

        let n = if has_trail { trail.len() } else { 0 };
        for i in (0..n).rev() {
            let to = trail[i];
            let segment = to - from; // backwards along the way the pivot came
            let length = segment.length();
            if length < 1e-4 {
                continue;
            }
            let dir = segment / length;
            heading = -dir;
            let t = math::clamp((p - from).dot(dir), 0.0, length);
            let d = across(p - (from + dir * t), up);
            if d < best {
                best = d;
                back = along + t;
            }
            along += length;
            from = to;
        }

        let on = math::max(0.0, (p - from).dot(-heading)); // straight on past the end
        if across(p - (from - heading * on), up) < best {
            back = along + on;
        }
        back
    }

    fn across(d: Float3, up: Float3) -> f32 {
        let d = d - up * d.dot(up);
        d.length_sq()
    }

    /// `At`: the point `back` metres behind `pivot` along the trail (pivot, then the points newest first), and the
    /// heading there (the way the pivot was going). Past the trail's end: straight on along its last heading (forward
    /// if the trail is empty).
    pub fn at(trail: &[Float3], pivot: Float3, back: f32, forward: Float3) -> (Float3, Float3) {
        let mut heading = forward;
        let mut from = pivot;
        let mut back = back;
        for i in (0..trail.len()).rev() {
            let to = trail[i];
            let segment = from - to; // the way the pivot went
            let length = segment.length();
            if length < 1e-4 {
                continue;
            }
            heading = segment / length;
            if back <= length {
                return (from - heading * back, heading);
            }
            back -= length;
            from = to;
        }
        (from - heading.normalize_safe(FORWARD) * back, heading)
    }
}

// ------------------------------------------------------------------------------------------------- turning in place

/// Turning in place (`NavGroupTurn`, `NavGroup::turn_in_place`): the moment the body's step goes against the
/// formation's heading (more than 120 degrees) just after its path was planned ([`turn::FRESH`]), the pivot moves to
/// the formation's rear (as deep as its rows go and its members stand, back along the trail, no further than the
/// trail goes), the heading turns round, the trail is turned round to end there, and members trade slots at once. Not
/// again for [`turn::COOLDOWN`] seconds.
pub mod turn {
    use super::*;

    /// Seconds after a turn before the next can happen.
    pub const COOLDOWN: f32 = 1.0;
    /// How soon after the body's path was planned a turn back counts as turning round.
    pub const FRESH: f32 = 0.5;

    /// `Turning`: whether the group is turning round now, its body having gone from `previous_position` to `pivot`
    /// this frame against its heading, just after its path was planned at `planned`.
    pub fn turning(group: &NavGroup, count: i32, pivot: Float3, time: f64, planned: f64) -> bool {
        if time - planned > FRESH as f64 {
            return false; // a corner on its way, not a new goal behind it
        }
        if !group.turn_in_place || group.mode != NavGroupMode::Formation || count < 2 || (group.turned_at > 0.0 && time < group.turned_at + COOLDOWN as f64) {
            return false;
        }
        let moved = pivot - group.previous_position;
        let level = Float3::new(moved.x, 0.0, moved.z);
        level.length_sq() >= 1e-4 && level.normalize().dot(group.forward) <= -0.5
    }

    /// `Check`: turns a group that's [`turning`]: the pivot moves back to its rear, the nearest of how deep its rows
    /// go, how far back its rearmost member stands (`reach`) and how far the trail goes. None (it swings round) if
    /// that's under a spacing, or its rows are a line abreast. Some(front): the new pivot; the heading, previous
    /// position, trail and next slot trade are set.
    pub fn check(group: &mut NavGroup, trail: &mut Vec<Float3>, mask: Option<&NavFormationData>, count: i32, reach: f32, time: f64) -> Option<Float3> {
        let mut depth = 0.0f32;
        for i in 0..count {
            depth = math::max(depth, -offset(group, mask, i, count).z);
        }
        if depth < 0.5 * group.spacing {
            return None; // a line abreast: its slots don't swing far
        }
        depth = math::min(depth, reach); // where its members are, not where they'd be

        // The rear, back along the trail from where the pivot was: only as far as the trail goes.
        let from = group.previous_position;
        let mut walked = 0.0f32;
        let mut at0 = from;
        for i in (0..trail.len()).rev() {
            walked += at0.distance(trail[i]);
            at0 = trail[i];
        }

        depth = math::min(depth, walked);
        if depth < group.spacing {
            return None;
        }

        let (front, heading) = trail::at(trail, from, depth, group.forward);

        // The trail turned round: from the old pivot (now the rear) to the new one, oldest first.
        let mut turned = Vec::with_capacity(trail.len() + 2);
        turned.push(from);
        let mut left = depth;
        let mut at = from;
        for i in (0..trail.len()).rev() {
            if left <= 0.0 {
                break;
            }
            let point = trail[i];
            let length = at.distance(point);
            if length >= left {
                break;
            }
            left -= length;
            turned.push(point);
            at = point;
        }
        turned.push(front);
        *trail = turned;

        let back = -Float3::new(heading.x, 0.0, heading.z);
        group.forward = back.normalize_safe(-group.forward);
        group.previous_position = front;
        group.velocity = Float3::default();
        group.turned_at = time;
        group.next_swap = 0.0; // trade slots now: the old rear row takes the front
        Some(front)
    }
}
