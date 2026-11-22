//! Plugin effects (ADR 0338 §5, amended by 0344; ABI 5.0): the core's side of the `myco_ext` import
//! the worklet shell binds (`src/plugins/audio/runtime/worklet/effectGlue.ts`).
//!
//! A plugin effect is an effect kind `PLUGIN_BASE + e` (`audio_dsp::fx::kind::plugin`) in a bus chain
//! (`fx.rs`, as `BUS_FX_CATALOGUE + kind`), an instance submix's chain at any level (`submix.rs`), or
//! a return (a bus). Its slot is an ordinary `audio_dsp::fx::Effect`: it keeps the parameters and
//! their glide as a built-in's do, plus the instance handle, the glide modes and the budget. Its
//! state lives in the plugin's own module and memory, never in `FxMem`, so it takes no effect memory.
//!
//! **The import** (`myco_ext`, all `i32`/pointers into the core's memory):
//! - `acquire(e) -> handle`: an instance of effect `e` from its pre-created pool (0: none free, the
//!   module not loaded yet, or `e` unknown: the slot passes through and asks again each block it runs,
//!   so a module that loads after the configuration still gets its slots).
//! - `release(handle)`: the slot is reconfigured to another kind.
//! - `describe(e, what) -> u32`: `what` 0, the glide modes (bit `i` log2, bit `16 + i` stepped);
//!   1, the instruction budget per frame.
//! - `process(handle, l, r, frames, p0, p1, flags, fuel) -> i32`: runs the instance in place on the
//!   planar block. `p0`, `p1` are 16 floats each (block start, block end); `flags` are
//!   `FX_PLUGIN_FLAG_*`; `fuel` is the grant (the instance's budget × frames, or 0 when the level's
//!   shared fuel can't cover it: the glue then passes dry without calling the plugin). A negative
//!   result is a fault or a pass (the glue left `l`, `r` untouched: the block passes **dry**); else
//!   bit 0 says the output is silent and the rest is the instructions the plugin used.
//! - `sweep(handles, n, last)`: after every configuration (`fxmem::rebuild`), the handles still held,
//!   in chunks; on the last chunk the glue releases every handle it gave that wasn't listed. So a
//!   slot freed by any path (a bus removed, a submix freed, RESET) gives its instance back.
//!
//! **Faults never reach the core**: the glue catches a plugin's trap, fuel exhaustion, non-finite or
//! out-of-range output and memory growth, and returns a negative status (0157's hard rebuild stays
//! for the core's own faults).
//!
//! **Shared fuel** (0344 §3): each chain level (the buses, the instance submixes) has
//! `FX_PLUGIN_FUEL_PER_FRAME × QUANTUM` instructions a quantum across all its plugin instances
//! ([`Fuel`]); a call whose budget doesn't fit what is left gets no fuel and passes dry, so runaway
//! instances hold the audio thread for a bounded time.
//!
//! Natively (`cargo test`) the import is a registry: a test installs a [`Host`] for its thread
//! ([`install`]); with none, `acquire` gives 0 and every plugin slot passes through.

use audio_dsp::fx::{plugin_flags, Effect, PARAMS};
use audio_wire::generated as wire;

/// Each chain level's shared fuel per frame (the wire's `FX_PLUGIN_FUEL_PER_FRAME`).
pub const FUEL_PER_FRAME: u32 = wire::FX_PLUGIN_FUEL_PER_FRAME;

const _: () = assert!(PARAMS == wire::FX_PARAMS as usize && audio_dsp::fx::kind::PLUGIN_BASE == wire::FX_PLUGIN_BASE);
const _: () = assert!(plugin_flags::PARAMS == wire::FX_PLUGIN_FLAG_PARAMS && plugin_flags::SILENT == wire::FX_PLUGIN_FLAG_SILENT && plugin_flags::RESET == wire::FX_PLUGIN_FLAG_RESET);

/// `describe`'s `what`: the glide modes.
pub const DESCRIBE_MODES: u32 = 0;
/// `describe`'s `what`: the instruction budget per frame.
pub const DESCRIBE_BUDGET: u32 = 1;

/// A chain level's fuel left this quantum (0344 §3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fuel(pub u32);

impl Fuel {
    /// A full quantum's worth for `frames` frames.
    pub fn quantum(frames: usize) -> Fuel {
        Fuel(FUEL_PER_FRAME.saturating_mul(frames as u32))
    }
}

#[cfg(target_arch = "wasm32")]
mod imp {
    #[link(wasm_import_module = "myco_ext")]
    extern "C" {
        #[link_name = "acquire"]
        fn ext_acquire(e: u32) -> u32;
        #[link_name = "release"]
        fn ext_release(handle: u32);
        #[link_name = "describe"]
        fn ext_describe(e: u32, what: u32) -> u32;
        #[link_name = "process"]
        fn ext_process(handle: u32, l: *mut f32, r: *mut f32, frames: u32, p0: *const f32, p1: *const f32, flags: u32, fuel: u32) -> i32;
        #[link_name = "sweep"]
        fn ext_sweep(handles: *const u32, n: u32, last: u32);
    }

    pub fn acquire(e: u32) -> u32 {
        // SAFETY: a plain call into the host's import; no pointers.
        unsafe { ext_acquire(e) }
    }
    pub fn release(handle: u32) {
        // SAFETY: as `acquire`.
        unsafe { ext_release(handle) }
    }
    pub fn describe(e: u32, what: u32) -> u32 {
        // SAFETY: as `acquire`.
        unsafe { ext_describe(e, what) }
    }
    pub fn process(handle: u32, l: &mut [f32], r: &mut [f32], p0: &[f32; 16], p1: &[f32; 16], flags: u32, fuel: u32) -> i32 {
        let n = l.len().min(r.len()) as u32;
        // SAFETY: the pointers are into the core's memory, valid for `n` floats (l, r) and 16 (p0, p1)
        // for the call; the glue writes only `l[..n]`, `r[..n]` and never keeps them.
        unsafe { ext_process(handle, l.as_mut_ptr(), r.as_mut_ptr(), n, p0.as_ptr(), p1.as_ptr(), flags, fuel) }
    }
    pub fn sweep(handles: &[u32], last: bool) {
        // SAFETY: the glue reads `handles.len()` u32s during the call.
        unsafe { ext_sweep(handles.as_ptr(), handles.len() as u32, last as u32) }
    }
}

/// The host of the native import: what a test installs ([`install`]) in place of the worklet's glue.
#[cfg(not(target_arch = "wasm32"))]
pub trait Host {
    fn acquire(&mut self, e: u32) -> u32;
    fn release(&mut self, handle: u32);
    fn describe(&mut self, e: u32, what: u32) -> u32;
    #[allow(clippy::too_many_arguments)]
    fn process(&mut self, handle: u32, l: &mut [f32], r: &mut [f32], p0: &[f32; 16], p1: &[f32; 16], flags: u32, fuel: u32) -> i32;
    fn sweep(&mut self, handles: &[u32], last: bool);
}

#[cfg(not(target_arch = "wasm32"))]
mod imp {
    use super::Host;
    use std::boxed::Box;
    use std::cell::RefCell;

    std::thread_local! {
        pub(super) static HOST: RefCell<Option<Box<dyn Host>>> = const { RefCell::new(None) };
    }

    fn with<R>(none: R, f: impl FnOnce(&mut dyn Host) -> R) -> R {
        HOST.with(|h| match h.borrow_mut().as_mut() {
            Some(host) => f(host.as_mut()),
            None => none,
        })
    }

    pub fn acquire(e: u32) -> u32 {
        with(0, |h| h.acquire(e))
    }
    pub fn release(handle: u32) {
        with((), |h| h.release(handle))
    }
    pub fn describe(e: u32, what: u32) -> u32 {
        with(0, |h| h.describe(e, what))
    }
    pub fn process(handle: u32, l: &mut [f32], r: &mut [f32], p0: &[f32; 16], p1: &[f32; 16], flags: u32, fuel: u32) -> i32 {
        with(-1, |h| h.process(handle, l, r, p0, p1, flags, fuel))
    }
    pub fn sweep(handles: &[u32], last: bool) {
        with((), |h| h.sweep(handles, last))
    }
}

/// Installs `host` as this thread's `myco_ext` (native tests); the previous one comes back.
#[cfg(not(target_arch = "wasm32"))]
pub fn install(host: Option<std::boxed::Box<dyn Host>>) -> Option<std::boxed::Box<dyn Host>> {
    imp::HOST.with(|h| core::mem::replace(&mut *h.borrow_mut(), host))
}

/// Sets up a plugin slot after `Effect::configure` gave it a new kind (`fxmem::configure`):
/// releases the instance of the kind it had (`old`: its kind and handle before), acquires one for
/// the new kind when it is a plugin's, and reads its glide modes and budget. A slot that keeps its
/// plugin kind keeps its instance (`fresh` false).
pub fn configure(e: &mut Effect, fresh: bool, old_kind: u32, old_handle: u32) {
    if !fresh {
        return;
    }
    if old_handle != 0 && audio_dsp::fx::kind::plugin(old_kind).is_some() {
        imp::release(old_handle);
    }
    e.handle = 0;
    e.modes = 0;
    e.budget = 0;
    if let Some(p) = audio_dsp::fx::kind::plugin(e.kind) {
        e.modes = imp::describe(p, DESCRIBE_MODES);
        e.budget = imp::describe(p, DESCRIBE_BUDGET);
        e.handle = imp::acquire(p);
    }
}

/// Runs plugin slot `e` on one block in place (`l`, `r` equal lengths), drawing on the level's
/// `fuel`: its glide steps, then the plugin runs through the import. A bypassed slot does nothing;
/// one with no instance asks for one first and passes through without; a fault or a call the fuel
/// can't cover leaves the block dry. Returns the call's status (negative: dry; `i32::MIN` when the
/// slot made no call).
pub fn process(e: &mut Effect, l: &mut [f32], r: &mut [f32], fuel: &mut Fuel) -> i32 {
    let Some(p) = audio_dsp::fx::kind::plugin(e.kind) else { return i32::MIN };
    if e.on == 0 {
        return i32::MIN;
    }
    let n = l.len().min(r.len());
    let (l, r) = (&mut l[..n], &mut r[..n]);
    if e.handle == 0 {
        e.handle = imp::acquire(p);
        if e.handle == 0 {
            return i32::MIN;
        }
    }
    let mut p0 = [0.0f32; PARAMS];
    let mut flags = e.plugin_block(n as u32, &mut p0);
    if l.iter().all(|x| *x == 0.0) && r.iter().all(|x| *x == 0.0) {
        flags |= plugin_flags::SILENT;
    }
    let need = e.budget.saturating_mul(n as u32);
    let grant = if need <= fuel.0 { need } else { 0 };
    let status = imp::process(e.handle, l, r, &p0, &e.cur, flags, grant);
    if status >= 0 {
        fuel.0 -= ((status as u32) >> 1).min(grant);
    }
    status
}

/// Gives the handles in use to the glue (`fxmem::rebuild`'s sweep): `each` calls its argument with
/// every configured effect; plugin slots' handles go in chunks, the last flagged.
pub fn sweep(each: impl FnOnce(&mut dyn FnMut(&Effect))) {
    const CHUNK: usize = 64;
    let mut buf = [0u32; CHUNK];
    let mut n = 0usize;
    each(&mut |e: &Effect| {
        if e.handle != 0 && audio_dsp::fx::kind::plugin(e.kind).is_some() {
            if n == CHUNK {
                imp::sweep(&buf, false);
                n = 0;
            }
            buf[n] = e.handle;
            n += 1;
        }
    });
    imp::sweep(&buf[..n], true);
}
