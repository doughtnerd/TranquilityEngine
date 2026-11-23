// Where the Scene plan's words go (journeys walk 2, V11): the object labels are spread so no two overlap and none covers
// another object's mark, and the selected object's floating toolbar is put where it covers no label (above a point or
// under a shape first, the prototype's places, then the other sides). Pure: screen pixels in, offsets and places out.

/** A screen rectangle, px. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A label as the plan draws it: centred on `x`, its baseline at `y`, in a font of `size` px. */
export interface PlanLabel {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly size: number;
}

/** A label's average glyph width as a share of its font size (the Studio's UI font, digits and lower case). */
const GLYPH = 0.58;

/** The box a label covers when moved down by `dy`. */
export function labelRect(l: PlanLabel, dy = 0): Rect {
  const w = Math.max(1, l.text.length) * l.size * GLYPH;
  return { x: l.x - w / 2, y: l.y + dy - l.size, w, h: l.size + 4 };
}

/** The smallest rectangle holding both. */
export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

const overlapArea = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * Each label's vertical offset, so none overlaps one placed before it (the order given: the most important first) nor
 * another object's mark (`keepOut`, by object id; its own mark doesn't count). A label keeps its place when it fits;
 * otherwise it moves a line down, then up, then two lines, and so on, and stays where it overlaps least when nothing
 * fits. Labels at offset 0 are left out.
 */
export function spreadLabels(labels: readonly PlanLabel[], keepOut: ReadonlyMap<string, Rect> = new Map()): Map<string, number> {
  const placed: Rect[] = [];
  const out = new Map<string, number>();
  for (const l of labels) {
    const line = l.size + 3;
    let best = 0;
    let bestCost = Infinity;
    for (const dy of [0, line, -line, 2 * line, -2 * line, 3 * line, -3 * line]) {
      const r = labelRect(l, dy);
      let cost = placed.reduce((sum, o) => sum + overlapArea(r, o), 0);
      for (const [id, mark] of keepOut) if (id !== l.id) cost += overlapArea(r, mark);
      if (cost < bestCost) {
        best = dy;
        bestCost = cost;
      }
      if (cost === 0) break;
    }
    placed.push(labelRect(l, best));
    if (best !== 0) out.set(l.id, best);
  }
  return out;
}

/**
 * Where the selected object's toolbar (`bar` px) goes in a view of `view` px: around `target` (the object's mark and its
 * own label), on the `prefer`red side first, then the other sides, at the first place inside the view that covers none
 * of `avoid` (the other labels and marks); else where it covers least. Returns its top-left corner.
 */
export function placeToolbar(o: {
  readonly target: Rect;
  readonly bar: { readonly w: number; readonly h: number };
  readonly view: { readonly width: number; readonly height: number };
  readonly avoid: readonly Rect[];
  readonly prefer: "above" | "below";
  readonly gap?: number;
}): { x: number; y: number } {
  const { target: t, bar, view } = o;
  const gap = o.gap ?? 8;
  const cx = t.x + t.w / 2 - bar.w / 2;
  const cy = t.y + t.h / 2 - bar.h / 2;
  const above = { x: cx, y: t.y - gap - bar.h };
  const below = { x: cx, y: t.y + t.h + gap };
  const sides = [
    ...(o.prefer === "above" ? [above, below] : [below, above]),
    { x: t.x + t.w + gap, y: cy },
    { x: t.x - gap - bar.w, y: cy },
  ];
  const clamp = (p: { x: number; y: number }) => ({
    x: Math.max(8, Math.min(view.width - bar.w - 8, p.x)),
    y: Math.max(4, Math.min(view.height - bar.h - 4, p.y)),
  });
  let best = clamp(sides[0]!);
  let bestCost = Infinity;
  for (const side of sides) {
    const p = clamp(side);
    const r = { x: p.x, y: p.y, w: bar.w, h: bar.h };
    // Clamping it back into the view can push it over what it belongs to: that counts as covering.
    const cost = [...o.avoid, t].reduce((sum, a) => sum + overlapArea(r, a), 0);
    if (cost < bestCost) {
      best = p;
      bestCost = cost;
    }
    if (cost === 0) break;
  }
  return best;
}
