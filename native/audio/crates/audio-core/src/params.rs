//! The parameters of `myco_audio_init` (api-and-models §5) and their validation.

/// What `myco_audio_init` receives. Every fixed region's size is a pure function of these, so the
/// same parameters always give the same [`crate::Layout`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct InitParams {
    /// The AudioContext's rate, in Hz.
    pub sample_rate: f32,
    /// Logical voices (voice slots): 1,024 to 4,096 in the presets (architecture §5.3).
    pub max_logical: u32,
    /// Voices mixed per quantum: 64 to 256 in the presets. At most `max_logical`.
    pub max_mixed: u32,
    /// Buses in the bus tree, master included.
    pub max_buses: u32,
    /// The clip arena's initial reserve in bytes (8 to 32 MB in the presets). Rounded up to whole
    /// 64 KiB pages by the layout. The arena grows past it later, in `onmessage` only (A1.3b).
    pub arena_initial_bytes: u32,
}

/// Why `InitParams::validate` refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InitError {
    SampleRate,
    MaxLogical,
    MaxMixed,
    MaxBuses,
}

impl InitParams {
    /// Lowest and highest context rates accepted (Web Audio's own range is 3 kHz to 768 kHz; the
    /// engine never asks for less than 8 kHz or more than 192 kHz).
    pub const SAMPLE_RATE_RANGE: (f32, f32) = (8_000.0, 192_000.0);
    /// Most logical voices: the selection works over at most 65,536 slots (ids keep 16 bits).
    pub const MAX_LOGICAL: u32 = 65_536;
    /// Most buses, master included.
    pub const MAX_BUSES: u32 = 256;

    /// Checks the ranges. Doesn't look at `arena_initial_bytes` (0 is allowed: the arena then
    /// starts empty and grows on the first clip).
    pub fn validate(&self) -> Result<(), InitError> {
        let (lo, hi) = Self::SAMPLE_RATE_RANGE;
        if !(self.sample_rate >= lo && self.sample_rate <= hi) {
            return Err(InitError::SampleRate);
        }
        if self.max_logical == 0 || self.max_logical > Self::MAX_LOGICAL {
            return Err(InitError::MaxLogical);
        }
        if self.max_mixed == 0 || self.max_mixed > self.max_logical {
            return Err(InitError::MaxMixed);
        }
        if self.max_buses == 0 || self.max_buses > Self::MAX_BUSES {
            return Err(InitError::MaxBuses);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_preset() -> InitParams {
        InitParams { sample_rate: 48_000.0, max_logical: 4_096, max_mixed: 128, max_buses: 32, arena_initial_bytes: 16 << 20 }
    }

    #[test]
    fn the_default_preset_is_valid() {
        assert_eq!(default_preset().validate(), Ok(()));
    }

    #[test]
    fn out_of_range_values_are_refused() {
        let p = default_preset();
        assert_eq!(InitParams { sample_rate: f32::NAN, ..p }.validate(), Err(InitError::SampleRate));
        assert_eq!(InitParams { sample_rate: 4_000.0, ..p }.validate(), Err(InitError::SampleRate));
        assert_eq!(InitParams { max_logical: 0, ..p }.validate(), Err(InitError::MaxLogical));
        assert_eq!(InitParams { max_mixed: 5_000, ..p }.validate(), Err(InitError::MaxMixed));
        assert_eq!(InitParams { max_buses: 0, ..p }.validate(), Err(InitError::MaxBuses));
    }
}
