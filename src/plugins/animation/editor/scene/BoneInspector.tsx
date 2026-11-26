// The Inspector's bone target (ADR 0373, 0242; T18): a bone of a node's Skeleton, selected in the Hierarchy. Read-only:
// its name, parent, rest pose (local, from the asset) and current pose (model space, animated where the Editor World
// animates the skeleton), plus Add BoneAttachment. The logic is `bones.ts`.
import { useEffect, useState } from "preact/hooks";
import { editor, type BoneInspectorProps, EmptyState } from "../../../../editor/sdk";
import { addBoneAttachment, boneDetails, type BonePose } from "./bones";
import "./scene.css";

/** How often the current pose is read again (it moves while something animates the skeleton). */
const POSE_REFRESH_MS = 200;

const num = (n: number) => (Math.abs(n) < 5e-5 ? "0" : n.toFixed(4).replace(/\.?0+$/, ""));
const vec = (v: readonly number[]) => v.map(num).join(", ");

function PoseRows(props: { pose: BonePose }) {
  const { pose } = props;
  return (
    <>
      <dt>Position</dt>
      <dd>{vec(pose.position)}</dd>
      <dt>Rotation</dt>
      <dd title="Quaternion x, y, z, w">{vec(pose.rotation)}</dd>
      <dt>Scale</dt>
      <dd>{vec(pose.scale)}</dd>
    </>
  );
}

export function BoneInspector(props: BoneInspectorProps) {
  const { scene, path, bone } = props;
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), POSE_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const details = boneDetails(scene, path, bone);
  if (!details) {
    return (
      <div class="inspector-body bone-inspector">
        <EmptyState compact title={`The bone ${bone} isn't in this node's skeleton (or the skeleton is still loading).`} />
      </div>
    );
  }
  const blocked = editor.scene.whyNotEdit(scene);
  return (
    <div class="inspector-body bone-inspector">
      <div class="bone-inspector-header">
        <span class="bone-inspector-name">{details.name}</span>
        <span class="badge" title="Bones come from the skeleton asset: they're read-only here">bone</span>
      </div>
      <dl class="node-meta">
        <dt>Skeleton</dt>
        <dd>{scene.sync.nodeFor(path)?.name ?? path.join("/")}</dd>
        <dt>Parent</dt>
        <dd>{details.parent ?? "none (a root bone)"}</dd>
        <dt>Children</dt>
        <dd>{details.children}</dd>
      </dl>
      <h4 class="bone-inspector-heading">Rest pose (local)</h4>
      <dl class="node-meta">
        <PoseRows pose={details.rest} />
      </dl>
      <h4 class="bone-inspector-heading">{details.animated ? "Current pose (model space, animated)" : "Current pose (model space, at rest)"}</h4>
      <dl class="node-meta">
        <PoseRows pose={details.pose} />
      </dl>
      <button type="button" class="bone-inspector-attach" disabled={blocked !== null} title={blocked ?? `Add a child node that follows ${details.name}`} onClick={() => addBoneAttachment(scene, path, details.name)}>
        Add BoneAttachment
      </button>
    </div>
  );
}
