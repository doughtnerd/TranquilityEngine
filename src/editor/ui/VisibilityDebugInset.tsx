// The occlusion debug view's inset (ADR 0460 §6): in the scene view's bottom-left corner, the occlusion buffer of the
// view the engine reports (the scene view's own while its Occlusion culling toggle is on, else the main camera's) as a
// grey depth image, and the readout: occluders, triangles, tested, culled, milliseconds. The red boxes of what it
// culled are the editor overlay's (`cameraPreview.ts`). Read through the viewport handle, about ten times a second.
import { useEffect, useRef, useState } from "preact/hooks";
import { viewport } from "../../engine/editor";
import { sceneCamera } from "../state";
import { depthImage, occlusionReadout, readoutSource, type OcclusionNumbers } from "../visibilityDebugLogic";
import "./visibility-debug.css";

const REFRESH_MS = 100;

export function VisibilityDebugInset() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [shown, setShown] = useState<{ source: string; stats: OcclusionNumbers; image: boolean } | null>(null);
  useEffect(() => {
    let pixels: Uint8ClampedArray | undefined;
    const look = () => {
      const world = sceneCamera.peek()?._world;
      const debug = world ? viewport(world).occlusionDebug(world) : null;
      if (!debug) return setShown(null);
      const c = canvas.current;
      if (c && debug.depth) {
        if (c.width !== debug.depth.width) c.width = debug.depth.width;
        if (c.height !== debug.depth.height) c.height = debug.depth.height;
        pixels = depthImage(debug.depth, pixels);
        c.getContext("2d")?.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, debug.depth.width, debug.depth.height), 0, 0);
      }
      setShown({ source: readoutSource(debug.kind), stats: debug.stats, image: !!debug.depth });
    };
    look();
    const timer = setInterval(look, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  return (
    <div class="visibility-debug" role="region" aria-label="Occlusion debug">
      <canvas ref={canvas} class="visibility-debug-depth" aria-label="Occlusion buffer" hidden={!shown?.image} />
      {shown ? (
        <>
          <p class="visibility-debug-source">{shown.source}</p>
          <dl class="visibility-debug-readout" aria-label="Occlusion readout">
            {occlusionReadout(shown.stats).map((row) => (
              <div key={row.label} class="visibility-debug-row" data-stat={row.label.toLowerCase()}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : (
        <p class="visibility-debug-empty">No occlusion this frame: turn on Occlusion culling, or add a perspective camera with occlusion culling and an LODGroup.</p>
      )}
    </div>
  );
}
