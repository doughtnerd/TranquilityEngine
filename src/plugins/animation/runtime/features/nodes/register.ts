// Registration seam: nodes (T45t). Third-party graph and rig nodes declared in `plugin.json` (`animationNodes`: wasm
// modules with a fuel pass) need nothing registered: a graph's modules load lazily when it is acquired
// (`./loader.ts`, from `../graph/asset.ts`), the core's host function is installed when the first module is bound
// (`./host.ts`), and faults are reported in `animation.Apply` (`../../stages/apply/nodes.ts`).
// `activate()` (`../../index.ts`) calls it once per activation.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerNodes(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
