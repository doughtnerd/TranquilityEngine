// The ragdoll builder's panel (ADR 0373 "Ragdoll builder"; T55): Generate from Skeleton, Test Drop, and the per-bone table. It is
// driven by props only (`RagdollBuilder.tsx` reads the scene and writes the component), so every state shows in a story.
import type { EditResult } from "../../../../editor/sdk";
import { BoneTable } from "./BoneTable";
import type { Bones } from "./ragdollLogic";
import type { TestDropState } from "./testDropLogic";
import "./ragdollBuilder.css";

export interface BuilderPanelProps {
  readonly bones: Bones;
  readonly selected: string | null;
  /** The skeleton's bone names, or null while unknown or when there is none. */
  readonly skeletonBones: readonly string[] | null;
  /** Why the bodies can't be changed now (playing, read-only scene), or null. */
  readonly whyNotEdit: string | null;
  /** Why Generate can't run (no Skeleton found), or null. */
  readonly whyNotGenerate: string | null;
  readonly generating: boolean;
  /** The last generate's failure, or null. */
  readonly generateError: string | null;
  readonly drop: TestDropState;
  onGenerate(): void;
  onTestDrop(): void;
  onSelect(bone: string | null): void;
  onEdit(result: EditResult<Bones>, label: string): boolean;
}

export function BuilderPanel(props: BuilderPanelProps) {
  const { bones } = props;
  const blocked = props.whyNotEdit;
  const generateWhy = blocked ?? props.whyNotGenerate;
  return (
    <div class="ragdoll-builder" aria-label="Ragdoll builder">
      <h4>Ragdoll builder</h4>
      <div class="ragdoll-actions">
        <button class="primary" disabled={props.generating || generateWhy !== null} title={generateWhy ?? "Fill the bodies and joint limits from the skeleton: capsules by bone length, limits from its joint ranges"} onClick={props.onGenerate}>
          {props.generating ? "Generating…" : bones.length ? "Regenerate from Skeleton" : "Generate from Skeleton"}
        </button>
        <button disabled={props.drop.disabled} title={props.drop.title} onClick={props.onTestDrop}>
          {props.drop.label}
        </button>
      </div>
      {generateWhy && <p class="ragdoll-note">{generateWhy}</p>}
      {props.generateError && (
        <p class="ragdoll-problem" role="alert">
          {props.generateError}
        </p>
      )}
      {bones.length === 0 ? (
        <p class="ragdoll-note">No bodies listed: at run time the skeleton's default ragdoll is built. Generate it here to edit its shapes and limits.</p>
      ) : (
        <BoneTable bones={bones} selected={props.selected} skeletonBones={props.skeletonBones} disabled={blocked !== null} onSelect={props.onSelect} onEdit={props.onEdit} />
      )}
    </div>
  );
}
