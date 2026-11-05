//! Region building (`RcRegions`): the distance field, watershed, monotone and layer region
//! partitioning, and region merging/filtering. A function-by-function port of Foxfire's `RcRegions`
//! (itself DotRecast's `RcRegions`) onto [`RcCompactHeightfield`].
//!
//! Operation order, iteration order and tie-breaks are the C#'s: they decide region ids.
use crate::constants::*;
use crate::types::{RcCompactHeightfield, RcCompactSpan};

#[derive(Clone, Copy, Debug, Default)]
struct RcLevelStackEntry {
    x: i32,
    y: i32,
    index: i32,
}

impl RcLevelStackEntry {
    fn new(x: i32, y: i32, index: i32) -> Self {
        Self { x, y, index }
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct RcDirtyEntry {
    index: i32,
    region: i32,
    distance2: i32,
}

impl RcDirtyEntry {
    fn new(index: i32, region: i32, distance2: i32) -> Self {
        Self { index, region, distance2 }
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct RcSweepSpan {
    /// Row id.
    rid: i32,
    /// Region id.
    id: i32,
    /// Number of neighbour samples.
    ns: i32,
    /// Neighbour id.
    nei: i32,
}

#[derive(Clone, Debug, Default)]
struct RcRegion {
    id: i32,
    span_count: i32,
    area_type: i32,
    remap: bool,
    visited: bool,
    overlap: bool,
    connects_to_border: bool,
    ymin: i32,
    ymax: i32,
    connections: Vec<i32>,
    floors: Vec<i32>,
}

impl RcRegion {
    fn create(id: i32) -> Self {
        Self {
            id,
            ymin: 0xffff,
            ymax: 0,
            connections: Vec::with_capacity(8),
            floors: Vec::with_capacity(8),
            ..Default::default()
        }
    }
}

// ------------------------------------------------------------------ helpers

/// The index of the neighbouring span of span `s` (at cell x, y) in direction `dir`, or -1.
#[inline]
fn nei(chf: &RcCompactHeightfield, x: i32, y: i32, dir: i32, s: &RcCompactSpan) -> i32 {
    let con = RcCompactHeightfield::get_con(s, dir);
    if con == RC_NOT_CONNECTED {
        return -1;
    }
    let ax = x + get_dir_offset_x(dir);
    let ay = y + get_dir_offset_y(dir);
    chf.cells[(ax + ay * chf.width) as usize].index + con
}

fn remove_at_shift<T>(list: &mut Vec<T>, index: usize) {
    list.remove(index);
}

fn contains_int(list: &[i32], v: i32) -> bool {
    list.iter().any(|&x| x == v)
}

fn create_regions(nreg: i32) -> Vec<RcRegion> {
    let mut regions = Vec::with_capacity(nreg.max(0) as usize);
    for i in 0..nreg {
        regions.push(RcRegion::create(i));
    }
    regions
}

fn store_regions(chf: &mut RcCompactHeightfield, src_reg: &[i32]) {
    for i in 0..chf.span_count as usize {
        chf.spans[i].reg = src_reg[i];
    }
}

// ------------------------------------------------------------- distance field

#[allow(clippy::too_many_arguments)]
fn relax_dist(chf: &RcCompactHeightfield, x: i32, y: i32, i: i32, s: &RcCompactSpan, dir_a: i32, dir_b: i32, src: &mut [i32]) {
    let ai = nei(chf, x, y, dir_a, s);
    if ai < 0 {
        return;
    }
    let (iu, aiu) = (i as usize, ai as usize);

    if src[aiu] + 2 < src[iu] {
        src[iu] = src[aiu] + 2;
    }

    let a_span = chf.spans[aiu];
    let ax = x + get_dir_offset_x(dir_a);
    let ay = y + get_dir_offset_y(dir_a);
    let aai = nei(chf, ax, ay, dir_b, &a_span);
    if aai >= 0 && src[aai as usize] + 3 < src[iu] {
        src[iu] = src[aai as usize] + 3;
    }
}

/// Calculates the (unblurred) distance to the nearest boundary of every span into `src` and returns
/// the maximum distance.
pub fn calculate_distance_field(chf: &RcCompactHeightfield, src: &mut [i32]) -> i32 {
    let w = chf.width;
    let h = chf.height;

    // Init distance.
    for i in 0..chf.span_count as usize {
        src[i] = 0xffff;
    }

    // Mark boundary cells.
    for y in 0..h {
        for x in 0..w {
            let c = chf.cells[(x + y * w) as usize];
            for i in c.index..c.index + c.count {
                let s = chf.spans[i as usize];
                let area = chf.areas[i as usize];

                let mut nc = 0;
                for dir in 0..4 {
                    let ai = nei(chf, x, y, dir, &s);
                    if ai >= 0 && area == chf.areas[ai as usize] {
                        nc += 1;
                    }
                }

                if nc != 4 {
                    src[i as usize] = 0;
                }
            }
        }
    }

    // Pass 1
    for y in 0..h {
        for x in 0..w {
            let c = chf.cells[(x + y * w) as usize];
            for i in c.index..c.index + c.count {
                let s = chf.spans[i as usize];
                relax_dist(chf, x, y, i, &s, 0, 3, src); // (-1,0), (-1,-1)
                relax_dist(chf, x, y, i, &s, 3, 2, src); // (0,-1), (1,-1)
            }
        }
    }

    // Pass 2
    for y in (0..h).rev() {
        for x in (0..w).rev() {
            let c = chf.cells[(x + y * w) as usize];
            for i in c.index..c.index + c.count {
                let s = chf.spans[i as usize];
                relax_dist(chf, x, y, i, &s, 2, 1, src); // (1,0), (1,1)
                relax_dist(chf, x, y, i, &s, 1, 0, src); // (0,1), (-1,1)
            }
        }
    }

    let mut max_dist = 0;
    for i in 0..chf.span_count as usize {
        max_dist = src[i].max(max_dist);
    }

    max_dist
}

fn box_blur(chf: &RcCompactHeightfield, thr: i32, src: &[i32], dst: &mut [i32]) {
    let w = chf.width;
    let h = chf.height;

    let thr = thr * 2;

    for y in 0..h {
        for x in 0..w {
            let c = chf.cells[(x + y * w) as usize];
            for i in c.index..c.index + c.count {
                let s = chf.spans[i as usize];
                let cd = src[i as usize];
                if cd <= thr {
                    dst[i as usize] = cd;
                    continue;
                }

                let mut d = cd;
                for dir in 0..4 {
                    let ai = nei(chf, x, y, dir, &s);
                    if ai >= 0 {
                        d += src[ai as usize];

                        let a_span = chf.spans[ai as usize];
                        let dir2 = (dir + 1) & 0x3;
                        let ax = x + get_dir_offset_x(dir);
                        let ay = y + get_dir_offset_y(dir);
                        let ai2 = nei(chf, ax, ay, dir2, &a_span);
                        if ai2 >= 0 {
                            d += src[ai2 as usize];
                        } else {
                            d += cd;
                        }
                    } else {
                        d += cd * 2;
                    }
                }

                dst[i as usize] = (d + 5) / 9;
            }
        }
    }
}

/// Port of rcBuildDistanceField. Fills `chf.dist` and `chf.max_distance`.
pub fn build_distance_field(chf: &mut RcCompactHeightfield) {
    let n = chf.span_count as usize;
    let mut src = vec![0i32; n];
    let mut blurred = vec![0i32; n];

    chf.max_distance = calculate_distance_field(chf, &mut src);

    // Blur
    box_blur(chf, 1, &src, &mut blurred);

    // Store distance.
    chf.dist.resize(n, 0);
    for i in 0..n {
        chf.dist[i] = blurred[i];
    }
}

// ------------------------------------------------------------ watershed pieces

#[allow(clippy::too_many_arguments)]
fn flood_region(
    x: i32,
    y: i32,
    i: i32,
    level: i32,
    r: i32,
    chf: &RcCompactHeightfield,
    src_reg: &mut [i32],
    src_dist: &mut [i32],
    stack: &mut Vec<RcLevelStackEntry>,
) -> bool {
    let area = chf.areas[i as usize];

    // Flood fill mark region.
    stack.clear();
    stack.push(RcLevelStackEntry::new(x, y, i));
    src_reg[i as usize] = r;
    src_dist[i as usize] = 0;

    let lev = if level >= 2 { level - 2 } else { 0 };
    let mut count = 0;

    while let Some(back) = stack.pop() {
        let cx = back.x;
        let cy = back.y;
        let ci = back.index;

        let cs = chf.spans[ci as usize];

        // Check if any of the neighbours already have a valid region set.
        let mut ar = 0;
        for dir in 0..4 {
            // 8 connected
            let ai = nei(chf, cx, cy, dir, &cs);
            if ai < 0 {
                continue;
            }

            if chf.areas[ai as usize] != area {
                continue;
            }

            let nr = src_reg[ai as usize];
            if (nr & RC_BORDER_REG) != 0 {
                continue;
            }

            if nr != 0 && nr != r {
                ar = nr;
                break;
            }

            let a_span = chf.spans[ai as usize];
            let dir2 = (dir + 1) & 0x3;
            let ax = cx + get_dir_offset_x(dir);
            let ay = cy + get_dir_offset_y(dir);
            let ai2 = nei(chf, ax, ay, dir2, &a_span);
            if ai2 >= 0 {
                if chf.areas[ai2 as usize] != area {
                    continue;
                }

                let nr2 = src_reg[ai2 as usize];
                if nr2 != 0 && nr2 != r {
                    ar = nr2;
                    break;
                }
            }
        }

        if ar != 0 {
            src_reg[ci as usize] = 0;
            continue;
        }

        count += 1;

        // Expand neighbours.
        for dir in 0..4 {
            let ai = nei(chf, cx, cy, dir, &cs);
            if ai < 0 {
                continue;
            }

            if chf.areas[ai as usize] != area {
                continue;
            }

            if chf.dist[ai as usize] >= lev && src_reg[ai as usize] == 0 {
                src_reg[ai as usize] = r;
                src_dist[ai as usize] = 0;
                stack.push(RcLevelStackEntry::new(cx + get_dir_offset_x(dir), cy + get_dir_offset_y(dir), ai));
            }
        }
    }

    count > 0
}

#[allow(clippy::too_many_arguments)]
fn expand_regions(
    max_iter: i32,
    level: i32,
    chf: &RcCompactHeightfield,
    src_reg: &mut [i32],
    src_dist: &mut [i32],
    stack: &mut Vec<RcLevelStackEntry>,
    fill_stack: bool,
) {
    let w = chf.width;
    let h = chf.height;

    if fill_stack {
        // Find cells revealed by the raised level.
        stack.clear();
        for y in 0..h {
            for x in 0..w {
                let c = chf.cells[(x + y * w) as usize];
                for i in c.index..c.index + c.count {
                    if chf.dist[i as usize] >= level && src_reg[i as usize] == 0 && chf.areas[i as usize] != RC_NULL_AREA {
                        stack.push(RcLevelStackEntry::new(x, y, i));
                    }
                }
            }
        }
    } else {
        // use cells in the input stack
        // mark all cells which already have a region
        for j in 0..stack.len() {
            let i = stack[j].index;
            if src_reg[i as usize] != 0 {
                stack[j] = RcLevelStackEntry::new(stack[j].x, stack[j].y, -1);
            }
        }
    }

    let mut dirty_entries: Vec<RcDirtyEntry> = Vec::with_capacity(64);
    let mut iter = 0;
    while !stack.is_empty() {
        let mut failed = 0usize;
        dirty_entries.clear();

        for j in 0..stack.len() {
            let x = stack[j].x;
            let y = stack[j].y;
            let i = stack[j].index;
            if i < 0 {
                failed += 1;
                continue;
            }

            let mut r = src_reg[i as usize];
            let mut d2 = 0xffff;
            let area = chf.areas[i as usize];
            let s = chf.spans[i as usize];
            for dir in 0..4 {
                let ai = nei(chf, x, y, dir, &s);
                if ai < 0 {
                    continue;
                }

                if chf.areas[ai as usize] != area {
                    continue;
                }

                let rai = src_reg[ai as usize];
                if rai > 0 && (rai & RC_BORDER_REG) == 0 && src_dist[ai as usize] + 2 < d2 {
                    r = rai;
                    d2 = src_dist[ai as usize] + 2;
                }
            }

            if r != 0 {
                stack[j] = RcLevelStackEntry::new(stack[j].x, stack[j].y, -1); // mark as used
                dirty_entries.push(RcDirtyEntry::new(i, r, d2));
            } else {
                failed += 1;
            }
        }

        // Copy entries that differ between src and dst to keep them in sync.
        for e in &dirty_entries {
            let idx = e.index as usize;
            src_reg[idx] = e.region;
            src_dist[idx] = e.distance2;
        }

        if failed == stack.len() {
            break;
        }

        if level > 0 {
            iter += 1;
            if iter >= max_iter {
                break;
            }
        }
    }
}

fn sort_cells_by_level(
    start_level: i32,
    chf: &RcCompactHeightfield,
    src_reg: &[i32],
    nb_stacks: usize,
    stacks: &mut [Vec<RcLevelStackEntry>],
    loglevels_per_stack: i32, // the levels per stack (2 in our case) as a bit shift
) {
    let w = chf.width;
    let h = chf.height;
    let start_level = start_level >> loglevels_per_stack;

    for j in 0..nb_stacks {
        stacks[j].clear();
    }

    // put all cells in the level range into the appropriate stacks
    for y in 0..h {
        for x in 0..w {
            let c = chf.cells[(x + y * w) as usize];
            for i in c.index..c.index + c.count {
                if chf.areas[i as usize] == RC_NULL_AREA || src_reg[i as usize] != 0 {
                    continue;
                }

                let level = chf.dist[i as usize] >> loglevels_per_stack;
                let mut s_id = start_level - level;
                if s_id >= nb_stacks as i32 {
                    continue;
                }

                if s_id < 0 {
                    s_id = 0;
                }

                stacks[s_id as usize].push(RcLevelStackEntry::new(x, y, i));
            }
        }
    }
}

fn append_stacks(src_stack: &[RcLevelStackEntry], dst_stack: &mut Vec<RcLevelStackEntry>, src_reg: &[i32]) {
    for e in src_stack {
        let i = e.index;
        if i < 0 || src_reg[i as usize] != 0 {
            continue;
        }

        dst_stack.push(*e);
    }
}

// ------------------------------------------------------------- region merging

fn remove_adjacent_neighbours(reg: &mut RcRegion) {
    // Remove adjacent duplicates.
    let mut i = 0;
    while i < reg.connections.len() && reg.connections.len() > 1 {
        let ni = (i + 1) % reg.connections.len();
        if reg.connections[i] == reg.connections[ni] {
            remove_at_shift(&mut reg.connections, i);
        } else {
            i += 1;
        }
    }
}

fn replace_neighbour(reg: &mut RcRegion, old_id: i32, new_id: i32) {
    let mut nei_changed = false;
    for c in reg.connections.iter_mut() {
        if *c == old_id {
            *c = new_id;
            nei_changed = true;
        }
    }

    for f in reg.floors.iter_mut() {
        if *f == old_id {
            *f = new_id;
        }
    }

    if nei_changed {
        remove_adjacent_neighbours(reg);
    }
}

fn can_merge_with_region(rega: &RcRegion, regb: &RcRegion) -> bool {
    if rega.area_type != regb.area_type {
        return false;
    }

    let mut n = 0;
    for &c in &rega.connections {
        if c == regb.id {
            n += 1;
        }
    }

    if n > 1 {
        return false;
    }

    for &f in &rega.floors {
        if f == regb.id {
            return false;
        }
    }

    true
}

fn add_unique_floor_region(reg: &mut RcRegion, n: i32) {
    if !contains_int(&reg.floors, n) {
        reg.floors.push(n);
    }
}

fn add_unique_connection(reg: &mut RcRegion, n: i32) {
    if !contains_int(&reg.connections, n) {
        reg.connections.push(n);
    }
}

/// Merges region `b` into region `a` (indices into `regions`, which must differ).
fn merge_regions(regions: &mut [RcRegion], a: usize, b: usize) -> bool {
    if a == b {
        return false;
    }
    let aid = regions[a].id;
    let bid = regions[b].id;

    // Duplicate current neighbourhood.
    let acon: Vec<i32> = regions[a].connections.clone();
    let bcon: Vec<i32> = regions[b].connections.clone();

    // Find insertion point on A.
    let mut insa: i32 = -1;
    for (i, &c) in acon.iter().enumerate() {
        if c == bid {
            insa = i as i32;
            break;
        }
    }

    if insa == -1 {
        return false;
    }

    // Find insertion point on B.
    let mut insb: i32 = -1;
    for (i, &c) in bcon.iter().enumerate() {
        if c == aid {
            insb = i as i32;
            break;
        }
    }

    if insb == -1 {
        return false;
    }

    // Merge neighbours.
    let rega = &mut regions[a];
    rega.connections.clear();
    let ni = acon.len() as i32;
    for i in 0..ni - 1 {
        rega.connections.push(acon[((insa + 1 + i) % ni) as usize]);
    }

    let ni = bcon.len() as i32;
    for i in 0..ni - 1 {
        rega.connections.push(bcon[((insb + 1 + i) % ni) as usize]);
    }

    remove_adjacent_neighbours(rega);

    let bfloors = regions[b].floors.clone();
    for f in bfloors {
        add_unique_floor_region(&mut regions[a], f);
    }

    let bspan = regions[b].span_count;
    regions[a].span_count += bspan;
    regions[b].span_count = 0;
    regions[b].connections.clear();

    true
}

fn is_region_connected_to_border(reg: &RcRegion) -> bool {
    // Region is connected to border if one of the neighbours is null id.
    contains_int(&reg.connections, 0)
}

fn is_solid_edge(chf: &RcCompactHeightfield, src_reg: &[i32], x: i32, y: i32, i: i32, dir: i32) -> bool {
    let s = chf.spans[i as usize];
    let mut r = 0;
    let ai = nei(chf, x, y, dir, &s);
    if ai >= 0 {
        r = src_reg[ai as usize];
    }

    r != src_reg[i as usize]
}

fn walk_contour(x: i32, y: i32, i: i32, dir: i32, chf: &RcCompactHeightfield, src_reg: &[i32], cont: &mut Vec<i32>) {
    let (mut x, mut y, mut i, mut dir) = (x, y, i, dir);
    let start_dir = dir;
    let starti = i;

    let ss = chf.spans[i as usize];
    let mut cur_reg = 0;
    let sai = nei(chf, x, y, dir, &ss);
    if sai >= 0 {
        cur_reg = src_reg[sai as usize];
    }

    cont.push(cur_reg);

    let mut iter = 0;
    loop {
        iter += 1;
        if iter >= 40000 {
            break;
        }
        let s = chf.spans[i as usize];

        if is_solid_edge(chf, src_reg, x, y, i, dir) {
            // Choose the edge corner
            let mut r = 0;
            let ai = nei(chf, x, y, dir, &s);
            if ai >= 0 {
                r = src_reg[ai as usize];
            }

            if r != cur_reg {
                cur_reg = r;
                cont.push(cur_reg);
            }

            dir = (dir + 1) & 0x3; // Rotate CW
        } else {
            let ni = nei(chf, x, y, dir, &s);
            if ni == -1 {
                // Should not happen.
                return;
            }

            x += get_dir_offset_x(dir);
            y += get_dir_offset_y(dir);
            i = ni;
            dir = (dir + 3) & 0x3; // Rotate CCW
        }

        if starti == i && start_dir == dir {
            break;
        }
    }

    // Remove adjacent duplicates.
    if cont.len() > 1 {
        let mut j = 0;
        while j < cont.len() {
            let nj = (j + 1) % cont.len();
            if cont[j] == cont[nj] {
                remove_at_shift(cont, j);
            } else {
                j += 1;
            }
        }
    }
}

/// Merges small regions into neighbours, removes tiny ones, compresses the region ids and remaps
/// `src_reg`. Returns the new max region id; regions found overlapping (several floors of one
/// column in the same region) are appended to `overlaps`.
fn merge_and_filter_regions(
    min_region_area: i32,
    merge_region_size: i32,
    max_region_id: i32,
    chf: &RcCompactHeightfield,
    src_reg: &mut [i32],
    overlaps: &mut Vec<i32>,
) -> i32 {
    let w = chf.width;
    let h = chf.height;

    let nreg = max_region_id + 1;
    let mut regions = create_regions(nreg);

    // Find edge of a region and find connections around the contour.
    for y in 0..h {
        for x in 0..w {
            let c = chf.cells[(x + y * w) as usize];
            let ni = c.index + c.count;
            for i in c.index..ni {
                let r = src_reg[i as usize];
                if r == 0 || r >= nreg {
                    continue;
                }

                regions[r as usize].span_count += 1;

                // Update floors.
                for j in c.index..ni {
                    if i == j {
                        continue;
                    }

                    let floor_id = src_reg[j as usize];
                    if floor_id == 0 || floor_id >= nreg {
                        continue;
                    }

                    let reg = &mut regions[r as usize];
                    if floor_id == r {
                        reg.overlap = true;
                    }

                    add_unique_floor_region(reg, floor_id);
                }

                // Have found contour
                if !regions[r as usize].connections.is_empty() {
                    continue;
                }

                regions[r as usize].area_type = chf.areas[i as usize];

                // Check if this cell is next to a border.
                let mut ndir = -1;
                for dir in 0..4 {
                    if is_solid_edge(chf, src_reg, x, y, i, dir) {
                        ndir = dir;
                        break;
                    }
                }

                if ndir != -1 {
                    // The cell is at border.
                    // Walk around the contour to find all the neighbours.
                    walk_contour(x, y, i, ndir, chf, src_reg, &mut regions[r as usize].connections);
                }
            }
        }
    }

    // Remove too small regions.
    let mut stack: Vec<i32> = Vec::with_capacity(32);
    let mut trace: Vec<i32> = Vec::with_capacity(32);
    for i in 0..nreg as usize {
        {
            let reg = &regions[i];
            if reg.id == 0 || (reg.id & RC_BORDER_REG) != 0 {
                continue;
            }

            if reg.span_count == 0 {
                continue;
            }

            if reg.visited {
                continue;
            }
        }

        // Count the total size of all the connected regions.
        // Also keep track of the regions connects to a tile border.
        let mut connects_to_border = false;
        let mut span_count = 0;
        stack.clear();
        trace.clear();

        regions[i].visited = true;
        stack.push(i as i32);

        while let Some(ri) = stack.pop() {
            // Pop
            let ri = ri as usize;

            span_count += regions[ri].span_count;
            trace.push(ri as i32);

            for j in 0..regions[ri].connections.len() {
                let cj = regions[ri].connections[j];
                if (cj & RC_BORDER_REG) != 0 {
                    connects_to_border = true;
                    continue;
                }

                let neireg = &mut regions[cj as usize];
                if neireg.visited {
                    continue;
                }

                if neireg.id == 0 || (neireg.id & RC_BORDER_REG) != 0 {
                    continue;
                }

                // Visit
                stack.push(neireg.id);
                neireg.visited = true;
            }
        }

        // If the accumulated regions size is too small, remove it.
        // Do not remove areas which connect to tile borders
        // as their size cannot be estimated correctly and removing them
        // can potentially remove necessary areas.
        if span_count < min_region_area && !connects_to_border {
            // Kill all visited regions.
            for &t in &trace {
                let dead = &mut regions[t as usize];
                dead.span_count = 0;
                dead.id = 0;
            }
        }
    }

    // Merge too small regions to neighbour regions.
    loop {
        let mut merge_count = 0;
        for i in 0..nreg as usize {
            {
                let reg = &regions[i];
                if reg.id == 0 || (reg.id & RC_BORDER_REG) != 0 {
                    continue;
                }

                if reg.overlap {
                    continue;
                }

                if reg.span_count == 0 {
                    continue;
                }

                // Check to see if the region should be merged.
                if reg.span_count > merge_region_size && is_region_connected_to_border(reg) {
                    continue;
                }
            }

            // Small region with more than 1 connection.
            // Or region which is not connected to a border at all.
            // Find smallest neighbour region that connects to this one.
            let mut smallest = 0xfffffff;
            let reg_id = regions[i].id;
            let mut merge_id = reg_id;
            for j in 0..regions[i].connections.len() {
                let cj = regions[i].connections[j];
                if (cj & RC_BORDER_REG) != 0 {
                    continue;
                }

                let mreg = &regions[cj as usize];
                if mreg.id == 0 || (mreg.id & RC_BORDER_REG) != 0 || mreg.overlap {
                    continue;
                }

                if mreg.span_count < smallest && can_merge_with_region(&regions[i], mreg) && can_merge_with_region(mreg, &regions[i]) {
                    smallest = mreg.span_count;
                    merge_id = mreg.id;
                }
            }

            // Found new id.
            if merge_id != reg_id {
                let old_id = reg_id;

                // Merge neighbours.
                if merge_regions(&mut regions, merge_id as usize, i) {
                    // Fixup regions pointing to current region.
                    for j in 0..nreg as usize {
                        let rj = &mut regions[j];
                        if rj.id == 0 || (rj.id & RC_BORDER_REG) != 0 {
                            continue;
                        }

                        // If another region was already merged into current region
                        // change the nid of the previous region too.
                        if rj.id == old_id {
                            rj.id = merge_id;
                        }

                        // Replace the current region with the new one if the
                        // current regions is neighbour.
                        replace_neighbour(rj, old_id, merge_id);
                    }

                    merge_count += 1;
                }
            }
        }
        if merge_count <= 0 {
            break;
        }
    }

    // Compress region Ids.
    for r in regions.iter_mut() {
        r.remap = false;
        if r.id == 0 {
            continue; // Skip nil regions.
        }

        if (r.id & RC_BORDER_REG) != 0 {
            continue; // Skip external regions.
        }

        r.remap = true;
    }

    let mut reg_id_gen = 0;
    for i in 0..nreg as usize {
        if !regions[i].remap {
            continue;
        }

        let old_id = regions[i].id;
        reg_id_gen += 1;
        let new_id = reg_id_gen;
        for rj in regions.iter_mut().take(nreg as usize).skip(i) {
            if rj.id == old_id {
                rj.id = new_id;
                rj.remap = false;
            }
        }
    }

    let max_region_id = reg_id_gen;

    // Remap regions.
    for i in 0..chf.span_count as usize {
        if (src_reg[i] & RC_BORDER_REG) == 0 {
            src_reg[i] = regions[src_reg[i] as usize].id;
        }
    }

    // Return regions that we found to be overlapping.
    for r in &regions {
        if r.overlap {
            overlaps.push(r.id);
        }
    }

    max_region_id
}

/// The layer variant of region merging: merges monotone regions into non-overlapping layers,
/// removes small layers, compresses ids and remaps `src_reg`. Returns the new max region id.
fn merge_and_filter_layer_regions(min_region_area: i32, max_region_id: i32, chf: &RcCompactHeightfield, src_reg: &mut [i32]) -> (bool, i32) {
    let w = chf.width;
    let h = chf.height;

    let nreg = max_region_id + 1;
    let mut regions = create_regions(nreg);

    // Find region neighbours and overlapping regions.
    let mut lregs: Vec<i32> = Vec::with_capacity(32);
    for y in 0..h {
        for x in 0..w {
            let c = chf.cells[(x + y * w) as usize];

            lregs.clear();

            for i in c.index..c.index + c.count {
                let s = chf.spans[i as usize];
                let area = chf.areas[i as usize];
                let ri = src_reg[i as usize];
                if ri == 0 || ri >= nreg {
                    continue;
                }

                {
                    let reg = &mut regions[ri as usize];

                    reg.span_count += 1;
                    reg.area_type = area;

                    reg.ymin = reg.ymin.min(s.y);
                    reg.ymax = reg.ymax.max(s.y);
                }

                // Collect all region layers.
                lregs.push(ri);

                // Update neighbours
                for dir in 0..4 {
                    let ai = nei(chf, x, y, dir, &s);
                    if ai < 0 {
                        continue;
                    }

                    let rai = src_reg[ai as usize];
                    let reg = &mut regions[ri as usize];
                    if rai > 0 && rai < nreg && rai != ri {
                        add_unique_connection(reg, rai);
                    }

                    if (rai & RC_BORDER_REG) != 0 {
                        reg.connects_to_border = true;
                    }
                }
            }

            // Update overlapping regions.
            if lregs.len() > 1 {
                for i in 0..lregs.len() - 1 {
                    for j in i + 1..lregs.len() {
                        if lregs[i] != lregs[j] {
                            add_unique_floor_region(&mut regions[lregs[i] as usize], lregs[j]);
                            add_unique_floor_region(&mut regions[lregs[j] as usize], lregs[i]);
                        }
                    }
                }
            }
        }
    }

    // Create 2D layers from regions.
    let mut layer_id = 1;

    for r in regions.iter_mut() {
        r.id = 0;
    }

    // Merge montone regions to create non-overlapping areas.
    let mut stack: Vec<i32> = Vec::with_capacity(32);
    for i in 1..nreg as usize {
        // Skip already visited.
        if regions[i].id != 0 {
            continue;
        }

        // Start search.
        regions[i].id = layer_id;

        stack.clear();
        stack.push(i as i32);

        while !stack.is_empty() {
            // Pop front
            let idx = stack[0] as usize;
            remove_at_shift(&mut stack, 0);

            let ncons = regions[idx].connections.len();
            for j in 0..ncons {
                let nei_id = regions[idx].connections[j];
                let nu = nei_id as usize;

                // Skip already visited.
                if regions[nu].id != 0 {
                    continue;
                }

                // Skip if different area type, do not connect regions with different area type.
                if regions[idx].area_type != regions[nu].area_type {
                    continue;
                }

                // Skip if the neighbour is overlapping root region.
                let mut overlap = false;
                for k in 0..regions[i].floors.len() {
                    if regions[i].floors[k] == nei_id {
                        overlap = true;
                        break;
                    }
                }

                if overlap {
                    continue;
                }

                // Deepen
                stack.push(nei_id);

                // Mark layer id
                regions[nu].id = layer_id;

                // Merge current layers to root.
                let nfloors = regions[nu].floors.clone();
                for f in nfloors {
                    add_unique_floor_region(&mut regions[i], f);
                }

                let (nymin, nymax, nspan, nborder) = {
                    let regn = &regions[nu];
                    (regn.ymin, regn.ymax, regn.span_count, regn.connects_to_border)
                };
                let root = &mut regions[i];
                root.ymin = root.ymin.min(nymin);
                root.ymax = root.ymax.max(nymax);
                root.span_count += nspan;
                regions[nu].span_count = 0;
                regions[i].connects_to_border = regions[i].connects_to_border || nborder;
            }
        }

        layer_id += 1;
    }

    // Remove small regions
    for i in 0..nreg as usize {
        if regions[i].span_count > 0 && regions[i].span_count < min_region_area && !regions[i].connects_to_border {
            let reg = regions[i].id;
            for rj in regions.iter_mut() {
                if rj.id == reg {
                    rj.id = 0;
                }
            }
        }
    }

    // Compress region Ids.
    for r in regions.iter_mut() {
        r.remap = false;
        if r.id == 0 {
            continue; // Skip nil regions.
        }

        if (r.id & RC_BORDER_REG) != 0 {
            continue; // Skip external regions.
        }

        r.remap = true;
    }

    let mut reg_id_gen = 0;
    for i in 0..nreg as usize {
        if !regions[i].remap {
            continue;
        }

        let old_id = regions[i].id;
        reg_id_gen += 1;
        let new_id = reg_id_gen;
        for rj in regions.iter_mut().take(nreg as usize).skip(i) {
            if rj.id == old_id {
                rj.id = new_id;
                rj.remap = false;
            }
        }
    }

    let max_region_id = reg_id_gen;

    // Remap regions.
    for i in 0..chf.span_count as usize {
        if (src_reg[i] & RC_BORDER_REG) == 0 {
            src_reg[i] = regions[src_reg[i] as usize].id;
        }
    }

    (true, max_region_id)
}

// ----------------------------------------------------------- region builders

fn paint_rect_region(minx: i32, maxx: i32, miny: i32, maxy: i32, reg_id: i32, chf: &RcCompactHeightfield, src_reg: &mut [i32]) {
    let w = chf.width;
    for y in miny..maxy {
        for x in minx..maxx {
            let c = chf.cells[(x + y * w) as usize];
            for i in c.index..c.index + c.count {
                if chf.areas[i as usize] != RC_NULL_AREA {
                    src_reg[i as usize] = reg_id;
                }
            }
        }
    }
}

/// Marks the four border strips; advances `id` by four.
fn paint_border_regions(border_size: i32, chf: &RcCompactHeightfield, src_reg: &mut [i32], id: &mut i32) {
    if border_size <= 0 {
        return;
    }

    let w = chf.width;
    let h = chf.height;

    // Make sure border will not overflow.
    let bw = w.min(border_size);
    let bh = h.min(border_size);

    // Paint regions
    paint_rect_region(0, bw, 0, h, *id | RC_BORDER_REG, chf, src_reg);
    *id += 1;
    paint_rect_region(w - bw, w, 0, h, *id | RC_BORDER_REG, chf, src_reg);
    *id += 1;
    paint_rect_region(0, w, 0, bh, *id | RC_BORDER_REG, chf, src_reg);
    *id += 1;
    paint_rect_region(0, w, h - bh, h, *id | RC_BORDER_REG, chf, src_reg);
    *id += 1;
}

/// Shared row-sweep used by both the monotone and layer partitioners (the C# source duplicates it).
fn sweep_rows(chf: &RcCompactHeightfield, src_reg: &mut [i32], border_size: i32, id: &mut i32) {
    let w = chf.width;
    let h = chf.height;

    // The original sizes this to max(w, h); it grows on demand here since multi-layer rows can exceed it.
    let nsweeps = w.max(h) + 1;
    let mut sweeps: Vec<RcSweepSpan> = vec![RcSweepSpan::default(); nsweeps as usize];

    let mut prev: Vec<i32> = vec![0; 1024];

    // Sweep one line at a time.
    for y in border_size..h - border_size {
        // Collect spans from this row.
        if prev.len() as i32 <= *id * 2 {
            prev.resize((*id * 2) as usize, 0);
        }
        for p in prev.iter_mut().take(*id as usize) {
            *p = 0;
        }

        let mut rid = 1;

        for x in border_size..w - border_size {
            let c = chf.cells[(x + y * w) as usize];

            for i in c.index..c.index + c.count {
                let s = chf.spans[i as usize];
                if chf.areas[i as usize] == RC_NULL_AREA {
                    continue;
                }

                // -x
                let mut previd = 0;
                let mut ai = nei(chf, x, y, 0, &s);
                if ai >= 0 && (src_reg[ai as usize] & RC_BORDER_REG) == 0 && chf.areas[i as usize] == chf.areas[ai as usize] {
                    previd = src_reg[ai as usize];
                }

                if previd == 0 {
                    previd = rid;
                    rid += 1;
                    if previd as usize >= sweeps.len() {
                        let n = sweeps.len() * 2;
                        sweeps.resize(n, RcSweepSpan::default());
                    }
                    let sw = &mut sweeps[previd as usize];
                    sw.rid = previd;
                    sw.ns = 0;
                    sw.nei = 0;
                }

                // -y
                ai = nei(chf, x, y, 3, &s);
                if ai >= 0
                    && src_reg[ai as usize] != 0
                    && (src_reg[ai as usize] & RC_BORDER_REG) == 0
                    && chf.areas[i as usize] == chf.areas[ai as usize]
                {
                    let nr = src_reg[ai as usize];
                    let sw = &mut sweeps[previd as usize];
                    if sw.nei == 0 || sw.nei == nr {
                        sw.nei = nr;
                        sw.ns += 1;
                        if prev.len() as i32 <= nr {
                            let n = (prev.len() * 2).max(nr as usize + 1);
                            prev.resize(n, 0);
                        }
                        prev[nr as usize] += 1;
                    } else {
                        sw.nei = RC_NULL_NEI;
                    }
                }

                src_reg[i as usize] = previd;
            }
        }

        // Create unique ID.
        for i in 1..rid as usize {
            let sw = &mut sweeps[i];
            if sw.nei != RC_NULL_NEI && sw.nei != 0 && prev[sw.nei as usize] == sw.ns {
                sw.id = sw.nei;
            } else {
                sw.id = *id;
                *id += 1;
            }
        }

        // Remap IDs
        for x in border_size..w - border_size {
            let c = chf.cells[(x + y * w) as usize];

            for i in c.index..c.index + c.count {
                let r = src_reg[i as usize];
                if r > 0 && r < rid {
                    src_reg[i as usize] = sweeps[r as usize].id;
                }
            }
        }
    }
}

/// Port of rcBuildRegionsMonotone. Writes region ids into `chf.spans[i].reg` and sets `chf.max_regions`.
pub fn build_regions_monotone(chf: &mut RcCompactHeightfield, min_region_area: i32, merge_region_area: i32) {
    let border_size = chf.border_size;
    let mut id = 1;

    let mut src_reg = vec![0i32; chf.span_count as usize];

    // Mark border regions.
    paint_border_regions(border_size, chf, &mut src_reg, &mut id);

    sweep_rows(chf, &mut src_reg, border_size, &mut id);

    // Merge regions and filter out small regions.
    let mut overlaps: Vec<i32> = Vec::with_capacity(8);
    chf.max_regions = merge_and_filter_regions(min_region_area, merge_region_area, id, chf, &mut src_reg, &mut overlaps);
    // Monotone partitioning does not generate overlapping regions.

    // Store the result out.
    store_regions(chf, &src_reg);
}

/// Port of rcBuildRegions (watershed). Requires [`build_distance_field`] first. Writes region ids into
/// `chf.spans[i].reg` and sets `chf.max_regions`. Returns the number of overlapping regions found
/// (DotRecast only logs a warning for this).
pub fn build_regions(chf: &mut RcCompactHeightfield, min_region_area: i32, merge_region_area: i32) -> i32 {
    let border_size = chf.border_size;

    const LOG_NB_STACKS: i32 = 3;
    const NB_STACKS: usize = 1 << LOG_NB_STACKS;

    let mut lvl_stacks: Vec<Vec<RcLevelStackEntry>> = (0..NB_STACKS).map(|_| Vec::with_capacity(256)).collect();

    let mut stack: Vec<RcLevelStackEntry> = Vec::with_capacity(256);

    let mut src_reg = vec![0i32; chf.span_count as usize];
    let mut src_dist = vec![0i32; chf.span_count as usize];

    let mut region_id = 1;
    let mut level = (chf.max_distance + 1) & !1;

    // expandIters defines how much the watershed "overflows" and simplifies the regions.
    let expand_iters = 8;

    paint_border_regions(border_size, chf, &mut src_reg, &mut region_id);

    let mut s_id: i32 = -1;
    while level > 0 {
        level = if level >= 2 { level - 2 } else { 0 };
        s_id = (s_id + 1) & (NB_STACKS as i32 - 1);
        let su = s_id as usize;

        if s_id == 0 {
            sort_cells_by_level(level, chf, &src_reg, NB_STACKS, &mut lvl_stacks, 1);
        } else {
            // copy left overs from last level
            let (left, right) = lvl_stacks.split_at_mut(su);
            append_stacks(&left[su - 1], &mut right[0], &src_reg);
        }

        // Expand current regions until no empty connected cells found.
        expand_regions(expand_iters, level, chf, &mut src_reg, &mut src_dist, &mut lvl_stacks[su], false);

        // Mark new regions with IDs.
        for j in 0..lvl_stacks[su].len() {
            let current = lvl_stacks[su][j];
            let x = current.x;
            let y = current.y;
            let i = current.index;
            if i >= 0 && src_reg[i as usize] == 0 && flood_region(x, y, i, level, region_id, chf, &mut src_reg, &mut src_dist, &mut stack) {
                region_id += 1;
            }
        }
    }

    // Expand current regions until no empty connected cells found.
    expand_regions(expand_iters * 8, 0, chf, &mut src_reg, &mut src_dist, &mut stack, true);

    // Merge regions and filter out small regions.
    let mut overlaps: Vec<i32> = Vec::with_capacity(8);
    chf.max_regions = merge_and_filter_regions(min_region_area, merge_region_area, region_id, chf, &mut src_reg, &mut overlaps);
    let overlap_count = overlaps.len() as i32;

    // Write the result out.
    store_regions(chf, &src_reg);

    overlap_count
}

/// Port of rcBuildLayerRegions. Writes region ids into `chf.spans[i].reg` and sets `chf.max_regions`.
pub fn build_layer_regions(chf: &mut RcCompactHeightfield, min_region_area: i32) -> bool {
    let border_size = chf.border_size;
    let mut id = 1;

    let mut src_reg = vec![0i32; chf.span_count as usize];

    // Mark border regions.
    paint_border_regions(border_size, chf, &mut src_reg, &mut id);

    sweep_rows(chf, &mut src_reg, border_size, &mut id);

    // Merge monotone regions to layers and remove small regions.
    let (ok, max_regions) = merge_and_filter_layer_regions(min_region_area, id, chf, &mut src_reg);
    if ok {
        chf.max_regions = max_regions;
        store_regions(chf, &src_reg);
    }

    ok
}

#[cfg(test)]
pub(crate) mod test_util {
    use crate::types::*;
    use nav_math::Float3;

    /// Builds a single-layer compact heightfield from rows of '#' (walkable) and '.' (empty).
    /// Row index = z, column index = x. All spans have y = 0, area 63.
    pub fn chf_from_rows(rows: &[&str]) -> RcCompactHeightfield {
        let h = rows.len() as i32;
        let w = rows[0].len() as i32;
        let walk = |x: i32, y: i32| -> bool { x >= 0 && y >= 0 && x < w && y < h && rows[y as usize].as_bytes()[x as usize] == b'#' };
        let mut chf = RcCompactHeightfield {
            width: w,
            height: h,
            walkable_height: 2,
            walkable_climb: 1,
            bmin: Float3::new(0.0, 0.0, 0.0),
            bmax: Float3::new(w as f32, 1.0, h as f32),
            cs: 1.0,
            ch: 1.0,
            ..Default::default()
        };
        chf.cells = vec![RcCompactCell::default(); (w * h) as usize];
        let mut idx = vec![-1i32; (w * h) as usize];
        let mut n = 0;
        for y in 0..h {
            for x in 0..w {
                if walk(x, y) {
                    chf.cells[(x + y * w) as usize] = RcCompactCell { index: n, count: 1 };
                    idx[(x + y * w) as usize] = n;
                    chf.spans.push(RcCompactSpan { y: 0, reg: 0, con: 0xffff_ffff, h: 10 });
                    chf.areas.push(63);
                    n += 1;
                }
            }
        }
        chf.span_count = n;
        chf.dist = vec![0; n as usize];
        for y in 0..h {
            for x in 0..w {
                if !walk(x, y) {
                    continue;
                }
                let i = idx[(x + y * w) as usize] as usize;
                for dir in 0..4 {
                    let nx = x + RcCompactHeightfield::dir_offset_x(dir);
                    let ny = y + RcCompactHeightfield::dir_offset_y(dir);
                    if walk(nx, ny) {
                        RcCompactHeightfield::set_con(&mut chf.spans[i], dir, 0);
                    }
                }
            }
        }
        chf
    }
}

#[cfg(test)]
mod tests {
    use super::test_util::*;
    use super::*;

    /// The number of distinct non-border region ids. (`max_regions` can exceed it: like Recast, the
    /// watershed counts its last, never-used id.)
    fn distinct(chf: &RcCompactHeightfield) -> usize {
        let mut ids: Vec<i32> = chf.spans.iter().map(|s| s.reg).filter(|&r| r > 0 && r & RC_BORDER_REG == 0).collect();
        ids.sort();
        ids.dedup();
        ids.len()
    }

    fn region_grid(chf: &RcCompactHeightfield) -> Vec<Vec<i32>> {
        let mut out = vec![vec![-1; chf.width as usize]; chf.height as usize];
        for y in 0..chf.height {
            for x in 0..chf.width {
                let c = chf.cells[(x + y * chf.width) as usize];
                if c.count > 0 {
                    out[y as usize][x as usize] = chf.spans[c.index as usize].reg;
                }
            }
        }
        out
    }

    #[test]
    fn distance_field_of_a_block() {
        let mut chf = chf_from_rows(&["#######", "#######", "#######", "#######", "#######", "#######", "#######"]);
        let mut src = vec![0; chf.span_count as usize];
        let max = calculate_distance_field(&chf, &mut src);
        // The border cells are 0 (they have a missing neighbour); the centre is 3 cells in, 2 per step.
        assert_eq!(src[0], 0);
        assert_eq!(src[(3 + 3 * 7) as usize], 6);
        assert_eq!(max, 6);
        assert_eq!(src[(1 + 1 * 7) as usize], 2);
        assert_eq!(src[(2 + 1 * 7) as usize], 2);
        assert_eq!(src[(2 + 2 * 7) as usize], 4);
        build_distance_field(&mut chf);
        assert_eq!(chf.max_distance, 6);
        assert_eq!(chf.dist.len(), chf.span_count as usize);
        // Blur leaves values at or below the threshold alone.
        assert_eq!(chf.dist[0], 0);
        assert_eq!(chf.dist[(1 + 7) as usize], 2);
        // Centre of a symmetric plateau blurs to (6 + 4*4 ... ) neighbourhood average.
        let centre = chf.dist[(3 + 3 * 7) as usize];
        assert!(centre > 0 && centre <= 6);
    }

    #[test]
    fn watershed_single_block_is_one_region() {
        let mut chf = chf_from_rows(&["######", "######", "######", "######"]);
        build_distance_field(&mut chf);
        let overlaps = build_regions(&mut chf, 0, 0);
        assert_eq!(overlaps, 0);
        assert_eq!(distinct(&chf), 1);
        assert!(chf.spans.iter().all(|s| s.reg == 1));
    }

    #[test]
    fn watershed_two_islands() {
        let mut chf = chf_from_rows(&["####..####", "####..####", "####..####", "####..####"]);
        build_distance_field(&mut chf);
        build_regions(&mut chf, 0, 0);
        assert_eq!(distinct(&chf), 2);
        let g = region_grid(&chf);
        assert_ne!(g[0][0], g[0][9]);
        assert!(g[0][0] > 0 && g[0][9] > 0);
        for row in &g {
            assert_eq!(row[0], row[3]);
            assert_eq!(row[6], row[9]);
        }
    }

    #[test]
    fn watershed_l_shape_and_hole() {
        let mut chf = chf_from_rows(&["###.....", "###.....", "###.....", "########", "########", "########"]);
        build_distance_field(&mut chf);
        build_regions(&mut chf, 0, 0);
        assert!(chf.max_regions >= 1);
        assert!(chf.spans.iter().all(|s| s.reg > 0));

        // A ring with a hole in the middle stays a single region (merged) or splits but is all assigned.
        let mut ring = chf_from_rows(&["#######", "#######", "###.###", "#######", "#######"]);
        build_distance_field(&mut ring);
        build_regions(&mut ring, 0, 0);
        assert!(ring.spans.iter().all(|s| s.reg > 0));
    }

    #[test]
    fn monotone_regions_on_shapes() {
        // Two islands: two regions.
        let mut chf = chf_from_rows(&["###..###", "###..###", "###..###"]);
        build_regions_monotone(&mut chf, 0, 0);
        assert_eq!(distinct(&chf), 2);
        let g = region_grid(&chf);
        assert_ne!(g[0][0], g[0][7]);
        assert_eq!(g[0][0], g[2][2]);

        // An L is one monotone region (rows chain through the column neighbours).
        let mut l = chf_from_rows(&["##..", "##..", "####", "####"]);
        build_regions_monotone(&mut l, 0, 0);
        assert_eq!(distinct(&l), 1);
        assert!(l.spans.iter().all(|s| s.reg == 1));

        // A hole: the cells either side of the hole join through the rows above and below.
        let mut ring = chf_from_rows(&["#####", "##.##", "#####"]);
        build_regions_monotone(&mut ring, 0, 0);
        assert!(ring.spans.iter().all(|s| s.reg > 0));
    }

    #[test]
    fn small_regions_are_filtered() {
        // A 1-cell island (not connected to the big one) is removed with min_region_area 2.
        let rows = ["###.#", "###..", "###.."];
        let mut chf = chf_from_rows(&rows);
        build_regions_monotone(&mut chf, 2, 0);
        let g = region_grid(&chf);
        assert_eq!(g[0][4], 0);
        assert!(g[0][0] > 0);
        assert_eq!(distinct(&chf), 1);

        // And it survives with min_region_area 1.
        let mut chf = chf_from_rows(&rows);
        build_regions_monotone(&mut chf, 1, 0);
        assert_eq!(distinct(&chf), 2);

        // Watershed likewise.
        let mut chf = chf_from_rows(&rows);
        build_distance_field(&mut chf);
        build_regions(&mut chf, 2, 0);
        let g = region_grid(&chf);
        assert_eq!(g[0][4], 0);
    }

    #[test]
    fn layer_regions() {
        let mut chf = chf_from_rows(&["###..###", "###..###", "###..###"]);
        assert!(build_layer_regions(&mut chf, 0));
        assert_eq!(distinct(&chf), 2);
        let g = region_grid(&chf);
        assert_ne!(g[0][0], g[0][7]);
        let mut chf = chf_from_rows(&["##..", "##..", "####"]);
        assert!(build_layer_regions(&mut chf, 0));
        assert_eq!(distinct(&chf), 1);
    }

    #[test]
    fn border_regions_are_painted() {
        let mut chf = chf_from_rows(&["########", "########", "########", "########", "########", "########"]);
        chf.border_size = 1;
        build_regions_monotone(&mut chf, 0, 0);
        let g = region_grid(&chf);
        assert!(g[0][3] & RC_BORDER_REG != 0);
        assert!(g[3][0] & RC_BORDER_REG != 0);
        assert!(g[2][3] > 0 && g[2][3] & RC_BORDER_REG == 0);
    }

    #[test]
    fn determinism() {
        let rows = ["###.######", "###.######", "###..#####", "##########", "#####..###", "#####..###"];
        let run = || {
            let mut chf = chf_from_rows(&rows);
            build_distance_field(&mut chf);
            let o = build_regions(&mut chf, 1, 2);
            (chf.spans.iter().map(|s| s.reg).collect::<Vec<_>>(), chf.dist.clone(), chf.max_regions, o)
        };
        assert_eq!(run(), run());
        let run_m = || {
            let mut chf = chf_from_rows(&rows);
            build_regions_monotone(&mut chf, 1, 2);
            chf.spans.iter().map(|s| s.reg).collect::<Vec<_>>()
        };
        assert_eq!(run_m(), run_m());
    }
}
