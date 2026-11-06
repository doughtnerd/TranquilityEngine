// The selected UI document element's box, outlined in the scene view (ADR 0077 §4). Drawn as an SVG
// polygon over the viewport, following the UI core's layout boxes every frame: a rectangle on a
// screen canvas, the projected quad on a world canvas. Renderer-neutral DOM (no backend code); the
// boxes come from the UI's layout on either backend (the UI core on Babylon, uikit on three.js). The
// resize handles and reorder marker are `uiHandles.ts`, in an overlay of their own above this one.
import type { Engine } from "../engine";
import { uiElementOutline, viewportCanvas } from "../engine/editor";
import { viewportElements } from "./ui/ScenePanel";
import { openScene } from "./state";
import { resolveUIElement, selectedUIRef } from "./uiDocuments";

const SVG = "http://www.w3.org/2000/svg";

/** Outline points as an SVG `points` attribute. */
export const polygonPoints = (points: readonly (readonly [number, number])[], dx = 0, dy = 0): string => points.map(([x, y]) => `${(x + dx).toFixed(1)},${(y + dy).toFixed(1)}`).join(" ");

/** Draw the selected UI element's outline over the viewport until the returned function is called. */
export function installUIElementOutline(engine: Engine): () => void {
  const world = engine.world;
  const host = viewportElements().viewport;
  const svg = document.createElementNS(SVG, "svg");
  svg.classList.add("ui-element-outline");
  svg.setAttribute("aria-hidden", "true");
  const polygon = document.createElementNS(SVG, "polygon");
  svg.appendChild(polygon);
  host.appendChild(svg);
  let raf = 0;
  let last = "";
  const frame = () => {
    raf = requestAnimationFrame(frame);
    const scene = openScene.peek(), ref = selectedUIRef();
    const el = scene && ref ? resolveUIElement(scene.sync, ref) : null;
    const canvas = viewportCanvas(world);
    const points = el && canvas && el.node.activeInHierarchy ? uiElementOutline(world, el.component) : null;
    let attr = "";
    if (points && canvas) {
      const c = canvas.getBoundingClientRect(), h = host.getBoundingClientRect();
      attr = polygonPoints(points, c.left - h.left, c.top - h.top);
    }
    if (attr === last) return;
    last = attr;
    svg.style.display = attr ? "" : "none";
    polygon.setAttribute("points", attr);
  };
  svg.style.display = "none";
  raf = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(raf);
    svg.remove();
  };
}
