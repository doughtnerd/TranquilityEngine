import { describe, expect, it } from "vitest";
import { jsonModuleSource } from "./jsonModule";

describe("the checker's module for a JSON file", () => {
  it("types valid JSON by its literal and invalid JSON as any", () => {
    expect(jsonModuleSource("data/a.json", '{ "x": 1 }')).toBe('const json = { "x": 1 };\nexport default json;\n');
    expect(jsonModuleSource("data/a.json", "{ nope")).toContain("declare const json: any;");
  });

  it("declares an action set file's default export as the ActionSetDef from myco, valid or not", () => {
    const source = '{ "id": "game.Move", "actions": [] }';
    for (const text of [source, "{ broken"]) {
      const module = jsonModuleSource("input/move.actions.json", text);
      expect(module).toContain('import type { ActionSetDef } from "myco";');
      expect(module).toContain("export default set;");
      expect(module).not.toContain("game.Move");
    }
  });
});
