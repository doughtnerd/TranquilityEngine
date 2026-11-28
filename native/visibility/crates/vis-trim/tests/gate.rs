//! ADR 0460 section 3, "The safety gate is a tolerance": on a reduced deterministic subset of the safety spike's
//! adversarial scenes (hollow buildings with windows and doorways, a camera beside and inside one, thin and low walls,
//! a heightfield), the decided rules leave no false occlusion of 16 pixels or more at 1080p against an exact reference
//! (the original meshes at 1920x1080, each occludee's silhouette tested pixel by pixel).
//!
//! The scenes are built in `tests/common`; the stand-ins are measured and trimmed by `vis-trim` as an import would.
mod common;
use common::*;
use vis_raster::buffer::DepthBuf;

fn prepared(scene: &Scene) -> Vec<Prepared> {
    scene.occluders.iter().map(|o| prepare(o, true)).collect()
}

#[test]
fn no_false_occlusion_of_16_pixels_at_1080p() {
    let mut oracle_buf = DepthBuf::new(OW, OH);
    let mut worst = Tally::default();
    for scene in scenes(10) {
        let prep = prepared(&scene);
        let dropped: u32 = prep.iter().map(|p| p.dropped).sum();
        let total: usize = prep.iter().map(|p| p.total).sum();
        for (w, h) in [(256, 128), (320, 180)] {
            let t = run_scene(&scene, &prep, w, h, &mut oracle_buf);
            println!(
                "{:<7} {}x{}: stand-in {} tris ({} trimmed), {} occludees in view, oracle culls {}, core culls {} of those ({:.1} %), false occlusions {} ({} of 16+ px)",
                scene.name, w, h, total, dropped, t.in_frustum, t.oracle_hidden, t.agreed, 100.0 * t.kept(), t.false_any, t.false_ge16
            );
            if (w, h) == (256, 128) {
                // the gate (ADR 0460: "no false occlusion may be 16 pixels or larger at 1080p")
                assert_eq!(
                    t.false_ge16, 0,
                    "{} at {}x{}: a false occlusion of 16 or more pixels",
                    scene.name, w, h
                );
            } else {
                // The 320x180 tier is "within a few percent" of the gate resolution (spikes/occlusion-safety). Here it has one
                // case: `bldg`'s far path, a 1.5 m box seen at 107 m through two oblique windows. The 1080p reference sees
                // it through a 2-pixel slit, because the wall strip beside the window (0.1 m wide, under a pixel) lands
                // between pixel centres; the strip is solid, so a renderer sampling differently would hide the box.
                assert!(
                    t.false_ge16 <= 1,
                    "{} at {}x{}: {} false occlusions of 16 or more pixels",
                    scene.name,
                    w,
                    h,
                    t.false_ge16
                );
            }
            // the rules must leave culling worth having (the spike's stand-ins kept 39.5 % overall, 80 % on walls, 65 % on terrain; these friendlier ones keep more)
            let floor = match scene.name {
                "walls" => 0.6,
                "hill" => 0.4,
                "beside" => 0.5,
                _ => 0.4,
            };
            assert!(
                t.kept() >= floor,
                "{}: only {:.1} % of the reference's culls kept",
                scene.name,
                100.0 * t.kept()
            );
            if (w, h) == (256, 128) {
                worst.add(t);
            }
        }
    }
    println!(
        "all scenes at 256x128: culls kept {:.1} %, false occlusions {} (0 of 16+ px)",
        100.0 * worst.kept(),
        worst.false_any
    );
    assert!(worst.kept() >= 0.4);
}

#[test]
fn the_gate_has_teeth_without_the_rules() {
    // the same stand-ins drawn exactly (no push, shrink or near rule) falsely hide visible things of 16+ pixels
    let mut oracle_buf = DepthBuf::new(OW, OH);
    let mut unsafe_total = Tally::default();
    let mut safe_total = Tally::default();
    for scene in scenes(10) {
        let prep = prepared(&scene);
        unsafe_total.add(run_scene_unsafe(&scene, &prep, 256, 128, &mut oracle_buf));
        safe_total.add(run_scene(&scene, &prep, 256, 128, &mut oracle_buf));
    }
    println!(
        "without the rules: {} false occlusions ({} of 16+ px); with: {} ({})",
        unsafe_total.false_any,
        unsafe_total.false_ge16,
        safe_total.false_any,
        safe_total.false_ge16
    );
    assert!(
        unsafe_total.false_ge16 > 0,
        "the scenes should be adversarial enough to need the rules"
    );
    assert_eq!(safe_total.false_ge16, 0);
}
