// Undo steps (ADR 0231): one step for everything done while it is open, put back when cancelled; and the shell
// opens command-stack groups only through this module.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandStack, RenameNode, SceneDocument } from "./document";
import { beginUndoStep, undoStep } from "./undoStep";

const scene = () => {
  const doc = new SceneDocument({ format: "myco.scene@1", nodes: [{ id: "a", name: "A" }] });
  return { doc, stack: new CommandStack(doc) };
};

describe("undo steps", () => {
  it("records a function's edits as one step and returns what it returns", () => {
    const { doc, stack } = scene();
    const n = undoStep(stack, "Rename twice", () => {
      stack.execute(new RenameNode("a", "B"));
      stack.execute(new RenameNode("a", "C"));
      return 2;
    });
    expect(n).toBe(2);
    expect(stack.undoLabel).toBe("Rename twice");
    stack.undo();
    expect(doc.node("a").name).toBe("A");
  });

  it("keeps an open step's edits on end, and puts them back on cancel", () => {
    const { doc, stack } = scene();
    const kept = beginUndoStep(stack, "Drag");
    stack.execute(new RenameNode("a", "B"));
    kept.end();
    kept.cancel(); // closed: does nothing
    expect(doc.node("a").name).toBe("B");
    const cancelled = beginUndoStep(stack, "Drag again");
    stack.execute(new RenameNode("a", "C"));
    cancelled.cancel();
    expect(cancelled.open).toBe(false);
    expect(doc.node("a").name).toBe("B");
    expect(stack.undoLabel).toBe("Drag");
  });

  it("is the only way the shell opens the command stack's groups", () => {
    const editor = resolve(__dirname);
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
    const allowed = new Set(["undoStep.ts", "document/CommandStack.ts"]);
    const bad = walk(editor)
      .filter((f) => /\.tsx?$/.test(f) && !/\.(test|stories)\.tsx?$/.test(f))
      .map((f) => relative(editor, f).replaceAll("\\", "/"))
      .filter((f) => !allowed.has(f) && /\.(beginGroup|endGroup|cancelGroup)\(/.test(readFileSync(join(editor, f), "utf8")));
    expect(bad).toEqual([]);
  });
});
