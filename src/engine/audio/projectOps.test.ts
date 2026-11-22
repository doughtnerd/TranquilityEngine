// ADR 0330 "Live mixing": the mix model's own live ops (returns, VCAs, mute, sends, snapshot edits) through their
// interface — refusals, application, inverses, the byte form — and `diffProjectMix`, the Studio's live diff.
import { describe, expect, it } from "vitest";
import { MIX_OP_NAMES, applyOpToSettings, diffProjectMix, opClass, opRefusal, type MixOp } from "./mixOps";
import { decodeMixOp, encodeMixOp, type MixOpNameTable } from "./mixOpCodec";
import { applyOpToProject, invertProjectOp, isProjectOp, projectOpRefusal, PROJECT_OP_NAMES, type ProjectMixOp } from "./projectOps";
import { audioProjectToJson, parseAudioProject } from "./project/format";
import { coreSectionOf } from "./project/runtimeView";
import type { AudioProject } from "./project/types";
import { defaultAudioSettings } from "./settings";

const MIX = {
  format: "myco.audio@1",
  parameters: [{ name: "threat", min: 0, max: 1, default: 0 }],
  buses: [
    { name: "Master", parent: null },
    { name: "Music", parent: "Master", volumeDb: -2, effects: [{ id: "fx1", type: "lowpass", params: { cutoff: 18000 } }] },
    { name: "SFX", parent: "Master", sends: [{ to: "Reverb", levelDb: -12 }] },
  ],
  returns: [{ name: "Reverb", output: "Master", volumeDb: -3, effects: [{ id: "fx1", type: "reverb", params: { mix: 100 } }] }],
  vcas: [{ name: "All", volumeDb: -4, members: ["Music"] }],
  snapshots: [{ name: "Under", priority: 10, buses: { Music: -6 } }],
};
const project = (): AudioProject => {
  const r = parseAudioProject(MIX);
  expect(r.problems).toEqual([]);
  return r.project;
};
const json = (p: AudioProject) => JSON.stringify(audioProjectToJson(p));
const apply = (p: AudioProject, ops: readonly MixOp[]) => ops.reduce((q, op) => (isProjectOp(op) ? applyOpToProject(q, op) : q), p);

const CASES: [string, ProjectMixOp][] = [
  ["mute a return", { op: "setMute", name: "Reverb", value: true }],
  ["mute a bus", { op: "setMute", name: "Music", value: true }],
  ["add a return", { op: "setReturn", name: "Hall", ret: { name: "Hall", output: "Music", volumeDb: -6, mute: false, effects: [] } }],
  ["rename a return (its sends follow)", { op: "setReturn", name: "Room", from: "Reverb", ret: { name: "Room", output: "Master", volumeDb: -3, mute: false, effects: [] } }],
  ["remove a return (its sends go)", { op: "setReturn", name: "Reverb", ret: null }],
  ["set a send", { op: "setSend", bus: "SFX", to: "Reverb", levelDb: -6 }],
  ["add a send", { op: "setSend", bus: "Music", to: "Reverb", levelDb: -18 }],
  ["remove a send", { op: "setSend", bus: "SFX", to: "Reverb", levelDb: null }],
  ["set a VCA", { op: "setVca", name: "All", vca: { name: "All", volumeDb: -10, members: ["Music", "SFX"] } }],
  ["add a VCA", { op: "setVca", name: "Fx", vca: { name: "Fx", volumeDb: 2, members: ["SFX"] } }],
  ["remove a VCA", { op: "setVca", name: "All", vca: null }],
  ["add a snapshot", { op: "setSnapshotDef", name: "Duck", snapshot: { name: "Duck", folder: "", start: { kind: "base" }, fadeInMs: 100, fadeOutMs: 100, holdMs: 0, priority: 5, combine: "add", buses: { SFX: -3 }, effects: {} } }],
  ["rename a snapshot", { op: "setSnapshotDef", name: "Deep", from: "Under", snapshot: { name: "Deep", folder: "", start: { kind: "code" }, fadeInMs: 300, fadeOutMs: 300, holdMs: 0, priority: 10, combine: "override", buses: { Music: -6 }, effects: {} } }],
  ["remove a snapshot", { op: "setSnapshotDef", name: "Under", snapshot: null }],
  ["a snapshot level", { op: "setSnapshotLevel", snapshot: "Under", target: "Reverb", db: -9 }],
  ["unlist a snapshot level", { op: "setSnapshotLevel", snapshot: "Under", target: "Music", db: null }],
  ["a snapshot override", { op: "setSnapshotEffect", snapshot: "Under", target: "Music", effect: "fx1", param: "cutoff", value: 900 }],
];

const table = (): MixOpNameTable & { name(id: number): string; bus(ref: number): string } => {
  const names: string[] = [];
  const id = (n: string) => (names.includes(n) ? names.indexOf(n) : names.push(n) - 1);
  return { nameId: id, busRef: id, name: (i) => names[i]!, bus: (i) => names[i]! };
};

describe("project ops (ADR 0330)", () => {
  it("are appended to the op names, and the old section refuses them", () => {
    expect(MIX_OP_NAMES.slice(-PROJECT_OP_NAMES.length)).toEqual([...PROJECT_OP_NAMES]);
    const a = defaultAudioSettings();
    const op: MixOp = { op: "setMute", name: "Music", value: true };
    expect(opRefusal(a, op)).toMatch(/audio\.json/);
    expect(applyOpToSettings(a, op)).toBe(a);
    expect(opClass(op, a)).toBe("none");
  });

  it.each(CASES)("%s: applies, inverts, and round-trips its byte form", (_label, op) => {
    const p = project();
    expect(projectOpRefusal(p, op)).toBeNull();
    const next = applyOpToProject(p, op);
    expect(next).not.toBe(p);
    expect(parseAudioProject(audioProjectToJson(next)).problems).toEqual([]);
    expect(json(apply(next, invertProjectOp(op, p)))).toBe(json(p));
    expect(applyOpToProject(next, op)).toBe(next); // again: no change
    const t = table();
    const bytes = encodeMixOp(op, "direct", t);
    expect(bytes.op).toBe(MIX_OP_NAMES.indexOf(op.op));
    expect(decodeMixOp({ ...bytes, words: Uint32Array.from(bytes.words) }, t)).toEqual({ op, class: "direct" });
  });

  it("a rename carries every reference; a removal drops what named it", () => {
    const renamed = applyOpToProject(project(), CASES[3]![1]);
    expect(renamed.buses.find((b) => b.name === "SFX")!.sends).toEqual([{ to: "Room", levelDb: -12 }]);
    const removed = applyOpToProject(project(), CASES[4]![1]);
    expect(removed.buses.find((b) => b.name === "SFX")!.sends).toEqual([]);
  });

  it.each([
    [{ op: "setMute", name: "Nope", value: true }, /No bus or return/],
    [{ op: "setSend", bus: "Master", to: "Reverb", levelDb: 0 }, /can't send/],
    [{ op: "setSend", bus: "SFX", to: "Music", levelDb: 0 }, /No return/],
    [{ op: "setReturn", name: "Music", ret: { name: "Music", output: "Master", volumeDb: 0, mute: false, effects: [] } }, /already named/],
    [{ op: "setReturn", name: "Hall", ret: { name: "Hall", output: "Nowhere", volumeDb: 0, mute: false, effects: [] } }, /output must be a bus/],
    [{ op: "setVca", name: "V", vca: { name: "V", volumeDb: 0, members: ["Reverb"] } }, /members must be buses/],
    [{ op: "setSnapshotDef", name: "X", from: "Nope", snapshot: { name: "X", folder: "", start: { kind: "code" }, fadeInMs: 0, fadeOutMs: 0, holdMs: 0, priority: 0, combine: "override", buses: {}, effects: {} } }, /No snapshot/],
    [{ op: "setSnapshotEffect", snapshot: "Under", target: "SFX", effect: "fx1", param: "cutoff", value: 1 }, /no effect/],
  ] as [ProjectMixOp, RegExp][])("refuses %j", (op, why) => {
    const p = project();
    expect(projectOpRefusal(p, op)).toMatch(why);
    expect(applyOpToProject(p, op)).toBe(p);
  });

  it("diffProjectMix: the old ops for the bus tree and levels, then the project ops; applied in order they reach `after`", () => {
    const before = project();
    let after = applyOpToProject(before, { op: "setReturn", name: "Hall", ret: { name: "Hall", output: "Master", volumeDb: -6, mute: false, effects: [] } });
    after = applyOpToProject(after, { op: "setSend", bus: "Music", to: "Hall", levelDb: -10 });
    after = applyOpToProject(after, { op: "setVca", name: "All", vca: null });
    after = applyOpToProject(after, { op: "setSnapshotLevel", snapshot: "Under", target: "Hall", db: -3 });
    after = { ...after, buses: after.buses.map((b) => (b.name === "Music" ? { ...b, volumeDb: -8 } : b)) };
    const { ops, restartRequired } = diffProjectMix(before, after);
    expect(restartRequired).toEqual([]);
    const old = ops.filter((o) => !isProjectOp(o));
    expect(old).toEqual([{ op: "setBus", bus: "Music", key: "volume", value: coreSectionOf(after).buses[1]!.volume }]);
    expect(ops.filter(isProjectOp).map((o) => o.op)).toEqual(["setReturn", "setSend", "setVca", "setSnapshotDef"]);
    // The project ops alone take the mid-point (the old ops applied) to `after`.
    const mid = { ...before, buses: before.buses.map((b) => (b.name === "Music" ? { ...b, volumeDb: -8 } : b)) };
    expect(json(apply(mid, ops))).toBe(json(after));
  });
});
