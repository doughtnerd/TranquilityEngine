import { describe, expect, it } from "vitest";
import { registerBuiltinPanels } from "../ui/panels.builtin";
import { registeredPanels } from "./registeredPanels";
import { closePanel, defaultLayout, instancesOf } from "./model";
import { addVersion, fileNameFor, layoutOf, matchesHead, mergeSaved, newLayoutFile, parseLayoutFile, restoreVersion, scopeLabel, type LayoutFile } from "./saved";

/** How many versions a layout file keeps. */
const MAX_VERSIONS = 50;

registerBuiltinPanels(); // as the editor does at boot
const catalog = registeredPanels();

describe("layout files (ADR 0174)", () => {
  it("names files from layout names, numbering clashes", () => {
    expect(fileNameFor("  Level Design / Audio! ", new Set())).toBe("level-design-audio.layout.json");
    expect(fileNameFor("Été", new Set())).toBe("ete.layout.json");
    expect(fileNameFor("!!!", new Set())).toBe("layout.layout.json");
    expect(fileNameFor("Custom", new Set())).toBe("custom.layout.json");
    expect(fileNameFor("Custom", new Set(["custom.layout.json"]))).toBe("custom-2.layout.json");
  });

  it("keeps versions as a tree: a save is a child of head, restore moves head, the next save branches", () => {
    const a = defaultLayout(catalog);
    let f = newLayoutFile("Custom", a, 1);
    f = addVersion(f, closePanel(a, instancesOf(a, "code")[0]!, catalog), 2);
    expect(f.head).toBe(2);
    expect(f.versions.map((v) => [v.seq, v.parent])).toEqual([[1, 0], [2, 1]]);
    f = restoreVersion(f, 1);
    expect(f.head).toBe(1);
    expect(instancesOf(layoutOf(f, catalog)!, "code")).toHaveLength(1);
    f = addVersion(f, closePanel(a, instancesOf(a, "history")[0]!, catalog), 3);
    expect(f.versions.map((v) => [v.seq, v.parent])).toEqual([[1, 0], [2, 1], [3, 1]]); // a new branch; version 2 is kept
    expect(restoreVersion(f, 99)).toBe(f);
  });

  it("prunes the oldest versions past the limit, never head or its ancestors", () => {
    const a = defaultLayout(catalog);
    let f = newLayoutFile("L", a, 0);
    for (let i = 1; i <= MAX_VERSIONS + 5; i++) f = addVersion(f, a, i);
    expect(f.versions).toHaveLength(MAX_VERSIONS);
    expect(f.versions.some((v) => v.seq === f.head)).toBe(true);
    // A branch: head on an old line keeps its ancestors; the old branch goes first, oldest first.
    let g = newLayoutFile("G", a, 0);
    g = addVersion(g, a, 1); // 2
    g = addVersion(g, a, 2); // 3
    g = restoreVersion(g, 1);
    for (let i = 3; g.versions.length < MAX_VERSIONS; i++) g = addVersion(g, a, i); // 4…, a line from 1
    expect(g.versions.map((v) => v.seq).slice(0, 3)).toEqual([1, 2, 3]);
    g = addVersion(g, a, 100);
    expect(g.versions.map((v) => v.seq).slice(0, 3)).toEqual([1, 3, 4]); // 2, the oldest off head's line
    g = addVersion(g, a, 101);
    expect(g.versions.map((v) => v.seq).slice(0, 2)).toEqual([1, 4]);
    expect(g.versions.find((v) => v.seq === 4)!.parent).toBe(1);
  });

  it("reads files back and rejects broken ones", () => {
    const f = newLayoutFile("Custom", defaultLayout(catalog), 5);
    expect(parseLayoutFile(JSON.stringify(f))).toEqual(f);
    expect(parseLayoutFile("nope")).toBeNull();
    expect(parseLayoutFile({ format: "myco.layout@1", name: "x", head: 1, versions: [] })).toBeNull();
    const badHead = { ...f, head: 42 };
    expect(parseLayoutFile(badHead)!.head).toBe(1);
  });

  it("lists a layout in both places once, with the newer copy", () => {
    const a = defaultLayout(catalog);
    const old: LayoutFile = newLayoutFile("Old name", a, 1);
    const newer: LayoutFile = addVersion({ ...old, name: "New name" }, a, 10);
    const list = mergeSaved(new Map([["x.layout.json", old], ["u.layout.json", old]]), new Map([["x.layout.json", newer]]));
    expect(list.map((s) => s.name)).toEqual(["New name", "Old name"]);
    expect(list[0]!.newest).toBe(newer);
    expect(list[0]!.user && list[0]!.project).toBeTruthy();
    expect(scopeLabel(["user", "project"])).toBe("User + Project");
    expect(scopeLabel(["project"])).toBe("Project");
  });

  it("tells whether the working layout still matches a file's head (ignoring sizes and instance ids)", () => {
    const a = defaultLayout(catalog);
    const f = newLayoutFile("L", a);
    expect(matchesHead(f, defaultLayout(catalog), catalog)).toBe(true);
    expect(matchesHead(f, closePanel(a, instancesOf(a, "code")[0]!, catalog), catalog)).toBe(false);
  });
});
