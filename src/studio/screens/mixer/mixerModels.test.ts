import { describe, expect, it } from "vitest";
import { audioProjectToJson, parseAudioProject } from "../../../engine/audio/project/format";
import type { AudioProject } from "../../../engine/audio/project/types";
import { addBus, addReturn, addVca, busFolders, busPath, deleteItem, descendantsOf, planDelete, renameItem, reroute, routingRows, whyNotReroute, whyNotRename, type EditResult } from "./busTree";
import { emptyMix, mixerFixture } from "./mixerFixture";
import { allocateBeds, bedText, seedVoiceLimit, setBed, setVoiceLimit, voiceLimitOf } from "./voicesAndBeds";

const ok = <T>(r: EditResult<T>): T => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};
const refused = <T>(r: EditResult<T>): string => ("refused" in r ? r.refused : "accepted");
/** The project round-trips through the file format unchanged (an edit never writes something the parse drops). */
const valid = (p: AudioProject) => {
  const back = parseAudioProject(audioProjectToJson(p));
  expect(back.problems).toEqual([]);
  expect(back.project).toEqual(p);
};

describe("routing tree", () => {
  it("lists buses depth first with paths and branches", () => {
    const p = mixerFixture();
    const rows = routingRows(p);
    expect(rows.map((r) => `${"  ".repeat(r.depth)}${r.name}`)).toEqual(["Master", "  SFX", "    Vehicles", "      Engine", "    Footsteps", "    Weapons", "  Ambience", "    Rain", "  Dialogue", "  Music", "  UI"]);
    expect(rows.find((r) => r.name === "Engine")!.branch).toBe("SFX");
    expect(busPath(p, "Engine")).toBe("SFX › Vehicles › Engine");
    expect(busPath(p, "Master")).toBe("Master");
    expect(routingRows(p, new Set(["SFX"])).map((r) => r.name)).toEqual(["Master", "SFX", "Ambience", "Rain", "Dialogue", "Music", "UI"]);
  });

  it("gives the routing tree as folder paths for Move to… (Master the root; a / in a name can't split a path)", () => {
    const p = ok(renameItem(mixerFixture(), "Rain", "Rain/Wind"));
    const t = busFolders(p);
    expect(t.pathOf("Master")).toBe("");
    expect(t.pathOf("Engine")).toBe("SFX/Vehicles/Engine");
    expect(t.pathOf("Rain/Wind")).toBe("Ambience/Rain∕Wind");
    expect(t.folders).toContain("Ambience/Rain∕Wind");
    expect(t.folders).not.toContain("");
    expect(t.busAt("Ambience/Rain∕Wind")).toBe("Rain/Wind");
    expect(t.busAt("")).toBe("Master");
    expect(t.busAt("Nope")).toBeNull();
  });

  it("refuses re-routing Master, onto itself, under a descendant, onto its current parent", () => {
    const p = mixerFixture();
    expect(whyNotReroute(p, "Master", "SFX")).toMatch(/Master/);
    expect(whyNotReroute(p, "SFX", "SFX")).toMatch(/itself/);
    expect(whyNotReroute(p, "SFX", "Engine")).toMatch(/under SFX/);
    expect(whyNotReroute(p, "Vehicles", "SFX")).toMatch(/already/);
    expect(whyNotReroute(p, "Vehicles", "Reverb")).toMatch(/isn't a bus/);
    const next = ok(reroute(p, "Vehicles", "Ambience"));
    expect(busPath(next, "Engine")).toBe("Ambience › Vehicles › Engine");
    expect(descendantsOf(next, "Ambience")).toEqual(["Vehicles", "Engine", "Rain"]);
    valid(next);
  });

  it("adds a bus inside the selection, uniquely named, after its subtree", () => {
    const p = mixerFixture();
    const a = ok(addBus(p, "Vehicles"));
    expect(a.name).toBe("New bus");
    expect(a.project.buses.map((b) => b.name).slice(2, 5)).toEqual(["Vehicles", "Engine", "New bus"]);
    const b = ok(addBus(a.project, "Reverb"));
    expect(b.name).toBe("New bus 2");
    expect(b.project.buses.find((x) => x.name === "New bus 2")!.parent).toBe("Master");
    valid(b.project);
    expect(ok(addReturn(p)).name).toBe("New return");
    expect(ok(addVca(p)).project.vcas.at(-1)).toEqual({ name: "New VCA", volumeDb: 0, members: [] });
  });

  it("renames with unique names across buses, returns and VCAs, rewriting every reference in the file", () => {
    const p = mixerFixture();
    expect(whyNotRename(p, "SFX", "Reverb")).toMatch(/taken/);
    expect(whyNotRename(p, "SFX", "Gameplay SFX")).toMatch(/taken/);
    expect(whyNotRename(p, "SFX", " ")).toMatch(/empty/);
    expect(whyNotRename(p, "Master", "Main")).toMatch(/Master/);
    const d = ok(renameItem(p, "Dialogue", "Voice"));
    expect(d.vcas.find((v) => v.name === "All voice")!.members).toEqual(["Voice"]);
    expect(d.ducking.map((r) => r.trigger)).toEqual(["Voice", "Voice", "Weapons"]);
    expect(d.buses.find((b) => b.name === "Music")!.effects[0]!.key).toBe("Voice");
    valid(d);
    const r = ok(renameItem(p, "Reverb", "Hall"));
    expect(r.buses.find((b) => b.name === "Vehicles")!.sends).toEqual([{ to: "Hall", levelDb: -12 }]);
    valid(r);
    const amb = ok(renameItem(p, "Ambience", "Amb"));
    expect(amb.snapshots.find((s) => s.name === "Underwater")!.effects).toEqual({ Amb: { fx1: { cutoff: 800 } } });
    expect(amb.automation.filter((a) => a.on === "Amb")).toHaveLength(2);
    expect(amb.buses.find((b) => b.name === "Rain")!.parent).toBe("Amb");
    valid(amb);
  });

  it("plans a delete listing what goes, and applies it in one edit", () => {
    const p = mixerFixture();
    expect(refused(planDelete(p, "Master"))).toMatch(/Master/);
    const plan = ok(planDelete(p, "Ambience"));
    expect(plan.movedChildren).toEqual(["Rain"]);
    expect(plan.lines).toEqual([
      "Rain moves up to Master",
      "Its 1 effect",
      "Its send to Reverb",
      "2 automation lanes",
      "Ducking: Dialogue ducks Ambience",
      "Ducking: Weapons ducks Ambience",
      "Its levels in 3 snapshots (Underwater, Pause menu, Low health)",
    ]);
    const next = ok(deleteItem(p, "Ambience"));
    expect(next.buses.find((b) => b.name === "Rain")!.parent).toBe("Master");
    expect(next.automation.some((a) => a.on === "Ambience")).toBe(false);
    expect(next.snapshots.find((s) => s.name === "Underwater")!.effects).toEqual({});
    valid(next);
    const dlg = ok(deleteItem(p, "Dialogue"));
    expect(dlg.buses.find((b) => b.name === "Music")!.effects[0]!.key).toBe("");
    expect(dlg.vcas.find((v) => v.name === "All voice")!.members).toEqual([]);
    valid(dlg);
    const rev = ok(deleteItem(p, "Reverb"));
    expect(rev.buses.every((b) => b.sends.length === 0)).toBe(true);
    valid(rev);
    expect(ok(planDelete(p, "Reverb")).lines).toContain("Sends to it from Vehicles, Ambience, Dialogue");
  });
});

describe("voice limits", () => {
  it("inherit the nearest ancestor's", () => {
    const p = mixerFixture();
    expect(voiceLimitOf(p, "SFX")).toMatchObject({ limit: 48, own: true, text: "48" });
    expect(voiceLimitOf(p, "Vehicles")).toMatchObject({ limit: 48, from: "SFX", own: false, text: "↑ 48" });
    expect(voiceLimitOf(p, "Engine").text).toBe("4");
    expect(voiceLimitOf(emptyMix(), "Master").text).toBe("∞");
    expect(seedVoiceLimit(p, "Vehicles")).toBe(48);
    expect(seedVoiceLimit(emptyMix(), "Master")).toBe(32);
  });
  it("set, clamped, and non-positive inherits", () => {
    const p = mixerFixture();
    expect(ok(setVoiceLimit(p, "Music", 8.4)).buses.find((b) => b.name === "Music")!.voiceLimit).toBe(8);
    expect(ok(setVoiceLimit(p, "Music", 99999)).buses.find((b) => b.name === "Music")!.voiceLimit).toBe(p.settings.voices.logical);
    expect(ok(setVoiceLimit(p, "SFX", 0)).buses.find((b) => b.name === "SFX")!.voiceLimit).toBeNull();
    expect(ok(setVoiceLimit(p, "SFX", 48))).toBe(p);
  });
});

describe("beds", () => {
  it("Master plus the maxBeds−1 highest priorities host; the rest share the nearest above", () => {
    const p = mixerFixture();
    const a = allocateBeds(p);
    expect(a.hosts).toEqual(["Master", "Ambience"]);
    expect(a.lost).toEqual(["Rain"]);
    expect(a.chip).toBe("Beds 2/2 · 1 sharing");
    expect(bedText(a.state.get("Rain"))).toBe("Lost · shares Ambience");
    expect(bedText(a.state.get("SFX"))).toBe("→ Master");
    expect(bedText(a.state.get("Ambience"))).toBe("Own · p80");
    const raised = ok(setBed(p, "Rain", "own", 90));
    expect(allocateBeds(raised).hosts).toEqual(["Master", "Rain"]);
    expect(bedText(allocateBeds(raised).state.get("Ambience"))).toBe("Lost · shares Master");
    const none = { ...p, settings: { ...p.settings, bed: { maxBeds: 0 } } };
    expect(allocateBeds(none).chip).toBe("No beds");
  });
  it("Master always owns; off and share", () => {
    const p = mixerFixture();
    expect(refused(setBed(p, "Master", "share"))).toMatch(/Master/);
    expect(ok(setBed(p, "Music", "off")).buses.find((b) => b.name === "Music")!.bed).toEqual({ own: false, priority: 128 });
    expect(ok(setBed(p, "Ambience", "share")).buses.find((b) => b.name === "Ambience")!.bed).toBeNull();
    valid(ok(setBed(p, "Music", "own", 300)));
  });
});
