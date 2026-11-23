// The clip compile pipeline's registration seam (T19; ADR 0370, 0371): Project Settings > Animation (the compression
// profile clips inherit from), and one compile service per open project, which the runtime asks for compiled clips
// (`setCompiledClipSource`) and which compiles clips again when their files change. Its cache is `.myco/anim/` in a
// writable project folder, memory otherwise; unused cached clips are pruned when the editor is idle after a project opens.
import { effect } from "@preact/signals";
import { animationSettingsOf } from "../../../../engine/animation/compile/settings";
import { Assets } from "../../../../engine/scene/Assets";
import type { EditorPluginContext } from "../../../../editor/sdk";
import type { EditorProject } from "../../../../editor/projects";
import { currentProject } from "../../../../editor/state";
import { setCompiledClipSource } from "../../runtime/features/clipSources";
import type { AnimationEditorIntegrations } from "../registration";
import { ClipCompileCache, memoryClipStore, projectClipStore } from "./cache";
import { animationSettings } from "./compressionSettingsModel";
import { workerRunner } from "./runner";
import { ClipCompileService } from "./service";

let current: { project: EditorProject; service: ClipCompileService } | null = null;
let watching = false;

/** @internal The open project's compile service (null with no project): the API the Asset Inspector (T54) calls. */
export function clipCompileService(): ClipCompileService | null {
  return current?.service ?? null;
}

function serviceFor(project: EditorProject): ClipCompileService {
  const store = project.canSave && project.root && project.fileSystem ? projectClipStore(project.fileSystem, project.root) : memoryClipStore();
  const settings = () => {
    try {
      return animationSettingsOf(JSON.parse(project.textOf("project.json") ?? "{}"));
    } catch {
      return animationSettingsOf(project.settings);
    }
  };
  return new ClipCompileService(new ClipCompileCache(store, workerRunner), { platform: () => Assets.platform, settings, warn: (m) => console.warn(m) });
}

export function registerCompile(context: EditorPluginContext, _on: AnimationEditorIntegrations): void {
  context.registerProjectSettingsSection({
    id: "animation",
    title: "Animation",
    keys: [animationSettings.key],
    problems: animationSettings.problems,
    view: () => import("./CompressionSettingsSection").then((m) => m.CompressionSettingsSection),
  });
  if (watching) return;
  // Page-wide, once: the open project's service follows `currentProject` (editor plugins have no deactivation hook).
  watching = true;
  effect(() => {
    const project = currentProject.value;
    if (current?.project === project) return;
    current = project ? { project, service: serviceFor(project) } : null;
    setCompiledClipSource(current?.service ?? null);
    const service = current?.service;
    if (service) {
      const idle = (globalThis as { requestIdleCallback?: (f: () => void) => void }).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 2000));
      idle(() => void service.prune().catch(() => 0));
    }
  });
  Assets.onChanged((path) => void current?.service.refresh(path));
}
