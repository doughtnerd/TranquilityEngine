//! The engine's one triangle winding (ADR 0450, `src/engine/scene/winding.ts`): a front face's right-hand normal
//! `(b - a) x (c - a)` points inward, so its outward normal is `(c - a) x (b - a)`. Engine triangles enter the bake in it
//! as they are (the walkable side faces along `front_normal`).
use crate::vec::Float3;

/// The outward (walkable-side) normal of triangle (a, b, c) in the engine's winding, unnormalised.
#[inline]
pub fn front_normal(a: Float3, b: Float3, c: Float3) -> Float3 {
    (c - a).cross(b - a)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_floor_wound_as_the_engine_winds_it_faces_up() {
        // Seen from above (looking down -y), a -> b -> c runs as engine meshes wind a floor: front normal +y.
        let n = front_normal(Float3::new(0.0, 0.0, 0.0), Float3::new(1.0, 0.0, 0.0), Float3::new(0.0, 0.0, 1.0));
        assert_eq!(n, Float3::new(0.0, 1.0, 0.0));
    }
}
