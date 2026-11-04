//! The polygon index, query side (Foxfire's `NavPolyIndex.cs`): a sparse uniform grid over polygon bounds, baked
//! into the navmesh (`index_*`, `poly_min`, `poly_max`), so nearest-polygon queries only look at the polygons near
//! the query point. Matches `nav_bake::output`'s build side (cell size, key packing, sort order).
use nav_format::NavMeshData;
use nav_math::math::{self, max};
use nav_math::{Float3, Int3};

const BITS: i32 = 21;
const OFFSET: i32 = 1 << (BITS - 1);
const MASK: i64 = (1i64 << BITS) - 1;

/// Queries touching more cells than this fall back to testing every polygon.
pub const MAX_QUERY_CELLS: i64 = 4096;

/// `NavPolyIndex.CellOf`.
#[inline]
pub fn cell_of(p: Float3, cell_size: f32) -> Int3 {
    Int3::new(
        math::floor(p.x / cell_size) as i32,
        math::floor(p.y / cell_size) as i32,
        math::floor(p.z / cell_size) as i32,
    )
}

/// `NavPolyIndex.Key`: the cell's three 21-bit offset coordinates, packed.
#[inline]
pub fn cell_key(c: Int3) -> i64 {
    ((((c.x.wrapping_add(OFFSET)) as i64) & MASK) << (2 * BITS))
        | ((((c.y.wrapping_add(OFFSET)) as i64) & MASK) << BITS)
        | (((c.z.wrapping_add(OFFSET)) as i64) & MASK)
}

/// `NavPolyIndex.TryGetCell`: the range of `index_polys` for a cell key, or `None` if the cell is empty.
#[inline]
pub fn try_get_cell(nav: &NavMeshData, key: i64) -> Option<(usize, usize)> {
    let (mut lo, mut hi) = (0i64, nav.index_keys.len() as i64 - 1);
    while lo <= hi {
        let mid = (lo + hi) >> 1;
        let k = nav.index_keys[mid as usize];
        if k == key {
            return Some((nav.index_start[mid as usize] as usize, nav.index_start[mid as usize + 1] as usize));
        }
        if k < key {
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    None
}

/// The polygons whose bounds touch the cell with this key (empty if the cell is).
pub fn cell_polys(nav: &NavMeshData, key: i64) -> &[i32] {
    match try_get_cell(nav, key) {
        Some((start, end)) => &nav.index_polys[start..end],
        None => &[],
    }
}

/// `NavPolyIndex.CanQuery`: the index is built, and the box of cells `c0..=c1` isn't too many.
#[inline]
pub fn can_query(nav: &NavMeshData, c0: Int3, c1: Int3) -> bool {
    if nav.index_keys.is_empty() || nav.poly_min.len() != nav.polys.len() {
        return false;
    }
    // Saturating: the C# multiplies in `long` and could wrap on absurd boxes; a huge span just means too many cells.
    let span = (c1.x as i64 - c0.x as i64 + 1)
        .saturating_mul(c1.y as i64 - c0.y as i64 + 1)
        .saturating_mul(c1.z as i64 - c0.z as i64 + 1);
    span <= MAX_QUERY_CELLS
}

/// `NavPolyIndex.BoundsDistanceSq`: squared distance from `p` to the polygon's bounds (0 inside).
#[inline]
pub fn bounds_distance_sq(nav: &NavMeshData, poly: i32, p: Float3) -> f32 {
    let zero = Float3::splat(0.0);
    let d = (nav.poly_min[poly as usize] - p).max_v(zero) + (p - nav.poly_max[poly as usize]).max_v(zero);
    d.length_sq()
}

/// The polygons whose bounds touch the cell holding `p`.
pub fn polys_near(nav: &NavMeshData, p: Float3) -> &[i32] {
    cell_polys(nav, cell_key(cell_of(p, nav.index_cell_size)))
}

/// Calls `f(cell, polys)` for each occupied cell of the box `c0..=c1`, in `NavPolyIndex`'s iteration order (z, then
/// y, then x). A polygon is listed in every cell its bounds touch.
pub fn for_each_cell(nav: &NavMeshData, c0: Int3, c1: Int3, mut f: impl FnMut(Int3, &[i32])) {
    for z in c0.z..=c1.z {
        for y in c0.y..=c1.y {
            for x in c0.x..=c1.x {
                let cell = Int3::new(x, y, z);
                if let Some((start, end)) = try_get_cell(nav, cell_key(cell)) {
                    f(cell, &nav.index_polys[start..end]);
                }
            }
        }
    }
}

/// The first cell of the query box (starting at `q0`) that a polygon's bounds touch, `max(CellOf(poly_min), q0)`: a
/// polygon is tested only in that cell, so a query doesn't see it twice.
#[inline]
pub fn first_cell(nav: &NavMeshData, poly: i32, q0: Int3) -> Int3 {
    let c = cell_of(nav.poly_min[poly as usize], nav.index_cell_size);
    Int3::new(max(c.x, q0.x), max(c.y, q0.y), max(c.z, q0.z))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_packs_offset_coordinates() {
        assert_eq!(cell_key(Int3::new(0, 0, 0)), ((OFFSET as i64) << 42) | ((OFFSET as i64) << 21) | OFFSET as i64);
        assert_ne!(cell_key(Int3::new(1, 2, 3)), cell_key(Int3::new(3, 2, 1)));
        assert_eq!(cell_of(Float3::new(-0.5, 1.5, 2.0), 1.0), Int3::new(-1, 1, 2));
    }
}
