// Editor registration seam: the ragdoll builder (ADR 0373, 0375; T55). Generates bodies and limits from bone lengths and
// the skeleton profile's joint ranges (`generateRagdollBones` in the runtime half), edits them with gizmos, test drop.
// The editor half's `activate()` (`../index.ts`) calls it once per activation; empty until T55.
import type { EditorPluginContext } from "../../../../editor/sdk";

/** @internal */
export function registerRagdollBuilder(_context: EditorPluginContext): void {}
