//! `anim-plugin-sdk` (ADR 0350, "Third-party graph and rig nodes"): the small C ABI a plugin's node
//! module implements (pose in, parameters in, pose out) and the Rust SDK for writing one.
//!
//! A node module is a wasm module with its own memory and no imports, declared in the plugin's
//! `plugin.json`. The core calls it inside graph evaluation (`anim-graph::plugin`) through the host;
//! faults pass the input pose through and report once (audio 0338's model). The loader meters it
//! first (`anim-meter`).
//!
//! - [`abi`]: the ABI, **version 1**: exports, signatures, the batch's buffer layouts, limits,
//!   faults.
//! - [`descriptor`]: the descriptor blob (node kinds and their parameter schema), its compile-time
//!   encoder and the loader's checked parser.
//! - [`Node`] and [`export_nodes!`]: the SDK. A plugin author writes
//!
//! ```ignore
//! #![cfg_attr(target_arch = "wasm32", no_std)]
//! use anim_plugin_sdk::{export_nodes, Context, Inputs, Node, ParamDesc, Params, Transform, Unit};
//!
//! struct Shrink;
//! impl Node for Shrink {
//!     const KIND: u32 = 1;
//!     const NAME: &'static str = "shrink";
//!     const PARAMS: &'static [ParamDesc] = &[ParamDesc::float("factor", Unit::Multiplier, 0.0, 1.0, 0.5).animatable()];
//!     type State = ();
//!     fn evaluate(_: &Context, _: &Inputs, p: &Params, _: &mut (), out: &mut [Transform]) {
//!         for t in out { for s in &mut t.scale { *s *= p.float(0); } }
//!     }
//! }
//! export_nodes!(Shrink);
//! anim_plugin_sdk::panic_handler!();
//! ```
//!
//! and builds it with `cargo build --target wasm32-unknown-unknown --release` as a `cdylib`.
//!
//! `no_std` and allocation-free: the descriptor is a `static` built at compile time, and buffers
//! come from growing the module's memory.
#![no_std]

pub mod abi;
pub mod descriptor;
#[doc(hidden)]
pub mod rt;
mod view;

pub use abi::{Status, ABI_VERSION};
pub use descriptor::{NodeDesc, ParamDesc, ParamKind, Unit};
pub use view::{Context, Inputs, Params, Transform};

/// Plain data a node may keep per instance: `Copy`, and every bit pattern (all zeros first of all)
/// is a valid value, because the core zero-fills a new instance's state and stores it as bytes.
///
/// # Safety
/// Implement it only for types with no padding-sensitive invariants, no references or pointers,
/// no `bool`/`char`/enums, and alignment at most 16, for example a `#[repr(C)]` struct of `f32`s.
pub unsafe trait Pod: Copy + 'static {}

macro_rules! pod {
    ($($t:ty),*) => { $(unsafe impl Pod for $t {})* };
}
pod!((), u8, i8, u16, i16, u32, i32, u64, i64, f32, f64);
unsafe impl<T: Pod, const N: usize> Pod for [T; N] {}

/// The bytes a state type takes in the descriptor; refuses (at compile time) alignment over 16.
pub const fn state_bytes_of<T>() -> u32 {
    assert!(
        core::mem::align_of::<T>() <= abi::STATE_ALIGN,
        "Node::State alignment must be at most 16"
    );
    assert!(
        core::mem::size_of::<T>() <= abi::MAX_STATE_BYTES as usize,
        "Node::State must be at most 64 KiB"
    );
    core::mem::size_of::<T>() as u32
}

/// A node kind. Implement it for a unit struct and list the struct in [`export_nodes!`].
pub trait Node {
    /// The id the graph stores and [`abi::EVALUATE`] receives; unique in the module and never
    /// reused for a different node.
    const KIND: u32;
    /// The node's name in the module (`plugin.json` namespaces it).
    const NAME: &'static str;
    /// Pose inputs, 0 ..= 8.
    const INPUTS: u8 = 1;
    /// Whether [`Context::parents`] is filled.
    const NEEDS_SKELETON: bool = false;
    /// The parameter schema, in block order.
    const PARAMS: &'static [ParamDesc] = &[];
    /// Per-instance state, zeroed when the instance is created; `()` for none.
    type State: Pod;

    /// The descriptor record. Don't override it.
    const DESC: NodeDesc = NodeDesc {
        kind: Self::KIND,
        name: Self::NAME,
        inputs: Self::INPUTS,
        flags: if Self::NEEDS_SKELETON {
            descriptor::NODE_NEEDS_SKELETON
        } else {
            0
        },
        params: Self::PARAMS,
        state_bytes: state_bytes_of::<Self::State>(),
    };

    /// Evaluates one instance. `out` holds `cx.bones` transforms and starts as a copy of input 0
    /// (identity for a 0-input node). A panic is a fault: the host passes input 0 through.
    /// Never allocates (there is no allocator).
    fn evaluate(
        cx: &Context<'_>,
        inputs: &Inputs<'_>,
        params: &Params<'_>,
        state: &mut Self::State,
        out: &mut [Transform],
    );
}

/// Exports a module's nodes: `myco_node_abi_version`, `myco_node_describe` (a compile-time
/// descriptor `static`; an invalid node list is a compile error), `myco_node_alloc` and
/// `myco_node_evaluate`, which dispatches on the kind. Use it once per module.
#[macro_export]
macro_rules! export_nodes {
    ($($node:ty),+ $(,)?) => {
        const __MYCO_NODES: &[$crate::NodeDesc] = &[$(<$node as $crate::Node>::DESC),+];
        const __MYCO_DESCRIPTOR_LEN: usize = $crate::descriptor::encoded_len(__MYCO_NODES);
        static __MYCO_DESCRIPTOR: [u8; __MYCO_DESCRIPTOR_LEN] =
            $crate::descriptor::encode::<__MYCO_DESCRIPTOR_LEN>(__MYCO_NODES);

        /// ABI: the version.
        #[unsafe(no_mangle)]
        pub extern "C" fn myco_node_abi_version() -> u32 {
            $crate::abi::ABI_VERSION
        }

        /// ABI: the descriptor blob.
        #[unsafe(no_mangle)]
        pub extern "C" fn myco_node_describe() -> *const u8 {
            __MYCO_DESCRIPTOR.as_ptr()
        }

        /// ABI: a buffer of at least `bytes`, 16-aligned, or null.
        #[unsafe(no_mangle)]
        pub extern "C" fn myco_node_alloc(bytes: u32) -> *mut u8 {
            $crate::rt::alloc(bytes)
        }

        /// ABI: evaluates `count` instances of node `kind` (see `anim_plugin_sdk::abi`).
        ///
        /// # Safety
        /// The pointers follow the ABI's batch layout.
        #[unsafe(no_mangle)]
        #[allow(clippy::too_many_arguments)]
        pub unsafe extern "C" fn myco_node_evaluate(
            kind: u32,
            count: u32,
            bones: u32,
            parents: *const u16,
            input: *const f32,
            output: *mut f32,
            params: *const u32,
            state: *mut u8,
            dt: f32,
        ) -> u32 {
            $(
                if kind == <$node as $crate::Node>::KIND {
                    // SAFETY: forwarded from this function's own contract.
                    return unsafe {
                        $crate::rt::evaluate::<$node>(count, bones, parents, input, output, params, state, dt)
                    };
                }
            )+
            $crate::abi::Status::UnknownKind as u32
        }
    };
}

/// A panic handler for wasm builds (`#![cfg_attr(target_arch = "wasm32", no_std)]`): a panic traps
/// through `unreachable`, which the host treats as a fault. Expands to nothing off wasm.
#[macro_export]
macro_rules! panic_handler {
    () => {
        #[cfg(target_arch = "wasm32")]
        #[panic_handler]
        fn __myco_panic(_: &::core::panic::PanicInfo<'_>) -> ! {
            ::core::arch::wasm32::unreachable()
        }
    };
}
