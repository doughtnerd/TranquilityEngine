// Third-party node faults after each evaluate (ADR 0370: "faults pass the input pose through and report once"; T45t).
// The core reports a node instance's first fault as a `PLUGIN_FAULT` record (cleared by the next `write_inputs`) and keeps
// trying the node every frame; this turns each record into one warning per node instance, naming the module, the node
// kind and why it failed (`./module.ts` remembers a trap's reason: out of its budget, or another trap).
// Internal to the animation plugin.
import type { AnimationFrame } from "../../stages/frame";
import { FAULT_HOST_THREW, FAULT_MISMATCH, FAULT_NO_HOST, FAULT_NO_MODULE, FAULT_NO_ROOM, FAULT_NOT_FINITE, FAULT_TRAP, PLUGIN_FAULT } from "../../wasm/wire/plugin";
import type { RecordFields } from "../../core/records";
import { boundNodeModule } from "./host";

const REASONS: Readonly<Record<number, string>> = {
  1: "the module has no node of that kind",
  2: "the module refused the call's arguments",
  [FAULT_TRAP]: "it trapped",
  [FAULT_NO_MODULE]: "its module isn't loaded",
  [FAULT_MISMATCH]: "the graph was compiled for another version of the module (state size or inputs differ)",
  [FAULT_NO_ROOM]: "the call didn't fit its buffers",
  [FAULT_NO_HOST]: "no node host is installed",
  [FAULT_HOST_THREW]: "the node host failed",
  [FAULT_NOT_FINITE]: "it wrote a non-finite value into the pose",
};

/** Node instances already warned about (graph instance handle, node index, module handle). */
const reported = new Set<string>();
const record = {} as RecordFields<typeof PLUGIN_FAULT>;

/** @internal The `animation.Apply` part: one warning per faulted node instance (see the file header). */
export function reportNodeFaults(frame: AnimationFrame): void {
  const core = frame.core.core;
  const n = core.pluginFaultCount();
  for (let i = 0; i < n; i++) {
    const f = core.pluginFault(i, record);
    const key = `${f.instance}:${f.node}:${f.module}`;
    if (reported.has(key)) continue;
    reported.add(key);
    const bound = boundNodeModule(f.module);
    const name = bound?.module.descriptor.nodes.find((d) => d.kind === f.kind)?.name ?? `kind ${f.kind}`;
    const trap = bound?.module.lastTrap;
    const why = f.status === FAULT_TRAP && trap ? trap.message : (REASONS[f.status] ?? `status ${f.status}`);
    console.warn(`[myco] animation: the plugin node "${name}" (${bound ? `module ${bound.path}, ` : ""}graph node ${f.node}) failed: ${why}. It passes its input pose through and is tried again each frame.`);
  }
  const dropped = core.pluginFaultsDropped();
  if (dropped > 0 && !reported.has("dropped")) {
    reported.add("dropped");
    console.warn(`[myco] animation: ${dropped} more plugin node faults this frame weren't reported (the report buffer is full).`);
  }
}
