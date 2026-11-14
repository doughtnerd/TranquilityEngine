import { describe, expect, it } from "vitest";
import { closePanel, defaultLayout, instancesOf } from "./model";
import { MAX_VERSIONS, addVersion, fileNameFor, layoutOf, matchesHead, mergeSaved, newLayoutFile, parseLayoutFile, pruneVersions, restoreVersion, scopeLabel, slugOf, type LayoutFile } from "./saved";

describe("layout files (ADR 0174)", () => {
  it("names files from layout names, numbering clashes", () => {
    expect(slugOf("Custom")).toBe("custom");
    expect(slugOf("  Level Design / Audio! ")).toBe("level-design-audio");
    expect(slugOf("Été")).toBe("ete");
    expect(slugOf("!!!")).toBe("layout");
    expect(fileNameFor("Custom", new Set())).toBe("custom.layout.json");
    expect(fileNameFor("Custom", new Set(["custom.layout.json"]))).toBe("custom-2.layout.json");
  });

  it("keeps versions as a tree: a save is a child of head, restore moves head, the next save branches", () => {
    const a = defaultLayout();
    let f = newLayoutFile("Custom", a, 1);
    f = addVersion(f, closePanel(a, instancesOf(a, "code")[0]!), 2);
    expect(f.head).toBe(2);
    expect(f.versions.map((v) => [v.seq, v.parent])).toEqual([[1, 0], [2, 1]]);
    f = restoreVersion(f, 1);
    expect(f.head).toBe(1);
    expect(instancesOf(layoutOf(f)!, "code")).toHaveLength(1);
    f = addVersion(f, closePanel(a, instancesOf(a, "history")[0]!), 3);
    expect(f.versions.map((v) => [v.seq, v.parent])).toEqual([[1, 0], [2, 1], [3, 1]]); // a new branch; version 2 is kept
    expect(restoreVersion(f, 99)).toBe(f);
  });

  it("prunes the oldest versions past the limit, never head or its ancestors", () => {
    const a = defaultLayout();
    let f = newLayoutFile("L", a, 0);
    for (let i = 1; i <= MAX_VERSIONS + 5; i++) f = addVersion(f, a, i);
    expect(f.versions).toHaveLength(MAX_VERSIONS);
    expect(f.versions.some((v) => v.seq === f.head)).toBe(true);
    // A branch: head on an old line keeps its ancestors.
    let g = newLayoutFile("G", a, 0);
    g = addVersion(g, a, 1); // 2
    g = addVersion(g, a, 2); // 3
    g = restoreVersion(g, 1);
    g = addVersion(g, a, 3); // 4, child of 1
    const pruned = pruneVersions(g, 2);
    expect(pruned.versions.map((v) => v.seq).sort()).toEqual([1, 4]);
    expect(pruned.versions.find((v) => v.seq === 4)!.parent).toBe(1);
  });

  it("reads files back and rejects broken ones", () => {
    const f = newLayoutFile("Custom", defaultLayout(), 5);
    expect(parseLayoutFile(JSON.stringify(f))).toEqual(f);
    expect(parseLayoutFile("nope")).toBeNull();
    expect(parseLayoutFile({ format: "myco.layout@1", name: "x", head: 1, versions: [] })).toBeNull();
    const badHead = { ...f, head: 42 };
    expect(parseLayoutFile(badHead)!.head).toBe(1);
  });

  it("lists a layout in both places once, with the newer copy", () => {
    const a = defaultLayout();
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
    const a = defaultLayout();
    const f = newLayoutFile("L", a);
    expect(matchesHead(f, defaultLayout())).toBe(true);
    expect(matchesHead(f, closePanel(a, instancesOf(a, "code")[0]!))).toBe(false);
  });
});
