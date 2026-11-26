//! The standalone module through its interface: sizing, a curve-eased tween run to its end, and
//! the statuses it shares with the animation core.

use myco_tween::host::{PASS_NORMAL, STATUS_FULL, STATUS_OK, STATUS_STALE_HANDLE};
use myco_tween::wire::*;
use myco_tween_wasm::Module;
use myco_wire::WireRecord;

fn create(ease: u32) -> Vec<u8> {
    TweenCreate {
        host_id: 1,
        column: 9,
        value_kind: KIND_VALUE,
        width: 1,
        ease,
        time_mode: TIME_UNSCALED,
        loops: 1,
        duration: 1.0,
        speed: 1.0,
        to0: 2.0,
        ..Default::default()
    }
    .encode()
}

#[test]
fn an_unsized_table_is_full() {
    let mut m = Module::default();
    assert_eq!(m.create(&create(EASE_LINEAR)), 0);
    assert_eq!(m.last_status(), STATUS_FULL);
}

#[test]
fn a_curve_eased_tween_reads_its_curve_and_completes() {
    let mut m = Module::default();
    assert_eq!(m.configure(8), STATUS_OK);
    // A step curve: 0 until x = 1 (so the value holds `from` until the end).
    let keys = [
        0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    ];
    let curve = m.load_curve(&keys);
    assert!(curve >= 1 << 16, "a curve handle is above every easing id");
    let h = m.create(&create(curve));
    assert_ne!(h, 0);

    m.begin_frame();
    m.update(0, PASS_NORMAL, 0.0, 0.5);
    assert_eq!(m.tweens().rows(), 1);
    assert_eq!(m.tweens().columns()[0], 9);
    assert_eq!(m.tweens().values()[0], 0.0);

    m.begin_frame();
    assert_eq!(m.update(0, PASS_NORMAL, 0.0, 0.5), 1);
    assert_eq!(m.tweens().values()[0], 2.0);
    let c = TweenChange::decode(m.tweens().changes()).unwrap();
    assert_eq!((c.handle, c.kind), (h, CHANGE_COMPLETED));

    assert_eq!(m.release_curve(curve), STATUS_OK);
    assert_eq!(m.release_curve(curve), STATUS_STALE_HANDLE);
}
