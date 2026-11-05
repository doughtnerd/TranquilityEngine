//! Contour building (`RcContours`): traces each region's outline on the compact heightfield,
//! simplifies it, and merges holes into their region's outline. A function-by-function port of
//! Foxfire's `RcContours` (DotRecast's `RcContours`). The flattened form of a contour
//! (`RcContourHeader`) lives in [`crate::types`].
use crate::constants::*;
use crate::types::build_contours_flags::*;
use crate::types::*;
use nav_math::Int4;

#[derive(Clone, Copy, Debug, Default)]
struct RcContourHole {
    /// Index into cset.conts.
    contour: i32,
    minx: i32,
    minz: i32,
    leftmost: i32,
}

#[derive(Clone, Debug)]
struct RcContourRegion {
    /// Index into cset.conts, -1 if none.
    outline: i32,
    holes: Vec<RcContourHole>,
}

#[derive(Clone, Copy, Debug, Default)]
struct RcPotentialDiagonal {
    vert: i32,
    dist: i32,
}

// ------------------------------------------------------------------ helpers

#[inline]
fn nei(chf: &RcCompactHeightfield, x: i32, y: i32, dir: i32, s: &RcCompactSpan) -> i32 {
    let con = RcCompactHeightfield::get_con(s, dir);
    if con == RC_NOT_CONNECTED {
        return -1;
    }
    chf.cells[(x + get_dir_offset_x(dir) + (y + get_dir_offset_y(dir)) * chf.width) as usize].index + con
}

fn insert_at<T: Copy>(list: &mut Vec<T>, index: usize, value: T) {
    list.insert(index, value);
}

// Geometric predicates (these live in RcMeshs in DotRecast), operating on the xz components.
#[inline]
fn next(i: i32, n: i32) -> i32 {
    if i + 1 < n { i + 1 } else { 0 }
}

#[inline]
fn prev(i: i32, n: i32) -> i32 {
    if i - 1 >= 0 { i - 1 } else { n - 1 }
}

#[inline]
fn area2(a: Int4, b: Int4, c: Int4) -> i32 {
    (b.x.wrapping_sub(a.x)).wrapping_mul(c.z.wrapping_sub(a.z)).wrapping_sub((c.x.wrapping_sub(a.x)).wrapping_mul(b.z.wrapping_sub(a.z)))
}

#[inline]
fn left(a: Int4, b: Int4, c: Int4) -> bool {
    area2(a, b, c) < 0
}

#[inline]
fn left_on(a: Int4, b: Int4, c: Int4) -> bool {
    area2(a, b, c) <= 0
}

#[inline]
fn collinear(a: Int4, b: Int4, c: Int4) -> bool {
    area2(a, b, c) == 0
}

#[inline]
fn v_equal(a: Int4, b: Int4) -> bool {
    a.x == b.x && a.z == b.z
}

fn intersect_prop(a: Int4, b: Int4, c: Int4, d: Int4) -> bool {
    // Eliminate improper cases.
    if collinear(a, b, c) || collinear(a, b, d) || collinear(c, d, a) || collinear(c, d, b) {
        return false;
    }

    (!left(a, b, c) ^ !left(a, b, d)) && (!left(c, d, a) ^ !left(c, d, b))
}

fn between(a: Int4, b: Int4, c: Int4) -> bool {
    if !collinear(a, b, c) {
        return false;
    }

    // If ab not vertical, check betweenness on x; else on z.
    if a.x != b.x {
        return (a.x <= c.x && c.x <= b.x) || (a.x >= c.x && c.x >= b.x);
    }
    (a.z <= c.z && c.z <= b.z) || (a.z >= c.z && c.z >= b.z)
}

fn intersect(a: Int4, b: Int4, c: Int4, d: Int4) -> bool {
    intersect_prop(a, b, c, d) || between(a, b, c) || between(a, b, d) || between(c, d, a) || between(c, d, b)
}

// ------------------------------------------------------------ contour tracing

/// The corner height of the vertex at the `dir` corner of span `i`, and whether it is a border
/// vertex (which gets removed later to match tile edges).
fn get_corner_height(x: i32, y: i32, i: i32, dir: i32, chf: &RcCompactHeightfield) -> (i32, bool) {
    let mut is_border_vertex = false;

    let s = chf.spans[i as usize];
    let mut ch = s.y;
    let dirp = (dir + 1) & 0x3;

    let mut regs = [0i32; 4];

    // Combine region and area codes in order to prevent
    // border vertices which are in between two areas to be removed.
    regs[0] = chf.spans[i as usize].reg | (chf.areas[i as usize] << 16);

    let ai = nei(chf, x, y, dir, &s);
    if ai >= 0 {
        let a_span = chf.spans[ai as usize];
        ch = ch.max(a_span.y);
        regs[1] = chf.spans[ai as usize].reg | (chf.areas[ai as usize] << 16);

        let ai2 = nei(chf, x + get_dir_offset_x(dir), y + get_dir_offset_y(dir), dirp, &a_span);
        if ai2 >= 0 {
            ch = ch.max(chf.spans[ai2 as usize].y);
            regs[2] = chf.spans[ai2 as usize].reg | (chf.areas[ai2 as usize] << 16);
        }
    }

    let ai = nei(chf, x, y, dirp, &s);
    if ai >= 0 {
        let a_span = chf.spans[ai as usize];
        ch = ch.max(a_span.y);
        regs[3] = chf.spans[ai as usize].reg | (chf.areas[ai as usize] << 16);

        let ai2 = nei(chf, x + get_dir_offset_x(dirp), y + get_dir_offset_y(dirp), dir, &a_span);
        if ai2 >= 0 {
            ch = ch.max(chf.spans[ai2 as usize].y);
            regs[2] = chf.spans[ai2 as usize].reg | (chf.areas[ai2 as usize] << 16); // (sic) matches the original, which writes regs[2] here
        }
    }

    // Check if the vertex is special edge vertex, these vertices will be removed later.
    for j in 0..4usize {
        let a = j;
        let b = (j + 1) & 0x3;
        let c = (j + 2) & 0x3;
        let d = (j + 3) & 0x3;

        // The vertex is a border vertex there are two same exterior cells in a row,
        // followed by two interior cells and none of the regions are out of Bounds.
        let two_same_exts = (regs[a] & regs[b] & RC_BORDER_REG) != 0 && regs[a] == regs[b];
        let two_ints = ((regs[c] | regs[d]) & RC_BORDER_REG) == 0;
        let ints_same_area = regs[c] >> 16 == regs[d] >> 16;
        let no_zeros = regs[a] != 0 && regs[b] != 0 && regs[c] != 0 && regs[d] != 0;
        if two_same_exts && two_ints && ints_same_area && no_zeros {
            is_border_vertex = true;
            break;
        }
    }

    (ch, is_border_vertex)
}

fn walk_contour(x: i32, y: i32, i: i32, chf: &RcCompactHeightfield, flags: &mut [i32], points: &mut Vec<Int4>) {
    let (mut x, mut y, mut i) = (x, y, i);
    // Choose the first non-connected edge
    let mut dir = 0;
    while (flags[i as usize] & (1 << dir)) == 0 {
        dir += 1;
    }

    let start_dir = dir;
    let starti = i;

    let area = chf.areas[i as usize];

    let mut iter = 0;
    loop {
        iter += 1;
        if iter >= 40000 {
            break;
        }
        if (flags[i as usize] & (1 << dir)) != 0 {
            // Choose the edge corner
            let mut is_area_border = false;
            let mut px = x;
            let (py, is_border_vertex) = get_corner_height(x, y, i, dir, chf);
            let mut pz = y;
            match dir {
                0 => pz += 1,
                1 => {
                    px += 1;
                    pz += 1;
                }
                2 => px += 1,
                _ => {}
            }

            let mut r = 0;
            let s = chf.spans[i as usize];
            let ai = nei(chf, x, y, dir, &s);
            if ai >= 0 {
                r = chf.spans[ai as usize].reg;
                if area != chf.areas[ai as usize] {
                    is_area_border = true;
                }
            }

            if is_border_vertex {
                r |= RC_BORDER_VERTEX;
            }
            if is_area_border {
                r |= RC_AREA_BORDER;
            }
            points.push(Int4::new(px, py, pz, r));

            flags[i as usize] &= !(1 << dir); // Remove visited edges
            dir = (dir + 1) & 0x3; // Rotate CW
        } else {
            let s = chf.spans[i as usize];
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
}

/// Squared distance from (x, z) to segment p-q, in doubles from the integer coordinates: every sum and product
/// is an exact integer and only the final division rounds, so every target gets the same bits.
fn distance_pt_seg(x: i32, z: i32, px: i32, pz: i32, qx: i32, qz: i32) -> f64 {
    let pqx = qx.wrapping_sub(px) as f64;
    let pqz = qz.wrapping_sub(pz) as f64;
    let dx = x.wrapping_sub(px) as f64;
    let dz = z.wrapping_sub(pz) as f64;
    let d = pqx * pqx + pqz * pqz;
    let t = pqx * dx + pqz * dz;
    if d <= 0.0 || t <= 0.0 {
        return dx * dx + dz * dz; // nearest to p
    }
    if t >= d {
        let ex = x.wrapping_sub(qx) as f64;
        let ez = z.wrapping_sub(qz) as f64;
        return ex * ex + ez * ez; // nearest to q
    }

    let cross = pqx * dz - pqz * dx; // |pq x pc| = |pq| * distance to the line
    cross * cross / d
}

fn simplify_contour(points: &[Int4], simplified: &mut Vec<Int4>, max_error: f32, max_edge_len: i32, build_flags: i32) {
    if points.is_empty() {
        return;
    }
    // Add initial points.
    let mut has_connections = false;
    for p in points {
        if (p.w & RC_CONTOUR_REG_MASK) != 0 {
            has_connections = true;
            break;
        }
    }

    if has_connections {
        // The contour has some portals to other regions.
        // Add a new point to every location where the region changes.
        let ni = points.len();
        for i in 0..ni {
            let ii = (i + 1) % ni;
            let different_regs = (points[i].w & RC_CONTOUR_REG_MASK) != (points[ii].w & RC_CONTOUR_REG_MASK);
            let area_borders = (points[i].w & RC_AREA_BORDER) != (points[ii].w & RC_AREA_BORDER);
            if different_regs || area_borders {
                simplified.push(Int4::new(points[i].x, points[i].y, points[i].z, i as i32));
            }
        }
    }

    if simplified.is_empty() {
        // If there is no connections at all,
        // create some initial points for the simplification process.
        // Find lower-left and upper-right vertices of the contour.
        let mut llx = points[0].x;
        let mut lly = points[0].y;
        let mut llz = points[0].z;
        let mut lli = 0;
        let mut urx = points[0].x;
        let mut ury = points[0].y;
        let mut urz = points[0].z;
        let mut uri = 0;
        for (i, p) in points.iter().enumerate() {
            let (x, y, z) = (p.x, p.y, p.z);
            if x < llx || (x == llx && z < llz) {
                llx = x;
                lly = y;
                llz = z;
                lli = i as i32;
            }

            if x > urx || (x == urx && z > urz) {
                urx = x;
                ury = y;
                urz = z;
                uri = i as i32;
            }
        }

        simplified.push(Int4::new(llx, lly, llz, lli));
        simplified.push(Int4::new(urx, ury, urz, uri));
    }

    // Add points until all raw points are within
    // error tolerance to the simplified shape.
    let pn = points.len() as i32;
    let mut i = 0usize;
    while i < simplified.len() {
        let ii = (i + 1) % simplified.len();

        let mut ax = simplified[i].x;
        let mut az = simplified[i].z;
        let ai = simplified[i].w;

        let mut bx = simplified[ii].x;
        let mut bz = simplified[ii].z;
        let bi = simplified[ii].w;

        // Find maximum deviation from the segment.
        let mut maxd: f64 = 0.0;
        let mut maxi: i32 = -1;
        let mut ci: i32;
        let cinc: i32;
        let endi: i32;

        // Traverse the segment in lexilogical order so that the
        // max deviation is calculated similarly when traversing
        // opposite segments.
        if bx > ax || (bx == ax && bz > az) {
            cinc = 1;
            ci = (ai + cinc) % pn;
            endi = bi;
        } else {
            cinc = pn - 1;
            ci = (bi + cinc) % pn;
            endi = ai;
            std::mem::swap(&mut ax, &mut bx);
            std::mem::swap(&mut az, &mut bz);
        }

        // Tessellate only outer edges or edges between areas.
        if (points[ci as usize].w & RC_CONTOUR_REG_MASK) == 0 || (points[ci as usize].w & RC_AREA_BORDER) != 0 {
            while ci != endi {
                let d = distance_pt_seg(points[ci as usize].x, points[ci as usize].z, ax, az, bx, bz);
                if d > maxd {
                    maxd = d;
                    maxi = ci;
                }

                ci = (ci + cinc) % pn;
            }
        }

        // If the max deviation is larger than accepted error,
        // add new point, else continue to next segment.
        if maxi != -1 && maxd > (max_error as f64) * (max_error as f64) {
            let p = points[maxi as usize];
            insert_at(simplified, i + 1, Int4::new(p.x, p.y, p.z, maxi));
        } else {
            i += 1;
        }
    }

    // Split too long edges.
    if max_edge_len > 0 && (build_flags & (RC_CONTOUR_TESS_WALL_EDGES | RC_CONTOUR_TESS_AREA_EDGES)) != 0 {
        let mut i = 0usize;
        while i < simplified.len() {
            let ii = (i + 1) % simplified.len();

            let ax = simplified[i].x;
            let az = simplified[i].z;
            let ai = simplified[i].w;

            let bx = simplified[ii].x;
            let bz = simplified[ii].z;
            let bi = simplified[ii].w;

            // Find maximum deviation from the segment.
            let mut maxi: i32 = -1;
            let ci = ((ai + 1) % pn) as usize;

            // Tessellate only outer edges or edges between areas.
            let mut tess = false;
            // Wall edges.
            if (build_flags & RC_CONTOUR_TESS_WALL_EDGES) != 0 && (points[ci].w & RC_CONTOUR_REG_MASK) == 0 {
                tess = true;
            }

            // Edges between areas.
            if (build_flags & RC_CONTOUR_TESS_AREA_EDGES) != 0 && (points[ci].w & RC_AREA_BORDER) != 0 {
                tess = true;
            }

            if tess {
                let dx = bx.wrapping_sub(ax);
                let dz = bz.wrapping_sub(az);
                if dx.wrapping_mul(dx).wrapping_add(dz.wrapping_mul(dz)) > max_edge_len.wrapping_mul(max_edge_len) {
                    // Round based on the segments in lexilogical order so that the
                    // max tesselation is consistent regardless in which direction
                    // segments are traversed.
                    let n = if bi < ai { bi + pn - ai } else { bi - ai };
                    if n > 1 {
                        if bx > ax || (bx == ax && bz > az) {
                            maxi = (ai + n / 2) % pn;
                        } else {
                            maxi = (ai + (n + 1) / 2) % pn;
                        }
                    }
                }
            }

            // If the max deviation is larger than accepted error,
            // add new point, else continue to next segment.
            if maxi != -1 {
                let p = points[maxi as usize];
                insert_at(simplified, i + 1, Int4::new(p.x, p.y, p.z, maxi));
            } else {
                i += 1;
            }
        }
    }

    for v in simplified.iter_mut() {
        // The edge vertex flag is take from the current raw point,
        // and the neighbour region is take from the next raw point.
        let ai = ((v.w + 1) % pn) as usize;
        let bi = v.w as usize;
        v.w = (points[ai].w & (RC_CONTOUR_REG_MASK | RC_AREA_BORDER)) | (points[bi].w & RC_BORDER_VERTEX);
    }
}

fn calc_area_of_polygon_2d(verts: &[Int4]) -> i32 {
    let nverts = verts.len();
    let mut area: i32 = 0;
    let mut j = nverts.wrapping_sub(1);
    for i in 0..nverts {
        let vi = verts[i];
        let vj = verts[j];
        area = area.wrapping_add(vi.x.wrapping_mul(vj.z).wrapping_sub(vj.x.wrapping_mul(vi.z)));
        j = i;
    }

    area.wrapping_add(1) / 2
}

fn intersect_seg_contour(d0: Int4, d1: Int4, i: i32, verts: &[Int4]) -> bool {
    let n = verts.len() as i32;

    // For each edge (k,k+1) of P
    for k in 0..n {
        let k1 = next(k, n);

        // Skip edges incident to i.
        if i == k || i == k1 {
            continue;
        }

        let p0 = verts[k as usize];
        let p1 = verts[k1 as usize];

        if v_equal(d0, p0) || v_equal(d1, p0) || v_equal(d0, p1) || v_equal(d1, p1) {
            continue;
        }

        if intersect(d0, d1, p0, p1) {
            return true;
        }
    }

    false
}

fn in_cone(i: i32, n: i32, verts: &[Int4], pj: Int4) -> bool {
    let pi = verts[i as usize];
    let pi1 = verts[next(i, n) as usize];
    let pin1 = verts[prev(i, n) as usize];

    // If P[i] is a convex vertex [ i+1 left or on (i-1,i) ].
    if left_on(pin1, pi, pi1) {
        return left(pi, pj, pin1) && left(pj, pi, pi1);
    }

    // Assume (i-1,i,i+1) not collinear.
    // else P[i] is reflex.
    !(left_on(pi, pj, pi1) && left_on(pj, pi, pin1))
}

fn remove_degenerate_segments(simplified: &mut Vec<Int4>) {
    // Remove adjacent vertices which are equal on xz-plane,
    // or else the triangulator will get confused.
    let mut npts = simplified.len() as i32;
    let mut i = 0;
    while i < npts {
        let ni = next(i, npts);

        if simplified[i as usize].x == simplified[ni as usize].x && simplified[i as usize].z == simplified[ni as usize].z {
            // Degenerate segment, remove.
            simplified.remove(i as usize);
            npts -= 1;
        }
        i += 1;
    }
}

/// Merges hole contour `cb` into outline `ca` at outline vertex `ia` and hole vertex `ib`; `cb`'s
/// vertices are emptied.
fn merge_contours(cset: &mut RcContourSet, ca_index: usize, cb_index: usize, ia: i32, ib: i32) {
    let ca_n = cset.conts[ca_index].verts.len() as i32;
    let cb_n = cset.conts[cb_index].verts.len() as i32;
    let max_verts = (ca_n + cb_n + 2) as usize;
    let mut verts: Vec<Int4> = Vec::with_capacity(max_verts);

    // Copy contour A.
    for i in 0..=ca_n {
        verts.push(cset.conts[ca_index].verts[((ia + i) % ca_n) as usize]);
    }

    // Copy contour B
    for i in 0..=cb_n {
        verts.push(cset.conts[cb_index].verts[((ib + i) % cb_n) as usize]);
    }

    cset.conts[ca_index].verts = verts;
    cset.conts[cb_index].verts = Vec::new();
}

/// Finds the lowest leftmost vertex of a contour. Returns (minx, minz, leftmost index).
fn find_left_most_vertex(verts: &[Int4]) -> (i32, i32, i32) {
    let mut minx = verts[0].x;
    let mut minz = verts[0].z;
    let mut leftmost = 0;
    for (i, v) in verts.iter().enumerate().skip(1) {
        let x = v.x;
        let z = v.z;
        if x < minx || (x == minx && z < minz) {
            minx = x;
            minz = z;
            leftmost = i as i32;
        }
    }

    (minx, minz, leftmost)
}

fn merge_region_holes(cset: &mut RcContourSet, region: &mut RcContourRegion) {
    let nholes = region.holes.len();

    // Sort holes from left to right.
    for hole in region.holes.iter_mut() {
        let (minx, minz, leftmost) = find_left_most_vertex(&cset.conts[hole.contour as usize].verts);
        hole.minx = minx;
        hole.minz = minz;
        hole.leftmost = leftmost;
    }

    // NativeSortExtension.Sort is an unstable introsort; a stable sort gives the same order for
    // distinct keys and a fixed order for ties.
    region.holes.sort_by(|a, b| {
        if a.minx == b.minx {
            a.minz.cmp(&b.minz)
        } else {
            a.minx.cmp(&b.minx)
        }
    });

    let mut diags: Vec<RcPotentialDiagonal> = Vec::new();

    // Merge holes into the outline one by one.
    for i in 0..nholes {
        let hole_contour = region.holes[i].contour as usize;
        let hole_n = cset.conts[hole_contour].verts.len() as i32;

        let mut index: i32 = -1;
        let mut best_vertex = region.holes[i].leftmost;
        for _iter in 0..hole_n {
            let outline_verts = &cset.conts[region.outline as usize].verts;
            let hole_verts = &cset.conts[hole_contour].verts;
            let outline_n = outline_verts.len() as i32;

            // Find potential diagonals.
            // The 'best' vertex must be in the cone described by 3 consecutive vertices of the outline.
            diags.clear();
            let corner = hole_verts[best_vertex as usize];
            for j in 0..outline_n {
                if in_cone(j, outline_n, outline_verts, corner) {
                    let dx = outline_verts[j as usize].x.wrapping_sub(corner.x);
                    let dz = outline_verts[j as usize].z.wrapping_sub(corner.z);
                    diags.push(RcPotentialDiagonal { vert: j, dist: dx.wrapping_mul(dx).wrapping_add(dz.wrapping_mul(dz)) });
                }
            }

            // Sort potential diagonals by distance, we want to make the connection as short as possible.
            diags.sort_by(|a, b| a.dist.cmp(&b.dist));

            // Find a diagonal that is not intersecting the outline not the remaining holes.
            index = -1;
            for d in diags.iter() {
                let pt = outline_verts[d.vert as usize];
                let mut intersect = intersect_seg_contour(pt, corner, d.vert, outline_verts);
                let mut k = i;
                while k < nholes && !intersect {
                    intersect |= intersect_seg_contour(pt, corner, -1, &cset.conts[region.holes[k].contour as usize].verts);
                    k += 1;
                }
                if !intersect {
                    index = d.vert;
                    break;
                }
            }

            // If found non-intersecting diagonal, stop looking.
            if index != -1 {
                break;
            }

            // All the potential diagonals for the current vertex were intersecting, try next vertex.
            best_vertex = (best_vertex + 1) % hole_n;
        }

        if index == -1 {
            cset.merge_hole_failures += 1; // "mergeHoles: Failed to find merge points"
            continue;
        }

        merge_contours(cset, region.outline as usize, hole_contour, index, best_vertex);
    }
}

/// Port of rcBuildContours. The raw contours match the region outlines exactly; `max_error` and
/// `max_edge_len` control how closely the simplified contours match them (`max_edge_len` 0 disables
/// edge splitting). On failure the status says why and `cset` is left default.
pub fn build_contours(chf: &RcCompactHeightfield, max_error: f32, max_edge_len: i32, build_flags: i32, cset: &mut RcContourSet) -> RcContourStatus {
    let w = chf.width;
    let h = chf.height;
    let border_size = chf.border_size;

    *cset = RcContourSet {
        conts: Vec::with_capacity(32),
        bmin: chf.bmin,
        bmax: chf.bmax,
        cs: chf.cs,
        ch: chf.ch,
        width: chf.width - chf.border_size * 2,
        height: chf.height - chf.border_size * 2,
        border_size: chf.border_size,
        max_error,
        merge_hole_failures: 0,
    };

    if border_size > 0 {
        // If the heightfield was build with bordersize, remove the offset.
        let pad = border_size as f32 * chf.cs;
        cset.bmin.x += pad;
        cset.bmin.z += pad;
        cset.bmax.x -= pad;
        cset.bmax.z -= pad;
    }

    let mut flags = vec![0i32; chf.span_count as usize];

    // Mark boundaries.
    for y in 0..h {
        for x in 0..w {
            let c = chf.cells[(x + y * w) as usize];
            for i in c.index..c.index + c.count {
                let mut res = 0;
                let s = chf.spans[i as usize];
                if s.reg == 0 || (s.reg & RC_BORDER_REG) != 0 {
                    flags[i as usize] = 0;
                    continue;
                }

                for dir in 0..4 {
                    let mut r = 0;
                    let ai = nei(chf, x, y, dir, &s);
                    if ai >= 0 {
                        r = chf.spans[ai as usize].reg;
                    }

                    if r == s.reg {
                        res |= 1 << dir;
                    }
                }

                flags[i as usize] = res ^ 0xf; // Inverse, mark non connected edges.
            }
        }
    }

    let mut verts: Vec<Int4> = Vec::with_capacity(256);
    let mut simplified: Vec<Int4> = Vec::with_capacity(64);

    for y in 0..h {
        for x in 0..w {
            let c = chf.cells[(x + y * w) as usize];
            for i in c.index..c.index + c.count {
                if flags[i as usize] == 0 || flags[i as usize] == 0xf {
                    flags[i as usize] = 0;
                    continue;
                }

                let reg = chf.spans[i as usize].reg;
                if reg == 0 || (reg & RC_BORDER_REG) != 0 {
                    continue;
                }
                let area = chf.areas[i as usize];

                verts.clear();
                simplified.clear();

                walk_contour(x, y, i, chf, &mut flags, &mut verts);

                simplify_contour(&verts, &mut simplified, max_error, max_edge_len, build_flags);
                remove_degenerate_segments(&mut simplified);

                // Store region->contour remap info.
                // Create contour.
                if simplified.len() >= 3 {
                    let mut cont = RcContour {
                        reg,
                        area,
                        verts: Vec::with_capacity(simplified.len()),
                        rverts: Vec::with_capacity(verts.len()),
                    };

                    for &sv in simplified.iter() {
                        let mut v = sv;
                        if border_size > 0 {
                            // If the heightfield was build with bordersize, remove the offset.
                            v.x -= border_size;
                            v.z -= border_size;
                        }

                        cont.verts.push(v);
                    }

                    for &rv in verts.iter() {
                        let mut v = rv;
                        if border_size > 0 {
                            v.x -= border_size;
                            v.z -= border_size;
                        }

                        cont.rverts.push(v);
                    }

                    cset.conts.push(cont);
                }
            }
        }
    }

    // Merge holes if needed.
    if !cset.conts.is_empty() {
        // Calculate winding of all polygons.
        let mut winding = vec![0i32; cset.conts.len()];
        let mut nholes = 0;
        for i in 0..cset.conts.len() {
            // If the contour is wound backwards, it is a hole.
            winding[i] = if calc_area_of_polygon_2d(&cset.conts[i].verts) < 0 { -1 } else { 1 };
            if winding[i] < 0 {
                nholes += 1;
            }
        }

        if nholes > 0 {
            // Collect outline contour and holes contours per region.
            // We assume that there is one outline and multiple holes.
            let nregions = (chf.max_regions + 1).max(0) as usize;
            let mut regions: Vec<RcContourRegion> = (0..nregions).map(|_| RcContourRegion { outline: -1, holes: Vec::new() }).collect();

            let mut status = RcContourStatus::Success;

            for i in 0..cset.conts.len() {
                if status != RcContourStatus::Success {
                    break;
                }
                let creg = cset.conts[i].reg;
                // (The C# indexes unchecked; a region id past max_regions grows the table here.)
                if creg < 0 {
                    continue;
                }
                if creg as usize >= regions.len() {
                    regions.resize_with(creg as usize + 1, || RcContourRegion { outline: -1, holes: Vec::new() });
                }
                let region = &mut regions[creg as usize];

                // Positively would contours are outlines, negative holes.
                if winding[i] > 0 {
                    if region.outline != -1 {
                        status = RcContourStatus::MultipleOutlines;
                        break;
                    }

                    region.outline = i as i32;
                } else {
                    region.holes.push(RcContourHole { contour: i as i32, ..Default::default() });
                }
            }

            // Finally merge each regions holes into the outline.
            let mut i = 0;
            while i < regions.len() && status == RcContourStatus::Success {
                let region = &mut regions[i];
                i += 1;
                if region.holes.is_empty() {
                    continue;
                }

                if region.outline >= 0 {
                    merge_region_holes(cset, region);
                } else {
                    // The region does not have an outline.
                    // This can happen if the contour becaomes selfoverlapping because of
                    // too aggressive simplification settings.
                    status = RcContourStatus::BadOutline;
                }
            }

            if status != RcContourStatus::Success {
                *cset = RcContourSet::default();
                return status;
            }

            return RcContourStatus::Success;
        }
    }

    RcContourStatus::Success
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::regions::test_util::chf_from_rows;
    use crate::regions::{build_distance_field, build_regions, build_regions_monotone};

    fn contours(rows: &[&str], max_error: f32, max_edge_len: i32, flags: i32) -> (RcContourStatus, RcContourSet) {
        let mut chf = chf_from_rows(rows);
        build_regions_monotone(&mut chf, 0, 0);
        let mut cset = RcContourSet::default();
        let st = build_contours(&chf, max_error, max_edge_len, flags, &mut cset);
        (st, cset)
    }

    #[test]
    fn square_contour() {
        let (st, cset) = contours(&["####", "####", "####", "####"], 1.3, 0, 0);
        assert_eq!(st, RcContourStatus::Success);
        assert_eq!(cset.conts.len(), 1);
        let c = &cset.conts[0];
        // Raw: the perimeter of a 4x4 square has 16 unit edges, one vertex each corner step: 16.
        assert_eq!(c.rverts.len(), 16);
        // Simplified: the 4 corners.
        assert_eq!(c.verts.len(), 4);
        assert!(calc_area_of_polygon_2d(&c.verts) > 0);
        assert_eq!(calc_area_of_polygon_2d(&c.verts), 16);
        assert_eq!(cset.width, 4);
        assert_eq!(cset.merge_hole_failures, 0);
    }

    #[test]
    fn wall_edge_tessellation_splits_long_edges() {
        let (_, cset) = contours(&["########", "########", "########", "########"], 1.3, 4, RC_CONTOUR_TESS_WALL_EDGES);
        // 8-long edges are split to <= 4.
        assert!(cset.conts[0].verts.len() > 4);
        let (_, plain) = contours(&["########", "########", "########", "########"], 1.3, 0, 0);
        assert_eq!(plain.conts[0].verts.len(), 4);
    }

    #[test]
    fn hole_is_merged_into_outline() {
        let rows = ["#########", "#########", "#########", "###...###", "###...###", "###...###", "#########", "#########", "#########"];
        // Watershed gives one region with an inner hole contour.
        let mut chf = chf_from_rows(&rows);
        build_regions_monotone(&mut chf, 0, 0);
        // Force a single region so the hole belongs to one outline.
        for s in chf.spans.iter_mut() {
            s.reg = 1;
        }
        chf.max_regions = 1;
        let mut cset = RcContourSet::default();
        let st = build_contours(&chf, 1.3, 0, 0, &mut cset);
        assert_eq!(st, RcContourStatus::Success);
        // The hole's contour is emptied and its vertices live in the outline.
        assert_eq!(cset.conts.len(), 2);
        let outline = cset.conts.iter().find(|c| c.verts.len() > 4).expect("merged outline");
        let hole = cset.conts.iter().find(|c| c.verts.is_empty());
        assert!(hole.is_some());
        // outline (4) + hole (4) + 2 bridge vertices.
        assert_eq!(outline.verts.len(), 4 + 4 + 2);
        assert!(!outline.rverts.is_empty());
        assert_eq!(cset.merge_hole_failures, 0);
    }

    #[test]
    fn two_regions_have_shared_portals() {
        let mut chf = chf_from_rows(&["######", "######", "######"]);
        // Two regions side by side.
        let n = chf.spans.len();
        for i in 0..n {
            chf.spans[i].reg = if (i % 6) < 3 { 1 } else { 2 };
        }
        chf.max_regions = 2;
        let mut cset = RcContourSet::default();
        assert_eq!(build_contours(&chf, 1.3, 0, 0, &mut cset), RcContourStatus::Success);
        assert_eq!(cset.conts.len(), 2);
        // Each region's contour carries the neighbour region on the shared edge.
        assert!(cset.conts[0].verts.iter().any(|v| (v.w & RC_CONTOUR_REG_MASK) == 2));
        assert!(cset.conts[1].verts.iter().any(|v| (v.w & RC_CONTOUR_REG_MASK) == 1));
    }

    #[test]
    fn multiple_outlines_status() {
        // Two disjoint squares given the same region id: two outlines for one region.
        let mut chf = chf_from_rows(&["##.##", "##.##"]);
        for s in chf.spans.iter_mut() {
            s.reg = 1;
        }
        chf.max_regions = 1;
        let mut cset = RcContourSet::default();
        // No holes, so no outline bookkeeping: still success (matches the C#).
        assert_eq!(build_contours(&chf, 1.3, 0, 0, &mut cset), RcContourStatus::Success);
        assert_eq!(cset.conts.len(), 2);
    }

    #[test]
    fn distance_pt_seg_cases() {
        assert_eq!(distance_pt_seg(0, 0, 0, 0, 10, 0), 0.0);
        assert_eq!(distance_pt_seg(5, 3, 0, 0, 10, 0), 9.0);
        assert_eq!(distance_pt_seg(-3, 4, 0, 0, 10, 0), 25.0);
        assert_eq!(distance_pt_seg(13, 4, 0, 0, 10, 0), 25.0);
        assert_eq!(distance_pt_seg(1, 1, 2, 2, 2, 2), 2.0);
    }

    #[test]
    fn watershed_contours_deterministic() {
        let rows = ["###.######", "###.######", "###..#####", "##########", "#####..###", "#####..###"];
        let run = || {
            let mut chf = chf_from_rows(&rows);
            build_distance_field(&mut chf);
            build_regions(&mut chf, 1, 2);
            let mut cset = RcContourSet::default();
            let st = build_contours(&chf, 1.3, 6, 3, &mut cset);
            (st, cset.conts.clone(), cset.merge_hole_failures)
        };
        let a = run();
        assert_eq!(a.0, RcContourStatus::Success);
        assert!(!a.1.is_empty());
        assert_eq!(a, run());
    }
}
