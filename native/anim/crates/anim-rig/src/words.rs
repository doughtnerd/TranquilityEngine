//! Word codecs for the solvers' fixed-size states ([`GrounderState`](crate::grounder::GrounderState),
//! [`SpringChainState`](crate::spring::SpringChainState), [`DampState`](crate::constraints::DampState)):
//! each writes itself as `u32` words (f32 bits, flags as 0/1) and reads itself back bit for bit, so
//! a caller can keep the state in a plain word blob that snapshots by copying (the graph's rig
//! nodes, ADR 0350's prediction rollback). Never allocates.

use anim_math::{AosQuat, AosVec3};

/// Writes words in order.
pub(crate) struct Put<'a> {
    out: &'a mut [u32],
    at: usize,
}

impl<'a> Put<'a> {
    pub(crate) fn new(out: &'a mut [u32]) -> Self {
        Put { out, at: 0 }
    }
    pub(crate) fn f(&mut self, v: f32) {
        self.out[self.at] = v.to_bits();
        self.at += 1;
    }
    pub(crate) fn b(&mut self, v: bool) {
        self.out[self.at] = v as u32;
        self.at += 1;
    }
    pub(crate) fn v(&mut self, v: AosVec3) {
        self.f(v.x);
        self.f(v.y);
        self.f(v.z);
    }
    pub(crate) fn q(&mut self, q: AosQuat) {
        self.f(q.x);
        self.f(q.y);
        self.f(q.z);
        self.f(q.w);
    }
}

/// Reads words in order.
pub(crate) struct Get<'a> {
    words: &'a [u32],
    at: usize,
}

impl<'a> Get<'a> {
    pub(crate) fn new(words: &'a [u32]) -> Self {
        Get { words, at: 0 }
    }
    pub(crate) fn f(&mut self) -> f32 {
        let v = f32::from_bits(self.words[self.at]);
        self.at += 1;
        v
    }
    pub(crate) fn b(&mut self) -> bool {
        let v = self.words[self.at] != 0;
        self.at += 1;
        v
    }
    pub(crate) fn v(&mut self) -> AosVec3 {
        AosVec3::new(self.f(), self.f(), self.f())
    }
    pub(crate) fn q(&mut self) -> AosQuat {
        AosQuat::new(self.f(), self.f(), self.f(), self.f())
    }
}
