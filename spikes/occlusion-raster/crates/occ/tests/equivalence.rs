//! Scalar reference vs 4-wide path, fine vs hierarchical test, and the oracle's no-false-occlusion property.
use occ::cull::*;
use occ::Ctx;

fn run(scene: u32, w: usize, h: usize, frame: u32, simd: bool, hier: bool) -> (u32, u32, [u32; N_STATS]) {
    let mut c = Ctx::new(scene, w, h);
    c.cfg = Config { simd, hier, ..Config::default() };
    c.set_cam(0, 0, frame);
    c.frame(0);
    (c.depth_hash(), c.vis_hash(0), c.stats)
}

#[test]
fn simd_matches_scalar_depth_buffer() {
    for scene in 0..3 {
        for &(w, h) in &[(256usize, 128usize), (320, 180), (512, 256)] {
            for &f in &[0u32, 77, 190] {
                let a = run(scene, w, h, f, false, true);
                let b = run(scene, w, h, f, true, true);
                assert_eq!(a.0, b.0, "depth buffer differs: scene {scene} {w}x{h} frame {f}");
                assert_eq!(a.1, b.1, "vis differs: scene {scene} {w}x{h} frame {f}");
                assert_eq!(a.2, b.2, "stats differ");
            }
        }
    }
}

#[test]
fn hierarchical_test_equals_pixel_test() {
    for scene in 0..3 {
        let a = run(scene, 320, 180, 40, true, false);
        let b = run(scene, 320, 180, 40, true, true);
        assert_eq!(a.1, b.1);
    }
}

#[test]
fn rasterises_something_and_culls_backfaces() {
    let (_, _, st) = run(0, 256, 128, 0, true, true);
    assert!(st[S_TRIS_RASTER] > 100, "stats {:?}", st);
    assert!(st[S_TRIS_BACK] > 100);
    let (_, _, st) = run(2, 256, 128, 0, true, true);
    assert!(st[S_TRIS_RASTER] > 100, "stats {:?}", st);
}

fn false_occluded(scene: u32, inner: f32, dilate: i32) -> (u32, u32) {
    let mut c = Ctx::new(scene, 256, 128);
    let (mut false_occ, mut culled) = (0, 0);
    for f in [0u32, 60, 120, 180] {
        c.cfg = Config { dilate, inner, ..Config::default() };
        c.set_cam(0, 0, f);
        c.frame(0);
        c.oracle(0, f as i32);
        c.compare(0);
        false_occ += c.acc[4];
        culled += c.acc[2];
    }
    eprintln!("scene {scene} inner {inner} dilate {dilate}: buffer culled {culled}, false occluded {false_occ}");
    (false_occ, culled)
}

/// Inner-conservative coverage (whole pixel inside the triangle) plus a 1 px dilated test rect never culls what the
/// 1080p oracle sees.
#[test]
fn inner_conservative_has_no_false_occlusion() {
    for scene in 0..3 {
        let (fo, culled) = false_occluded(scene, 0.5, 1);
        assert_eq!(fo, 0, "scene {scene}");
        assert!(culled > 0);
    }
}

/// Centre sampling + 1 px dilation: exact on the city (big occluders), not on thin forest trunks (sub-pixel occluders).
#[test]
fn centre_sampling_is_exact_on_city_only() {
    for scene in 0..2 {
        assert_eq!(false_occluded(scene, 0.0, 1).0, 0, "scene {scene}");
    }
    let (fo, culled) = false_occluded(2, 0.0, 1);
    assert!(fo > 0 && (fo as f32) < 0.1 * culled as f32, "forest false occluded {fo} of {culled}");
}
