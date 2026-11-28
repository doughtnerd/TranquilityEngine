// Dropping a clip on an Animator (ADR 0373 "Drop behaviour"; T18), on its Hierarchy row or its Inspector card.
//
// - **Without a graph** the Animator plays one clip on start (D94 `defaultClip`): the drop sets it, or replaces the one it
//   has (the implicit graph has no clip list; code plays any other clip by name, so there is nothing else to add to).
// - **With a graph** the clip goes in the graph as a state ("Add as state", T51): a new clip player playing it, in a new
//   state of the output's state machine (`graphEditor/machineLogic.ts` `addClipAsState`), as one undo step of the graph
//   file's asset document; refused when the graph file isn't in the project or has no machine the state could play in.
//
// Every drop goes through the refused-or-next result (ADR 0307, 0313) and `applyEdit`: a refusal is reported, an
// accepted one is one undo step (of the scene for a default clip, of the graph's document for a state).
import { accept, applyEdit, applyToDocument, editor, mapEdit, openAssetDocument, refuse, refusalOf, type EditResult, type NodePath, type OpenScene, assetRefTarget } from "../../../../editor/sdk";
import type { AnimGraph } from "../../../../engine/animation/animGraph";
import { addClipAsState, type ClipState } from "../graphEditor/machineLogic";
import { normalizeAssetPath } from "../../../../engine/scene/Assets";
import { Animator } from "../../runtime/components/Animator";
import { clipRefKind } from "../../../../engine/animation/compile/keys";

/** The Assets panel entry is a clip: an authored clip, a compiled one, or a model's clip (`model.glb#Anim/<name>`). */
export function isClipAsset(entry: string): boolean {
  const kind = clipRefKind(entry);
  return kind === "source" || kind === "compiled" || kind === "model";
}

/** A clip's name for messages: a model clip's own name, else the file's name without its endings. */
export function clipName(entry: string): string {
  const sub = /#Anim\/([^#]+)$/.exec(entry);
  if (sub) return sub[1]!;
  return entry.split("/").pop()!.replace(/\.anim\.(json|bin)$/i, "");
}

const assetRef = (entry: string) => (entry.startsWith("asset:") ? entry : `asset:${entry}`);

/** What an Animator holds that a clip drop reads. */
interface AnimatorClips {
  /** Its graph asset ("" for none). */
  readonly graph: string;
  /** Its default clip ("" for none). */
  readonly defaultClip: string;
}

/**
 * The Animator's next `defaultClip` after dropping `clip` (an `asset:` reference) on it, or why not (it already plays
 * that clip). Only for an Animator without a graph.
 */
function clipDropEdit(animator: AnimatorClips, clip: string): EditResult<string> {
  if (normalizeAssetPath(animator.defaultClip) === normalizeAssetPath(clip)) return refuse("it already plays that clip on start");
  return accept(clip);
}

/** The project path of an Animator's graph, if the project has the file. */
function graphPath(animator: AnimatorClips): string | null {
  const path = normalizeAssetPath(animator.graph);
  return editor.project.current?.files.includes(path) ? path : null;
}

/** The graph after adding `clip` as a state (named after the clip), or why not. */
function addAsStateEdit(animator: AnimatorClips, clip: string, entry: string): EditResult<ClipState> {
  const path = graphPath(animator);
  const project = editor.project.current;
  if (!path || !project) return refuse(`its graph ${assetRefTarget(animator.graph)} isn't in the project`);
  const graph = editor.assets.read<AnimGraph>(project, path).value;
  return addClipAsState(graph, clip, clipName(entry).replace(/[^A-Za-z0-9_ .-]/g, "") || "State");
}

/** The Animator on the node at `path` (its Editor World copy: prefab values and overrides applied), or null. */
function animatorAt(scene: OpenScene, path: NodePath): Animator | null {
  return scene.sync.nodeFor(path)?.getComponent(Animator) ?? null;
}

/** What dropping `assets` on the node does, as the drag's text, or null when it isn't one clip on a node with an Animator. */
export function clipDropLabel(scene: OpenScene, path: NodePath, assets: readonly string[]): string | null {
  if (assets.length !== 1 || !isClipAsset(assets[0]!)) return null;
  const animator = animatorAt(scene, path);
  if (!animator) return null;
  const entry = assets[0]!;
  if (animator.graph) {
    const refused = refusalOf(addAsStateEdit(animator, assetRef(entry), entry));
    return refused ? `Can't add ${clipName(entry)}: ${refused}` : `Add ${clipName(entry)} as a state in ${graphName(animator)}`;
  }
  const refused = refusalOf(clipDropEdit(animator, assetRef(entry)));
  return refused ? `Can't add ${clipName(entry)}: ${refused}` : labelFor(animator, entry);
}

const graphName = (animator: AnimatorClips) => assetRefTarget(animator.graph).split("/").pop()!.replace(/\.animgraph\.json$/i, "");

function labelFor(animator: Animator, entry: string): string {
  const node = animator.node.name;
  return animator.defaultClip ? `Replace ${node}'s default clip ${clipName(animator.defaultClip)} with ${clipName(entry)}` : `Set ${clipName(entry)} as ${node}'s default clip`;
}

/**
 * Drop the clip `entry` on the Animator of the node at `path`: without a graph, sets (or replaces) its default clip as
 * one undo step of the scene; with one, adds it as a state of the graph as one undo step of the graph's document. Reports
 * why not when refused. Returns whether it changed.
 */
export function dropClipOnAnimator(scene: OpenScene, path: NodePath, entry: string): boolean {
  const animator = animatorAt(scene, path);
  if (!animator) return applyEdit(refuse("the node has no Animator"), `Add ${clipName(entry)}`, () => {});
  if (animator.graph) {
    const result = addAsStateEdit(animator, assetRef(entry), entry);
    const label = `Add ${clipName(entry)} as a state in ${graphName(animator)}`;
    const graphFile = graphPath(animator);
    const project = editor.project.current;
    if ("refused" in result || !graphFile || !project) return applyEdit(result, label, () => {});
    return applyToDocument(openAssetDocument<AnimGraph>(project, graphFile), mapEdit(result, (r) => r.graph), label);
  }
  const result = clipDropEdit(animator, assetRef(entry));
  const label = "refused" in result ? `Add ${clipName(entry)} to ${animator.node.name}` : labelFor(animator, entry);
  let written = false;
  const accepted = applyEdit(result, label, (next) => {
    editor.scene.edit(label, () => (written = editor.scene.writeField({ scene, path, type: "engine.Animator" }, "defaultClip", next) === null), scene);
  });
  return accepted && written;
}
