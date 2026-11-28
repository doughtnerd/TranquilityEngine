// The badge beside `MeshRenderer.occlusion` in the Inspector (ADR 0460 §6), contributed as a field adornment: the
// renderer's effective role (occluder and occludee, or occludee only) with why, from the engine's own rule
// (`occlusionRoleOf`, the one the visibility stage picks occluders with). Looked at again a few times a second, as the
// width test follows the camera.
import { useEffect, useState } from "preact/hooks";
import type { FieldAdornmentProps } from "../../../editor/sdk";
import { MeshRenderer } from "../../../engine/render/components";
import { occlusionRoleOf } from "../../../engine/render/visibility/service";
import { occlusionRoleText } from "./occlusionLogic";
import "./occlusion-role.css";

const REFRESH_MS = 500;

/** Shown only on `MeshRenderer.occlusion`; every other field row gets nothing. */
export function OcclusionRoleAdornment(props: FieldAdornmentProps) {
  if (props.type !== "engine.MeshRenderer" || props.field !== "occlusion") return null;
  return <OcclusionRoleBadge {...props} />;
}

function OcclusionRoleBadge({ scene, path, index, value }: FieldAdornmentProps) {
  const [text, setText] = useState<{ label: string; title: string } | null>(null);
  useEffect(() => {
    const look = () => {
      const node = scene.sync.nodeFor(path);
      const renderer = node?.isValid ? (node.getBehaviors(MeshRenderer)[index] ?? null) : null;
      setText(renderer ? occlusionRoleText(occlusionRoleOf(renderer)) : null);
    };
    look();
    const timer = setInterval(look, REFRESH_MS);
    return () => clearInterval(timer);
  }, [scene, path, index, value]);
  if (!text) return null;
  return (
    <span class="occlusion-role" role="note" aria-label={`Occlusion role: ${text.label}`} title={text.title}>
      {text.label}
    </span>
  );
}
