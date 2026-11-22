//! What [`crate::export_nodes!`]'s exports call. Hidden from the docs: plugin authors use the
//! macro, not these.

use crate::abi::{Status, MAX_BONES, STATE_ALIGN};
use crate::descriptor::{param_words, NODE_NEEDS_SKELETON};
use crate::view::{Context, Inputs, Params, Transform};
use crate::Node;

/// `myco_node_alloc`: grows the memory by enough 64 KiB pages for `bytes` (at least one) and
/// returns the first new page, or null when the memory is at its maximum. Blocks are never freed.
/// Off wasm (native tests of a plugin crate) it always returns null.
pub fn alloc(bytes: u32) -> *mut u8 {
    #[cfg(target_arch = "wasm32")]
    {
        const PAGE: usize = 65536;
        let pages = (bytes as usize).div_ceil(PAGE).max(1);
        let old = core::arch::wasm32::memory_grow(0, pages);
        if old == usize::MAX {
            return core::ptr::null_mut();
        }
        (old * PAGE) as *mut u8
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = bytes;
        core::ptr::null_mut()
    }
}

/// A slice of `len` items at `ptr`, or `None` when `ptr` is null or misaligned (an empty slice for
/// `len == 0` whatever `ptr` is).
///
/// # Safety
/// When `len > 0` and `ptr` is non-null and aligned, `ptr` must point to `len` readable items.
unsafe fn slice<'a, T>(ptr: *const T, len: usize) -> Option<&'a [T]> {
    if len == 0 {
        return Some(&[]);
    }
    if ptr.is_null() || !ptr.is_aligned() {
        return None;
    }
    // SAFETY: the caller guarantees `len` readable items at the non-null, aligned `ptr`.
    Some(unsafe { core::slice::from_raw_parts(ptr, len) })
}

/// As [`slice`], mutable.
///
/// # Safety
/// As [`slice`], writable, and not aliased by any other slice made for the call.
unsafe fn slice_mut<'a, T>(ptr: *mut T, len: usize) -> Option<&'a mut [T]> {
    if len == 0 {
        return Some(&mut []);
    }
    if ptr.is_null() || !ptr.is_aligned() {
        return None;
    }
    // SAFETY: as above, plus exclusivity from the caller.
    Some(unsafe { core::slice::from_raw_parts_mut(ptr, len) })
}

/// `myco_node_evaluate` for node `N`: checks the arguments, then for each instance copies its
/// first input into its output (identity for a 0-input node) and calls [`Node::evaluate`].
///
/// # Safety
/// The pointers follow [`crate::abi`]'s batch layout for `N`'s descriptor and `count` instances of
/// `bones` bones; `output` and `state` don't overlap each other or any input.
#[allow(clippy::too_many_arguments)]
pub unsafe fn evaluate<N: Node>(
    count: u32,
    bones: u32,
    parents: *const u16,
    input: *const f32,
    output: *mut f32,
    params: *const u32,
    state: *mut u8,
    dt: f32,
) -> u32 {
    match unsafe { run::<N>(count, bones, parents, input, output, params, state, dt) } {
        Some(()) => Status::Ok as u32,
        None => Status::BadArguments as u32,
    }
}

#[allow(clippy::too_many_arguments)]
unsafe fn run<N: Node>(
    count: u32,
    bones: u32,
    parents: *const u16,
    input: *const f32,
    output: *mut f32,
    params: *const u32,
    state: *mut u8,
    dt: f32,
) -> Option<()> {
    if bones > MAX_BONES {
        return None;
    }
    let count = count as usize;
    let bones = bones as usize;
    let inputs = N::INPUTS as usize;
    let words = param_words(N::PARAMS);
    let state_size = core::mem::size_of::<N::State>();
    let stride = crate::abi::state_stride(state_size);

    let in_len = count.checked_mul(inputs)?.checked_mul(bones)?;
    let out_len = count.checked_mul(bones)?;
    let input = unsafe { slice(input.cast::<Transform>(), in_len) }?;
    let output = unsafe { slice_mut(output.cast::<Transform>(), out_len) }?;
    let params = unsafe { slice(params, count.checked_mul(words)?) }?;
    let parents = if N::DESC.flags & NODE_NEEDS_SKELETON != 0 {
        unsafe { slice(parents, bones) }?
    } else {
        &[]
    };
    if state_size > 0 && count > 0 {
        if state.is_null() || !(state as usize).is_multiple_of(STATE_ALIGN) {
            return None;
        }
        count.checked_mul(stride)?;
    }

    for i in 0..count {
        let out = &mut output[i * bones..(i + 1) * bones];
        let ins = Inputs {
            data: &input[i * inputs * bones..(i + 1) * inputs * bones],
            bones,
        };
        if inputs > 0 {
            out.copy_from_slice(ins.pose(0));
        } else {
            out.fill(Transform::IDENTITY);
        }
        let p = Params {
            words: &params[i * words..(i + 1) * words],
            schema: N::PARAMS,
        };
        let s: &mut N::State = if state_size == 0 {
            // SAFETY: a dangling, aligned pointer is a valid reference to a zero-sized value.
            unsafe { &mut *core::ptr::NonNull::<N::State>::dangling().as_ptr() }
        } else {
            // SAFETY: `state` is 16-aligned (checked) and `State`'s alignment is at most 16
            // (checked when `N::DESC` is built); instance `i`'s state lies inside the caller's
            // `count × stride` bytes, and every bit pattern is a valid `State` (`Pod`).
            unsafe { &mut *state.add(i * stride).cast::<N::State>() }
        };
        let cx = Context {
            dt,
            bones,
            parents,
            instance: i,
        };
        N::evaluate(&cx, &ins, &p, s, out);
    }
    Some(())
}
