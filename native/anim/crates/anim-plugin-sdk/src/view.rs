//! Safe views over a call's buffers: transforms, input poses, a parameter block and the context.

use crate::descriptor::{param_offset, ParamDesc, ParamKind};

/// One bone's local transform, laid out as the ABI's 10 floats: translation, rotation
/// (`x y z w`), scale. It maps `p` to `rotation · (scale ⊙ p) + translation`.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transform {
    pub translation: [f32; 3],
    pub rotation: [f32; 4],
    pub scale: [f32; 3],
}

const _: () = assert!(core::mem::size_of::<Transform>() == crate::abi::BONE_BYTES);
const _: () = assert!(core::mem::align_of::<Transform>() == 4);

impl Transform {
    /// No translation, no rotation, unit scale.
    pub const IDENTITY: Self = Self {
        translation: [0.0; 3],
        rotation: [0.0, 0.0, 0.0, 1.0],
        scale: [1.0; 3],
    };
}

impl Default for Transform {
    fn default() -> Self {
        Self::IDENTITY
    }
}

/// An instance's input poses: `len()` poses of `bones` transforms each.
#[derive(Clone, Copy, Debug)]
pub struct Inputs<'a> {
    pub(crate) data: &'a [Transform],
    pub(crate) bones: usize,
}

impl<'a> Inputs<'a> {
    /// Input count (the node's declared inputs).
    pub fn len(&self) -> usize {
        self.data.len().checked_div(self.bones).unwrap_or(0)
    }

    /// Whether there are no inputs (or no bones).
    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    /// Input `j`'s pose. Panics (a fault) when `j >= len()`.
    pub fn pose(&self, j: usize) -> &'a [Transform] {
        &self.data[j * self.bones..(j + 1) * self.bones]
    }
}

/// An instance's parameter block, read by parameter index (declared order).
#[derive(Clone, Copy, Debug)]
pub struct Params<'a> {
    pub(crate) words: &'a [u32],
    pub(crate) schema: &'static [ParamDesc],
}

impl<'a> Params<'a> {
    fn at(&self, index: usize, kind: ParamKind) -> &'a [u32] {
        debug_assert_eq!(self.schema[index].kind, kind, "parameter {index} kind");
        let o = param_offset(self.schema, index);
        &self.words[o..o + kind.words()]
    }

    /// Float parameter `index`.
    pub fn float(&self, index: usize) -> f32 {
        f32::from_bits(self.at(index, ParamKind::Float)[0])
    }

    /// Int parameter `index`.
    pub fn int(&self, index: usize) -> i32 {
        self.at(index, ParamKind::Int)[0] as i32
    }

    /// Bool parameter `index` (any non-zero word is true).
    pub fn bool(&self, index: usize) -> bool {
        self.at(index, ParamKind::Bool)[0] != 0
    }

    /// Vec2 parameter `index`.
    pub fn vec2(&self, index: usize) -> [f32; 2] {
        let w = self.at(index, ParamKind::Vec2);
        [f32::from_bits(w[0]), f32::from_bits(w[1])]
    }

    /// Vec3 parameter `index`.
    pub fn vec3(&self, index: usize) -> [f32; 3] {
        let w = self.at(index, ParamKind::Vec3);
        [
            f32::from_bits(w[0]),
            f32::from_bits(w[1]),
            f32::from_bits(w[2]),
        ]
    }

    /// Quaternion parameter `index` (`x y z w`).
    pub fn quat(&self, index: usize) -> [f32; 4] {
        let w = self.at(index, ParamKind::Quat);
        [
            f32::from_bits(w[0]),
            f32::from_bits(w[1]),
            f32::from_bits(w[2]),
            f32::from_bits(w[3]),
        ]
    }

    /// The raw words.
    pub fn words(&self) -> &'a [u32] {
        self.words
    }
}

/// What one instance's evaluation knows besides its poses, parameters and state.
#[derive(Clone, Copy, Debug)]
pub struct Context<'a> {
    /// The graph's step in seconds.
    pub dt: f32,
    /// Bones per pose.
    pub bones: usize,
    /// Parent indices (`abi::NO_PARENT` for a root), when the node sets `NEEDS_SKELETON`; else
    /// empty.
    pub parents: &'a [u16],
    /// The instance's index in this batch (not stable across frames).
    pub instance: usize,
}
