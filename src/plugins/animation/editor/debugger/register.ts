// Editor registration seam: debugger (T52, T60). Registers the live debugger: graph overlay, why-not transitions, live parameters, the recorder.
// The editor half's `activate()` (`../index.ts`) calls it once per activation. It installs the source the graph editor
// reads (`source.ts`'s `liveDebugSource`): the play session's (`localSource.ts`) while the editor plays, else the build
// the debug link's menu picked (`linkSource.ts`, ADR 0376), else the play session's again (off until Play); a take the
// graph editor opened (`takeControl.ts`, `takeSource.ts`, ADR 0348) wins over all of them until it is closed. The local
// source ends its recording when a play session ends. The graph editor (`../graphEditor/AnimGraphEditor.tsx`) shows the
// debugger while the source is live.
import { effect, signal } from "@preact/signals";
import { editor, editorDebugLink, type EditorPluginContext } from "../../../../editor/sdk";
import type { AnimationEditorIntegrations } from "../registration";
import { createLinkSource, type LinkDebugSource } from "./linkSource";
import { createLocalSource } from "./localSource";
import { liveDebugSource } from "./source";
import { closeTake, openedTake } from "./takeControl";

/** The previous activation's effects and link source, ended by the next one. */
let previousEffects: (() => void)[] = [];

/** @internal */
export function registerDebugger(_context: EditorPluginContext, _on: AnimationEditorIntegrations): void {
  // A previous activation's sources end their recordings and subscriptions.
  for (const stop of previousEffects) stop();
  previousEffects = [];
  const previous = liveDebugSource.peek();
  if (previous && "dispose" in previous) (previous as { dispose(): void }).dispose();
  const local = createLocalSource({
    worlds: () => editor.scene.playWorlds, // tracks: the graph editor shows the debugger when play starts
    paused: () => editor.scene.playPaused,
    liveNode: () => editor.scene.selection.live(),
    redraw: () => editor.scene.redrawPlay(),
  });
  const linked = signal<LinkDebugSource | null>(null);
  previousEffects.push(
    // A new or ended play session: the recorder's Animator is gone with the old Worlds.
    effect(() => {
      void editor.scene.playWorlds;
      local.dispose();
    }),
    // The build the debug link's menu picked (ADR 0376): a source over its animation topic.
    effect(() => {
      const build = editorDebugLink().active.value;
      linked.peek()?.dispose();
      linked.value = build ? createLinkSource({ name: build.name, peer: build.peer }) : null;
    }),
    // A take opened for debugging (ADR 0348, T73) shows instead of the game, until it is closed.
    effect(() => {
      const playing = editor.scene.playWorlds.length > 0;
      const take = openedTake.value?.source;
      liveDebugSource.value = take ?? (!playing && linked.value ? linked.value : local);
    }),
    () => {
      closeTake();
      linked.peek()?.dispose();
      local.dispose();
    },
  );
}
