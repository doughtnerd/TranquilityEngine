// M1's own convolver (init + process on a region), nothing else.
use audio_dsp::convolver as m1;
static mut REGION: Vec<u64> = Vec::new();
#[no_mangle]
pub extern "C" fn probe_init() {
    unsafe {
        let r = &mut *std::ptr::addr_of_mut!(REGION);
        *r = vec![0u64; m1::region_bytes(48_000.0).div_ceil(8)];
        let b = std::slice::from_raw_parts_mut(r.as_mut_ptr() as *mut u8, r.len() * 8);
        m1::init(b, 48_000.0);
    }
}
#[no_mangle]
pub extern "C" fn probe_process(a: *const f32, b: *const f32, o: *mut f32) {
    unsafe {
        let r = &mut *std::ptr::addr_of_mut!(REGION);
        let bytes = std::slice::from_raw_parts_mut(r.as_mut_ptr() as *mut u8, r.len() * 8);
        let (a, b, o) = (std::slice::from_raw_parts(a, 128), std::slice::from_raw_parts(b, 128), std::slice::from_raw_parts_mut(o, 256));
        let (ol, or) = o.split_at_mut(128);
        m1::process(bytes, a, b, ol, or);
    }
}
