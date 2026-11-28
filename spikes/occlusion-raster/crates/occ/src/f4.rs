//! A 4-wide f32 vector: wasm simd128 intrinsics on wasm32+simd128, SSE on x86_64, scalar array elsewhere.
//! No fused multiply-add anywhere, so every backend rounds each operation the same way (identical results).
#![allow(clippy::missing_safety_doc)]

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod imp {
    use core::arch::wasm32::*;
    #[derive(Clone, Copy)]
    pub struct F4(pub v128);
    pub const BACKEND: &str = "wasm-simd128";
    impl F4 {
        #[inline(always)]
        pub fn splat(x: f32) -> F4 {
            F4(f32x4_splat(x))
        }
        #[inline(always)]
        pub fn new(a: f32, b: f32, c: f32, d: f32) -> F4 {
            F4(f32x4(a, b, c, d))
        }
        #[inline(always)]
        pub unsafe fn load(p: *const f32) -> F4 {
            F4(v128_load(p as *const v128))
        }
        #[inline(always)]
        pub unsafe fn store(self, p: *mut f32) {
            v128_store(p as *mut v128, self.0)
        }
        #[inline(always)]
        pub fn add(self, o: F4) -> F4 {
            F4(f32x4_add(self.0, o.0))
        }
        #[inline(always)]
        pub fn mul(self, o: F4) -> F4 {
            F4(f32x4_mul(self.0, o.0))
        }
        #[inline(always)]
        pub fn min(self, o: F4) -> F4 {
            F4(f32x4_min(self.0, o.0))
        }
        #[inline(always)]
        pub fn max(self, o: F4) -> F4 {
            F4(f32x4_max(self.0, o.0))
        }
        /// All-ones lanes where self >= o.
        #[inline(always)]
        pub fn ge(self, o: F4) -> F4 {
            F4(f32x4_ge(self.0, o.0))
        }
        #[inline(always)]
        pub fn and(self, o: F4) -> F4 {
            F4(v128_and(self.0, o.0))
        }
        /// mask ? a : b
        #[inline(always)]
        pub fn select(mask: F4, a: F4, b: F4) -> F4 {
            F4(v128_bitselect(a.0, b.0, mask.0))
        }
        #[inline(always)]
        pub fn any(self) -> bool {
            v128_any_true(self.0)
        }
        #[inline(always)]
        pub fn hmin(self) -> f32 {
            let a = f32x4_min(self.0, i32x4_shuffle::<2, 3, 0, 1>(self.0, self.0));
            let b = f32x4_min(a, i32x4_shuffle::<1, 0, 3, 2>(a, a));
            f32x4_extract_lane::<0>(b)
        }
        #[inline(always)]
        pub fn to_array(self) -> [f32; 4] {
            [
                f32x4_extract_lane::<0>(self.0),
                f32x4_extract_lane::<1>(self.0),
                f32x4_extract_lane::<2>(self.0),
                f32x4_extract_lane::<3>(self.0),
            ]
        }
    }
}

#[cfg(target_arch = "x86_64")]
mod imp {
    use core::arch::x86_64::*;
    #[derive(Clone, Copy)]
    pub struct F4(pub __m128);
    pub const BACKEND: &str = "x86-sse";
    impl F4 {
        #[inline(always)]
        pub fn splat(x: f32) -> F4 {
            unsafe { F4(_mm_set1_ps(x)) }
        }
        #[inline(always)]
        pub fn new(a: f32, b: f32, c: f32, d: f32) -> F4 {
            unsafe { F4(_mm_set_ps(d, c, b, a)) }
        }
        #[inline(always)]
        pub unsafe fn load(p: *const f32) -> F4 {
            F4(_mm_loadu_ps(p))
        }
        #[inline(always)]
        pub unsafe fn store(self, p: *mut f32) {
            _mm_storeu_ps(p, self.0)
        }
        #[inline(always)]
        pub fn add(self, o: F4) -> F4 {
            unsafe { F4(_mm_add_ps(self.0, o.0)) }
        }
        #[inline(always)]
        pub fn mul(self, o: F4) -> F4 {
            unsafe { F4(_mm_mul_ps(self.0, o.0)) }
        }
        #[inline(always)]
        pub fn min(self, o: F4) -> F4 {
            unsafe { F4(_mm_min_ps(self.0, o.0)) }
        }
        #[inline(always)]
        pub fn max(self, o: F4) -> F4 {
            unsafe { F4(_mm_max_ps(self.0, o.0)) }
        }
        #[inline(always)]
        pub fn ge(self, o: F4) -> F4 {
            unsafe { F4(_mm_cmpge_ps(self.0, o.0)) }
        }
        #[inline(always)]
        pub fn and(self, o: F4) -> F4 {
            unsafe { F4(_mm_and_ps(self.0, o.0)) }
        }
        #[inline(always)]
        pub fn select(mask: F4, a: F4, b: F4) -> F4 {
            unsafe { F4(_mm_or_ps(_mm_and_ps(mask.0, a.0), _mm_andnot_ps(mask.0, b.0))) }
        }
        #[inline(always)]
        pub fn any(self) -> bool {
            unsafe { _mm_movemask_ps(self.0) != 0 }
        }
        #[inline(always)]
        pub fn hmin(self) -> f32 {
            let a = self.to_array();
            a[0].min(a[1]).min(a[2].min(a[3]))
        }
        #[inline(always)]
        pub fn to_array(self) -> [f32; 4] {
            let mut o = [0f32; 4];
            unsafe { _mm_storeu_ps(o.as_mut_ptr(), self.0) };
            o
        }
    }
}

#[cfg(not(any(all(target_arch = "wasm32", target_feature = "simd128"), target_arch = "x86_64")))]
mod imp {
    #[derive(Clone, Copy)]
    pub struct F4(pub [f32; 4]);
    pub const BACKEND: &str = "scalar-array";
    #[inline(always)]
    fn m(b: bool) -> f32 {
        f32::from_bits(if b { u32::MAX } else { 0 })
    }
    impl F4 {
        #[inline(always)]
        pub fn splat(x: f32) -> F4 {
            F4([x; 4])
        }
        #[inline(always)]
        pub fn new(a: f32, b: f32, c: f32, d: f32) -> F4 {
            F4([a, b, c, d])
        }
        #[inline(always)]
        pub unsafe fn load(p: *const f32) -> F4 {
            F4([*p, *p.add(1), *p.add(2), *p.add(3)])
        }
        #[inline(always)]
        pub unsafe fn store(self, p: *mut f32) {
            for i in 0..4 {
                *p.add(i) = self.0[i];
            }
        }
        #[inline(always)]
        pub fn add(self, o: F4) -> F4 {
            F4([self.0[0] + o.0[0], self.0[1] + o.0[1], self.0[2] + o.0[2], self.0[3] + o.0[3]])
        }
        #[inline(always)]
        pub fn mul(self, o: F4) -> F4 {
            F4([self.0[0] * o.0[0], self.0[1] * o.0[1], self.0[2] * o.0[2], self.0[3] * o.0[3]])
        }
        #[inline(always)]
        pub fn min(self, o: F4) -> F4 {
            F4([self.0[0].min(o.0[0]), self.0[1].min(o.0[1]), self.0[2].min(o.0[2]), self.0[3].min(o.0[3])])
        }
        #[inline(always)]
        pub fn max(self, o: F4) -> F4 {
            F4([self.0[0].max(o.0[0]), self.0[1].max(o.0[1]), self.0[2].max(o.0[2]), self.0[3].max(o.0[3])])
        }
        #[inline(always)]
        pub fn ge(self, o: F4) -> F4 {
            F4([m(self.0[0] >= o.0[0]), m(self.0[1] >= o.0[1]), m(self.0[2] >= o.0[2]), m(self.0[3] >= o.0[3])])
        }
        #[inline(always)]
        pub fn and(self, o: F4) -> F4 {
            let mut r = [0f32; 4];
            for i in 0..4 {
                r[i] = f32::from_bits(self.0[i].to_bits() & o.0[i].to_bits());
            }
            F4(r)
        }
        #[inline(always)]
        pub fn select(mask: F4, a: F4, b: F4) -> F4 {
            let mut r = [0f32; 4];
            for i in 0..4 {
                r[i] = if mask.0[i].to_bits() != 0 { a.0[i] } else { b.0[i] };
            }
            F4(r)
        }
        #[inline(always)]
        pub fn any(self) -> bool {
            self.0.iter().any(|v| v.to_bits() != 0)
        }
        #[inline(always)]
        pub fn hmin(self) -> f32 {
            self.0[0].min(self.0[1]).min(self.0[2].min(self.0[3]))
        }
        #[inline(always)]
        pub fn to_array(self) -> [f32; 4] {
            self.0
        }
    }
}

pub use imp::{F4, BACKEND};
