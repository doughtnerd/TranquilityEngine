import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The graph's width must come from its container, not from the readout row (E6.1b): in the 280 px right dock the
// readout's fields used to make the svg ~474 px wide the moment a key was selected. Layout needs a browser (the
// editor specs measure it); this pins the CSS that keeps the readout from sizing the graph.
const css = readFileSync(new URL("./curveEditor.css", import.meta.url), "utf8");
const rule = (selector: string): string => {
  const m = css.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m"));
  expect(m, `rule for ${selector}`).not.toBeNull();
  return m![1];
};

describe("curve widget layout", () => {
  it("the readout wraps inside the container instead of widening it", () => {
    expect(rule(".curve-readout")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(".curve-readout")).toMatch(/min-width:\s*0/);
  });
  it("the readout's fields have no intrinsic width (a floor on the label, none on the input)", () => {
    expect(rule(".curve-readout label")).toMatch(/flex:\s*1 1 \d+px/);
    expect(rule(".curve-readout input, .curve-readout select")).toMatch(/width:\s*0/);
    expect(rule(".curve-readout input, .curve-readout select")).toMatch(/min-width:\s*0/);
  });
  it("the editor and its svg are bounded by the container", () => {
    expect(rule(".curve-editor")).toMatch(/max-width:\s*100%/);
    expect(rule(".curve-editor")).toMatch(/min-width:\s*0/);
    expect(rule(".curve-svg")).toMatch(/width:\s*100%/);
    expect(rule(".curve-svg")).toMatch(/max-width:\s*100%/);
  });
});
