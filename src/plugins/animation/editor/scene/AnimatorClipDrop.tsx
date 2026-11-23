// The Animator's Inspector section (ADR 0373 "Drop behaviour"; T18): a drop zone under its fields for a clip dragged from
// the Assets panel. It says what releasing does (set or replace the default clip, add it as a state of the Animator's
// graph, or why not), and the drop is `clipDrop.ts`'s, as on the Animator's Hierarchy row.
import { useEffect, useRef, useState } from "preact/hooks";
import { registerAssetDropTarget, type InspectorSectionProps } from "../../../../editor/sdk";
import { clipDropLabel, dropClipOnAnimator, isClipAsset } from "./clipDrop";
import "./scene.css";

export function AnimatorClipDrop(props: InspectorSectionProps) {
  const { scene, paths } = props;
  const path = paths[0]!;
  const zone = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState<string | null>(null);
  useEffect(() => {
    const el = zone.current;
    if (!el) return;
    return registerAssetDropTarget(el, {
      accepts: (assets) => assets.length === 1 && isClipAsset(assets[0]!),
      label: (assets) => clipDropLabel(scene, path, assets),
      drop: (assets) => void dropClipOnAnimator(scene, path, assets[0]!),
      over: (assets) => setOver(clipDropLabel(scene, path, assets)),
      leave: () => setOver(null),
    });
  }, [scene, path.join("/")]);
  const refused = over?.startsWith("Can't") ?? false;
  return (
    <div ref={zone} class={`animator-clip-drop${over ? " over" : ""}${refused ? " refused" : ""}`} aria-label="Drop a clip here">
      {over ?? "Drop a clip here to play it on start"}
    </div>
  );
}
