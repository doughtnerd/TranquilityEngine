//! Orientation bins: Foxfire's `Lib/NavMeshOrientationBins.cs` plus the bake's per-bin records
//! (`Authoring/Baking/BakingComponents.cs`: `Bin`, `BinSetMetadata`; `NavigationBakingInitSystem`).
//!
//! The navmesh is not one heightfield. Every world-space triangle is assigned to exactly one *orientation bin*: a
//! fixed right-handed frame `[t, n, b]` where local Y is the bin's "up" `n`. Each bin is rasterized as an ordinary
//! Y-up Recast heightfield in its own frame, so floors, walls and ceilings all use the same Recast code.
//!
//! Bin layout (indices are what `TriangleData::bin`, `NavPoly::bin` and `BinGrid::bin` hold):
//! `[0]` = the floor bin (identity frame), `[1 ..= side_bin_count]` = the side rings, then the ceiling bin if the
//! config allows ceilings (`ceiling_bin`, else -1).
//!
//! Pipeline role:
//! * [`OrientationBinSet::create`] builds the frames and the bin adjacency masks from an [`OrientationConfig`] and
//!   the [`SurfaceRing`]s. The adjacency masks are baked into the navmesh (`NavMeshData::bin_adjacency`) and are the
//!   stitcher's prefilter for fold links.
//! * [`BinClassifier`] decides, per triangle, which bin it belongs to and whether it is walkable there (the
//!   classify stage, `classify.rs`).
//! * [`Bin`] / [`OrientationBinSet::bake_bins`] add each bin's local bounds for the chunk's world bounds.
//!
//! Float-op order mirrors the C# exactly; trigonometry goes through `nav_math::exact` (Foxfire's `NavExactMath`)
//! so every target gets the same bits.
use nav_math::exact;
use nav_math::math::{self, Float3x3};
use nav_math::Float3;

pub use nav_format::OrientationBin;
use nav_recast::FFBounds;

/// A ring of side bins at one tilt from world up, evenly spaced in azimuth (`SurfaceRing`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SurfaceRing {
    /// 0 < tilt < 180, e.g. 45 (steep slope), 90 (wall), 135 (overhang).
    pub tilt_deg: f32,
    /// Bins in the ring, e.g. 4 or 8.
    pub count: i32,
    /// Rotates the ring to match a level's dominant wall directions.
    pub azimuth_offset_deg: f32,
}

impl SurfaceRing {
    /// `SurfaceRing.Default`: four wall bins.
    pub const DEFAULT: SurfaceRing = SurfaceRing { tilt_deg: 90.0, count: 4, azimuth_offset_deg: 0.0 };
}

impl Default for SurfaceRing {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// Bake-time surface constraints (`OrientationConfig`). `max_fold_deg` is used by the stitcher via the bin
/// adjacency masks.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OrientationConfig {
    /// Walkable surfaces up to this tilt from world up: ~92 = floors + walls, no overhangs; 180 = everything.
    pub max_surface_deg: f32,
    /// Surfaces within this of world up always go to the floor bin (e.g. 45).
    pub ground_capture_deg: f32,
    /// Surfaces within this of world down go to the ceiling bin (e.g. 45).
    pub ceiling_capture_deg: f32,
    /// Max angle between a triangle and its bin's normal (keep well under 85).
    pub coverage_deg: f32,
    /// Sharpest fold the bake links, as the angle between the two meeting surfaces' normals regardless of which way
    /// they face (0-90): a 30 degree crease and a 150 degree wedge are both 30, a floor meeting a wall is 90.
    pub max_fold_deg: f32,
}

impl OrientationConfig {
    /// `OrientationConfig.Default`.
    pub const DEFAULT: OrientationConfig = OrientationConfig {
        max_surface_deg: 180.0,
        ground_capture_deg: 45.0,
        ceiling_capture_deg: 45.0,
        coverage_deg: 60.0,
        max_fold_deg: 90.0,
    };
}

impl Default for OrientationConfig {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// Methods of Foxfire's `OrientationBin` on `nav_format::OrientationBin` (the baked 40-byte struct is reused as is).
pub trait OrientationBinExt: Sized {
    /// Deterministic per-bin frame. The floor bin gets the identity frame (`n = (0,1,0)`, `t = (1,0,0)`).
    fn from_normal(n: Float3) -> Self;
    /// Columns `t, n, b`.
    fn local_to_world(&self) -> Float3x3;
    /// Transpose of [`local_to_world`](Self::local_to_world).
    fn world_to_local(&self) -> Float3x3;
    /// Local-frame bounds `(min, max)` of a world AABB (box around its 8 rotated corners). Exact for bins whose axes
    /// line up with the world axes; looser for diagonal bins, which only costs some empty columns.
    fn local_bounds(&self, world_min: Float3, world_max: Float3) -> (Float3, Float3);
}

impl OrientationBinExt for OrientationBin {
    fn from_normal(n: Float3) -> Self {
        let n = exact::normalize(n);
        let t = if math::abs(n.y) > 0.999 {
            Float3::new(1.0, 0.0, 0.0) // floor / ceiling
        } else {
            exact::normalize(n.cross(Float3::new(0.0, 1.0, 0.0))) // horizontal, along the surface
        };
        let b = t.cross(n); // det[t n b] = +1 for any t perpendicular to n
        OrientationBin { n, t, b, tilt_deg: exact::degrees(exact::acos(n.y)) }
    }

    fn local_to_world(&self) -> Float3x3 {
        Float3x3::new(self.t, self.n, self.b)
    }

    fn world_to_local(&self) -> Float3x3 {
        self.local_to_world().transpose()
    }

    fn local_bounds(&self, world_min: Float3, world_max: Float3) -> (Float3, Float3) {
        let to_local = self.world_to_local();
        let mut local_min = Float3::splat(f32::MAX);
        let mut local_max = Float3::splat(f32::MIN);
        for i in 0..8 {
            let corner = Float3::new(
                if i & 1 != 0 { world_max.x } else { world_min.x },
                if i & 2 != 0 { world_max.y } else { world_min.y },
                if i & 4 != 0 { world_max.z } else { world_min.z },
            );
            let p = to_local.mul_vec(corner);
            local_min = local_min.min_v(p);
            local_max = local_max.max_v(p);
        }
        (local_min, local_max)
    }
}

/// Bin layout and adjacency (`OrientationBinSet`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OrientationBinSet {
    pub bins: Vec<OrientationBin>,
    /// Bit j of `[i]` set: surfaces in bins i and j may fold within `max_fold_deg` (a stitcher prefilter).
    pub adjacency: Vec<u64>,
    pub first_side_bin: i32,
    pub side_bin_count: i32,
    /// -1 if ceilings are disabled.
    pub ceiling_bin: i32,
}

/// At most 64 bins fit the 64-bit adjacency masks.
pub const MAX_BINS: usize = 64;

impl OrientationBinSet {
    /// Builds the bins and adjacency from `cfg` and `rings`. Errors if there would be more than [`MAX_BINS`] bins.
    pub fn create(cfg: &OrientationConfig, rings: &[SurfaceRing]) -> Result<Self, String> {
        let mut list: Vec<OrientationBin> = Vec::with_capacity(16);
        list.push(OrientationBin::from_normal(Float3::new(0.0, 1.0, 0.0)));

        for ring in rings {
            // Skip rings that would only hold surfaces we're not allowed to walk on anyway.
            if ring.tilt_deg - cfg.coverage_deg > cfg.max_surface_deg {
                continue;
            }

            let tilt = exact::radians(ring.tilt_deg);
            for i in 0..ring.count {
                // `i * 2f * math.PI / ring.Count`, left to right, in floats.
                let az = exact::radians(ring.azimuth_offset_deg) + i as f32 * 2.0 * math::PI / ring.count as f32;
                let n = Float3::new(
                    exact::sin(tilt) * exact::cos(az),
                    exact::cos(tilt),
                    exact::sin(tilt) * exact::sin(az),
                );
                list.push(OrientationBin::from_normal(n));
            }
        }

        let side_count = list.len() as i32 - 1;
        let mut ceiling = -1;
        if cfg.max_surface_deg > 180.0 - cfg.ceiling_capture_deg {
            ceiling = list.len() as i32;
            list.push(OrientationBin::from_normal(Float3::new(0.0, -1.0, 0.0)));
        }

        if list.len() > MAX_BINS {
            return Err("At most 64 orientation Bins are supported (64-bit adjacency masks).".to_string());
        }

        // A prefilter for the stitcher, which checks each fold's own delta (NavFold.Delta): a bin holds surfaces up
        // to CoverageDeg from its normal, so surfaces in two bins can be up to 2 * CoverageDeg closer to parallel
        // than the bins' normals are.
        let slack = cfg.max_fold_deg + 2.0 * cfg.coverage_deg;
        let mut adjacency = vec![0u64; list.len()];
        for i in 0..list.len() {
            let mut m = 0u64;
            for j in 0..list.len() {
                let deg = exact::degrees(exact::acos(list[i].n.dot(list[j].n)));
                if i != j && math::min(deg, 180.0 - deg) <= slack {
                    m |= 1u64 << j;
                }
            }
            adjacency[i] = m;
        }

        Ok(Self { bins: list, adjacency, first_side_bin: 1, side_bin_count: side_count, ceiling_bin: ceiling })
    }

    /// The bake's per-bin records for world bounds `world_min..world_max` (`NavigationBakingInitSystem`): frame,
    /// local bounds, both matrices and the adjacency mask. The bounds are the chunk box when the chunk has bounds,
    /// else the geometry's bounds.
    pub fn bake_bins(&self, world_min: Float3, world_max: Float3) -> Vec<Bin> {
        self.bins
            .iter()
            .enumerate()
            .map(|(i, bin)| {
                let (lmin, lmax) = bin.local_bounds(world_min, world_max);
                Bin {
                    n: bin.n,
                    t: bin.t,
                    b: bin.b,
                    tilt_deg: bin.tilt_deg,
                    // `new FFBounds { Min, Max }`: Center stays zero, as in the C#.
                    bounds: FFBounds { center: Float3::default(), min: lmin, max: lmax },
                    world_to_local: bin.world_to_local(),
                    local_to_world: bin.local_to_world(),
                    adjacency_mask: self.adjacency[i],
                }
            })
            .collect()
    }
}

/// One orientation bin as the bake carries it (`Bin`): its frame and its bounds in that frame. Independent of voxel
/// size, so every resolution tier shares it; the voxel grids live in `BinGrid`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Bin {
    pub n: Float3,
    pub t: Float3,
    pub b: Float3,
    pub tilt_deg: f32,
    /// In the bin's local frame (`center` is left zero, as the C# does).
    pub bounds: FFBounds,
    pub world_to_local: Float3x3,
    pub local_to_world: Float3x3,
    pub adjacency_mask: u64,
}

impl Bin {
    /// `Bin.ToOrientation`: the baked blob record.
    pub fn to_orientation(&self) -> OrientationBin {
        OrientationBin { n: self.n, t: self.t, b: self.b, tilt_deg: self.tilt_deg }
    }
}

/// `BinSetMetadata`: the bin layout and the cosines the classification jobs compare against.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BinSetMetadata {
    pub first_side_bin: i32,
    pub side_bin_count: i32,
    pub ceiling_bin: i32,
    pub max_surface_cos: f32,
    pub ground_capture_cos: f32,
    pub ceiling_capture_cos: f32,
    pub coverage_cos: f32,
    /// Sharpest fold the stitcher links (`OrientationConfig::max_fold_deg`).
    pub max_fold_deg: f32,
}

impl BinSetMetadata {
    pub fn new(set: &OrientationBinSet, cfg: &OrientationConfig) -> Self {
        Self {
            first_side_bin: set.first_side_bin,
            side_bin_count: set.side_bin_count,
            ceiling_bin: set.ceiling_bin,
            max_surface_cos: exact::cos(exact::radians(cfg.max_surface_deg)),
            ground_capture_cos: exact::cos(exact::radians(cfg.ground_capture_deg)),
            ceiling_capture_cos: exact::cos(exact::radians(cfg.ceiling_capture_deg)),
            coverage_cos: exact::cos(exact::radians(cfg.coverage_deg)),
            max_fold_deg: cfg.max_fold_deg,
        }
    }

    /// `NavigationBakingSystem.BinNeeded`: whether a tier whose profiles build walls / ceilings needs bin `k`.
    /// The floor bin and any other bin are always needed.
    pub fn bin_needed(&self, k: i32, walls: bool, ceilings: bool) -> bool {
        if k == self.ceiling_bin {
            return ceilings;
        }
        if k >= self.first_side_bin && k < self.first_side_bin + self.side_bin_count {
            return walls;
        }
        true
    }
}

/// Per-triangle classifier (`BinClassifier`). Decides whether a world-space triangle is walkable in a given bin: not
/// beyond `max_surface_deg`, assigned to that bin, and within its coverage cone.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BinClassifier {
    pub bins: Vec<OrientationBin>,
    pub first_side_bin: i32,
    pub side_bin_count: i32,
    pub ceiling_bin: i32,
    pub max_surface_cos: f32,
    pub ground_capture_cos: f32,
    pub ceiling_capture_cos: f32,
    pub coverage_cos: f32,
    /// Set if the mesh winding makes floor normals point down.
    pub flip_winding: bool,
}

impl BinClassifier {
    pub fn create(set: &OrientationBinSet, cfg: &OrientationConfig, flip_winding: bool) -> Self {
        Self {
            bins: set.bins.clone(),
            first_side_bin: set.first_side_bin,
            side_bin_count: set.side_bin_count,
            ceiling_bin: set.ceiling_bin,
            max_surface_cos: exact::cos(exact::radians(cfg.max_surface_deg)),
            ground_capture_cos: exact::cos(exact::radians(cfg.ground_capture_deg)),
            ceiling_capture_cos: exact::cos(exact::radians(cfg.ceiling_capture_deg)),
            coverage_cos: exact::cos(exact::radians(cfg.coverage_deg)),
            flip_winding,
        }
    }

    /// Same convention as Recast's calcTriNormal: `cross(v1 - v0, v2 - v0)`.
    pub fn is_walkable_in(&self, bin: i32, a: Float3, b: Float3, c: Float3) -> bool {
        let mut nrm = (b - a).cross(c - a);
        let len = nrm.length();
        if len <= 1e-12 {
            return false;
        }
        nrm = nrm / len;
        if self.flip_winding {
            nrm = -nrm;
        }

        nrm.y >= self.max_surface_cos
            && self.assign_bin(nrm) == bin
            && nrm.dot(self.bins[bin as usize].n) > self.coverage_cos
    }

    /// Floor and ceiling get priority within their capture cones, so ordinary ramps stay in the floor bin instead of
    /// creating fold seams. Everything else goes to the nearest side bin.
    pub fn assign_bin(&self, nrm: Float3) -> i32 {
        if nrm.y >= self.ground_capture_cos {
            return 0;
        }
        if self.ceiling_bin >= 0 && -nrm.y >= self.ceiling_capture_cos {
            return self.ceiling_bin;
        }

        let mut best = -1;
        let mut best_dot = f32::MIN;
        for k in self.first_side_bin..self.first_side_bin + self.side_bin_count {
            let d = nrm.dot(self.bins[k as usize].n);
            if d > best_dot {
                best_dot = d;
                best = k;
            }
        }

        if best >= 0 {
            return best;
        }

        // No side bins configured: fall back to floor/ceiling; the coverage test rejects anything too steep.
        if self.ceiling_bin >= 0 && nrm.y < 0.0 {
            self.ceiling_bin
        } else {
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(cfg: &OrientationConfig, rings: &[SurfaceRing]) -> OrientationBinSet {
        OrientationBinSet::create(cfg, rings).unwrap()
    }

    #[test]
    fn default_config_has_floor_four_walls_and_ceiling() {
        let s = set(&OrientationConfig::DEFAULT, &[SurfaceRing::DEFAULT]);
        assert_eq!(s.bins.len(), 6);
        assert_eq!((s.first_side_bin, s.side_bin_count, s.ceiling_bin), (1, 4, 5));
        assert_eq!(s.adjacency.len(), 6);
    }

    #[test]
    fn floors_and_walls_only_has_no_ceiling() {
        let cfg = OrientationConfig { max_surface_deg: 92.0, ..OrientationConfig::DEFAULT };
        let s = set(&cfg, &[SurfaceRing::DEFAULT]);
        assert_eq!(s.bins.len(), 5);
        assert_eq!(s.ceiling_bin, -1);
        // A ring that would only hold unwalkable surfaces is skipped (170 - 60 = 110 > 92).
        let ring = SurfaceRing { tilt_deg: 170.0, count: 4, azimuth_offset_deg: 0.0 };
        assert_eq!(set(&cfg, &[ring]).bins.len(), 1);
    }

    #[test]
    fn floor_bin_is_identity_frame() {
        let s = set(&OrientationConfig::DEFAULT, &[SurfaceRing::DEFAULT]);
        let f = &s.bins[0];
        assert_eq!(f.n, Float3::new(0.0, 1.0, 0.0));
        assert_eq!(f.t, Float3::new(1.0, 0.0, 0.0));
        assert_eq!(f.b, Float3::new(0.0, 0.0, 1.0));
        assert_eq!(f.tilt_deg, 0.0);
        assert_eq!(f.world_to_local(), Float3x3::IDENTITY);
        assert_eq!(s.bins[s.ceiling_bin as usize].tilt_deg, 180.0);
    }

    #[test]
    fn frames_are_orthonormal_with_det_plus_one() {
        let rings = [
            SurfaceRing::DEFAULT,
            SurfaceRing { tilt_deg: 45.0, count: 8, azimuth_offset_deg: 22.5 },
            SurfaceRing { tilt_deg: 135.0, count: 6, azimuth_offset_deg: 10.0 },
        ];
        let s = set(&OrientationConfig::DEFAULT, &rings);
        assert_eq!(s.bins.len(), 1 + 4 + 8 + 6 + 1);
        for (i, bin) in s.bins.iter().enumerate() {
            let tol = 1e-5;
            assert!((bin.n.length() - 1.0).abs() < tol, "n length, bin {i}");
            assert!((bin.t.length() - 1.0).abs() < tol, "t length, bin {i}");
            assert!((bin.b.length() - 1.0).abs() < tol, "b length, bin {i}");
            assert!(bin.n.dot(bin.t).abs() < tol && bin.n.dot(bin.b).abs() < tol && bin.t.dot(bin.b).abs() < tol);
            // det [t n b] = t . (n x b) = +1
            let det = bin.t.dot(bin.n.cross(bin.b));
            assert!((det - 1.0).abs() < tol, "det {det}, bin {i}");
            // world_to_local is the inverse of local_to_world.
            let id = bin.local_to_world().mul(bin.world_to_local());
            assert!((id.c0.x - 1.0).abs() < tol && (id.c1.y - 1.0).abs() < tol && (id.c2.z - 1.0).abs() < tol);
        }
    }

    #[test]
    fn tilt_matches_ring() {
        let ring = SurfaceRing { tilt_deg: 45.0, count: 4, azimuth_offset_deg: 0.0 };
        let s = set(&OrientationConfig::DEFAULT, &[ring]);
        for bin in &s.bins[1..5] {
            assert!((bin.tilt_deg - 45.0).abs() < 1e-3);
        }
    }

    #[test]
    fn adjacency_is_symmetric_and_irreflexive() {
        let rings = [SurfaceRing::DEFAULT, SurfaceRing { tilt_deg: 45.0, count: 8, azimuth_offset_deg: 0.0 }];
        for fold in [0.0f32, 30.0, 90.0] {
            let cfg = OrientationConfig { max_fold_deg: fold, ..OrientationConfig::DEFAULT };
            let s = set(&cfg, &rings);
            for i in 0..s.bins.len() {
                assert_eq!((s.adjacency[i] >> i) & 1, 0, "bin {i} adjacent to itself");
                for j in 0..s.bins.len() {
                    assert_eq!((s.adjacency[i] >> j) & 1, (s.adjacency[j] >> i) & 1, "asymmetric {i},{j}");
                }
            }
        }
        // Floor and ceiling are 180 degrees apart (0 after min(deg, 180 - deg)): always within the slack.
        let s = set(&OrientationConfig::DEFAULT, &[SurfaceRing::DEFAULT]);
        assert_ne!((s.adjacency[0] >> s.ceiling_bin) & 1, 0);
        // Floor to wall (90) is adjacent only if slack (fold + 2 * coverage) >= 90.
        let tight = OrientationConfig { max_fold_deg: 0.0, coverage_deg: 30.0, ..OrientationConfig::DEFAULT };
        let t = set(&tight, &[SurfaceRing::DEFAULT]);
        assert_eq!((t.adjacency[0] >> 1) & 1, 0);
        let loose = OrientationConfig { max_fold_deg: 30.0, coverage_deg: 30.0, ..OrientationConfig::DEFAULT };
        let l = set(&loose, &[SurfaceRing::DEFAULT]);
        assert_eq!((l.adjacency[0] >> 1) & 1, 1);
    }

    #[test]
    fn too_many_bins_is_an_error() {
        let ring = SurfaceRing { tilt_deg: 90.0, count: 70, azimuth_offset_deg: 0.0 };
        assert!(OrientationBinSet::create(&OrientationConfig::DEFAULT, &[ring]).is_err());
    }

    #[test]
    fn classifier_assigns_normals_to_expected_bins() {
        let cfg = OrientationConfig::DEFAULT;
        let s = set(&cfg, &[SurfaceRing::DEFAULT]);
        let c = BinClassifier::create(&s, &cfg, false);
        // Up and 30 degree ramps stay on the floor.
        assert_eq!(c.assign_bin(Float3::new(0.0, 1.0, 0.0)), 0);
        let ramp = Float3::new(exact::sin(exact::radians(30.0)), exact::cos(exact::radians(30.0)), 0.0);
        assert_eq!(c.assign_bin(ramp), 0);
        // Down goes to the ceiling.
        assert_eq!(c.assign_bin(Float3::new(0.0, -1.0, 0.0)), s.ceiling_bin);
        // A wall facing +x goes to the side bin whose n is nearest +x.
        let wall = c.assign_bin(Float3::new(1.0, 0.0, 0.0));
        assert!((1..=4).contains(&wall));
        assert!(s.bins[wall as usize].n.x > 0.99);
        let wall_z = c.assign_bin(Float3::new(0.0, 0.0, -1.0));
        assert!(s.bins[wall_z as usize].n.z < -0.99);
    }

    #[test]
    fn classifier_walkability() {
        let cfg = OrientationConfig::DEFAULT;
        let s = set(&cfg, &[SurfaceRing::DEFAULT]);
        let c = BinClassifier::create(&s, &cfg, false);
        let (a, b, cc) = (Float3::new(0.0, 0.0, 0.0), Float3::new(0.0, 0.0, 1.0), Float3::new(1.0, 0.0, 0.0));
        // cross((0,0,1), (1,0,0)) = (0, 1, 0): a floor triangle.
        assert!(c.is_walkable_in(0, a, b, cc));
        assert!(!c.is_walkable_in(1, a, b, cc));
        // Flipped winding is the ceiling.
        assert!(c.is_walkable_in(s.ceiling_bin, a, cc, b));
        let flipped = BinClassifier::create(&s, &cfg, true);
        assert!(flipped.is_walkable_in(s.ceiling_bin, a, b, cc));
        // Degenerate triangle.
        assert!(!c.is_walkable_in(0, a, a, a));
        // Nothing past max_surface_deg: a floors-only config rejects the ceiling.
        let floors = OrientationConfig { max_surface_deg: 60.0, ..cfg };
        let fs = set(&floors, &[]);
        let fc = BinClassifier::create(&fs, &floors, false);
        assert!(!fc.is_walkable_in(0, a, cc, b));
    }

    #[test]
    fn bake_bins_local_bounds() {
        let s = set(&OrientationConfig::DEFAULT, &[SurfaceRing::DEFAULT]);
        let bins = s.bake_bins(Float3::new(-1.0, -2.0, -3.0), Float3::new(4.0, 5.0, 6.0));
        assert_eq!(bins.len(), s.bins.len());
        // The floor bin's frame is the identity: local bounds equal the world bounds.
        assert_eq!(bins[0].bounds.min, Float3::new(-1.0, -2.0, -3.0));
        assert_eq!(bins[0].bounds.max, Float3::new(4.0, 5.0, 6.0));
        assert_eq!(bins[0].adjacency_mask, s.adjacency[0]);
        assert_eq!(bins[2].to_orientation(), s.bins[2]);
        // Every bin's bounds contain the rotated box's centre.
        for bin in &bins {
            let c = bin.world_to_local.mul_vec(Float3::new(1.5, 1.5, 1.5));
            assert!(bin.bounds.min.x <= c.x && c.x <= bin.bounds.max.x);
            assert!(bin.bounds.min.y <= c.y && c.y <= bin.bounds.max.y);
            assert!(bin.bounds.min.z <= c.z && c.z <= bin.bounds.max.z);
        }
    }

    #[test]
    fn metadata_and_bin_needed() {
        let cfg = OrientationConfig::DEFAULT;
        let s = set(&cfg, &[SurfaceRing::DEFAULT]);
        let m = BinSetMetadata::new(&s, &cfg);
        assert!((m.ground_capture_cos - 0.707_106_77).abs() < 1e-6);
        assert!(m.bin_needed(0, false, false));
        assert!(!m.bin_needed(1, false, true));
        assert!(m.bin_needed(1, true, false));
        assert!(!m.bin_needed(5, true, false));
        assert!(m.bin_needed(5, false, true));
    }

    #[test]
    fn deterministic() {
        let rings = [SurfaceRing::DEFAULT, SurfaceRing { tilt_deg: 45.0, count: 8, azimuth_offset_deg: 7.0 }];
        let a = set(&OrientationConfig::DEFAULT, &rings);
        let b = set(&OrientationConfig::DEFAULT, &rings);
        assert_eq!(a, b);
        for (x, y) in a.bins.iter().zip(&b.bins) {
            assert_eq!(x.n.x.to_bits(), y.n.x.to_bits());
            assert_eq!(x.tilt_deg.to_bits(), y.tilt_deg.to_bits());
        }
    }
}
