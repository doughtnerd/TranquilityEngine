// Registration seam: bones (T32). Bone overrides (`Animator.bone`, `../bones.ts`) need nothing registered per activation:
// a World gets a post-propagation hook (`World._afterPropagation`) only while it has overrides waiting, and
// BoneAttachments' follow pass applies them first. `activate()` (`../../index.ts`) calls it once per activation.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerBones(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
