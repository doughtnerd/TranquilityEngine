// Registration seam: attachments (T17). BoneAttachments move onto their bones in a post-propagation hook
// (`World._afterPropagation`), which `./follow.ts` adds to a World when its first BoneAttachment activates and removes
// with its last, so Worlds without attachments pay nothing. There is nothing to register per activation.
// `activate()` (`../../index.ts`) calls it once per activation.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerAttachments(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
