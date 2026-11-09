//! The clip arena's size classes (api-and-models §5 "Arena", architecture §5.2 "Classes").
//!
//! Four classes per power of two, from 4 KB: 4, 5, 6, 7, 8, 10, 12, 14, 16, 20 … KB. Class `k`
//! lies in doubling `d = k / 4` at step `s = k % 4`, and holds `(1024 << d) * (4 + s)` bytes. A
//! request rounds up to the smallest class that holds it, so rounding wastes at most 25% of the
//! request. Every class is a whole number of KB (so blocks carved one after another from a
//! page-aligned base stay 1024-byte aligned) and at least 4 KB (so a free block can hold the free
//! list's link).
//!
//! Pure functions, no state, no allocation. A1.3b-L1 fills the bodies.

/// The smallest class, in bytes (class 0).
pub const MIN_CLASS_BYTES: usize = 4 * 1024;
/// Classes per power of two.
pub const CLASSES_PER_DOUBLING: usize = 4;
/// Powers of two covered: classes run from 4 KB (doubling 0) to doubling 19.
pub const DOUBLINGS: usize = 20;
/// Number of classes: `CLASSES_PER_DOUBLING * DOUBLINGS` = 80.
pub const NUM_CLASSES: usize = CLASSES_PER_DOUBLING * DOUBLINGS;
/// The largest class, in bytes: `class_bytes(NUM_CLASSES - 1)` = `(1024 << 19) * 7` =
/// 3,758,096,384 (fits a `u32`, so it fits wasm32's `usize`).
pub const MAX_CLASS_BYTES: usize = (1024 << (DOUBLINGS - 1)) * 7;

/// Bytes in class `class`: `(1024 << (class / 4)) * (4 + class % 4)`. Returns 0 for
/// `class >= NUM_CLASSES`.
pub fn class_bytes(class: usize) -> usize {
    let _ = class;
    todo!("A1.3b-L1")
}

/// The smallest class whose `class_bytes` is at least `bytes`. `bytes` of 0 gives class 0.
/// `None` when `bytes > MAX_CLASS_BYTES`. Runs in `onmessage` only, so it may loop over classes.
pub fn class_of(bytes: usize) -> Option<usize> {
    let _ = bytes;
    todo!("A1.3b-L1")
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    #[test]
    #[ignore = "A1.3b-L1"]
    fn the_first_classes_are_4_5_6_7_8_10_12_14_16_kb() {}

    #[test]
    #[ignore = "A1.3b-L1"]
    fn classes_increase_and_are_whole_kb() {}

    #[test]
    #[ignore = "A1.3b-L1"]
    fn the_constants_agree() {}

    #[test]
    #[ignore = "A1.3b-L1"]
    fn class_of_rounds_up_to_the_smallest_class_that_holds_the_request() {}

    #[test]
    #[ignore = "A1.3b-L1"]
    fn requests_past_the_largest_class_have_none() {}

    #[test]
    #[ignore = "A1.3b-L1"]
    fn rounding_wastes_at_most_a_quarter() {}

    #[test]
    #[ignore = "A1.3b-L1"]
    fn out_of_range_classes_have_zero_bytes() {}
}
