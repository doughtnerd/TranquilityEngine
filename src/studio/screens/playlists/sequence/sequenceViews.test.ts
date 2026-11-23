// The Sequence view's drawing parts through their own interfaces (UI pass W-7, L1): a clip's curve keys under its
// trim and length edges leave the press to the edge, and a parameter-driven lane draws its curve over the parameter's
// range (its min and max named at the ends).
import type { VNode } from "preact";
import { describe, expect, it } from "vitest";
import type { ParameterDef } from "../../../../engine/audio/parameters";
import { parameterLaneRange } from "./automationEdits";
import { CurveOverlay, type CurveOverlayProps } from "./CurveOverlay";

const SPEC = { min: -60, max: 6, scale: "linear" as const, bool: false };

/** The key circles the overlay draws, as their class names. */
function keyClasses(props: CurveOverlayProps): string[] {
  const svg = CurveOverlay(props) as VNode<{ children: unknown[] }>;
  const keys = (svg.props.children[1] ?? []) as VNode<{ class: string }>[];
  return keys.map((k) => k.props.class);
}

describe("curve overlay on a clip", () => {
  const base: CurveOverlayProps = { curve: [[0, -12], [1.5, 0], [3, -24]], spec: SPEC, width: 300, height: 60, toX: (x) => x * 100, fromX: (px) => px / 100, interactive: true };

  it("leaves keys at the clip's edges to the trim and length handles", () => {
    expect(keyClasses({ ...base, edgeGuard: 6 })).toEqual(["sq-key at-edge", "sq-key", "sq-key at-edge"]);
  });

  it("lets every key take the press where no edge handles sit (a track's lane)", () => {
    expect(keyClasses(base)).toEqual(["sq-key", "sq-key", "sq-key"]);
  });
});

describe("parameter-driven lanes", () => {
  const parameters: ParameterDef[] = [{ name: "rpm", min: 0, max: 8000, default: 0, seekSpeed: 0 }, { name: "gear", labels: ["1", "2", "3"], default: "1" }];

  it("draws over the parameter's range, a labelled one over its labels", () => {
    expect(parameterLaneRange({ parameter: "rpm" }, [[1000, 0], [6000, 1]], parameters)).toEqual({ name: "rpm", min: 0, max: 8000 });
    expect(parameterLaneRange({ parameter: "gear" }, [[0, 0]], parameters)).toEqual({ name: "gear", min: 0, max: 2 });
  });

  it("falls back to the keys for a parameter that isn't defined, and is none for a time lane", () => {
    expect(parameterLaneRange({ parameter: "speed" }, [[0, 0], [200, 1]], parameters)).toEqual({ name: "speed", min: 0, max: 200 });
    expect(parameterLaneRange("clipTime", [[0, 0]], parameters)).toBeNull();
  });
});
