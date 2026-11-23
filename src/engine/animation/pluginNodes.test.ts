// ADR 0370 (T45t): `plugin.json`'s `animationNodes`, read leniently: good entries kept (a bare string is a module), bad
// ones dropped and bad budgets defaulted, one problem line each; and a call's fuel.
import { describe, expect, it } from "vitest";
import { callFuel, MAX_NODE_MODULES, NODE_FUEL, parseAnimationNodes } from "./pluginNodes";

describe("parseAnimationNodes", () => {
  it("is empty without the section", () => {
    expect(parseAnimationNodes(undefined)).toEqual({ modules: [], problems: [] });
  });

  it("keeps modules with their budgets, defaulting an absent one", () => {
    expect(parseAnimationNodes([{ module: "nodes/sway.wasm", budget: 5000 }, { module: "./nodes/ik.wasm" }, "more.wasm"])).toEqual({
      modules: [
        { module: "nodes/sway.wasm", budget: 5000 },
        { module: "nodes/ik.wasm", budget: NODE_FUEL.default },
        { module: "more.wasm", budget: NODE_FUEL.default },
      ],
      problems: [],
    });
  });

  it("drops bad entries and defaults bad budgets, with one line each", () => {
    const { modules, problems } = parseAnimationNodes([
      42,
      { module: "../outside.wasm" },
      { module: "nodes/notwasm.js" },
      { module: "nodes/a.wasm", budget: 0 },
      { module: "nodes/b.wasm", budget: NODE_FUEL.max + 1 },
      { module: "nodes/c.wasm", budget: 1.5 },
      { module: "nodes/a.wasm" },
    ]);
    expect(modules).toEqual([
      { module: "nodes/a.wasm", budget: NODE_FUEL.default },
      { module: "nodes/b.wasm", budget: NODE_FUEL.default },
      { module: "nodes/c.wasm", budget: NODE_FUEL.default },
    ]);
    expect(problems).toEqual([
      'animationNodes[0]: must be an object with a "module"; ignored',
      "animationNodes[1].module: must be the path of a .wasm file inside the plugin; ignored",
      "animationNodes[2].module: must be the path of a .wasm file inside the plugin; ignored",
      `animationNodes[3].budget: must be a whole number from 1 to ${NODE_FUEL.max}; using ${NODE_FUEL.default}`,
      `animationNodes[4].budget: must be a whole number from 1 to ${NODE_FUEL.max}; using ${NODE_FUEL.default}`,
      `animationNodes[5].budget: must be a whole number from 1 to ${NODE_FUEL.max}; using ${NODE_FUEL.default}`,
      'animationNodes[6].module: "nodes/a.wasm" is listed twice; the first is used',
    ]);
  });

  it("ignores a section that isn't a list, and entries past the limit", () => {
    expect(parseAnimationNodes({ module: "a.wasm" }).modules).toEqual([]);
    expect(parseAnimationNodes({ module: "a.wasm" }).problems).toHaveLength(1);
    const many = parseAnimationNodes(Array.from({ length: MAX_NODE_MODULES + 2 }, (_, i) => `m${i}.wasm`));
    expect(many.modules).toHaveLength(MAX_NODE_MODULES);
    expect(many.problems).toEqual([`animationNodes: at most ${MAX_NODE_MODULES} modules; the rest are ignored`]);
  });
});

describe("callFuel", () => {
  it("is the budget per instance times the instances, plus the base", () => {
    expect(callFuel(5000, 1)).toBe(5000n + BigInt(NODE_FUEL.base));
    expect(callFuel(5000, 3)).toBe(15000n + BigInt(NODE_FUEL.base));
  });
});
