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
    if class >= NUM_CLASSES {
        return 0;
    }
    let doubling = class / CLASSES_PER_DOUBLING;
    let step = class % CLASSES_PER_DOUBLING;
    (1024usize << doubling) * (CLASSES_PER_DOUBLING + step)
}

/// The smallest class whose `class_bytes` is at least `bytes`. `bytes` of 0 gives class 0.
/// `None` when `bytes > MAX_CLASS_BYTES`. Runs in `onmessage` only, so it may loop over classes.
pub fn class_of(bytes: usize) -> Option<usize> {
    if bytes > MAX_CLASS_BYTES {
        return None;
    }
    (0..NUM_CLASSES).find(|&k| class_bytes(k) >= bytes)
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    #[test]
    fn the_first_classes_are_4_5_6_7_8_10_12_14_16_kb() {
        let kb = [4, 5, 6, 7, 8, 10, 12, 14, 16];
        for (k, &want) in kb.iter().enumerate() {
            assert_eq!(class_bytes(k), want * 1024, "class {k}");
        }
    }

    #[test]
    fn classes_increase_and_are_whole_kb() {
        let mut prev = 0;
        for k in 0..NUM_CLASSES {
            let b = class_bytes(k);
            assert_eq!(b % 1024, 0, "class {k} is not whole KB");
            assert!(b >= 4096, "class {k} is below 4 KB");
            assert!(b > prev, "class {k} is not larger than the class before it");
            prev = b;
        }
    }

    #[test]
    fn the_constants_agree() {
        assert_eq!(NUM_CLASSES, CLASSES_PER_DOUBLING * DOUBLINGS);
        assert_eq!(class_bytes(0), MIN_CLASS_BYTES);
        assert_eq!(class_bytes(NUM_CLASSES - 1), MAX_CLASS_BYTES);
        assert!(MAX_CLASS_BYTES as u64 <= u32::MAX as u64);
    }

    #[test]
    fn class_of_rounds_up_to_the_smallest_class_that_holds_the_request() {
        assert_eq!(class_of(0), Some(0));
        assert_eq!(class_of(1), Some(0));
        assert_eq!(class_of(4096), Some(0));
        assert_eq!(class_of(4097), Some(1));
        for k in 0..NUM_CLASSES {
            assert_eq!(class_of(class_bytes(k)), Some(k), "exact fit, class {k}");
        }
        for k in 0..NUM_CLASSES - 1 {
            assert_eq!(class_of(class_bytes(k) + 1), Some(k + 1), "one past class {k}");
        }
    }

    #[test]
    fn requests_past_the_largest_class_have_none() {
        assert_eq!(class_of(MAX_CLASS_BYTES + 1), None);
        assert_eq!(class_of(usize::MAX), None);
    }

    #[test]
    fn rounding_wastes_at_most_a_quarter() {
        // Requests of 1..=4096 bytes all take the 4 KB class, so the 25% bound can only hold
        // from 4097 bytes up. The checks below start there.
        let check = |b: usize| {
            let c = class_of(b).unwrap();
            let waste = (class_bytes(c) - b) as u64;
            assert!(waste * 4 <= b as u64, "request {b} wastes {waste} bytes");
        };
        for k in 1..NUM_CLASSES {
            check(class_bytes(k - 1) + 1);
        }
        for b in (MIN_CLASS_BYTES + 1)..=65536 {
            check(b);
        }
    }

    #[test]
    fn out_of_range_classes_have_zero_bytes() {
        assert_eq!(class_bytes(NUM_CLASSES), 0);
        assert_eq!(class_bytes(usize::MAX), 0);
    }
}
