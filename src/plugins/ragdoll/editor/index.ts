// The Ragdoll plugin's editor half (ADR 0133, 0373, 0375): the ragdoll builder (T55, `builder/register.ts`). Editor
// code: the runtime half never imports it.
import type { EditorPlugin } from "../../../editor/sdk";
import { ragdollManifest } from "../manifest";
import { registerRagdollBuilder } from "./builder/register";

export const ragdollEditorPlugin: EditorPlugin = {
  manifest: ragdollManifest,
  activate(context) {
    registerRagdollBuilder(context); // T55
  },
};
