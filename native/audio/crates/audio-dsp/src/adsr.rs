//! The Amp envelope (ADR 0345's catalogue `envelope`, ADR 0362 item 2): attack, hold, decay, sustain and release over
//! an envelope's own time in frames, evaluated per sample. One implementation for the core's clip voices (the ENVELOPE
//! record, `audio-core`'s voice chain) and the offline sample render (`audio-offline`), so a clip's envelope heard live
//! and the same envelope baked into a sample are the same numbers.
//!
//! - **Stages.** From frame 0 the level rises linearly from 0 to 1 over `attack` frames, holds 1 for `hold`, falls
//!   linearly to `sustain` over `decay`, then holds `sustain`.
//! - **Key-off.** At frame `key_off` (`KEY_OFF_NONE`: never) the release starts from the level reached there and falls
//!   linearly to 0 over `release` frames; after it, and at once with a release of 0, the gain is 0.
//! - **A span** ([`Adsr::fit`]): a clip (or a sample being baked) of `len` frames squeezes its stages to fit, in the
//!   order the Studio draws them (`src/studio/screens/playlists/sequence/adsrModel.ts`, `adsrShape`): the attack takes
//!   what it needs of the span, then the hold, the decay, and the release last, which ends on the span's last frame
//!   (its key-off is `len - release`).
//!
//! The arithmetic is in f64 and rounded to f32 once, so every caller gets the same bits. Pure; nothing allocates.

/// `Adsr::key_off` for an envelope that is never keyed off (it holds its sustain).
pub const KEY_OFF_NONE: u32 = u32::MAX;

/// One envelope, in frames. All-zero is silence after frame 0 (a key-off at 0 with no release); [`Adsr::IDENTITY`] is
/// a gain of 1 throughout.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Adsr {
    pub attack: u32,
    pub hold: u32,
    pub decay: u32,
    pub release: u32,
    /// The frame the release starts at; [`KEY_OFF_NONE`] never.
    pub key_off: u32,
    /// The sustain level, 0..1 (clamped when read).
    pub sustain: f32,
}

impl Adsr {
    /// No stages and no key-off: a gain of 1 at every frame.
    pub const IDENTITY: Adsr = Adsr { attack: 0, hold: 0, decay: 0, release: 0, key_off: KEY_OFF_NONE, sustain: 1.0 };

    /// The envelope of stage lengths `attack`, `hold`, `decay` and `release` (frames) and `sustain` (0..1) over a span
    /// of `len` frames (`None`: unbounded, never keyed off), the stages squeezed into the span in order (attack, hold,
    /// decay, then release) and the release ending on its last frame.
    pub fn fit(attack: u32, hold: u32, decay: u32, sustain: f32, release: u32, len: Option<u32>) -> Adsr {
        let Some(len) = len else {
            return Adsr { attack, hold, decay, release, key_off: KEY_OFF_NONE, sustain };
        };
        let a = attack.min(len);
        let h = hold.min(len - a);
        let d = decay.min(len - a - h);
        let r = release.min(len - a - h - d);
        Adsr { attack: a, hold: h, decay: d, release: r, key_off: len - r, sustain }
    }

    /// The level before any key-off at frame `t`: the attack, hold, decay and sustain.
    #[inline]
    fn level(&self, t: u64) -> f64 {
        let s = (self.sustain as f64).clamp(0.0, 1.0);
        let (a, h, d) = (self.attack as u64, self.hold as u64, self.decay as u64);
        if t < a {
            t as f64 / a as f64
        } else if t < a + h {
            1.0
        } else if t < a + h + d {
            1.0 - (1.0 - s) * ((t - a - h) as f64 / d as f64)
        } else {
            s
        }
    }

    /// The gain at envelope frame `t`.
    #[inline]
    pub fn gain(&self, t: u64) -> f32 {
        let k = self.key_off as u64;
        if self.key_off == KEY_OFF_NONE || t < k {
            return self.level(t) as f32;
        }
        let x = t - k;
        let r = self.release as u64;
        if x >= r {
            return 0.0;
        }
        (self.level(k) * (1.0 - x as f64 / r as f64)) as f32
    }

    /// `true` when every gain from frame `t` on is 0 (past the release).
    #[inline]
    pub fn silent_from(&self, t: u64) -> bool {
        self.key_off != KEY_OFF_NONE && t >= self.key_off as u64 + self.release as u64
    }

    /// Multiplies `l` and `r` (the same length) by the gains of frames `t0..`.
    #[inline]
    pub fn apply(&self, t0: u64, l: &mut [f32], r: &mut [f32]) {
        for (i, (a, b)) in l.iter_mut().zip(r.iter_mut()).enumerate() {
            let g = self.gain(t0 + i as u64);
            *a *= g;
            *b *= g;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stages_rise_hold_fall_sustain_and_release() {
        let e = Adsr { attack: 100, hold: 50, decay: 100, release: 200, key_off: 1_000, sustain: 0.5 };
        assert_eq!(e.gain(0), 0.0);
        assert_eq!(e.gain(50), 0.5);
        assert_eq!(e.gain(100), 1.0);
        assert_eq!(e.gain(149), 1.0);
        assert_eq!(e.gain(200), 0.75);
        assert_eq!(e.gain(250), 0.5);
        assert_eq!(e.gain(999), 0.5);
        assert_eq!(e.gain(1_000), 0.5);
        assert_eq!(e.gain(1_100), 0.25);
        assert_eq!(e.gain(1_200), 0.0);
        assert!(e.silent_from(1_200) && !e.silent_from(1_199));
    }

    #[test]
    fn a_key_off_in_the_attack_releases_from_the_level_reached() {
        let e = Adsr { attack: 100, hold: 0, decay: 0, release: 100, key_off: 50, sustain: 1.0 };
        assert_eq!(e.gain(50), 0.5);
        assert_eq!(e.gain(100), 0.25);
        assert_eq!(e.gain(150), 0.0);
    }

    #[test]
    fn identity_and_no_release_and_unbounded() {
        assert!((0..10_000).step_by(37).all(|t| Adsr::IDENTITY.gain(t) == 1.0));
        let cut = Adsr { release: 0, key_off: 10, ..Adsr::IDENTITY };
        assert_eq!(cut.gain(9), 1.0);
        assert_eq!(cut.gain(10), 0.0);
        let open = Adsr::fit(10, 0, 10, 0.25, 500, None);
        assert_eq!(open.key_off, KEY_OFF_NONE);
        assert_eq!(open.gain(1_000_000), 0.25);
    }

    #[test]
    fn a_short_span_squeezes_the_stages_in_order_and_the_release_ends_on_its_last_frame() {
        // Everything fits: the release ends on the span's end.
        let e = Adsr::fit(100, 20, 100, 0.5, 200, Some(1_000));
        assert_eq!((e.attack, e.hold, e.decay, e.release, e.key_off), (100, 20, 100, 200, 800));
        assert_eq!(e.gain(999), (0.5 * (1.0 - 199.0 / 200.0)) as f32);
        assert_eq!(e.gain(1_000), 0.0);
        // The release is squeezed first, then the decay, the hold, the attack.
        let e = Adsr::fit(100, 20, 100, 0.5, 200, Some(250));
        assert_eq!((e.attack, e.hold, e.decay, e.release, e.key_off), (100, 20, 100, 30, 220));
        let e = Adsr::fit(100, 20, 100, 0.5, 200, Some(60));
        assert_eq!((e.attack, e.hold, e.decay, e.release, e.key_off), (60, 0, 0, 0, 60));
        assert_eq!(e.gain(59), (59.0f64 / 60.0) as f32);
        assert_eq!(e.gain(60), 0.0);
    }
}
