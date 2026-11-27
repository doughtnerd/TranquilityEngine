import { beforeAll, describe, expect, it } from "vitest";
import { LayoutTree, loadLayoutEngine, type LayoutContent, type LayoutDisplay, type LayoutEdge, type LayoutFlexDirection, type LayoutItems, type LayoutLength, type LayoutNode, type LayoutOverflow, type LayoutPosition, type LayoutWrap, type MeasureInput } from "../ui/taffy/layoutTree";
import cases from "./layoutConformance/cases.json";
import chromium from "./layoutConformance/chromium.json";

// ADR 0433: the UI core's layout engine against Chromium's boxes for the flex cases the UI core uses.
// `npm run conformance:layout` (scripts/layout-conformance.mjs) records chromium.json from cases.json; that script
// says how a case is built in the browser.

interface CaseNode {
  style: Record<string, number | string | null>;
  children?: CaseNode[];
  /** A measured leaf: `count` words of `width` x `lineHeight`. */
  words?: [number, number, number];
}

/** Chromium lays out in 1/64 px units. */
const TOLERANCE = 1 / 32;
const EDGES: readonly LayoutEdge[] = ["top", "right", "bottom", "left"];

/**
 * The words model, as the browser lays out the inline boxes: as many per line as fit (at least one). Its width is CSS's
 * shrink-to-fit width, min(max-content, max(min-content, room)): wrapped text takes the whole room, not its widest line.
 */
function words([count, width, lineHeight]: [number, number, number]) {
  return (input: MeasureInput) => {
    const room = input.knownWidth ?? (input.availableWidth === -Infinity ? 0 : input.availableWidth);
    const perLine = Math.max(1, Math.floor((room + 1e-4) / width));
    const lines = Math.ceil(count / perLine);
    // A line's baseline is its words' bottom edge (an inline box with no text sits on the baseline), so the first
    // baseline is the first line's height.
    return { width: input.knownWidth ?? Math.min(count * width, Math.max(width, room)), height: lines * lineHeight, baseline: lineHeight };
  };
}

function build(t: LayoutTree, spec: CaseNode, out: LayoutNode[]): LayoutNode {
  const n = t.create(spec.words ? words(spec.words) : undefined);
  out.push(n);
  const s = spec.style;
  const len = (v: number | string | null | undefined) => (v === null ? undefined : (v as LayoutLength));
  for (const [k, v] of Object.entries(s)) {
    if (v === null) continue;
    switch (k) {
      case "width": n.setWidth(len(v)); break;
      case "height": n.setHeight(len(v)); break;
      case "minWidth": n.setMinWidth(len(v)); break;
      case "minHeight": n.setMinHeight(len(v)); break;
      case "maxWidth": n.setMaxWidth(len(v)); break;
      case "maxHeight": n.setMaxHeight(len(v)); break;
      case "flexBasis": n.setFlexBasis(len(v)); break;
      case "flexGrow": n.setFlexGrow(v as number); break;
      case "flexShrink": n.setFlexShrink(v as number); break;
      case "aspectRatio": n.setAspectRatio(v as number); break;
      case "flexDirection": n.setFlexDirection(v as LayoutFlexDirection); break;
      case "justifyContent": n.setJustifyContent(v as LayoutContent); break;
      case "alignContent": n.setAlignContent(v as LayoutContent); break;
      case "alignItems": n.setAlignItems(v as LayoutItems); break;
      case "alignSelf": n.setAlignSelf(v as LayoutItems); break;
      case "flexWrap": n.setFlexWrap(v as LayoutWrap); break;
      case "position": n.setPosition(v as LayoutPosition); break;
      case "display": n.setDisplay(v as LayoutDisplay); break;
      case "overflow": n.setOverflow(v as LayoutOverflow); break;
      case "direction": n.setDirection(v as "ltr" | "rtl"); break;
      case "gap": n.setGap(len(v)); break;
      case "rowGap": case "columnGap": break; // below
      case "padding": for (const e of EDGES) n.setPadding(e, len(v)); break;
      case "border": for (const e of EDGES) n.setBorder(e, len(v)); break;
      case "margin": for (const e of EDGES) n.setMargin(e, len(v)); break;
      case "paddingTop": n.setPadding("top", len(v)); break;
      case "paddingRight": n.setPadding("right", len(v)); break;
      case "paddingBottom": n.setPadding("bottom", len(v)); break;
      case "paddingLeft": n.setPadding("left", len(v)); break;
      case "marginTop": n.setMargin("top", len(v)); break;
      case "marginRight": n.setMargin("right", len(v)); break;
      case "marginBottom": n.setMargin("bottom", len(v)); break;
      case "marginLeft": n.setMargin("left", len(v)); break;
      case "top": case "right": case "bottom": case "left": n.setInset(k, len(v)); break;
      default: throw new Error(`conformance case: unknown style ${k}`);
    }
  }
  if ("rowGap" in s || "columnGap" in s) n.setGap(len(s.columnGap), len(s.rowGap));
  // Taffy doesn't inherit direction; the UI core passes each element's resolved direction.
  if (s.direction === undefined) n.setDirection("ltr");
  const kids = (spec.children ?? []).map((c) => build(t, inherit(c, s.direction), out));
  if (kids.length) n.setChildren(kids);
  return n;
}

/** A child spec with its parent's direction when it sets none. */
function inherit(spec: CaseNode, direction: number | string | null | undefined): CaseNode {
  return direction && spec.style.direction === undefined ? { ...spec, style: { ...spec.style, direction } } : spec;
}

beforeAll(async () => {
  await loadLayoutEngine();
});

describe("layout engine conformance with Chromium", () => {
  const recorded = new Map(chromium.cases.map((c) => [c.name, c.boxes]));

  it("has Chromium's boxes for every case", () => {
    expect([...recorded.keys()]).toEqual(cases.map((c) => c.name));
  });

  for (const c of cases as unknown as { name: string; width: number; height: number; root: CaseNode }[]) {
    it(c.name, () => {
      const t = new LayoutTree();
      const nodes: LayoutNode[] = [];
      const root = build(t, c.root, nodes);
      t.compute(root, c.width, c.height);
      const ours = nodes.map((n) => {
        const b = n.layout();
        return [b.x, b.y, b.width, b.height];
      });
      t.free();
      const theirs = recorded.get(c.name)!;
      expect(ours.length).toBe(theirs.length);
      ours.forEach((box, i) => {
        box.forEach((v, j) => {
          if (Math.abs(v - theirs[i]![j]!) > TOLERANCE) expect.soft(box, `node ${i} (pre-order)`).toEqual(theirs[i]);
        });
      });
    });
  }
});
