// What a take's source reads of the editor (ADR 0348, 0373; T73): the play session's Animators, where a take's poses are
// shown while the session is paused, and the play viewport's redraw.
import { editor } from "../../../../editor/sdk";
import { graphAnimators, graphPath } from "../../runtime/features/debug/targets";
import type { TakeSession } from "./takeSource";

export const takeSession: TakeSession = {
  animator: (graph) => graphAnimators(editor.scene.playWorlds).find((a) => graphPath(a.animator.graph) === graph)?.animator ?? null,
  redraw: () => editor.scene.redrawPlay(),
};
