//! Spike B0 (ADR 0338): a stand-in for the audio core. It owns planar stereo buffers and parameter blocks for up
//! to 32 effect slots in its own memory and calls each slot's plugin through the `myco_ext.process` import, as the
//! core's chains would. It keeps a running state (a quantum counter, a fault counter and an FNV hash over every
//! slot's output) so the spike can show that a plugin fault leaves the host's state exactly as a pass-through would.

#![no_std]

const SLOTS: usize = 32;
const FRAMES: usize = 128;

#[link(wasm_import_module = "myco_ext")]
extern "C" {
    fn process(handle: u32, l: *mut f32, r: *mut f32, frames: u32, p0: *const f32, p1: *const f32, flags: u32) -> i32;
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

static mut L: [[f32; FRAMES]; SLOTS] = [[0.0; FRAMES]; SLOTS];
static mut R: [[f32; FRAMES]; SLOTS] = [[0.0; FRAMES]; SLOTS];
static mut P0: [[f32; 16]; SLOTS] = [[0.0; 16]; SLOTS];
static mut P1: [[f32; 16]; SLOTS] = [[0.0; 16]; SLOTS];
static mut HANDLES: [u32; SLOTS] = [0; SLOTS];
static mut QUANTA: u32 = 0;
static mut FAULTS: u32 = 0;
static mut HASH: u32 = 0x811c_9dc5;
static mut PHASE: u32 = 0;

/// Binds slot `slot` to plugin instance `handle` with parameters `p0[0..3]` = `p1[0..3]` = (a, b, c).
#[no_mangle]
pub extern "C" fn host_bind(slot: u32, handle: u32, a: f32, b: f32, c: f32) {
    unsafe {
        let s = slot as usize;
        HANDLES[s] = handle;
        P0[s][0] = a;
        P0[s][1] = b;
        P0[s][2] = c;
        P1[s] = P0[s];
    }
}

/// Sets slot `slot`'s block-end parameter 0 (the faulty kind reads its mode there).
#[no_mangle]
pub extern "C" fn host_set_p1(slot: u32, value: f32) {
    unsafe { P1[slot as usize][0] = value }
}

/// One quantum: fills `n` slots with a deterministic signal, calls each slot's plugin, folds the outputs into the
/// hash. A negative return from the import counts as a fault (the glue already left the dry input in place).
#[no_mangle]
pub extern "C" fn host_quantum(n: u32) -> u32 {
    unsafe {
        let n = (n as usize).min(SLOTS);
        for s in 0..n {
            for i in 0..FRAMES {
                let k = PHASE.wrapping_add((i + s * 7) as u32);
                let v = ((k.wrapping_mul(2_654_435_761) >> 9) as f32 / 8_388_608.0) - 1.0;
                L[s][i] = v * 0.5;
                R[s][i] = -v * 0.25;
            }
        }
        for s in 0..n {
            let rc = process(
                HANDLES[s],
                L[s].as_mut_ptr(),
                R[s].as_mut_ptr(),
                FRAMES as u32,
                P0[s].as_ptr(),
                P1[s].as_ptr(),
                0,
            );
            if rc < 0 {
                FAULTS += 1;
            }
        }
        for s in 0..n {
            for i in 0..FRAMES {
                HASH = (HASH ^ L[s][i].to_bits()).wrapping_mul(16_777_619);
                HASH = (HASH ^ R[s][i].to_bits()).wrapping_mul(16_777_619);
            }
        }
        PHASE = PHASE.wrapping_add(FRAMES as u32);
        QUANTA += 1;
        HASH
    }
}

/// Only the calls of one quantum (no signal fill, no hash): isolates the import's cost for the timing runs.
#[no_mangle]
pub extern "C" fn host_calls(n: u32) -> i32 {
    unsafe {
        let n = (n as usize).min(SLOTS);
        let mut rc = 0;
        for s in 0..n {
            rc |= process(HANDLES[s], L[s].as_mut_ptr(), R[s].as_mut_ptr(), FRAMES as u32, P0[s].as_ptr(), P1[s].as_ptr(), 0);
        }
        rc
    }
}

#[no_mangle]
pub extern "C" fn host_hash() -> u32 {
    unsafe { HASH }
}

#[no_mangle]
pub extern "C" fn host_quanta() -> u32 {
    unsafe { QUANTA }
}

#[no_mangle]
pub extern "C" fn host_faults() -> u32 {
    unsafe { FAULTS }
}

/// Resets the running state (not the bindings).
#[no_mangle]
pub extern "C" fn host_reset() {
    unsafe {
        QUANTA = 0;
        FAULTS = 0;
        HASH = 0x811c_9dc5;
        PHASE = 0;
    }
}
