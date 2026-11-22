//! ADR 0338 §5 (ABI 5.0), amended by 0344 §3: plugin effects in the core's chains, through `scheduler::submit` and
//! `Core::process`, with the native `myco_ext` registry (`audio_core::ext::install`) standing in for the worklet glue.
//!
//! - a plugin slot on a bus calls the import and processes; its 16 parameters reach the call;
//! - a fault status passes the block dry;
//! - the buses' plugin calls share one quantum's fuel: past it, a call gets no fuel and the block passes dry;
//! - a submix runs a plugin effect at its level; freeing the slot releases its instance (the sweep);
//! - a parameter edit glides between the block edges (`p0` to `p1`), a stepped one steps.

mod common;

use std::cell::RefCell;
use std::rc::Rc;

use audio_core::ext::{self, Host};
use audio_wire::generated as wire;
use common::*;

const V1: u32 = 0x0001_0001;
const E: u32 = 3;
const PLUGIN: u32 = wire::FX_PLUGIN_BASE + E;
/// The DC voice's level on the bus (a non-spatial mono voice plays at unity in both channels).
const DRY: f32 = 1.0;

/// What the stand-in host saw.
#[derive(Default)]
struct Seen {
    acquired: Vec<u32>,
    released: Vec<u32>,
    /// Per call: (handle, p0, p1, flags, fuel).
    calls: Vec<(u32, [f32; 16], [f32; 16], u32, u32)>,
    /// The handles the last complete sweep listed.
    swept: Vec<u32>,
    partial: Vec<u32>,
    next: u32,
}

/// A gain plugin: multiplies by `p1[0]` and uses all its grant; `fault` makes every call fail.
struct GainHost {
    seen: Rc<RefCell<Seen>>,
    budget: u32,
    modes: u32,
    fault: Rc<RefCell<bool>>,
    /// The module isn't loaded: no instance, and `describe` knows nothing yet.
    loading: Rc<RefCell<bool>>,
    /// The next `process` answers `STALE` (the module was reloaded).
    stale: Rc<RefCell<bool>>,
}

impl Host for GainHost {
    fn acquire(&mut self, e: u32) -> u32 {
        if e != E || *self.loading.borrow() {
            return 0;
        }
        let mut s = self.seen.borrow_mut();
        s.next += 1;
        let h = 100 + s.next;
        s.acquired.push(h);
        h
    }
    fn release(&mut self, handle: u32) {
        self.seen.borrow_mut().released.push(handle);
    }
    fn describe(&mut self, _e: u32, what: u32) -> u32 {
        if *self.loading.borrow() {
            0
        } else if what == ext::DESCRIBE_BUDGET {
            self.budget
        } else {
            self.modes
        }
    }
    fn process(&mut self, handle: u32, l: &mut [f32], r: &mut [f32], p0: &[f32; 16], p1: &[f32; 16], flags: u32, fuel: u32) -> i32 {
        self.seen.borrow_mut().calls.push((handle, *p0, *p1, flags, fuel));
        if self.stale.replace(false) {
            return ext::STALE;
        }
        if *self.fault.borrow() || fuel == 0 {
            return -1;
        }
        for x in l.iter_mut().chain(r.iter_mut()) {
            *x *= p1[0];
        }
        (fuel << 1) as i32
    }
    fn sweep(&mut self, handles: &[u32], last: bool) {
        let mut s = self.seen.borrow_mut();
        s.partial.extend_from_slice(handles);
        if last {
            s.swept = core::mem::take(&mut s.partial);
        }
    }
}

struct Rig {
    m: Mixer,
    seen: Rc<RefCell<Seen>>,
    fault: Rc<RefCell<bool>>,
    loading: Rc<RefCell<bool>>,
    stale: Rc<RefCell<bool>>,
}

impl Drop for Rig {
    fn drop(&mut self) {
        ext::install(None);
    }
}

fn rig(budget: u32, modes: u32) -> Rig {
    let seen = Rc::new(RefCell::new(Seen::default()));
    let fault = Rc::new(RefCell::new(false));
    let loading = Rc::new(RefCell::new(false));
    let stale = Rc::new(RefCell::new(false));
    ext::install(Some(Box::new(GainHost { seen: seen.clone(), budget, modes, fault: fault.clone(), loading: loading.clone(), stale: stale.clone() })));
    let mut m = Mixer::new(4);
    m.set_lookahead(0.0);
    Rig { m, seen, fault, loading, stale }
}

fn p16(v: &[f32]) -> [f32; 16] {
    let mut p = [0.0; 16];
    p[..v.len()].copy_from_slice(v);
    p
}

/// A plugin effect on a bus, its parameters `p`.
fn bus_plugin(p: &[f32]) -> wire::BusConfigBusesEffects {
    wire::BusConfigBusesEffects { type_: wire::BUS_FX_CATALOGUE + PLUGIN, p: p16(p) }
}

fn tree(effects: Vec<wire::BusConfigBusesEffects>) -> Rec {
    Rec::Config(wire::BusConfig { voice_id: 0, frame_offset: wire::ASAP, buses: vec![wire::BusConfigBuses { parent: ROOT, effects }] })
}

fn last_left(m: &mut Mixer) -> f32 {
    let (l, _) = m.render();
    l[127]
}

#[test]
fn a_bus_plugin_slot_calls_the_import_with_its_16_parameters_and_processes() {
    let mut r = rig(200, 0);
    let mut p = vec![0.5f32];
    p.extend((1..16).map(|i| i as f32));
    r.m.submit(&[tree(vec![bus_plugin(&p)]), dc(V1, 0, 0.0)]);
    assert_eq!(r.seen.borrow().acquired, [101], "acquired where the slot was configured");
    let out = last_left(&mut r.m);
    let s = r.seen.borrow();
    let (h, p0, p1, flags, fuel) = s.calls[0];
    assert_eq!(h, 101);
    assert_eq!(p1, p16(&p), "all 16 parameters reach the call");
    assert_eq!(p0, p1, "an effect that hasn't run takes its parameters at once");
    assert_eq!(flags, wire::FX_PLUGIN_FLAG_PARAMS | wire::FX_PLUGIN_FLAG_RESET, "the first block: changed, reset");
    assert_eq!(fuel, 200 * 128, "its budget times the frames");
    // A mono voice of DC 1.0, then the plugin's ×0.5.
    assert!((out - 0.5 * DRY).abs() < 1e-4, "{out}");
    drop(s);
    last_left(&mut r.m);
    assert_eq!(r.seen.borrow().calls[1].3, 0, "a settled block: no flags");
}

#[test]
fn a_fault_status_passes_the_block_dry() {
    let mut r = rig(200, 0);
    r.m.submit(&[tree(vec![bus_plugin(&[0.25])]), dc(V1, 0, 0.0)]);
    let wet = last_left(&mut r.m);
    *r.fault.borrow_mut() = true;
    let dry = last_left(&mut r.m);
    assert!((wet - 0.25 * DRY).abs() < 1e-4, "{wet}");
    assert!((dry - DRY).abs() < 1e-4, "the fault left the block dry: {dry}");
    *r.fault.borrow_mut() = false;
    assert!((last_left(&mut r.m) - wet).abs() < 1e-6, "the next good block is wet again");
}

#[test]
fn the_buses_share_one_quantums_fuel_and_a_call_past_it_passes_dry() {
    // 1,000 instructions a frame each: five calls use the level's 5,000 a frame; the sixth to eighth get none.
    let mut r = rig(1_000, 0);
    let fx = (0..8).map(|_| bus_plugin(&[0.5])).collect();
    r.m.submit(&[tree(fx), dc(V1, 0, 0.0)]);
    let out = last_left(&mut r.m);
    let grants: Vec<u32> = r.seen.borrow().calls.iter().map(|c| c.4).collect();
    assert_eq!(grants, [128_000, 128_000, 128_000, 128_000, 128_000, 0, 0, 0]);
    assert_eq!(wire::FX_PLUGIN_FUEL_PER_FRAME, 5_000);
    // Five halvings ran; the starved three passed dry.
    assert!((out - DRY / 32.0).abs() < 1e-5, "{out}");
    r.seen.borrow_mut().calls.clear();
    last_left(&mut r.m);
    let grants: Vec<u32> = r.seen.borrow().calls.iter().map(|c| c.4).collect();
    assert_eq!(&grants[..5], [128_000; 5], "every quantum starts with the full fuel again");
}

#[test]
fn a_submix_runs_a_plugin_at_its_level_and_freeing_it_releases_the_instance() {
    let mut r = rig(100, 0);
    let submix = |n: usize| {
        let s = wire::Submix {
            voice_id: 2,
            frame_offset: wire::ASAP,
            group: 7,
            bus: 0,
            parent: 0,
            reserved: 0,
            effects: (0..n).map(|_| wire::SubmixEffects { type_: PLUGIN, flags: wire::SUBMIX_FX_ON, p: p16(&[0.5]) }).collect(),
        };
        let mut b = vec![0u8; 1024];
        let len = s.write(&mut b, 0).unwrap();
        b.truncate(len);
        Rec::Raw(b)
    };
    let Rec::Play(mut play) = dc(V1, 0, 0.0) else { unreachable!() };
    play.group = 7;
    r.m.submit(&[tree(vec![]), submix(1), Rec::Play(play)]);
    let out = last_left(&mut r.m);
    assert!((out - 0.5 * DRY).abs() < 1e-4, "{out}");
    assert_eq!(r.seen.borrow().swept, [101], "the sweep after the configure lists the held instance");
    r.m.submit(&[submix(0)]);
    assert!(r.seen.borrow().swept.is_empty(), "the freed slot's instance isn't held any more");
    assert!((last_left(&mut r.m) - DRY).abs() < 1e-4, "the voice is back on its bus, dry");
}

#[test]
fn a_kind_change_releases_the_instance_and_an_edit_glides_between_block_edges() {
    // Parameter 1 glides in log2, parameter 2 steps.
    let mut r = rig(100, (1 << 1) | (1 << (16 + 2)));
    r.m.submit(&[tree(vec![bus_plugin(&[1.0, 100.0, 0.0])]), dc(V1, 0, 0.0)]);
    last_left(&mut r.m);
    r.m.submit(&[tree(vec![bus_plugin(&[1.0, 400.0, 2.0])])]);
    last_left(&mut r.m);
    {
        let s = r.seen.borrow();
        let (_, p0, p1, flags, _) = *s.calls.last().unwrap();
        assert_eq!(flags & wire::FX_PLUGIN_FLAG_PARAMS, wire::FX_PLUGIN_FLAG_PARAMS);
        assert_eq!(p0[1], 100.0, "the block starts where the glide starts");
        // Two octaves over 960 frames: one block moves 2 × 128 / 960 octaves.
        let want = 100.0 * (2.0f32 * 128.0 / 960.0).exp2();
        assert!((p1[1] - want).abs() < 0.01, "{} vs {want}", p1[1]);
        assert_eq!((p0[2], p1[2]), (2.0, 2.0), "a stepped parameter steps at the block's start");
    }
    // Another type in the slot: the instance goes back.
    r.m.submit(&[tree(vec![wire::BusConfigBusesEffects { type_: wire::BUS_FX_CATALOGUE + wire::SUBMIX_FX_GAIN, p: p16(&[-6.0]) }])]);
    assert_eq!(r.seen.borrow().released, [101]);
    assert!(r.seen.borrow().swept.is_empty());
}

#[test]
fn a_slot_configured_before_its_module_loaded_gets_an_instance_and_budget_once_it_has() {
    let mut r = rig(300, 0);
    *r.loading.borrow_mut() = true;
    r.m.submit(&[tree(vec![bus_plugin(&[0.5])]), dc(V1, 0, 0.0)]);
    assert!((last_left(&mut r.m) - DRY).abs() < 1e-6, "no instance yet: dry");
    assert!(r.seen.borrow().calls.is_empty(), "and no call");
    *r.loading.borrow_mut() = false;
    let out = last_left(&mut r.m);
    assert!((out - 0.5 * DRY).abs() < 1e-4, "{out}");
    let s = r.seen.borrow();
    assert_eq!((s.calls[0].0, s.calls[0].4), (101, 300 * 128), "the instance and the budget it reads on acquiring");
}

#[test]
fn a_stale_handle_is_forgotten_and_the_slot_asks_for_a_new_instance() {
    let mut r = rig(100, 0);
    r.m.submit(&[tree(vec![bus_plugin(&[0.5])]), dc(V1, 0, 0.0)]);
    last_left(&mut r.m);
    *r.stale.borrow_mut() = true;
    assert!((last_left(&mut r.m) - DRY).abs() < 1e-6, "the stale block passes dry");
    assert!((last_left(&mut r.m) - 0.5 * DRY).abs() < 1e-4);
    assert_eq!(r.seen.borrow().acquired, [101, 102], "a new instance");
}

#[test]
fn a_stepped_parameter_set_alone_flags_its_block_as_changed() {
    let mut r = rig(100, 1 << 16);
    r.m.submit(&[tree(vec![bus_plugin(&[0.0])]), dc(V1, 0, 0.0)]);
    last_left(&mut r.m);
    last_left(&mut r.m);
    r.m.submit(&[tree(vec![bus_plugin(&[1.0])])]);
    last_left(&mut r.m);
    last_left(&mut r.m);
    let s = r.seen.borrow();
    let flags: Vec<u32> = s.calls.iter().map(|c| c.3 & wire::FX_PLUGIN_FLAG_PARAMS).collect();
    assert_eq!(flags, [1, 0, 1, 0], "changed on the block the stepped value arrives in, and only then");
    assert_eq!((s.calls[2].1[0], s.calls[2].2[0]), (1.0, 1.0), "stepped: both edges at the new value");
}

#[test]
fn with_no_host_a_plugin_slot_passes_through() {
    ext::install(None);
    let mut m = Mixer::new(4);
    m.set_lookahead(0.0);
    m.submit(&[tree(vec![bus_plugin(&[0.5])]), dc(V1, 0, 0.0)]);
    assert!((last_left(&mut m) - DRY).abs() < 1e-4);
}
