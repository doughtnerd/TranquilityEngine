//! Raw wasm exports (no wasm-bindgen: the hot path is plain numbers and pointers into linear memory; the engine
//! would add wasm-bindgen glue for setup only, as native/anim does). Single-threaded: one global context.
use occ::cull::{Config, N_STATS};
use occ::Ctx;
use std::cell::UnsafeCell;

struct Global(UnsafeCell<Option<Ctx>>);
unsafe impl Sync for Global {}
static G: Global = Global(UnsafeCell::new(None));

#[allow(clippy::mut_from_ref)]
fn c() -> &'static mut Ctx {
    unsafe { (*G.0.get()).as_mut().expect("init first") }
}

#[no_mangle]
pub extern "C" fn init(scene: u32, w: u32, h: u32) -> u32 {
    unsafe { *G.0.get() = Some(Ctx::new(scene, w as usize, h as usize)) };
    1
}
#[no_mangle]
pub extern "C" fn set_res(w: u32, h: u32) {
    c().set_res(w as usize, h as usize);
}
#[no_mangle]
pub extern "C" fn set_config(cap: u32, min_area: f32, dilate: i32, simd: u32, hier: u32, eps: f32, inner: f32) {
    c().cfg = Config { cap_tris: cap, min_area, dilate, simd: simd != 0, hier: hier != 0, eps, inner };
}
#[no_mangle]
pub extern "C" fn set_cam(slot: u32, kind: u32, frame: u32) {
    c().set_cam(slot as usize, kind, frame);
}
#[no_mangle]
pub extern "C" fn st_clear() {
    c().st_clear();
}
#[no_mangle]
pub extern "C" fn st_select(slot: u32) {
    c().st_select(slot as usize);
}
#[no_mangle]
pub extern "C" fn st_setup(slot: u32) {
    c().st_setup(slot as usize);
}
#[no_mangle]
pub extern "C" fn st_raster() {
    c().st_raster();
}
#[no_mangle]
pub extern "C" fn st_mip() {
    c().st_mip();
}
#[no_mangle]
pub extern "C" fn st_test(slot: u32) {
    c().st_test(slot as usize);
}
#[no_mangle]
pub extern "C" fn frame(slot: u32) {
    c().frame(slot as usize);
}
#[no_mangle]
pub extern "C" fn oracle(slot: u32, key: i32) {
    c().oracle(slot as usize, key);
}
#[no_mangle]
pub extern "C" fn compare(slot: u32) {
    c().compare(slot as usize);
}
#[no_mangle]
pub extern "C" fn vis_hash(slot: u32) -> u32 {
    c().vis_hash(slot as usize)
}
#[no_mangle]
pub extern "C" fn depth_hash() -> u32 {
    c().depth_hash()
}
#[no_mangle]
pub extern "C" fn save_prev(slot: u32) {
    c().save_prev(slot as usize);
}
#[no_mangle]
pub extern "C" fn st_reproject(slot: u32) {
    c().st_reproject(slot as usize);
}
#[no_mangle]
pub extern "C" fn test_stale(slot: u32) {
    c().test_stale(slot as usize);
}

// ---- views into linear memory (JS builds Float32Array / Uint8Array / Uint32Array views over these)
#[no_mangle]
pub extern "C" fn n_inst() -> u32 {
    c().scene.inst_mesh.len() as u32
}
#[no_mangle]
pub extern "C" fn n_occludees() -> u32 {
    (c().scene.aabbs.len() / 6) as u32
}
#[no_mangle]
pub extern "C" fn inst_ptr() -> u32 {
    c().scene.inst_xf.as_ptr() as u32
}
#[no_mangle]
pub extern "C" fn aabb_ptr() -> u32 {
    c().scene.aabbs.as_ptr() as u32
}
#[no_mangle]
pub extern "C" fn vis_ptr(slot: u32) -> u32 {
    c().vis[slot as usize].as_ptr() as u32
}
#[no_mangle]
pub extern "C" fn oracle_vis_ptr() -> u32 {
    c().oracle_vis.as_ptr() as u32
}
#[no_mangle]
pub extern "C" fn stats_ptr() -> u32 {
    c().stats.as_ptr() as u32
}
#[no_mangle]
pub extern "C" fn acc_ptr() -> u32 {
    c().acc.as_ptr() as u32
}
#[no_mangle]
pub extern "C" fn n_stats() -> u32 {
    N_STATS as u32
}
#[no_mangle]
pub extern "C" fn total_source_tris() -> u32 {
    c().scene.total_source_tris()
}
