//! The least-significant-first bit writer of the segment bitstreams.

/// Appends codes of 0..=32 bits, least significant bit first.
#[derive(Default)]
pub(crate) struct BitWriter {
    bytes: Vec<u8>,
    bits: u64,
}

impl BitWriter {
    /// Appends the low `bits` bits of `code`.
    pub(crate) fn push(&mut self, code: u32, bits: u32) {
        debug_assert!(bits == 32 || code >> bits == 0, "code wider than its rate");
        for i in 0..bits {
            if self.bits % 8 == 0 {
                self.bytes.push(0);
            }
            let bit = ((code >> i) & 1) as u8;
            let last = self.bytes.len() - 1;
            self.bytes[last] |= bit << (self.bits % 8);
            self.bits += 1;
        }
    }

    /// Bits written.
    pub(crate) fn bit_len(&self) -> u64 {
        self.bits
    }

    /// The bytes (the last one zero-padded).
    pub(crate) fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packs_least_significant_first() {
        let mut w = BitWriter::default();
        w.push(0b101, 3);
        w.push(0b11, 2);
        w.push(0xFFFF_FFFF, 32);
        assert_eq!(w.bit_len(), 37);
        let b = w.into_bytes();
        assert_eq!(b.len(), 5);
        assert_eq!(b[0], 0b1111_1101);
        assert_eq!(b[4], 0b0001_1111);
    }
}
