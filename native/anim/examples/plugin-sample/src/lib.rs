//! A sample third-party node module (ADR 0370, T45), built with `anim-plugin-sdk`:
//!
//! - **`sway`** (kind 1): a procedural additive layer. Bones from `first_bone` on rotate about
//!   `axis` by `amplitude · sin(2π · phase) · falloff^k` (`k` = bones past `first_bone`), applied
//!   in the parent's space on top of the input; `phase` advances by `frequency · dt` and lives in
//!   the instance state.
//! - **`scale`** (kind 2): passes the pose through with every translation scaled by `factor`
//!   (a uniformly bigger or smaller character with the same bone rotations).
//!
//! Build: `cargo build -p plugin-sample --target wasm32-unknown-unknown --release` (from
//! `native/anim/`); the module is `target/wasm32-unknown-unknown/release/plugin_sample.wasm`.
#![cfg_attr(target_arch = "wasm32", no_std)]

use anim_plugin_sdk::{export_nodes, Context, Inputs, Node, ParamDesc, Params, Transform, Unit};

const PI: f32 = core::f32::consts::PI;
const TAU: f32 = core::f32::consts::TAU;
const HALF_PI: f32 = core::f32::consts::FRAC_PI_2;

/// `sin(x)` for |x| up to about 2³⁰: reduced to [−π/2, π/2], then a degree-9 odd Taylor
/// polynomial (error below 4e-6). Plain multiplies and adds, so every target gets the same bits.
fn sin(x: f32) -> f32 {
    let q = x * (1.0 / TAU);
    let k = (if q >= 0.0 { q + 0.5 } else { q - 0.5 }) as i32 as f32;
    let mut r = x - k * TAU;
    if r > HALF_PI {
        r = PI - r;
    } else if r < -HALF_PI {
        r = -PI - r;
    }
    let r2 = r * r;
    r * (1.0
        + r2 * (-1.0 / 6.0 + r2 * (1.0 / 120.0 + r2 * (-1.0 / 5040.0 + r2 * (1.0 / 362_880.0)))))
}

/// `cos(x)` = `sin(x + π/2)`.
fn cos(x: f32) -> f32 {
    sin(x + HALF_PI)
}

/// `1 / sqrt(x)` for `x > 0`: a bit-level first guess and three Newton steps (relative error
/// about 1e-7). `core` has no `sqrt` without `std`, and plain arithmetic keeps wasm and native
/// bit-identical.
fn inv_sqrt(x: f32) -> f32 {
    let mut y = f32::from_bits(0x5f37_59df - (x.to_bits() >> 1));
    for _ in 0..3 {
        y = y * (1.5 - 0.5 * x * y * y);
    }
    y
}

/// Hamilton product `a · b` (`x y z w`).
fn quat_mul(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ]
}

/// The procedural sway layer.
pub struct Sway;

/// Sway's parameter indices.
mod sway {
    pub const AMPLITUDE: usize = 0;
    pub const FREQUENCY: usize = 1;
    pub const AXIS: usize = 2;
    pub const FIRST_BONE: usize = 3;
    pub const FALLOFF: usize = 4;
}

impl Node for Sway {
    const KIND: u32 = 1;
    const NAME: &'static str = "sway";
    const PARAMS: &'static [ParamDesc] = &[
        ParamDesc::float("amplitude", Unit::Degrees, 0.0, 90.0, 5.0).animatable(),
        ParamDesc::float("frequency", Unit::Hertz, 0.0, 10.0, 0.5).animatable(),
        ParamDesc::vec3("axis", Unit::None, -1.0, 1.0, [0.0, 0.0, 1.0]),
        ParamDesc::int("first_bone", 0, 65534, 1),
        ParamDesc::float("falloff", Unit::Ratio, 0.0, 1.0, 0.8),
    ];
    /// The phase in cycles, in [0, 1).
    type State = f32;

    fn evaluate(
        cx: &Context<'_>,
        _: &Inputs<'_>,
        p: &Params<'_>,
        phase: &mut f32,
        out: &mut [Transform],
    ) {
        let mut ph = *phase + p.float(sway::FREQUENCY) * cx.dt;
        ph -= ph as i32 as f32;
        if !(0.0..1.0).contains(&ph) {
            ph = 0.0; // NaN or a negative step: restart the cycle.
        }
        *phase = ph;

        let a = p.vec3(sway::AXIS);
        let len2 = a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
        if len2 <= 1e-12 {
            return;
        }
        let r = inv_sqrt(len2);
        let axis = [a[0] * r, a[1] * r, a[2] * r];
        let mut angle = p.float(sway::AMPLITUDE) * (PI / 180.0) * sin(TAU * ph);
        let falloff = p.float(sway::FALLOFF);
        let first = p.int(sway::FIRST_BONE).max(0) as usize;
        for t in out.iter_mut().skip(first) {
            let half = 0.5 * angle;
            let s = sin(half);
            let q = [axis[0] * s, axis[1] * s, axis[2] * s, cos(half)];
            t.rotation = quat_mul(q, t.rotation);
            angle *= falloff;
        }
    }
}

/// The pass-through with scale.
pub struct Scale;

impl Node for Scale {
    const KIND: u32 = 2;
    const NAME: &'static str = "scale";
    const PARAMS: &'static [ParamDesc] =
        &[ParamDesc::float("factor", Unit::Multiplier, 0.0, 10.0, 1.0).animatable()];
    type State = ();

    fn evaluate(
        _: &Context<'_>,
        _: &Inputs<'_>,
        p: &Params<'_>,
        _: &mut (),
        out: &mut [Transform],
    ) {
        let f = p.float(0);
        for t in out {
            for c in &mut t.translation {
                *c *= f;
            }
        }
    }
}

export_nodes!(Sway, Scale);
anim_plugin_sdk::panic_handler!();
