//! The runtime boundary through its own interface (`Core`: the regions the JavaScript side fills and reads).
use vis_wasm::{Core, BAD_SIZE, OK, STATS_LEN, VIEW_BAD_RANGE, VIEW_NOT_FINITE, VIEW_SINGULAR};

/// A view from the origin looking along +z (column-major view-projection, clip w = depth), 60 degrees, 16:9.
fn header(near: f32, far: f32) -> [f32; 23] {
    let t = (60f32.to_radians() * 0.5).tan();
    let (sx, sy) = (1.0 / (t * 16.0 / 9.0), 1.0 / t);
    let (a, b) = (far / (far - near), -near * far / (far - near));
    // V = identity (looking along +z from the origin); P rows: x*sx, y*sy, z*a + b, z; column-major
    let mut h = [0f32; 23];
    h[0] = sx;
    h[5] = sy;
    h[10] = a;
    h[11] = 1.0;
    h[14] = b;
    h[19] = near;
    h[20] = far;
    h[21] = sx;
    h[22] = sy;
    h
}

/// A wall at z = 10, 20 m square, as two triangles with their error and neighbours.
fn put_wall(core: &mut Core) {
    let (a, b, c, d) = (
        [-10.0f32, -10.0, 10.0],
        [-10.0, 10.0, 10.0],
        [10.0, 10.0, 10.0],
        [10.0, -10.0, 10.0],
    );
    let tris: Vec<f32> = [a, b, c, a, c, d].concat();
    core.triangles_mut()[..18].copy_from_slice(&tris);
    core.errors_mut()[..2].copy_from_slice(&[0.0, 0.0]);
    core.neighbors_mut()[..6].copy_from_slice(&[u32::MAX, u32::MAX, 1, 0, u32::MAX, u32::MAX]);
}

fn put_boxes(core: &mut Core, zs: &[f32]) {
    for (i, z) in zs.iter().enumerate() {
        core.boxes_mut()[i * 6..i * 6 + 6].copy_from_slice(&[
            -1.0,
            -1.0,
            z - 1.0,
            1.0,
            1.0,
            z + 1.0,
        ]);
    }
}

#[test]
fn a_frame_hides_what_is_behind_the_wall() {
    let mut core = Core::new(256, 128, 64, 64).unwrap();
    *core.view_mut() = header(0.1, 500.0);
    put_wall(&mut core);
    put_boxes(&mut core, &[20.0, 5.0, 30.0]);
    assert_eq!(core.occlude(2, 3), OK);
    assert_eq!(&core.hidden()[..3], &[1, 0, 1]);
    let s = core.stats();
    assert_eq!(
        (s[0], s[1], s[7], s[10]),
        (OK, 2, 3, 2),
        "status, triangles, tested, culled"
    );
    assert!(core.depth().iter().any(|d| *d > 0.0));
    assert_eq!(core.depth().len(), 256 * 128);
}

#[test]
fn the_result_is_this_frames_not_the_last() {
    let mut core = Core::new(256, 128, 64, 64).unwrap();
    *core.view_mut() = header(0.1, 500.0);
    put_wall(&mut core);
    put_boxes(&mut core, &[20.0, 20.0, 20.0, 20.0]);
    core.occlude(2, 4);
    assert_eq!(&core.hidden()[..4], &[1, 1, 1, 1]);
    // no occluders now: the same boxes are all visible, not left at 1
    core.occlude(0, 4);
    assert_eq!(&core.hidden()[..4], &[0, 0, 0, 0]);
}

#[test]
fn a_refused_view_leaves_everything_visible() {
    let mut core = Core::new(256, 128, 64, 64).unwrap();
    put_wall(&mut core);
    put_boxes(&mut core, &[20.0]);
    for (name, mutate, code) in [
        (
            "nan",
            (|h: &mut [f32; 23]| h[3] = f32::NAN) as fn(&mut [f32; 23]),
            VIEW_NOT_FINITE,
        ),
        ("zero scale", |h: &mut [f32; 23]| h[5] = 0.0, VIEW_SINGULAR),
        ("bad near", |h: &mut [f32; 23]| h[19] = 0.0, VIEW_BAD_RANGE),
    ] {
        let mut h = header(0.1, 500.0);
        mutate(&mut h);
        *core.view_mut() = h;
        assert_eq!(core.occlude(2, 1), code, "{name}");
        assert_eq!(core.hidden()[0], 0, "{name}: nothing hidden");
        assert_eq!(core.stats()[0], code);
    }
}

#[test]
fn counts_over_the_capacity_are_refused() {
    let mut core = Core::new(256, 128, 4, 4).unwrap();
    *core.view_mut() = header(0.1, 500.0);
    assert_eq!(core.occlude(5, 1), BAD_SIZE);
    assert_eq!(core.occlude(1, 5), BAD_SIZE);
    assert_eq!(core.stats().len(), STATS_LEN);
}

#[test]
fn sizes_the_core_refuses() {
    assert!(
        Core::new(250, 128, 8, 8).is_none(),
        "width not a multiple of 8"
    );
    assert!(Core::new(0, 128, 8, 8).is_none());
    assert!(Core::new(256, 128, usize::MAX / 64, 8).is_none());
    assert!(Core::new(100_000, 128, 8, 8).is_none());
    assert!(Core::new(320, 180, 8, 8).is_some(), "the high tier");
}
