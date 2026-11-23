// Dropping a clip on an Animator (ADR 0373 "Drop behaviour"; T18), on its Hierarchy row or its Inspector card.
//
// - **Without a graph** the Animator plays one clip on start (D94 `defaultClip`): the drop sets it, or replaces the one it
//   has (the implicit graph has no clip list; code plays any other clip by name, so there is nothing else to add to).
// - **With a graph** the clip belongs in the graph as a state ("Add as state"): that needs the graph editor (T51), so the
//   drop is refused with a reason saying where to do it until then.
//
// Every drop goes through the refused-or-next result (ADR 0307, 0313) and `applyEdit`: a refusal is reported, an
// accepted one is one undo step.
import { accept, applyEdit, editor, refuse, refusalOf, type EditResult, type NodePath, type OpenScene } from "../../../../editor/sdk";
import { ANIM_SOURCE_SUFFIX } from "../../../../engine/animation/animSource";
import { normalizeAssetPath } from "../../../../engine/scene/Assets";
import { Animator } from "../../runtime/components/Animator";

/** The Assets panel entry is a clip: an authored clip, a compiled one, or a model's clip (`model.glb#Anim/<name>`). */
export function isClipAsset(entry: string): boolean {
  const lower = entry.toLowerCase();
  return lower.endsWith(ANIM_SOURCE_SUFFIX) || lower.endsWith(".anim.bin") || /#Anim\/[^#]+$/.test(entry);
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
 * The Animator's next `defaultClip` after dropping `clip` (an `asset:` reference) on it, or why not: refused with a graph
 * (adding a state is the graph editor's, T51) or when it already plays that clip.
 */
function clipDropEdit(animator: AnimatorClips, clip: string): EditResult<string> {
  if (animator.graph) return refuse("it runs an animation graph, so the clip goes in as a state; add it in the graph (the Animation Graph editor isn't built yet)");
  if (normalizeAssetPath(animator.defaultClip) === normalizeAssetPath(clip)) return refuse("it already plays that clip on start");
  return accept(clip);
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
  const result = clipDropEdit(animator, assetRef(assets[0]!));
  const refused = refusalOf(result);
  return refused ? `Can't add ${clipName(assets[0]!)}: ${refused}` : labelFor(animator, assets[0]!);
}

function labelFor(animator: Animator, entry: string): string {
  const node = animator.node.name;
  return animator.defaultClip ? `Replace ${node}'s default clip ${clipName(animator.defaultClip)} with ${clipName(entry)}` : `Set ${clipName(entry)} as ${node}'s default clip`;
}

/**
 * Drop the clip `entry` on the Animator of the node at `path`: sets (or replaces) its default clip as one undo step, or
 * reports why not. Returns whether it changed.
 */
export function dropClipOnAnimator(scene: OpenScene, path: NodePath, entry: string): boolean {
  const animator = animatorAt(scene, path);
  if (!animator) return applyEdit(refuse("the node has no Animator"), `Add ${clipName(entry)}`, () => {});
  const result = clipDropEdit(animator, assetRef(entry));
  const label = "refused" in result ? `Add ${clipName(entry)} to ${animator.node.name}` : labelFor(animator, entry);
  let written = false;
  const accepted = applyEdit(result, label, (next) => {
    editor.scene.edit(label, () => (written = editor.scene.writeField({ scene, path, type: "engine.Animator" }, "defaultClip", next) === null), scene);
  });
  return accepted && written;
}
