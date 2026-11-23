// Registration seam: attachments (T17). Registers the post-propagation hook that moves BoneAttachments onto their bones.
// `activate()` (`../../index.ts`) calls it once per activation; empty until T17.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerAttachments(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
