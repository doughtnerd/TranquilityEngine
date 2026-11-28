use meshopt::{simplify, SimplifyOptions, VertexDataAdapter};
use std::alloc::{alloc, dealloc, Layout};

// The vendored C++ calls operator new/delete; wasm32-unknown-unknown has no libc++, so provide them.
#[no_mangle]
pub extern "C" fn _Znwm(n: usize) -> *mut u8 {
    unsafe {
        let p = alloc(Layout::from_size_align(n + 16, 16).unwrap());
        *(p as *mut usize) = n;
        p.add(16)
    }
}
#[no_mangle]
pub extern "C" fn _ZdlPv(p: *mut u8) {
    unsafe {
        if p.is_null() { return; }
        let b = p.sub(16);
        let n = *(b as *mut usize);
        dealloc(b, Layout::from_size_align(n + 16, 16).unwrap());
    }
}

#[no_mangle]
pub extern "C" fn simp(idx: *const u32, n: usize, pos: *const f32, nv: usize, target: usize, err: f32, out: *mut u32) -> usize {
    let indices = unsafe { std::slice::from_raw_parts(idx, n) };
    let bytes = unsafe { std::slice::from_raw_parts(pos as *const u8, nv * 12) };
    let adapter = VertexDataAdapter::new(bytes, 12, 0).unwrap();
    let r = simplify(indices, &adapter, target, err, SimplifyOptions::empty(), None);
    let o = unsafe { std::slice::from_raw_parts_mut(out, r.len()) };
    o.copy_from_slice(&r);
    r.len()
}

#[no_mangle]
pub extern "C" fn walloc(n: usize) -> *mut u8 { _Znwm(n) }
