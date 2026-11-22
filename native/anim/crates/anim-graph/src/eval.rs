//! The evaluation context every node sees, and a node's compiled data.
//!
//! Seam (T02): T13r adds the interpreter's state (pose stack, parameter rows, instance state,
//! output views) to [`EvalContext`] and the node's fields to [`NodeData`]; families read them.

use core::marker::PhantomData;

/// The state a node evaluates against: the instance's poses, parameters and outputs. Borrowed for
/// one evaluation; never allocates.
#[derive(Debug, Default)]
pub struct EvalContext<'a> {
    _state: PhantomData<&'a mut ()>,
}

impl<'a> EvalContext<'a> {
    /// An empty context.
    pub fn new() -> Self {
        EvalContext {
            _state: PhantomData,
        }
    }
}

/// One node's entry in a compiled graph: its parameter bytes from the node table.
#[derive(Clone, Copy, Debug)]
pub struct NodeData<'a> {
    /// The node's parameters, as the graph compiler laid them out for its kind.
    pub params: &'a [u8],
}
