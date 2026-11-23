// The Animation plugin's editor half (ADR 0133, 0373): asset kinds and formats, scene integration, and the animation
// tools. `activate()` is written once: it calls every tool's registration seam (`<tool>/register.ts`) in a fixed order,
// so each build task fills only its own tool's file. Editor code: the runtime half never imports it.
import type { EditorPlugin, EditorPluginContext } from "../../../editor/sdk";
import { animationManifest } from "../manifest";
import { registerAnimationWindow } from "./animationWindow/register";
import { registerClipImport } from "./clipImport/register";
import { registerCompile } from "./compile/register";
import { registerDebugger } from "./debugger/register";
import { registerFormats } from "./formats/register";
import { registerGraphEditor } from "./graphEditor/register";
import { registerPoseDatabase } from "./poseDatabase/register";
import { registerProfiler } from "./profiler/register";
import type { AnimationEditorIntegrations } from "./registration";
import { registerScene } from "./scene/register";
import { registerSkeleton } from "./skeleton/register";
import { registerTimeline } from "./timeline/register";
import { registerTwoD } from "./twoD/register";

/** The tools' seams, in registration order: formats first, since the tools open their assets. */
const TOOLS: readonly ((context: EditorPluginContext, on: AnimationEditorIntegrations) => void)[] = [
  registerFormats, // T03t: asset kinds, formats, reference rewriting
  registerScene, // T18: model drops, clips on Animators, bones in the Hierarchy, bone gizmo, clip preview
  registerCompile, // T19: the clip compile pipeline (compression settings, the compile worker and cache)
  registerAnimationWindow, // T50
  registerGraphEditor, // T51
  registerDebugger, // T52
  registerTimeline, // T53
  registerSkeleton, // T54: bone map, chains, retarget
  registerClipImport, // T54: clip import settings
  registerPoseDatabase, // T55
  registerTwoD, // T56
  registerProfiler, // T34
];

export const animationEditorPlugin: EditorPlugin = {
  manifest: animationManifest,
  activate(context) {
    const on: AnimationEditorIntegrations = { physics: context.plugins.isActive("myco.physics"), audio: context.plugins.isActive("myco.audio") };
    for (const register of TOOLS) register(context, on);
  },
};
