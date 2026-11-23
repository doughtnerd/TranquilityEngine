import { describe, expect, it } from "vitest";
import { audioProjectToJson, parseAudioProject } from "../../../engine/audio/project/format";
import type { AudioProject, Snapshot } from "../../../engine/audio/project/types";
import type { EditResult } from "./busTree";
import { mixerFixture } from "./mixerFixture";
import { BOOL_OPS, conditionHolds, opIndex, opsFor, overlapsOf, resolveSnapshots, retarget, startHolds, TEXT_OPS, triggerSummary, triggerText, withOp } from "./snapshotBlend";
import { addFolder, deleteFolder, deleteSnapshot, duplicateSnapshot, followFolder, moveFolder, movedFolderPath, moveSnapshot, newFolderPath, newSnapshot, renameFolder, renameSnapshot, searchSnapshots, snapshotFolders, snapshotTree } from "./snapshotTree";

const ok = <T>(r: EditResult<T>): T => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};
const refused = <T>(r: EditResult<T>): string => ("refused" in r ? r.refused : "accepted");
const valid = (p: AudioProject) => {
  const back = parseAudioProject(audioProjectToJson(p));
  expect(back.problems).toEqual([]);
  expect(back.project).toEqual(p);
};
const snap = (s: Partial<Snapshot> & { name: string }): Snapshot => ({ folder: "", start: { kind: "code" }, fadeInMs: 300, fadeOutMs: 300, holdMs: 0, priority: 0, combine: "override", buses: {}, effects: {}, ...s });

describe("conditions", () => {
  const p = mixerFixture();
  it("evaluate numbers and labels against test values (defaults when unset)", () => {
    expect(conditionHolds({ parameter: "depth", op: "gt", value: 0 }, p.parameters, {})).toBe(false);
    expect(conditionHolds({ parameter: "depth", op: "gt", value: 0 }, p.parameters, { depth: 3 })).toBe(true);
    expect(conditionHolds({ parameter: "health", op: "between", value: 30, value2: 10 }, p.parameters, { health: 20 })).toBe(true);
    expect(conditionHolds({ parameter: "gameState", op: "is", value: "Paused" }, p.parameters, { gameState: 1 })).toBe(true);
    expect(conditionHolds({ parameter: "gameState", op: "not", value: "Paused" }, p.parameters, {})).toBe(true);
    expect(conditionHolds({ parameter: "gameState", op: "gt", value: 0 }, p.parameters, { gameState: 2 })).toBe(false);
    expect(conditionHolds({ parameter: "nope", op: "gt", value: 0 }, p.parameters, {})).toBe(false);
  });
  it("starts: base always, code and never off, all / any", () => {
    expect(startHolds({ kind: "base" }, p.parameters, {})).toBe(true);
    expect(startHolds({ kind: "code" }, p.parameters, {})).toBe(false);
    const any = { kind: "conditions" as const, match: "any" as const, conditions: [{ parameter: "depth", op: "gt" as const, value: 0 }, { parameter: "health", op: "lt" as const, value: 20 }] };
    expect(startHolds(any, p.parameters, { health: 10 })).toBe(true);
    expect(startHolds({ ...any, match: "all" }, p.parameters, { health: 10 })).toBe(false);
    expect(triggerText(any)).toBe("depth > 0 or health < 20");
    expect(triggerSummary(any)).toBe("depth > 0 or 1 more");
    expect(triggerSummary({ kind: "never" })).toBe("Never (audition only)");
  });
  it("true / false and text parameters: their comparisons, defaults and words (spec §2.10)", () => {
    const combat = p.parameters.find((q) => q.name === "inCombat")!;
    const surface = p.parameters.find((q) => q.name === "surface")!;
    expect(opsFor(combat).map((o) => o.label)).toEqual(["is true", "is false"]);
    expect(opsFor(surface).map((o) => o.label)).toEqual(["is", "is not", "contains", "starts with"]);
    expect(opsFor(p.parameters.find((q) => q.name === "health")).map((o) => o.label)).toEqual(["is below", "is at most", "equals", "is not", "is at least", "is above", "is between"]);
    const c = retarget({ parameter: "depth", op: "gt", value: 0 }, combat);
    expect(c).toEqual({ parameter: "inCombat", op: "is", value: "true" });
    expect(conditionHolds(c, p.parameters, {})).toBe(false);
    expect(conditionHolds(c, p.parameters, { inCombat: 1 })).toBe(true);
    const off = withOp(c, BOOL_OPS[1]!);
    expect(opIndex(off, combat)).toBe(1);
    expect(conditionHolds(off, p.parameters, {})).toBe(true);
    const has = withOp({ parameter: "surface", op: "is", value: "rav" }, TEXT_OPS[2]!);
    expect(conditionHolds(has, p.parameters, { surface: 1 })).toBe(true);
    expect(conditionHolds(has, p.parameters, { surface: 0 })).toBe(false);
    expect(conditionHolds({ parameter: "surface", op: "starts", value: "wo" }, p.parameters, { surface: 2 })).toBe(true);
    const start = { kind: "conditions" as const, match: "any" as const, conditions: [has, c] };
    expect(triggerText(start, p.parameters)).toBe('surface contains "rav" or inCombat is true');
    expect(triggerSummary(start, p.parameters)).toBe('surface contains "rav" or 1 more');
  });
});

describe("snapshot resolution (ADR 0344)", () => {
  it("override snapshots resolve per bus by priority; Add stacks on top", () => {
    const r = resolveSnapshots([
      { snapshot: snap({ name: "Underwater", priority: 20, buses: { Music: -6, Ambience: -20 } }) },
      { snapshot: snap({ name: "Pause", priority: 40, buses: { Music: -14 } }) },
      { snapshot: snap({ name: "Tension", combine: "add", buses: { Music: -2 } }) },
    ]);
    expect(r.levels).toEqual({ Music: -16, Ambience: -20 });
    expect(r.sources.Music).toEqual([{ name: "Pause", how: "override" }, { name: "Tension", how: "add" }]);
  });
  it("equal priority: the one started last wins", () => {
    const a = snap({ name: "A", priority: 10, buses: { Music: -6 } });
    const b = snap({ name: "B", priority: 10, buses: { Music: -12 } });
    expect(resolveSnapshots([{ snapshot: a }, { snapshot: b }]).levels.Music).toBe(-12);
    expect(resolveSnapshots([{ snapshot: b }, { snapshot: a }]).levels.Music).toBe(-6);
  });
  it("a snapshot affects only what it lists, scales with its fade, and Add never overrides parameters", () => {
    const low = snap({ name: "Low", priority: 5, buses: { Music: -6 }, effects: { Music: { fx1: { cutoff: 800 } } } });
    const high = snap({ name: "High", priority: 50, buses: { SFX: -10 } });
    const add = snap({ name: "Add", combine: "add", effects: { Music: { fx1: { cutoff: 200 } } } });
    const r = resolveSnapshots([{ snapshot: low, weight: 0.5 }, { snapshot: high }, { snapshot: add }], () => 20000);
    expect(r.levels).toEqual({ Music: -3, SFX: -10 });
    expect(r.effects.Music!.fx1!.cutoff).toEqual({ value: 10400, from: "Low" });
  });
  it("lists overlaps with the outcome and a warning for equal priorities", () => {
    const p = mixerFixture();
    const o = overlapsOf(p.snapshots, "Underwater", p.parameters, { health: 5 });
    expect(o.map((x) => [x.name, x.shared, x.outcome, x.warn, x.onNow, x.priority, x.changes])).toEqual([
      ["Pause menu", ["Ambience", "Music"], "Pause menu wins (priority 40 over 20).", false, false, 40, ["SFX", "Ambience", "Music"]],
      ["Cinematic", ["Footsteps"], "Cinematic wins (priority 30 over 20).", false, false, 30, ["Footsteps", "Weapons", "UI"]],
      ["Low health", ["Ambience", "Music"], "Underwater wins (priority 20 over 10).", false, true, 10, ["Ambience", "Music"]],
    ]);
    // Shared effect parameters are named in words, never by internal ids.
    const both = [...p.snapshots, { ...p.snapshots.find((s) => s.name === "Underwater")!, name: "Deep", priority: 5 }];
    expect(overlapsOf(both, "Underwater", p.parameters, {}, undefined, (bus, id, param) => `${bus} › ${id === "fx1" ? "Low-pass" : id} ${param}`).find((x) => x.name === "Deep")!.shared).toContain("Ambience › Low-pass cutoff");
    const draft = { ...p.snapshots.find((s) => s.name === "Underwater")!, priority: 40 };
    expect(overlapsOf(p.snapshots, "Underwater", p.parameters, {}, draft)[0]).toMatchObject({ warn: true, outcome: "Same priority (40): the one started last wins." });
    const addDraft = { ...draft, combine: "add" as const };
    expect(overlapsOf(p.snapshots, "Underwater", p.parameters, {}, addDraft)[0]!.outcome).toBe("Underwater adds its levels on top of Pause menu.");
  });
});

describe("snapshot tree", () => {
  it("folders first, then snapshots, alphabetically; search by name and trigger", () => {
    const p = mixerFixture();
    const tree = snapshotTree(p);
    expect(tree.map((n) => (n.kind === "folder" ? `${n.name}/` : n.name))).toEqual(["Cutscenes/", "States/", "Gameplay"]);
    expect(searchSnapshots(p.snapshots, "depth").map((s) => s.path)).toEqual(["States/Underwater"]);
    expect(searchSnapshots(p.snapshots, "base").map((s) => s.name)).toEqual(["Gameplay"]);
    expect(searchSnapshots(p.snapshots, "e").map((s) => s.name)).toEqual(["Cinematic", "Gameplay", "Low health", "Pause menu", "Underwater"]);
    const deep = ok(addFolder(p, "States"));
    expect(deep.path).toBe("States/New folder");
    expect(snapshotTree(deep.project).find((n) => n.kind === "folder" && n.name === "States")).toMatchObject({ count: 4, children: [{ kind: "folder", name: "New folder" }, { name: "Low health" }, { name: "Pause menu" }, { name: "Underwater" }] });
  });
  it("new, rename, duplicate, move, delete", () => {
    const p = mixerFixture();
    const n = ok(newSnapshot(p, "States"));
    expect(n.name).toBe("New snapshot");
    expect(n.project.snapshots.at(-1)).toMatchObject({ folder: "States", start: { kind: "code" } });
    expect(refused(renameSnapshot(p, "Underwater", "Pause menu"))).toMatch(/another/);
    expect(ok(renameSnapshot(p, "Underwater", "Submerged")).snapshots[1]!.name).toBe("Submerged");
    const d = ok(duplicateSnapshot(p, "Gameplay"));
    expect(d.name).toBe("Gameplay copy");
    expect(d.project.snapshots[1]).toMatchObject({ name: "Gameplay copy", start: { kind: "code" } });
    expect(refused(moveSnapshot(p, "Underwater", "States"))).toMatch(/already/);
    expect(ok(moveSnapshot(p, "Underwater", "")).snapshots[1]!.folder).toBe("");
    expect(ok(deleteSnapshot(p, "Cinematic")).snapshots.map((s) => s.name)).not.toContain("Cinematic");
    valid(d.project);
  });
  it("a folder emptied by a move or a delete stays, saved in the file", () => {
    const p = ok(deleteSnapshot(mixerFixture(), "Cinematic"));
    expect(snapshotFolders(p)).toContain("Cutscenes");
    expect(p.snapshotFolders).toEqual(["Cutscenes"]);
    valid(p);
    // Moving a snapshot back in makes it a folder with something in it again (no longer listed as empty).
    const back = ok(moveSnapshot(p, "Gameplay", "Cutscenes"));
    expect(back.snapshotFolders).toBeUndefined();
    valid(back);
  });
  it("folders: new, rename, move and delete (contents move up), each an edit of the file", () => {
    const p = ok(moveSnapshot(mixerFixture(), "Underwater", "States/Water"));
    const r = ok(renameFolder(p, "States", "Game states"));
    expect(r.path).toBe("Game states");
    expect(r.project.snapshots.find((s) => s.name === "Underwater")!.folder).toBe("Game states/Water");
    expect(refused(renameFolder(p, "States", "Cutscenes"))).toMatch(/already/);
    expect(refused(renameFolder(p, "States", "a/b"))).toMatch(/can't/);
    expect(refused(moveFolder(p, "States", "States/Water"))).toMatch(/itself/);
    expect(ok(moveFolder(p, "States/Water", "Cutscenes")).project.snapshots.find((s) => s.name === "Underwater")!.folder).toBe("Cutscenes/Water");
    const del = ok(deleteFolder(p, "States"));
    expect(del.snapshots.find((s) => s.name === "Underwater")!.folder).toBe("Water");
    expect(del.snapshots.find((s) => s.name === "Low health")!.folder).toBe("");
    expect(newFolderPath(p, "States")).toBe("States/New folder");
  });
  it("an empty folder renames, moves and deletes in place: no placeholder left, and what's inside follows (MX-41)", () => {
    const made = ok(addFolder(mixerFixture(), ""));
    const deep = ok(addFolder(made.project, made.path));
    expect(deep.project.snapshotFolders).toEqual(["New folder/New folder"]);
    const renamed = ok(renameFolder(deep.project, "New folder", " Combat "));
    expect(renamed.path).toBe("Combat");
    expect(snapshotFolders(renamed.project)).toEqual(["Combat", "Combat/New folder", "Cutscenes", "States"]);
    valid(renamed.project);
    const moved = ok(moveFolder(renamed.project, "Combat", "States"));
    expect(moved.path).toBe("States/Combat");
    expect(snapshotFolders(moved.project)).toEqual(["Cutscenes", "States", "States/Combat", "States/Combat/New folder"]);
    expect(snapshotFolders(ok(deleteFolder(moved.project, "States/Combat")))).toEqual(["Cutscenes", "States", "States/New folder"]);
    expect(refused(renameFolder(made.project, "New folder", "States"))).toMatch(/already/);
  });
  it("a selected folder follows a rename, a move and a delete", () => {
    expect(followFolder("States/Water", "States", "Game states")).toBe("Game states/Water");
    expect(followFolder("Cutscenes", "States", "Game states")).toBe("Cutscenes");
    expect(followFolder("States/Water", "States", "")).toBe("Water");
    expect(followFolder("States", "States", "")).toBe("");
    expect(movedFolderPath("States/Water", "Cutscenes")).toBe("Cutscenes/Water");
    expect(movedFolderPath("States/Water", "")).toBe("Water");
    expect(refused(moveFolder(mixerFixture(), "Empty", "States"))).toMatch(/no folder/);
  });
});
