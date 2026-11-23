// One third-party node module, instantiated (ADR 0370 "Third-party graph and rig nodes"; T45t). The host duties of
// `anim-plugin-sdk`'s ABI (`native/anim/crates/anim-plugin-sdk/src/abi.rs`) for a *metered* module:
//
// - **Load:** compile, refuse any import, instantiate with none, check the ABI version (`myco_node_abi_version`), read
//   the descriptor (`myco_node_describe`: the blob's length is at offset 8 of its header) and copy it out. The fuel
//   counter starts at 0 in a fresh instance (D64), so it is set before every call into the module, setup calls too.
// - **Per call** (`PLUGIN_CALL`, one record from the core): lay the call's buffers out in one block of the module's
//   memory (allocated once, and again larger when a call needs more: blocks never move or free), copy the inputs,
//   parameters, state and parent indices in, set the fuel to `budget × count + base`, evaluate, and on status 0 copy the
//   output pose and the state back into the core's memory.
// - **Faults:** a trap (out of fuel included: `myco_fuel_get() < 0`) answers `FAULT_TRAP`, and the instance, whose memory
//   may be half-written, is replaced by a fresh one before the next call. A non-zero status is answered as it is. The
//   core then passes input 0 through, keeps the state, and reports the node instance's first fault (D62, D78).
//
// No wasm type leaves this folder. Internal to the animation plugin.
import { callFuel, NODE_FUEL } from "../../../../../engine/animation/pluginNodes";
import { NODE_ABI_VERSION, readPluginDescriptor, type PluginModuleDescriptor } from "../../../../../engine/animation/pluginDescriptor";
import { FAULT_NO_ROOM, FAULT_TRAP, PLUGIN_CALL } from "../../wasm/wire/plugin";

interface NodeExports {
  readonly memory: WebAssembly.Memory;
  myco_node_abi_version(): number;
  myco_node_describe(): number;
  myco_node_alloc(bytes: number): number;
  myco_node_evaluate(kind: number, count: number, bones: number, parents: number, input: number, output: number, params: number, state: number, dt: number): number;
  myco_fuel_set(fuel: bigint): void;
  myco_fuel_get(): bigint;
}

const REQUIRED = ["memory", "myco_node_abi_version", "myco_node_describe", "myco_node_alloc", "myco_node_evaluate", "myco_fuel_set", "myco_fuel_get"] as const;
/** Fuel for setup calls (version, descriptor, allocation): generous, they run once per instance. */
const SETUP_FUEL = 1n << 32n;
/** `abi::BONE_BYTES`; state blocks are 16-aligned (`abi::state_stride`). */
const BONE_BYTES = 40;
const align16 = (n: number) => Math.ceil(n / 16) * 16;
const F = PLUGIN_CALL.fields;

/** @internal Whether `module`'s exports say it was metered (`anim-meter` adds `myco_fuel_set` and its marker). */
export function isMeteredModule(module: WebAssembly.Module): boolean {
  return WebAssembly.Module.customSections(module, "myco.metered").length > 0 || WebAssembly.Module.exports(module).some((e) => e.name === "myco_fuel_set");
}

/** @internal Why the last call faulted, for the warning. */
export interface NodeTrap {
  readonly outOfFuel: boolean;
  readonly message: string;
}

/** @internal A metered node module, instantiated, with its descriptor. */
export class NodeModule {
  /**
   * The module from metered bytes, or why it was refused: imports, missing ABI exports, no fuel counter (not metered),
   * another ABI version, a descriptor that doesn't read, or a trap in a setup call.
   */
  static async create(bytes: Uint8Array, budget: number = NODE_FUEL.default): Promise<{ readonly module: NodeModule } | { readonly error: string }> {
    let compiled: WebAssembly.Module;
    try {
      compiled = await WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>);
    } catch (err) {
      return { error: `it isn't a valid wasm module (${err instanceof Error ? err.message : String(err)})` };
    }
    const imports = WebAssembly.Module.imports(compiled);
    if (imports.length > 0) return { error: `node modules import nothing; it imports ${imports[0]!.module}.${imports[0]!.name}` };
    const names = new Set(WebAssembly.Module.exports(compiled).map((e) => e.name));
    if (!names.has("myco_fuel_set")) return { error: "it isn't metered (the editor meters project modules; builds ship them metered)" };
    const missing = REQUIRED.find((n) => !names.has(n));
    if (missing) return { error: `it doesn't export ${missing}` };
    try {
      const exports = (await WebAssembly.instantiate(compiled, {})).exports as unknown as NodeExports;
      exports.myco_fuel_set(SETUP_FUEL);
      const version = exports.myco_node_abi_version() >>> 0;
      if (version !== NODE_ABI_VERSION) return { error: `it implements node ABI ${version}; this engine calls ${NODE_ABI_VERSION}` };
      exports.myco_fuel_set(SETUP_FUEL);
      const at = exports.myco_node_describe() >>> 0;
      const buffer = exports.memory.buffer;
      if (at === 0 || at + 16 > buffer.byteLength) return { error: "its descriptor pointer is out of its memory" };
      const length = new DataView(buffer).getUint32(at + 8, true);
      if (length < 16 || at + length > buffer.byteLength) return { error: "its descriptor runs out of its memory" };
      const blob = new Uint8Array(buffer, at, length).slice();
      const read = readPluginDescriptor(blob);
      if ("error" in read) return { error: read.error };
      return { module: new NodeModule(compiled, exports, blob, read.descriptor, budget) };
    } catch (err) {
      return { error: `it trapped while loading (${err instanceof Error ? err.message : String(err)})` };
    }
  }

  /** The block the call buffers sit in, and its size (0: none yet in this instance). */
  private block = 0;
  private capacity = 0;
  /** Why the last call faulted (null after a success). */
  lastTrap: NodeTrap | null = null;

  private constructor(
    private readonly compiled: WebAssembly.Module,
    private exports: NodeExports,
    /** The descriptor blob as the module returned it (what `plugin_register` takes). */
    readonly descriptorBytes: Uint8Array,
    readonly descriptor: PluginModuleDescriptor,
    /** Fuel per node instance per call (the plugin's declared `budget`). */
    public budget: number,
  ) {}

  /** A fresh instance after a trap (synchronous: the module is compiled already, and at most 8 MiB, the meter's limit). */
  private reinstantiate(): void {
    this.exports = new WebAssembly.Instance(this.compiled, {}).exports as unknown as NodeExports;
    this.block = 0;
    this.capacity = 0;
  }

  /** At least `bytes` of call buffer in the module's memory; 0 when the module can't give them. */
  private room(bytes: number): number {
    if (bytes <= this.capacity) return this.block;
    const want = Math.max(bytes, this.capacity * 2, 4096);
    this.exports.myco_fuel_set(SETUP_FUEL);
    const at = this.exports.myco_node_alloc(want) >>> 0;
    if (at === 0) return 0;
    this.block = at;
    this.capacity = want;
    return at;
  }

  /**
   * Answers the core's host call: the `PLUGIN_CALL` record at byte `record` of the core's memory `core`. Returns 0, the
   * module's non-zero status, or a `FAULT_*`.
   */
  call(core: ArrayBuffer, record: number): number {
    const view = new DataView(core);
    const u = (f: keyof typeof F) => view.getUint32(record + F[f].offset, true);
    const kind = u("kind"), count = u("count"), bones = u("bones"), inputs = u("inputs");
    const paramWords = u("paramWords"), stateBytes = u("stateBytes"), parents = u("parents");
    const dt = view.getFloat32(record + F.dt.offset, true);    const pose = bones * BONE_BYTES;
    const sizes = { input: count * inputs * pose, output: count * pose, params: count * paramWords * 4, state: count * align16(stateBytes), parents: parents ? bones * 2 : 0 };
    const total = align16(sizes.input) + align16(sizes.output) + align16(sizes.params) + sizes.state + align16(sizes.parents);
    try {
      const base = this.room(total);
      if (base === 0) return this.fault(FAULT_NO_ROOM, false, `it couldn't allocate ${total} bytes for the call`);
      let at = base;
      const place = (n: number) => {
        const p = at;
        at += align16(n);
        return p;
      };
      const p = { input: place(sizes.input), output: place(sizes.output), params: place(sizes.params), state: place(sizes.state), parents: place(sizes.parents) };
      const from = new Uint8Array(core);
      const to = new Uint8Array(this.exports.memory.buffer);
      const copyIn = (src: number, dst: number, n: number) => void (n > 0 && to.set(from.subarray(src, src + n), dst));
      copyIn(u("input"), p.input, sizes.input);
      copyIn(u("params"), p.params, sizes.params);
      copyIn(u("state"), p.state, sizes.state);
      copyIn(parents, p.parents, sizes.parents);
      const fuel = callFuel(this.budget, count);
      this.exports.myco_fuel_set(fuel);
      let status: number;
      try {
        status = this.exports.myco_node_evaluate(kind, count, bones, parents ? p.parents : 0, sizes.input ? p.input : 0, p.output, sizes.params ? p.params : 0, sizes.state ? p.state : 0, dt) >>> 0;
      } catch (err) {
        const outOfFuel = this.exports.myco_fuel_get() < 0n;
        this.reinstantiate();
        return this.fault(FAULT_TRAP, outOfFuel, outOfFuel ? `it ran out of its instruction budget (${fuel} for ${count} instance${count === 1 ? "" : "s"})` : `it trapped (${err instanceof Error ? err.message : String(err)})`);
      }
      if (status !== 0) return this.fault(status, false, `it returned status ${status}`);
      const back = new Uint8Array(this.exports.memory.buffer);
      from.set(back.subarray(p.output, p.output + sizes.output), u("output"));
      if (sizes.state > 0) from.set(back.subarray(p.state, p.state + sizes.state), u("state"));
      this.lastTrap = null;
      return 0;
    } catch (err) {
      // A trap in a setup call (allocation) or a copy out of range: the instance can't be trusted either.
      this.reinstantiate();
      return this.fault(FAULT_TRAP, false, `it trapped (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  private fault(status: number, outOfFuel: boolean, message: string): number {
    this.lastTrap = { outOfFuel, message };
    return status;
  }
}
