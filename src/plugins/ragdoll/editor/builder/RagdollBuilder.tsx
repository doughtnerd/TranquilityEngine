// The ragdoll builder as the Ragdoll component's Inspector section (ADR 0131, 0373, 0375; T55): under the Ragdoll's fields, the
// builder panel (`BuilderPanel.tsx`) over the selected node: it finds the Skeleton the Ragdoll builds on, generates the
// bodies from it (`generateLogic.ts`: one undo step that writes `bones`, `pelvis` and `front`), writes each table edit to
// `bones` (one undo step each), and drives Test Drop on the running game (`testDropLogic.ts`).
import { useState } from "preact/hooks";
import { applyEdit, editor, sectionField, type InspectorSectionProps } from "../../../../editor/sdk";
import type { GameObject } from "../../../../engine/scene/GameObject";
import { loadSkeletonBytes } from "../../../animation/runtime";
import { Ragdoll, type RagdollBone, type RagdollMode } from "../../runtime/Ragdoll";
import { BuilderPanel } from "./BuilderPanel";
import { generateRagdoll } from "./generateLogic";
import { selectedBodyBone } from "./ragdollGizmo";
import { findRigSkeleton } from "./rigLookup";
import { skeletonInfoIfLoaded } from "./skeletonInfo";
import { liveNodeFor, nextDropMode, testDropState } from "./testDropLogic";

/** The mode a live Ragdoll had before a test drop, by node: what Reset puts back. */
const before = new WeakMap<GameObject, RagdollMode>();

/** The live Ragdoll of the selected node in the play session, or null. */
function liveRagdoll(id: string): { node: GameObject; ragdoll: Ragdoll } | null {
  for (const world of editor.scene.playWorlds) {
    const node = liveNodeFor(world, id);
    const ragdoll = node?.getComponent(Ragdoll);
    if (node && ragdoll) return { node, ragdoll };
  }
  return null;
}

/** The Ragdoll card's builder section. */
export function RagdollBuilderSection({ scene, paths, info }: InspectorSectionProps) {
  const path = paths[0]!;
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, bump] = useState(0);
  const bones = (sectionField(info, "bones") as readonly RagdollBone[] | undefined) ?? [];
  const node = scene.sync.nodeFor(path);
  const rig = node ? findRigSkeleton(node) : null;
  const skeletonRef = rig?.skeleton.skeleton ?? "";
  const skeletonBones = skeletonRef ? (skeletonInfoIfLoaded(skeletonRef)?.names ?? null) : null;
  const place = { scene, path, type: info.type, index: info.index };

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const bytes = await loadSkeletonBytes(skeletonRef);
      const made = bytes ? await generateRagdoll(bytes, rig?.skeleton.profile ?? "") : { error: `the skeleton "${skeletonRef}" can't be read.` };
      if ("error" in made) return setError(made.error);
      editor.scene.edit("Generate the ragdoll", () => {
        editor.scene.writeField(place, "bones", made.bones);
        if (made.pelvis) editor.scene.writeField(place, "pelvis", made.pelvis);
        editor.scene.writeField(place, "front", made.front);
      }, scene);
    } finally {
      setGenerating(false);
    }
  };

  const id = path[path.length - 1]!;
  const live = liveRagdoll(id);
  const dropped = live ? before.has(live.node) : false;
  const testDrop = () => {
    if (!live) return;
    const next = nextDropMode(dropped, before.get(live.node) ?? "off");
    if (!dropped) before.set(live.node, live.ragdoll.mode);
    else before.delete(live.node);
    void editor.scene.writeField({ node: live.node, type: info.type, index: info.index }, "mode", next);
    bump((n) => n + 1);
  };

  return (
    <BuilderPanel
      bones={bones}
      selected={selectedBodyBone.value}
      skeletonBones={skeletonBones}
      whyNotEdit={editor.scene.whyNotEdit(scene)}
      whyNotGenerate={skeletonRef ? null : "No Skeleton found on this node, below it or above it: add one (or an Animator's rig) to generate from."}
      generating={generating}
      generateError={error}
      drop={testDropState(editor.scene.playState, live ? { mode: live.ragdoll.mode } : null, dropped)}
      onGenerate={() => void generate()}
      onTestDrop={testDrop}
      onSelect={(bone) => (selectedBodyBone.value = bone)}
      onEdit={(result, label) => applyEdit(result, label, (next) => editor.scene.edit(label, () => editor.scene.writeField(place, "bones", next as RagdollBone[]), scene))}
    />
  );
}
