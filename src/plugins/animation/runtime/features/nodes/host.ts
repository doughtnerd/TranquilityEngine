// The core's host function for third-party nodes (ADR 0370 "Third-party graph and rig nodes"; T45t). The animation core
// can't instantiate another wasm module, so a plugin node calls the imported `mycoAnimPluginHost.call(record)` (a global
// the core's glue reads, `anim-wasm/src/plugin.rs`) with a `PLUGIN_CALL` record in its memory; this answers it by the
// record's module handle, through the module the loader bound to that handle (`./module.ts` does the copies, the fuel and
// the fault handling). Page-wide, as the core is: installed the first time a module is bound, before any evaluate can
// reach a plugin node. Internal to the animation plugin.
import type { AnimationCore } from "../../core/AnimationCore";
import { FAULT_NO_MODULE, PLUGIN_CALL } from "../../wasm/wire/plugin";
import type { NodeModule } from "./module";

/** Core module handle → the module answering for it, and its project path (for warnings). */
const bound = new Map<number, { readonly module: NodeModule; readonly path: string }>();
let memory: (() => ArrayBuffer) | null = null;

const host = {
  call(record: number): number {
    const buffer = memory?.();
    if (!buffer) return FAULT_NO_MODULE;
    const handle = new DataView(buffer).getUint32(record + PLUGIN_CALL.fields.module.offset, true);
    const entry = bound.get(handle);
    return entry ? entry.module.call(buffer, record) : FAULT_NO_MODULE;
  },
};

/** @internal Answers the core's calls for module `handle` (from `plugin_register` in `core`) with `module`. */
export function bindNodeModule(core: AnimationCore, handle: number, module: NodeModule, path: string): void {
  memory = () => core.buffer();
  bound.set(handle, { module, path });
  (globalThis as { mycoAnimPluginHost?: typeof host }).mycoAnimPluginHost = host;
}

/** @internal The module bound to a core module handle, with its path, or undefined. */
export function boundNodeModule(handle: number): { readonly module: NodeModule; readonly path: string } | undefined {
  return bound.get(handle);
}
