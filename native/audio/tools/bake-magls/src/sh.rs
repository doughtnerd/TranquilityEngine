//! Real spherical harmonics to order 3 in AmbiX (ACN channel order, SN3D normalisation), in `f64`.
//!
//! Axes are AmbiX's: x front, y left, z up. The engine's listener space (x right, y up, forward -z)
//! maps to them by [`from_engine`]. Azimuths in this tool are AmbiX azimuths (positive to the left)
//! unless a name says `engine` (positive to the right, as `EqualPowerPanner` and the HRTF panner).

/// Channels of an order-3 bed.
pub const CHANNELS: usize = 16;

/// The 16 SN3D ACN harmonics of the unit vector `(x, y, z)`.
pub fn sh16(x: f64, y: f64, z: f64) -> [f64; CHANNELS] {
    let (xx, yy, zz) = (x * x, y * y, z * z);
    let s3 = libm::sqrt(3.0);
    [
        1.0,
        y,
        z,
        x,
        s3 * x * y,
        s3 * y * z,
        0.5 * (3.0 * zz - 1.0),
        s3 * x * z,
        0.5 * s3 * (xx - yy),
        libm::sqrt(5.0 / 8.0) * y * (3.0 * xx - yy),
        libm::sqrt(15.0) * x * y * z,
        libm::sqrt(3.0 / 8.0) * y * (5.0 * zz - 1.0),
        0.5 * z * (5.0 * zz - 3.0),
        libm::sqrt(3.0 / 8.0) * x * (5.0 * zz - 1.0),
        0.5 * libm::sqrt(15.0) * z * (xx - yy),
        libm::sqrt(5.0 / 8.0) * x * (xx - 3.0 * yy),
    ]
}

/// The harmonics of the direction at AmbiX azimuth `az` and elevation `el` (radians).
pub fn sh16_at(az: f64, el: f64) -> [f64; CHANNELS] {
    let c = libm::cos(el);
    sh16(c * libm::cos(az), c * libm::sin(az), libm::sin(el))
}

/// Order of ACN channel `c`.
pub const fn order_of(c: usize) -> usize {
    if c == 0 {
        0
    } else if c < 4 {
        1
    } else if c < 9 {
        2
    } else {
        3
    }
}

/// `-1` for the channels that are odd in y (degree `m < 0`: ACN `c < l² + l`), `+1` otherwise:
/// mirroring a direction left to right multiplies channel `c` by this.
pub const fn mirror_sign(c: usize) -> f64 {
    let l = order_of(c);
    if c < l * l + l {
        -1.0
    } else {
        1.0
    }
}

/// Engine listener-space direction (x right, y up, z back) to AmbiX (x front, y left, z up).
pub fn from_engine(d: [f64; 3]) -> [f64; 3] {
    [-d[2], -d[0], d[1]]
}
