import { describe, expect, it } from "vitest";
import { audioProjectToJson, parseAudioProject } from "../../../engine/audio/project/format";
import type { AudioProject, Snapshot } from "../../../engine/audio/project/types";
import type { EditResult } from "./busTree";
import { mixerFixture } from "./mixerFixture";
import { conditionHolds, overlapsOf, resolveSnapshots, startHolds, triggerText } from "./snapshotBlend";
import { deleteFolder, deleteSnapshot, duplicateSnapshot, moveFolder, moveSnapshot, newFolderPath, newSnapshot, renameFolder, renameSnapshot, searchSnapshots, snapshotTree } from "./snapshotTree";

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
    expect(o.map((x) => [x.name, x.shared, x.outcome, x.warn, x.onNow])).toEqual([
      ["Pause menu", ["Ambience", "Music"], "Pause menu wins (priority 40 over 20).", false, false],
      ["Cinematic", ["Footsteps"], "Cinematic wins (priority 30 over 20).", false, false],
      ["Low health", ["Ambience", "Music"], "Underwater wins (priority 20 over 10).", false, true],
    ]);
    const draft = { ...p.snapshots.find((s) => s.name === "Underwater")!, priority: 40 };
    expect(overlapsOf(p.snapshots, "Underwater", p.parameters, {}, draft)[0]).toMatchObject({ warn: true, outcome: "Same priority (40): the one started last wins." });
    const addDraft = { ...draft, combine: "add" as const };
    expect(overlapsOf(p.snapshots, "Underwater", p.parameters, {}, addDraft)[0]!.outcome).toBe("Underwater adds its levels on top of Pause menu.");
  });
});

describe("snapshot tree", () => {
  it("folders first, then snapshots; search by name and trigger", () => {
    const p = mixerFixture();
    const tree = snapshotTree(p.snapshots);
    expect(tree.map((n) => (n.kind === "folder" ? `${n.name}/` : n.name))).toEqual(["Cutscenes/", "States/", "Gameplay"]);
    expect(searchSnapshots(p.snapshots, "depth").map((s) => s.path)).toEqual(["States/Underwater"]);
    expect(searchSnapshots(p.snapshots, "base").map((s) => s.name)).toEqual(["Gameplay"]);
    expect(snapshotTree(p.snapshots, ["States/Deep"]).find((n) => n.kind === "folder" && n.name === "States")).toMatchObject({ children: [{ kind: "folder", name: "Deep" }, { name: "Underwater" }, { name: "Pause menu" }, { name: "Low health" }] });
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
  it("folders rename, move and delete (contents move up)", () => {
    const p = ok(moveSnapshot(mixerFixture(), "Underwater", "States/Water"));
    expect(ok(renameFolder(p, "States", "Game states")).snapshots.find((s) => s.name === "Underwater")!.folder).toBe("Game states/Water");
    expect(refused(renameFolder(p, "States", "Cutscenes"))).toMatch(/already/);
    expect(refused(moveFolder(p, "States", "States/Water"))).toMatch(/itself/);
    expect(ok(moveFolder(p, "States/Water", "Cutscenes")).snapshots.find((s) => s.name === "Underwater")!.folder).toBe("Cutscenes/Water");
    const del = ok(deleteFolder(p, "States"));
    expect(del.snapshots.find((s) => s.name === "Underwater")!.folder).toBe("Water");
    expect(del.snapshots.find((s) => s.name === "Low health")!.folder).toBe("");
    expect(newFolderPath(p, "States")).toBe("States/New folder");
  });
});
