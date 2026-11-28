// What a take's source reads of the editor (ADR 0348, 0373; T73): the play session's Animators, where a take's poses are
// shown while the session is paused, and the play viewport's redraw.
import { editor } from "../../../../editor/sdk";
import { graphAnimators,} from "../../runtime/features/debug/targets";
import type { TakeSession } from "./takeSource";
import { normalizeAssetPath } from "../../../../engine/scene/assetPath";

export const takeSession: TakeSession = {
  animator: (graph) => graphAnimators(editor.scene.playWorlds).find((a) => normalizeAssetPath(a.animator.graph) === graph)?.animator ?? null,
  redraw: () => editor.scene.redrawPlay(),
};
