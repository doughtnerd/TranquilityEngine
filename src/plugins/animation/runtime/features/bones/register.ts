// Registration seam: bones (T32). Registers bone overrides written in `lateUpdate()`, applied through T17's post-propagation hook before attachments follow.
// `activate()` (`../../index.ts`) calls it once per activation; empty until T32.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerBones(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
