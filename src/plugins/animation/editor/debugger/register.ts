// Editor registration seam: debugger (T52). Registers the live debugger: graph overlay, why-not transitions, live parameters, the recorder.
// The editor half's `activate()` (`../index.ts`) calls it once per activation. It installs the play session's source
// (`localSource.ts`) as the one the graph editor reads (`source.ts`'s `liveDebugSource`), and ends its recording when a
// play session ends. The graph editor (`../graphEditor/AnimGraphEditor.tsx`) shows the debugger while the game runs.
import { effect } from "@preact/signals";
import { editor, type EditorPluginContext } from "../../../../editor/sdk";
import type { AnimationEditorIntegrations } from "../registration";
import { createLocalSource } from "./localSource";
import { liveDebugSource } from "./source";

/** @internal */
export function registerDebugger(_context: EditorPluginContext, _on: AnimationEditorIntegrations): void {
  // A previous activation's source ends its recording.
  const previous = liveDebugSource.peek();
  if (previous && "dispose" in previous) (previous as { dispose(): void }).dispose();
  const source = createLocalSource({
    worlds: () => editor.scene.playWorlds, // tracks: the graph editor shows the debugger when play starts
    paused: () => editor.scene.playPaused,
    liveNode: () => editor.scene.selection.live(),
    redraw: () => editor.scene.redrawPlay(),
  });
  liveDebugSource.value = source;
  // A new or ended play session: the recorder's Animator is gone with the old Worlds.
  effect(() => {
    void editor.scene.playWorlds;
    source.dispose();
  });
}
