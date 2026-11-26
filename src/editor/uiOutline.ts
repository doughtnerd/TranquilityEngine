// The selected UI element's box (one a UIView rendered), outlined in the scene view (ADR 0077 §4). Drawn as an SVG
// polygon over the viewport, following the UI core's layout boxes every frame: a rectangle on a
// screen canvas, the projected quad on a world canvas, clipped to what an `overflow: hidden` ancestor shows (ADR 0418). Renderer-neutral DOM (no backend code); the
// boxes come from the UI core's layout (ADR 0076). The
// resize handles and reorder marker are `uiHandles.ts`, in an overlay of their own above this one.
import type { Engine } from "../engine";
import { viewport, viewportCanvas } from "../engine/editor";
import { viewportElements } from "./ui/ScenePanel";
import { openScene } from "./state";
import { selectedUIComponent } from "./uiViews";

const SVG = "http://www.w3.org/2000/svg";

/** Outline points as an SVG `points` attribute. */
const polygonPoints = (points: readonly (readonly [number, number])[], dx = 0, dy = 0): string => points.map(([x, y]) => `${(x + dx).toFixed(1)},${(y + dy).toFixed(1)}`).join(" ");

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
    const scene = openScene.peek();
    const el = scene ? selectedUIComponent(scene.sync) : null; // a view's element (ADR 0419 wave C)
    const canvas = viewportCanvas(world);
    // The part that's drawn (ADR 0418: an `overflow: hidden` ancestor clips it), else the whole box.
    const box = el && canvas && el.node.activeInHierarchy ? viewport(world).uiElementBox(el.component) : null;
    const points = box ? (box.clip ?? box.points) : null;
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
