//! Feature `plugin`: third-party node modules: registration, the imported host call, fault reports
//! (wire family `plugin`, whose module documents the call). Filled by T45 (core half).
//!
//! - `plugin_register(descriptor)`: the module's descriptor blob (`anim-plugin-sdk::descriptor`,
//!   checked by its parser) becomes an arena asset ([`PluginModule`]: each node kind's inputs,
//!   state size, skeleton flag and default parameter block); the handle is what the graph binds
//!   (`graph_bind`) and what the host call names. Registration also grows the call buffers
//!   (load time) to [`MAX_NESTING`] frames of the largest kind at the init's `max_bones`, so
//!   evaluation never allocates.
//! - The arena is the graph's [`PluginHost`]: [`PluginHost::call`] writes a `PluginCall` record and
//!   calls the host's `mycoAnimPluginHost.call(record)` (a wasm-bindgen import from a JavaScript
//!   namespace the Phase B host provides; Node tests set it). Off wasm there is no host and every
//!   call faults with `FAULT_NO_HOST`, which native tests use for the fault path; the success path
//!   is tested through `anim-graph`'s interface with a native host.
//! - Fault reports: each node instance's first fault, as `PluginFault` records (cleared by
//!   `write_inputs`).

use core::cell::{Cell, RefCell};

use anim_graph::plugin::{Call, CallBuffers, Fault, NodeInfo, PluginHost};
use anim_plugin_sdk::abi::{state_stride, BONE_FLOATS};
use anim_plugin_sdk::descriptor::Descriptor;
use anim_wire::core::{Init, STATUS_BAD_ASSET, STATUS_NOT_INITIALIZED};
use anim_wire::plugin::{PluginCall, PluginFault, PLUGIN_FAULT_CAPACITY};
use anim_wire::WireRecord;
use wasm_bindgen::prelude::wasm_bindgen;

use crate::assets::{Arena, Asset};
use crate::init::{with, Core};

/// Plugin nodes nested in one pull (a plugin node's input sub-graph holding another) that the call
/// buffers hold; deeper ones fault with `FAULT_NO_ROOM`.
pub const MAX_NESTING: usize = 4;

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]):
/// the fault buffer and the call record (the call buffers grow with registrations).
pub(crate) fn bytes_needed(_init: &Init) -> u64 {
    (PLUGIN_FAULT_CAPACITY as u64 + 1) * PluginFault::STRIDE as u64
}

/// One node kind of a registered module.
#[derive(Clone, Copy, Debug)]
struct KindEntry {
    kind: u32,
    inputs: u32,
    state_bytes: u32,
    needs_skeleton: bool,
    /// Its default block in [`PluginModule::defaults`].
    defaults: (usize, usize),
}

/// A registered node module.
pub struct PluginModule {
    kinds: Vec<KindEntry>,
    defaults: Vec<u32>,
}

impl PluginModule {
    fn parse(bytes: &[u8]) -> Option<PluginModule> {
        let d = Descriptor::parse(bytes).ok()?;
        let mut kinds = Vec::with_capacity(d.node_count());
        let mut defaults = Vec::new();
        for n in d.nodes() {
            let first = defaults.len();
            for p in n.params().checked() {
                defaults.extend_from_slice(&p.default[..p.kind.words()]);
            }
            kinds.push(KindEntry {
                kind: n.kind,
                inputs: n.inputs as u32,
                state_bytes: n.state_bytes,
                needs_skeleton: n.needs_skeleton(),
                defaults: (first, defaults.len()),
            });
        }
        Some(PluginModule { kinds, defaults })
    }

    fn kind(&self, kind: u32) -> Option<&KindEntry> {
        self.kinds.iter().find(|k| k.kind == kind)
    }
}

/// The host side's per-arena state: call buffers, fault reports, the instance being evaluated,
/// the call record.
pub struct Runtime {
    buffers: RefCell<CallBuffers>,
    faults: RefCell<Vec<u8>>,
    fault_count: Cell<usize>,
    faults_dropped: Cell<u32>,
    instance: Cell<u32>,
    record: RefCell<Vec<u8>>,
}

impl Default for Runtime {
    fn default() -> Self {
        Runtime::new()
    }
}

impl Runtime {
    /// Empty buffers, room for [`PLUGIN_FAULT_CAPACITY`] fault reports.
    pub fn new() -> Runtime {
        Runtime {
            buffers: RefCell::new(CallBuffers::default()),
            faults: RefCell::new(vec![
                0;
                PLUGIN_FAULT_CAPACITY as usize * PluginFault::STRIDE as usize
            ]),
            fault_count: Cell::new(0),
            faults_dropped: Cell::new(0),
            instance: Cell::new(0),
            record: RefCell::new(vec![0; PluginCall::STRIDE as usize]),
        }
    }

    /// Clears the fault reports (every `write_inputs`).
    pub fn begin_frame(&self) {
        self.fault_count.set(0);
        self.faults_dropped.set(0);
    }

    /// The instance whose faults follow (`evaluate`, per instance).
    pub fn set_instance(&self, handle: u32) {
        self.instance.set(handle);
    }

    fn push_fault(&self, f: PluginFault) {
        let stride = PluginFault::STRIDE as usize;
        let n = self.fault_count.get();
        let mut bytes = self.faults.borrow_mut();
        match bytes.get_mut(n * stride..(n + 1) * stride) {
            Some(out) => {
                let _ = f.encode_into(out);
                self.fault_count.set(n + 1);
            }
            None => self
                .faults_dropped
                .set(self.faults_dropped.get().saturating_add(1)),
        }
    }
}

/// A slice's byte offset in memory, or 0 for an empty one.
fn ptr<T>(s: &[T]) -> u32 {
    if s.is_empty() {
        0
    } else {
        s.as_ptr() as usize as u32
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    /// The Phase B host: runs the `PluginCall` record at `record` (a byte offset in this module's
    /// memory) and returns its status.
    #[wasm_bindgen(catch, js_namespace = mycoAnimPluginHost, js_name = call)]
    fn host_call(record: u32) -> Result<u32, wasm_bindgen::JsValue>;
}

impl PluginHost for Arena {
    fn node(&self, module: u32, kind: u32) -> Option<NodeInfo<'_>> {
        let Ok(Asset::Plugin(m)) = self.get(module) else {
            return None;
        };
        let k = m.kind(kind)?;
        Some(NodeInfo {
            inputs: k.inputs,
            state_bytes: k.state_bytes,
            needs_skeleton: k.needs_skeleton,
            defaults: &m.defaults[k.defaults.0..k.defaults.1],
        })
    }

    fn buffers(&self) -> &RefCell<CallBuffers> {
        &self.plugin_rt.buffers
    }

    fn call(&self, call: Call<'_>) -> u32 {
        let state_bytes = self
            .node(call.module, call.kind)
            .map_or(0, |n| n.state_bytes);
        let record = PluginCall {
            module: call.module,
            kind: call.kind,
            count: 1,
            bones: call.bones,
            inputs: call.inputs,
            param_words: call.params.len() as u32,
            state_bytes,
            parents: ptr(call.parents),
            input: ptr(call.input),
            output: ptr(call.output),
            params: ptr(call.params),
            state: ptr(call.state),
            dt: call.dt,
        };
        let mut buf = self.plugin_rt.record.borrow_mut();
        let _ = record.encode_into(&mut buf);
        #[cfg(target_arch = "wasm32")]
        {
            match host_call(ptr(&buf)) {
                Ok(status) => status,
                Err(_) => anim_wire::plugin::FAULT_HOST_THREW,
            }
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            anim_wire::plugin::FAULT_NO_HOST
        }
    }

    fn fault(&self, f: Fault) {
        self.plugin_rt.push_fault(PluginFault {
            instance: self.plugin_rt.instance.get(),
            node: f.node,
            module: f.module,
            kind: f.kind,
            status: f.status,
        });
    }
}

fn register(arena: &mut Arena, max_bones: usize, bytes: &[u8]) -> Result<u32, u32> {
    let module = PluginModule::parse(bytes).ok_or(STATUS_BAD_ASSET)?;
    let mut need = (0usize, 0usize);
    for k in &module.kinds {
        let floats = (k.inputs as usize + 1) * max_bones * BONE_FLOATS;
        let words = (k.defaults.1 - k.defaults.0) + state_stride(k.state_bytes as usize) / 4;
        need = (need.0.max(floats), need.1.max(words));
    }
    let h = arena.insert(Asset::Plugin(module))?;
    arena
        .plugin_rt
        .buffers
        .borrow_mut()
        .reserve(MAX_NESTING * need.0, MAX_NESTING * need.1);
    Ok(h)
}

impl Core {
    /// Registers a node module by its descriptor blob; returns the module handle, or 0 (see
    /// `last_status`: `STATUS_BAD_ASSET` for a blob the SDK's parser refuses).
    pub fn plugin_register(&mut self, descriptor: &[u8]) -> u32 {
        if !self.started {
            return self.handle(Err(STATUS_NOT_INITIALIZED));
        }
        let r = register(&mut self.arena, self.max_bones, descriptor);
        self.handle(r)
    }

    /// The fault reports since the last `write_inputs` (`PluginFault` records).
    pub fn plugin_faults(&self) -> Vec<u8> {
        let n = self.arena.plugin_rt.fault_count.get() * PluginFault::STRIDE as usize;
        self.arena.plugin_rt.faults.borrow()[..n].to_vec()
    }

    /// Fault reports dropped since the last `write_inputs` because the buffer was full.
    pub fn plugin_faults_dropped(&self) -> u32 {
        self.arena.plugin_rt.faults_dropped.get()
    }
}

/// Registers a node module by its descriptor blob (copied in); returns its handle, or 0.
#[wasm_bindgen]
pub fn plugin_register(descriptor: &[u8]) -> u32 {
    with(|c| c.plugin_register(descriptor))
}

/// The fault reports' byte offset in memory (`plugin` family `PluginFault` records).
#[wasm_bindgen]
pub fn plugin_faults_ptr() -> u32 {
    with(|c| ptr(&c.arena.plugin_rt.faults.borrow()))
}

/// Fault reports waiting (since the last `write_inputs`).
#[wasm_bindgen]
pub fn plugin_fault_count() -> u32 {
    with(|c| c.arena.plugin_rt.fault_count.get() as u32)
}

/// Fault reports dropped since the last `write_inputs`.
#[wasm_bindgen]
pub fn plugin_faults_dropped() -> u32 {
    with(|c| c.plugin_faults_dropped())
}
