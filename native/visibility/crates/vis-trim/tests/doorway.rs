//! Hole trimming reopens a doorway (ADR 0447 section 3): a stand-in that closes a doorway falsely hides what is seen
//! through it; with its closed-hole triangles trimmed at import, the doorway is open again.
mod common;
use common::*;
use vis_raster::buffer::DepthBuf;

#[test]
fn trimming_reopens_a_doorway() {
    let scene = scenes(12).into_iter().find(|s| s.name == "bldg").unwrap();
    // the stand-in of the middle building closes its front doorway and every window
    let one = Scene {
        name: "doorway",
        occluders: vec![Occluder {
            original: scene.occluders[1].original.clone(),
            standin: scene.occluders[1].standin.clone(),
            bmin: scene.occluders[1].bmin,
            bmax: scene.occluders[1].bmax,
        }],
        boxes: scene.boxes.clone(),
        paths: scene
            .paths
            .iter()
            .filter(|p| p.0 == "door" || p.0 == "door-oblique")
            .cloned()
            .collect(),
    };
    let mut oracle_buf = DepthBuf::new(OW, OH);

    let untrimmed = vec![prepare(&one.occluders[0], false)];
    let trimmed = vec![prepare(&one.occluders[0], true)];
    assert!(
        trimmed[0].dropped > 50,
        "the doorway and the windows are closed in the stand-in ({} triangles trimmed)",
        trimmed[0].dropped
    );
    assert_eq!(untrimmed[0].dropped, 0);

    // judged against the building itself, from a camera walking up to the doorway
    let closed = run_scene(&one, &untrimmed, 256, 128, &mut oracle_buf);
    let open = run_scene(&one, &trimmed, 256, 128, &mut oracle_buf);
    println!(
        "closed doorway: {} false occlusions ({} of 16+ px); trimmed: {} ({})",
        closed.false_any, closed.false_ge16, open.false_any, open.false_ge16
    );
    assert!(
        closed.false_ge16 >= 100,
        "an untrimmed stand-in hides what is visible through the doorway ({closed:?})"
    );
    assert_eq!(
        open.false_ge16, 0,
        "trimmed, nothing of 16 pixels or more is hidden"
    );
    assert!(open.false_any <= 2);
    // and trimming does not throw away the culling: the walls still hide what is behind them
    assert!(
        open.kept() > 0.5,
        "{:.1} % of the reference's culls kept",
        100.0 * open.kept()
    );
}
