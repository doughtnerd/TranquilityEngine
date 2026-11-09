// Geometry and labels of the Particle Graph canvas (ADR 0060). Systems and nodes are laid out by
// the browser (blocks hold inline fields of varying height), so their sizes and port centres are
// measured from the DOM after each render, in graph units relative to their own top-left, and fed
// to xyflow (wiring, snapping) and to the wires.
import type { ContextKind, OutputType } from "../../../../../engine/scene/particleGraph";
import type { CanvasNode, Point } from "../../../../../editor/sdk";

export const SYSTEM_WIDTH = 330;
export const NODE_WIDTH = 210;

export const CONTEXT_TITLES: Record<ContextKind, string> = { spawn: "Spawn", initialize: "Initialize Particle", update: "Update Particle", output: "Output Particle" };

export const OUTPUT_LABELS: Record<OutputType, string> = { quad: "Quad", stretched: "Stretched Quad", horizontal: "Horizontal Quad", vertical: "Vertical Quad", mesh: "Mesh", trail: "Trail" };

/** An element on the canvas the panel measured: its size and its ports' centres, in graph units from its top-left. */
export interface Measured {
  w: number;
  h: number;
  inputs: { id: string; x: number; y: number }[];
  outputs: { id: string; x: number; y: number }[];
}

/**
 * Measure every `[data-owner]` (systems and nodes) in the viewport and their `[data-port]`
 * elements. `zoom` is the viewport's scale, so screen pixels become graph units.
 */
export function measureCanvas(viewport: HTMLElement, zoom: number): Map<string, Measured> {
  const out = new Map<string, Measured>();
  const r2 = (n: number) => Math.round(n * 2) / 2;
  for (const owner of viewport.querySelectorAll<HTMLElement>("[data-owner]")) {
    const r = owner.getBoundingClientRect();
    const m: Measured = { w: r2(r.width / zoom), h: r2(r.height / zoom), inputs: [], outputs: [] };
    for (const port of owner.querySelectorAll<HTMLElement>("[data-port]")) {
      const p = port.getBoundingClientRect();
      const at = { id: port.dataset.port!, x: r2((p.left + p.width / 2 - r.left) / zoom), y: r2((p.top + p.height / 2 - r.top) / zoom) };
      (port.dataset.side === "output" ? m.outputs : m.inputs).push(at);
    }
    out.set(owner.dataset.owner!, m);
  }
  return out;
}

/** Did a measurement change? */
export function sameMeasure(a: ReadonlyMap<string, Measured>, b: ReadonlyMap<string, Measured>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, m] of a) {
    const o = b.get(id);
    if (!o || JSON.stringify(o) !== JSON.stringify(m)) return false;
  }
  return true;
}

/** A canvas item for xyflow and framing. */
export function canvasNode(id: string, at: Point, m: Measured | undefined, fallback: { w: number; h: number }, selected: boolean): CanvasNode {
  return { id, x: at.x, y: at.y, width: m?.w ?? fallback.w, height: m?.h ?? fallback.h, selected, inputs: m?.inputs ?? [], outputs: m?.outputs ?? [] };
}

/** Where a port is in graph units (or the owner's edge, near its title, while the port isn't shown). */
export function portPoint(nodes: ReadonlyMap<string, CanvasNode>, owner: string, port: string, side: "input" | "output"): Point | null {
  const n = nodes.get(owner);
  if (!n) return null;
  const p = (side === "input" ? n.inputs : n.outputs).find((q) => q.id === port);
  if (p) return { x: n.x + p.x, y: n.y + p.y };
  return { x: side === "input" ? n.x : n.x + n.width, y: n.y + 16 };
}

/** The CSS class for a port type: `pt-number`, `pt-event`… */
export const portTypeClass = (t: string | null | undefined) => `pt-${t ?? "number"}`;
