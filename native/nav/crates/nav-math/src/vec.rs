//! Small vector types mirroring Unity.Mathematics' `float2/3/4`, `int2/3/4` and `double3`, which
//! Foxfire's code and baked data use. `#[repr(C)]` with no padding, so baked arrays hash and
//! serialise as the plain bytes Foxfire's layouts expect (ADR 0065).
use core::ops::{Add, AddAssign, Div, Index, IndexMut, Mul, MulAssign, Neg, Sub, SubAssign};

macro_rules! vector {
    ($name:ident, $t:ty, $n:literal, $($f:ident),+) => {
        #[repr(C)]
        #[derive(Clone, Copy, Debug, Default, PartialEq)]
        pub struct $name { $(pub $f: $t),+ }

        impl $name {
            #[inline] pub const fn new($($f: $t),+) -> Self { Self { $($f),+ } }
            #[inline] pub const fn splat(v: $t) -> Self { Self { $($f: v),+ } }
            #[inline] pub fn to_array(self) -> [$t; $n] { [$(self.$f),+] }
            #[inline] pub fn from_array(a: [$t; $n]) -> Self { let [$($f),+] = a; Self { $($f),+ } }
            #[inline] pub fn map(self, f: impl Fn($t) -> $t) -> Self { Self { $($f: f(self.$f)),+ } }
            #[inline] pub fn zip(self, o: Self, f: impl Fn($t, $t) -> $t) -> Self { Self { $($f: f(self.$f, o.$f)),+ } }
            #[inline] pub fn min(self, o: Self) -> Self { self.zip(o, |a, b| if b < a { b } else { a }) }
            #[inline] pub fn max(self, o: Self) -> Self { self.zip(o, |a, b| if b > a { b } else { a }) }
        }
        impl Add for $name { type Output = Self; #[inline] fn add(self, o: Self) -> Self { Self { $($f: self.$f + o.$f),+ } } }
        impl Sub for $name { type Output = Self; #[inline] fn sub(self, o: Self) -> Self { Self { $($f: self.$f - o.$f),+ } } }
        impl Mul for $name { type Output = Self; #[inline] fn mul(self, o: Self) -> Self { Self { $($f: self.$f * o.$f),+ } } }
        impl Div for $name { type Output = Self; #[inline] fn div(self, o: Self) -> Self { Self { $($f: self.$f / o.$f),+ } } }
        impl Mul<$t> for $name { type Output = Self; #[inline] fn mul(self, s: $t) -> Self { Self { $($f: self.$f * s),+ } } }
        impl Div<$t> for $name { type Output = Self; #[inline] fn div(self, s: $t) -> Self { Self { $($f: self.$f / s),+ } } }
        impl Neg for $name { type Output = Self; #[inline] fn neg(self) -> Self { Self { $($f: -self.$f),+ } } }
        impl AddAssign for $name { #[inline] fn add_assign(&mut self, o: Self) { $(self.$f += o.$f;)+ } }
        impl SubAssign for $name { #[inline] fn sub_assign(&mut self, o: Self) { $(self.$f -= o.$f;)+ } }
        impl MulAssign<$t> for $name { #[inline] fn mul_assign(&mut self, s: $t) { $(self.$f *= s;)+ } }
        impl Index<usize> for $name {
            type Output = $t;
            #[inline] fn index(&self, i: usize) -> &$t { [$(&self.$f),+][i] }
        }
        impl IndexMut<usize> for $name {
            #[inline] fn index_mut(&mut self, i: usize) -> &mut $t { [$(&mut self.$f),+].into_iter().nth(i).expect("vector index out of range") }
        }
    };
}

vector!(Float2, f32, 2, x, y);
vector!(Float3, f32, 3, x, y, z);
vector!(Float4, f32, 4, x, y, z, w);
vector!(Double2, f64, 2, x, y);
vector!(Double3, f64, 3, x, y, z);
vector!(Int2, i32, 2, x, y);
vector!(Int3, i32, 3, x, y, z);
vector!(Int4, i32, 4, x, y, z, w);

impl Float3 {
    #[inline] pub fn dot(self, o: Self) -> f32 { self.x * o.x + self.y * o.y + self.z * o.z }
    #[inline] pub fn cross(self, o: Self) -> Self { Self::new(self.y * o.z - self.z * o.y, self.z * o.x - self.x * o.z, self.x * o.y - self.y * o.x) }
    #[inline] pub fn length_sq(self) -> f32 { self.dot(self) }
    #[inline] pub fn length(self) -> f32 { self.length_sq().sqrt() }
    #[inline] pub fn xz(self) -> Float2 { Float2::new(self.x, self.z) }
    #[inline] pub fn to_double(self) -> Double3 { Double3::new(self.x as f64, self.y as f64, self.z as f64) }
}

impl Float2 {
    #[inline] pub fn dot(self, o: Self) -> f32 { self.x * o.x + self.y * o.y }
    #[inline] pub fn length_sq(self) -> f32 { self.dot(self) }
    #[inline] pub fn length(self) -> f32 { self.length_sq().sqrt() }
}

impl Double3 {
    #[inline] pub fn dot(self, o: Self) -> f64 { self.x * o.x + self.y * o.y + self.z * o.z }
    #[inline] pub fn cross(self, o: Self) -> Self { Self::new(self.y * o.z - self.z * o.y, self.z * o.x - self.x * o.z, self.x * o.y - self.y * o.x) }
    #[inline] pub fn to_float(self) -> Float3 { Float3::new(self.x as f32, self.y as f32, self.z as f32) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layouts_have_no_padding() {
        assert_eq!(core::mem::size_of::<Float3>(), 12);
        assert_eq!(core::mem::size_of::<Float4>(), 16);
        assert_eq!(core::mem::size_of::<Int3>(), 12);
        assert_eq!(core::mem::size_of::<Double3>(), 24);
    }

    #[test]
    fn indexing_and_ops() {
        let mut v = Float3::new(1.0, 2.0, 3.0);
        v[1] = 5.0;
        assert_eq!(v, Float3::new(1.0, 5.0, 3.0));
        assert_eq!(v.cross(Float3::new(0.0, 0.0, 1.0)), Float3::new(5.0, -1.0, 0.0));
        assert_eq!((v * 2.0).x, 2.0);
    }
}
