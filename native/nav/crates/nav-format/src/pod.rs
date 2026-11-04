//! Plain-old-data helpers: views of `#[repr(C)]` types as bytes and back, for the raw little-endian arrays of
//! the baked layouts. Every implementor has no implicit padding (padding is an explicit zero field, as the C#
//! layouts hash it) and every bit pattern is a valid value (enums are newtypes over their integer).

pub use nav_math::hash::Pod;

/// The bytes of a slice of POD values (little-endian hosts only, see the crate root).
pub fn bytes_of<T: Pod>(s: &[T]) -> &[u8] {
    // SAFETY: Pod types have no padding, so every byte is initialised.
    unsafe { core::slice::from_raw_parts(s.as_ptr() as *const u8, core::mem::size_of_val(s)) }
}

/// The bytes of one POD value.
pub fn bytes_of_one<T: Pod>(v: &T) -> &[u8] {
    bytes_of(core::slice::from_ref(v))
}

/// Copies `bytes` into a new `Vec<T>` (the source needn't be aligned). `bytes.len()` must be a multiple of
/// `size_of::<T>()`; any remainder is ignored.
pub fn vec_from_bytes<T: Pod>(bytes: &[u8]) -> Vec<T> {
    let size = core::mem::size_of::<T>();
    let n = bytes.len().checked_div(size).unwrap_or(0);
    let mut v: Vec<T> = Vec::with_capacity(n);
    // SAFETY: capacity n, we write n*size bytes, and any bit pattern is a valid T.
    unsafe {
        core::ptr::copy_nonoverlapping(bytes.as_ptr(), v.as_mut_ptr() as *mut u8, n * size);
        v.set_len(n);
    }
    v
}

/// One POD value from the first `size_of::<T>()` bytes (panics if shorter).
pub fn read_one<T: Pod>(bytes: &[u8]) -> T {
    let v = vec_from_bytes::<T>(&bytes[..core::mem::size_of::<T>()]);
    v[0]
}
