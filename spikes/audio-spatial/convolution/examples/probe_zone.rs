// The spike's owned-buffer zone: process, incremental prep and the stagger planner.
// conv.rs is included by path, not through the lib: the lib's exported probes would end up in this wasm.
#[allow(dead_code)]
#[path = "../src/conv.rs"]
mod conv;
use conv::*;
static mut S: Option<(Scratch, Vec<Zone>, Option<Prep>)> = None;
#[no_mangle]
pub extern "C" fn probe_begin(l: *const f32, r: *const f32, frames: u32, sched: u32, units: u32) -> u32 {
    unsafe {
        let s = (*std::ptr::addr_of_mut!(S)).get_or_insert_with(|| (Scratch::new(), Vec::new(), None));
        let ir = [std::slice::from_raw_parts(l, frames as usize).to_vec(), std::slice::from_raw_parts(r, frames as usize).to_vec()];
        // The planner is not in the probe: schedules are data (the scheduler would hold a table).
        let mut p = Prep::new(ir, [(sched & 15, 15 - (sched & 7)), ((sched >> 4) & 15, 14 - ((sched >> 4) & 7))]);
        let done = p.tick(&mut s.0, units as usize);
        if done {
            s.1.push(p.zone);
        } else {
            s.2 = Some(p);
        }
        done as u32
    }
}
#[no_mangle]
pub extern "C" fn probe_tick(units: u32) -> u32 {
    unsafe {
        let s = (*std::ptr::addr_of_mut!(S)).as_mut().unwrap();
        let mut p = s.2.take().unwrap();
        let done = p.tick(&mut s.0, units as usize);
        if done {
            s.1.push(p.zone);
        } else {
            s.2 = Some(p);
        }
        done as u32
    }
}
#[no_mangle]
pub extern "C" fn probe_process(z: u32, a: *const f32, b: *const f32, o: *mut f32) {
    unsafe {
        let s = (*std::ptr::addr_of_mut!(S)).as_mut().unwrap();
        let (a, b, o) = (std::slice::from_raw_parts(a, 128), std::slice::from_raw_parts(b, 128), std::slice::from_raw_parts_mut(o, 256));
        let (ol, or) = o.split_at_mut(128);
        s.1[z as usize].process(&mut s.0, a, b, ol, or);
    }
}
