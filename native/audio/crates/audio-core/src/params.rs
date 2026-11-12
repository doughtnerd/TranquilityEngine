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
    /// ABI 2.0 (contract C8): most ambisonic beds decoded at once (`audio.bed.maxBeds`, 0..4).
    /// Sizes the `Beds` region (48 KB each). 0 leaves the region empty.
    pub max_beds: u32,
    /// ABI 2.0 (C8): reverb-zone convolver slots (`maxActive + 1` on default and high, `maxActive`
    /// on low; OD2). Sizes the `Zones` region with `zone_max_frames`. 0 leaves it empty.
    pub max_zone_slots: u32,
    /// ABI 2.0 (C8): the longest zone kernel, in frames at the context rate
    /// (`audio.zones.maxIrSeconds` × rate). 0 when there are no zone slots.
    pub zone_max_frames: u32,
    /// ABI 2.0 (C8): 16-channel wide stream rings and their private bed decoders
    /// (`audio.ambisonic.maxClips`, 0..4). Sizes the `Wide` region. 0 leaves it empty.
    pub max_wide: u32,
    /// ABI 3.0 (ADR 0166 M4, API section 4.5): music stream rings (`audio.music.rings`, 0..16). C1
    /// sizes the `Streams` region to `(G + M) x RING_BYTES` with it. 0 leaves no music ring.
    pub max_music_rings: u32,
}

impl Default for InitParams {
    /// M2's default preset (architecture §5.3; `presetFromSettings` with default settings):
    /// 48 kHz, 4,096 logical, 128 mixed, 32 buses, a 16 MiB arena, and no M3 region (every
    /// ABI 2.0 count 0), so an M2 configuration lays out exactly as before.
    fn default() -> Self {
        InitParams {
            sample_rate: 48_000.0,
            max_logical: 4_096,
            max_mixed: 128,
            max_buses: 32,
            arena_initial_bytes: 16 << 20,
            max_beds: 0,
            max_zone_slots: 0,
            zone_max_frames: 0,
            max_wide: 0,
            max_music_rings: 0,
        }
    }
}

/// Why `InitParams::validate` refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InitError {
    SampleRate,
    MaxLogical,
    MaxMixed,
    MaxBuses,
    /// `max_beds` above [`InitParams::MAX_BEDS`].
    MaxBeds,
    /// `max_zone_slots` above [`InitParams::MAX_ZONE_SLOTS`], or zone slots with `zone_max_frames`
    /// 0, or `zone_max_frames` past [`InitParams::MAX_ZONE_SECONDS`] at the rate.
    Zones,
    /// `max_wide` above [`InitParams::MAX_WIDE`].
    MaxWide,
    /// `max_music_rings` above [`InitParams::MAX_MUSIC_RINGS`] (ABI 3.0).
    MusicRings,
}

impl InitParams {
    /// Lowest and highest context rates accepted (Web Audio's own range is 3 kHz to 768 kHz; the
    /// engine never asks for less than 8 kHz or more than 192 kHz).
    pub const SAMPLE_RATE_RANGE: (f32, f32) = (8_000.0, 192_000.0);
    /// Most logical voices: the selection works over at most 65,536 slots (ids keep 16 bits).
    pub const MAX_LOGICAL: u32 = 65_536;
    /// Most buses, master included.
    pub const MAX_BUSES: u32 = 256;
    /// ABI 2.0 (C8): most beds (`audio.bed.maxBeds` 0..4; the wire's `MAX_BEDS`).
    pub const MAX_BEDS: u32 = audio_wire::generated::MAX_BEDS;
    /// Most zone slots (`maxActive + 1` with `maxActive` 0..2 needs 3; the wire carries 4).
    pub const MAX_ZONE_SLOTS: u32 = audio_wire::generated::MAX_ZONE_SLOTS;
    /// The longest zone IR (`audio.zones.maxIrSeconds` 0.5..8).
    pub const MAX_ZONE_SECONDS: f32 = 8.0;
    /// Most wide (3-16 channel) stream rings (`audio.ambisonic.maxClips` 0..4).
    pub const MAX_WIDE: u32 = 4;
    /// ABI 3.0: most music rings (`audio.music.rings`; the wire's `MAX_MUSIC_RINGS`).
    pub const MAX_MUSIC_RINGS: u32 = audio_wire::generated::MAX_MUSIC_RINGS;

    /// Checks the ranges. Doesn't look at `arena_initial_bytes` (0 is allowed: the arena then
    /// starts empty and grows on the first clip). Zero is always valid for the four ABI 2.0 counts
    /// (no region); `zone_max_frames` is ignored without zone slots.
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
        if self.max_beds > Self::MAX_BEDS {
            return Err(InitError::MaxBeds);
        }
        if self.max_zone_slots > Self::MAX_ZONE_SLOTS
            || (self.max_zone_slots > 0 && (self.zone_max_frames == 0 || self.zone_max_frames as f32 > (Self::MAX_ZONE_SECONDS * self.sample_rate).ceil()))
        {
            return Err(InitError::Zones);
        }
        if self.max_wide > Self::MAX_WIDE {
            return Err(InitError::MaxWide);
        }
        if self.max_music_rings > Self::MAX_MUSIC_RINGS {
            return Err(InitError::MusicRings);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_preset() -> InitParams {
        InitParams::default()
    }

    #[test]
    fn the_default_is_m2s_preset_with_no_m3_region() {
        let p = InitParams::default();
        assert_eq!((p.sample_rate, p.max_logical, p.max_mixed, p.max_buses, p.arena_initial_bytes), (48_000.0, 4_096, 128, 32, 16 << 20));
        assert_eq!((p.max_beds, p.max_zone_slots, p.zone_max_frames, p.max_wide), (0, 0, 0, 0));
        assert_eq!(p.max_music_rings, 0);
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
        assert_eq!(InitParams { max_beds: 5, ..p }.validate(), Err(InitError::MaxBeds));
        assert_eq!(InitParams { max_zone_slots: 5, zone_max_frames: 96_000, ..p }.validate(), Err(InitError::Zones));
        assert_eq!(InitParams { max_zone_slots: 1, zone_max_frames: 0, ..p }.validate(), Err(InitError::Zones));
        assert_eq!(InitParams { max_zone_slots: 1, zone_max_frames: 384_001, ..p }.validate(), Err(InitError::Zones));
        assert_eq!(InitParams { max_wide: 5, ..p }.validate(), Err(InitError::MaxWide));
        assert_eq!(InitParams { max_music_rings: 17, ..p }.validate(), Err(InitError::MusicRings));
        assert_eq!(InitParams { max_music_rings: 16, ..p }.validate(), Ok(()));
        assert_eq!(InitParams { max_music_rings: 0, ..p }.validate(), Ok(()));
    }

    #[test]
    fn the_m3_presets_are_valid() {
        let p = default_preset();
        // C10 high: 4 beds, 3 zone slots of 4 s, 2 wide rings; low: 0 beds, 1 slot of 1 s, 1 ring.
        assert_eq!(InitParams { max_beds: 4, max_zone_slots: 3, zone_max_frames: 192_000, max_wide: 2, ..p }.validate(), Ok(()));
        assert_eq!(InitParams { max_beds: 0, max_zone_slots: 1, zone_max_frames: 48_000, max_wide: 1, ..p }.validate(), Ok(()));
        assert_eq!(InitParams { zone_max_frames: 1, ..p }.validate(), Ok(()), "frames are ignored without slots");
    }
}
