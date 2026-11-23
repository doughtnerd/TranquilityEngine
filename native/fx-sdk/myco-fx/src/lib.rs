//! Write Myco audio effect plugins (ADR 0352 §2, amended by 0358): DSP that runs in the audio worklet beside the
//! audio core, in its own WebAssembly memory, with no imports, under an instruction budget.
//!
//! Implement [`Effect`] for each effect and list them in [`export_effects!`]; the macro writes the DSP ABI 1.0 exports
//! (`myco_fx_abi`, `myco_fx_create`, `myco_fx_destroy`, `myco_fx_reset`, `myco_fx_io`, `myco_fx_process`,
//! `myco_fx_tail_frames`). An effect's index in the list is its `kind`, which `plugin.json` names per effect.
//!
//! ```ignore
//! #![cfg_attr(target_arch = "wasm32", no_std)]
//! use myco_fx::{Effect, Flags, Status, PARAMS};
//!
//! pub struct Gain;
//! impl Effect for Gain {
//!     fn new(_sample_rate: f32, _max_frames: usize) -> Self { Gain }
//!     fn reset(&mut self) {}
//!     fn process(&mut self, l: &mut [f32], r: &mut [f32], p0: &[f32; PARAMS], p1: &[f32; PARAMS], _flags: Flags) -> Status {
//!         let n = l.len() as f32;
//!         for i in 0..l.len() {
//!             let g = p0[0] + (p1[0] - p0[0]) * i as f32 / n;
//!             l[i] *= g;
//!             r[i] *= g;
//!         }
//!         Status::Ok
//!     }
//! }
//! myco_fx::export_effects!(Gain);
//! ```
//!
//! **Rules the host enforces** (a breach is a fault: the block passes through dry and the instance is re-created):
//! - `new` may allocate (it runs off the audio path); `process` must not grow memory. The module's memory is capped at
//!   the manifest's `memoryMB` (default 4, at most 64).
//! - Each `process` call has a budget of the manifest's `instructionsPerFrame` × frames (default 1,000 per frame, at
//!   most 5,000); running past it traps.
//! - Output samples must be finite and within ±64.
//! - The module imports nothing: no `std` I/O, no clock, no randomness from the host. Use [`math`] (or the `libm`
//!   crate) for transcendentals.
//!
//! **Building.** A `cdylib` crate built for `wasm32-unknown-unknown` with `panic = "abort"`, and with
//! `-C link-arg=-zstack-size=65536 -C link-arg=--max-memory=<memoryMB × 1048576>` so the module's initial memory
//! fits its budget. With the default `runtime` feature, this crate installs a freeing allocator ([`heap`]) and a panic
//! handler that traps, on wasm32 only, so the plugin crate can be `no_std` there and use `std` in native tests.
#![no_std]

extern crate alloc;
#[cfg(test)]
extern crate std;

pub mod heap;
pub mod math;

/// The DSP ABI this crate writes: `major << 8 | minor` (1.0).
pub const ABI: u32 = 0x0100;
/// Parameters per block edge (`p0`, `p1`).
pub const PARAMS: usize = 16;
/// The largest `max_frames` `create` accepts (the core passes 128; the offline renderer 4,096).
pub const MAX_FRAMES: u32 = 65536;

/// What the host says about a block (`flags` of `myco_fx_process`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Flags(pub u32);

impl Flags {
    /// Bit 0: a parameter changed since the last block (`p0` differs from the previous `p1`, or a new value arrived).
    pub const PARAMS_CHANGED: u32 = 1;
    /// Bit 1: the input is silent (all zeros).
    pub const INPUT_SILENT: u32 = 2;

    pub fn params_changed(self) -> bool {
        self.0 & Self::PARAMS_CHANGED != 0
    }
    pub fn input_silent(self) -> bool {
        self.0 & Self::INPUT_SILENT != 0
    }
}

/// What `process` reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i32)]
pub enum Status {
    /// The block was processed.
    Ok = 0,
    /// The output is silent and stays so while the input is (the tail has finished).
    Silent = 1,
}

/// One effect type. The host creates an instance per slot that uses it, at most `maxInstances` of them.
pub trait Effect: Sized {
    /// A new instance for `sample_rate` and blocks of at most `max_frames` frames. May allocate.
    fn new(sample_rate: f32, max_frames: usize) -> Self;
    /// Clears tails and history; parameters arrive with every block, so there are none to keep.
    fn reset(&mut self);
    /// Processes one block in place: planar stereo, `l.len() == r.len()` frames (at most `max_frames`). `p0` holds the
    /// parameters at the block's start and `p1` at its end, already glided by the core: ramp between them per sample
    /// for a smooth parameter, or read `p1` for a stepped one (`smooth: false` in the manifest: then `p0 == p1`).
    fn process(&mut self, l: &mut [f32], r: &mut [f32], p0: &[f32; PARAMS], p1: &[f32; PARAMS], flags: Flags) -> Status;
    /// Frames of tail after the input stops (a delay's or reverb's ring-out); 0 when there is none.
    fn tail_frames(&self) -> u32 {
        0
    }
}

/// One effect type behind the ABI: what `export_effects!` lists per kind. The handles are pointers into the module's
/// memory (`usize`, so the same code runs natively in tests).
#[derive(Clone, Copy)]
pub struct Kind {
    create: fn(f32, u32) -> usize,
    destroy: unsafe fn(usize),
    reset: unsafe fn(usize),
    io: unsafe fn(usize) -> usize,
    process: unsafe fn(usize, u32, u32) -> i32,
    tail_frames: unsafe fn(usize) -> u32,
}

impl Kind {
    /// The kind of effect type `T`.
    pub const fn of<T: Effect>() -> Kind {
        Kind {
            create: rt::create::<T>,
            destroy: rt::destroy::<T>,
            reset: rt::reset::<T>,
            io: rt::io::<T>,
            process: rt::process::<T>,
            tail_frames: rt::tail_frames::<T>,
        }
    }

    /// `myco_fx_create`: a new instance's handle, or 0 when `max_frames` is 0 or above [`MAX_FRAMES`], or memory ran out.
    pub fn create(&self, sample_rate: f32, max_frames: u32) -> usize {
        (self.create)(sample_rate, max_frames)
    }
    /// `myco_fx_destroy`. Safety: `handle` came from this kind's `create` and wasn't destroyed.
    pub unsafe fn destroy(&self, handle: usize) {
        (self.destroy)(handle)
    }
    /// `myco_fx_reset`. Safety: as `destroy`.
    pub unsafe fn reset(&self, handle: usize) {
        (self.reset)(handle)
    }
    /// `myco_fx_io`: the address of the instance's I/O block, `{ f32 l[max]; f32 r[max]; f32 p0[16]; f32 p1[16] }`.
    /// Safety: as `destroy`.
    pub unsafe fn io(&self, handle: usize) -> usize {
        (self.io)(handle)
    }
    /// `myco_fx_process`: [`Status`] as an integer. Frames above `max_frames` are clamped to it. Safety: as `destroy`.
    pub unsafe fn process(&self, handle: usize, frames: u32, flags: u32) -> i32 {
        (self.process)(handle, frames, flags)
    }
    /// `myco_fx_tail_frames`. Safety: as `destroy`.
    pub unsafe fn tail_frames(&self, handle: usize) -> u32 {
        (self.tail_frames)(handle)
    }
}

#[doc(hidden)]
pub mod rt {
    //! The ABI's glue for one effect type: an instance owns its effect and its I/O block.
    use super::{Effect, Flags, Status, MAX_FRAMES, PARAMS};
    use alloc::alloc::{alloc_zeroed, dealloc, Layout};
    use alloc::boxed::Box;

    struct Instance<T> {
        io: *mut f32,
        max: usize,
        effect: T,
    }

    fn io_layout(max: usize) -> Option<Layout> {
        Layout::from_size_align((2 * max + 2 * PARAMS) * core::mem::size_of::<f32>(), 16).ok()
    }

    pub fn create<T: Effect>(sample_rate: f32, max_frames: u32) -> usize {
        if max_frames == 0 || max_frames > MAX_FRAMES || !sample_rate.is_finite() || sample_rate <= 0.0 {
            return 0;
        }
        let max = max_frames as usize;
        let Some(layout) = io_layout(max) else { return 0 };
        // SAFETY: the layout has a non-zero size.
        let io = unsafe { alloc_zeroed(layout) } as *mut f32;
        if io.is_null() {
            return 0;
        }
        let instance = Box::new(Instance { io, max, effect: T::new(sample_rate, max) });
        Box::into_raw(instance) as usize
    }

    pub unsafe fn destroy<T: Effect>(handle: usize) {
        let instance = Box::from_raw(handle as *mut Instance<T>);
        if let Some(layout) = io_layout(instance.max) {
            dealloc(instance.io as *mut u8, layout);
        }
    }

    pub unsafe fn reset<T: Effect>(handle: usize) {
        (*(handle as *mut Instance<T>)).effect.reset();
    }

    pub unsafe fn io<T: Effect>(handle: usize) -> usize {
        (*(handle as *const Instance<T>)).io as usize
    }

    pub unsafe fn process<T: Effect>(handle: usize, frames: u32, flags: u32) -> i32 {
        let instance = &mut *(handle as *mut Instance<T>);
        let max = instance.max;
        let n = (frames as usize).min(max);
        let io = instance.io;
        // The four regions of the I/O block don't overlap.
        let l = core::slice::from_raw_parts_mut(io, n);
        let r = core::slice::from_raw_parts_mut(io.add(max), n);
        let p0 = &*(io.add(2 * max) as *const [f32; PARAMS]);
        let p1 = &*(io.add(2 * max + PARAMS) as *const [f32; PARAMS]);
        match instance.effect.process(l, r, p0, p1, Flags(flags)) {
            Status::Ok => 0,
            Status::Silent => 1,
        }
    }

    pub unsafe fn tail_frames<T: Effect>(handle: usize) -> u32 {
        (*(handle as *const Instance<T>)).effect.tail_frames()
    }
}

/// Writes the DSP ABI 1.0 exports for the listed effect types (their index is their `kind`), on wasm32. On every
/// target it also defines `MYCO_FX_KINDS: &[myco_fx::Kind]`, the same dispatch the exports use, so native tests can
/// drive an effect through the ABI's own create, I/O block, process and destroy.
#[macro_export]
macro_rules! export_effects {
    ($($effect:ty),+ $(,)?) => {
        /// The effect types this module exports, by kind.
        pub static MYCO_FX_KINDS: &[$crate::Kind] = &[$($crate::Kind::of::<$effect>()),+];

        #[cfg(target_arch = "wasm32")]
        const _: () = {
            fn kind(k: u32) -> Option<&'static $crate::Kind> {
                MYCO_FX_KINDS.get(k as usize)
            }
            #[no_mangle]
            pub extern "C" fn myco_fx_abi() -> u32 {
                $crate::ABI
            }
            #[no_mangle]
            pub extern "C" fn myco_fx_create(k: u32, sample_rate: f32, max_frames: u32) -> u32 {
                kind(k).map_or(0, |e| e.create(sample_rate, max_frames) as u32)
            }
            #[no_mangle]
            pub extern "C" fn myco_fx_destroy(k: u32, state: u32) {
                if let (Some(e), true) = (kind(k), state != 0) {
                    unsafe { e.destroy(state as usize) }
                }
            }
            #[no_mangle]
            pub extern "C" fn myco_fx_reset(k: u32, state: u32) {
                if let (Some(e), true) = (kind(k), state != 0) {
                    unsafe { e.reset(state as usize) }
                }
            }
            #[no_mangle]
            pub extern "C" fn myco_fx_io(k: u32, state: u32) -> u32 {
                match (kind(k), state != 0) {
                    (Some(e), true) => unsafe { e.io(state as usize) as u32 },
                    _ => 0,
                }
            }
            #[no_mangle]
            pub extern "C" fn myco_fx_process(k: u32, state: u32, frames: u32, flags: u32) -> i32 {
                match (kind(k), state != 0) {
                    (Some(e), true) => unsafe { e.process(state as usize, frames, flags) },
                    _ => 0,
                }
            }
            #[no_mangle]
            pub extern "C" fn myco_fx_tail_frames(k: u32, state: u32) -> u32 {
                match (kind(k), state != 0) {
                    (Some(e), true) => unsafe { e.tail_frames(state as usize) },
                    _ => 0,
                }
            }
        };
    };
}

#[cfg(all(target_arch = "wasm32", feature = "runtime"))]
mod runtime {
    #[global_allocator]
    static ALLOCATOR: crate::heap::WasmHeap = crate::heap::WasmHeap::new();

    #[panic_handler]
    fn panic(_: &core::panic::PanicInfo) -> ! {
        core::arch::wasm32::unreachable()
    }
}
