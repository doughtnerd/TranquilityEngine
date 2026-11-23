import { describe, expect, it } from "vitest";
import { audioProjectToJson, parseAudioProject } from "../../../engine/audio/project/format";
import { BRANCH_COLOURS, busColour, defaultBusColour, dragHint, kindBadge, MASTER_COLOUR, playlistName, RETURN_COLOUR, rowMeta, setBusColour, stripKind, usedBy, VCA_COLOUR } from "./busRows";
import type { EditResult } from "./busTree";
import { mixerFixture } from "./mixerFixture";
import { pushReading, sparkline } from "./loudnessHistory";
import { allocateBeds, bedCell, bedsTitle, bedText, bedTitle, setBed, voiceLimitOf } from "./voicesAndBeds";

const ok = <T>(r: EditResult<T>): T => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};

describe("bus colours (spec §2.9)", () => {
  it("each top-level branch takes the next colour; buses inside follow; Master, returns and VCAs have their own", () => {
    const p = mixerFixture();
    expect(busColour(p, "Master")).toBe(MASTER_COLOUR);
    expect(busColour(p, "SFX")).toBe(BRANCH_COLOURS[0]);
    expect(busColour(p, "Engine")).toBe(BRANCH_COLOURS[0]);
    expect(busColour(p, "Ambience")).toBe(BRANCH_COLOURS[1]);
    expect(busColour(p, "Rain")).toBe(BRANCH_COLOURS[1]);
    expect(busColour(p, "Dialogue")).toBe(BRANCH_COLOURS[2]);
    expect(busColour(p, "Reverb")).toBe(RETURN_COLOUR);
    expect(busColour(p, "Gameplay SFX")).toBe(VCA_COLOUR);
  });
  it("a bus's own colour wins and colours the buses inside it; Reset goes back to the branch's; it is saved", () => {
    const p = ok(setBusColour(mixerFixture(), "Vehicles", "#ff8800"));
    expect(busColour(p, "Vehicles")).toBe("#ff8800");
    expect(busColour(p, "Engine")).toBe("#ff8800");
    expect(busColour(p, "Footsteps")).toBe(BRANCH_COLOURS[0]);
    expect(defaultBusColour(p, "Vehicles")).toBe(BRANCH_COLOURS[0]);
    const back = parseAudioProject(audioProjectToJson(p));
    expect(back.problems).toEqual([]);
    expect(back.project).toEqual(p);
    const reset = ok(setBusColour(p, "Vehicles", null));
    expect(reset.buses.find((b) => b.name === "Vehicles")).not.toHaveProperty("colour");
  });
});

describe("row meta and strip kinds (spec §4.3.3)", () => {
  it("says the effects and automation, what's folded inside, a return's sends and a VCA's buses", () => {
    const p = mixerFixture();
    expect(rowMeta(p, "Ambience").text).toBe("fx 1 · auto 2");
    expect(rowMeta(p, "Music").text).toBe("fx 1 · auto 1");
    expect(rowMeta(p, "Footsteps").text).toBe("");
    expect(rowMeta(p, "SFX", true).text).toBe("+4 inside");
    expect(rowMeta(p, "Reverb").text).toBe("fx 1 · ← 3 sends");
    expect(rowMeta(p, "Reverb").title).toBe("Fed by sends from Vehicles, Ambience, Dialogue");
    expect(rowMeta(p, "Gameplay SFX").text).toBe("3 buses");
    expect(rowMeta(p, "All voice").text).toBe("1 bus");
  });
  it("names a strip's kind and the Inspector's badge", () => {
    const p = mixerFixture();
    expect([stripKind(p, "Master"), stripKind(p, "SFX"), stripKind(p, "Vehicles"), stripKind(p, "Reverb")]).toEqual(["Output", "Bus · to Master", "Bus · in SFX", "Return"]);
    expect([kindBadge(p, "Master"), kindBadge(p, "Music"), kindBadge(p, "Reverb"), kindBadge(p, "All voice")]).toEqual(["Output", "Bus", "Return", "VCA"]);
  });
  it("words the re-route drag's hint", () => {
    expect(dragHint("Weapons", "Ambience", null)).toEqual({ text: "Drop: route Weapons into Ambience", refused: false });
    expect(dragHint("Weapons", "SFX", "Weapons already feeds SFX")).toEqual({ text: "Can't route Weapons there: Weapons already feeds SFX", refused: true });
    expect(dragHint("SFX", null, null).text).toBe("Drop on a bus to route SFX into it");
  });
});

describe("voices and beds in the spec's notation", () => {
  it("shows inherited limits with ↑ and beds as → host, Own · pN, and lost in warning words", () => {
    const p = mixerFixture();
    expect(voiceLimitOf(p, "Vehicles").text).toBe("↑ 48");
    const a = allocateBeds(p);
    expect(bedCell(a.state.get("Master"), true)).toBe("Own · base");
    expect(bedCell(a.state.get("Ambience"))).toBe("Own · p80");
    expect(bedCell(a.state.get("SFX"))).toBe("→ Master");
    expect(bedCell(a.state.get("Rain"))).toBe("→ Ambience · p60");
    expect(bedText(a.state.get("Master"), true)).toBe("Base bed");
    expect(bedTitle(a.state.get("Rain"), false, a.maxBeds)).toBe("Asks for its own bed (priority 60) but lost: only 2 beds exist. Shares Ambience bed instead.");
    expect(bedsTitle(a)).toBe("Beds: Master, Ambience. Max beds (2) is a project setting. Master always hosts one; the rest go to the buses that ask, by priority. Lost and sharing: Rain → Ambience.");
    expect(bedsTitle(allocateBeds(ok(setBed(p, "Rain", "share"))))).not.toMatch(/Lost/);
  });
});

describe("Used by (spec §4.3.4)", () => {
  it("lists the playlists routed straight to a bus, sorted, and counts those routed to buses inside it", () => {
    const p = mixerFixture();
    const files: Record<string, string[]> = {
      SFX: ["audio/b.playlist.json", "scenes/level.scene.json", "audio/a.playlist.json"],
      Vehicles: ["audio/car.playlist.json", "audio/a.playlist.json"],
      Engine: ["audio/engine.playlist.json"],
    };
    const u = usedBy(p, "SFX", (b) => files[b] ?? [], (f) => f.endsWith(".playlist.json"));
    expect(u).toEqual({ direct: ["audio/a.playlist.json", "audio/b.playlist.json"], inside: 2 });
    expect(usedBy(p, "UI", () => [], () => true)).toEqual({ direct: [], inside: 0 });
    expect(playlistName("audio/music/Theme.playlist.json")).toBe("Theme");
  });
});

describe("the loudness graph (spec §4.3.6)", () => {
  it("keeps the last 60 s, at most two samples a second, and skips silence", () => {
    let h = pushReading([], 0, -20);
    h = pushReading(h, 0.2, -19);
    h = pushReading(h, 0.6, null);
    h = pushReading(h, 1, -18);
    expect(h.map((x) => x.lufs)).toEqual([-20, -18]);
    h = pushReading(h, 60.5, -16);
    expect(h.map((x) => x.t)).toEqual([1, 60.5]);
  });
  it("draws the newest at the right edge and the target as a level line", () => {
    const s = sparkline([{ t: 30, lufs: -24 }, { t: 60, lufs: -6 }], 60, -24);
    expect(s.points).toEqual([[300, 25], [600, 0]]);
    expect(s.target).toBe(25);
    expect(sparkline([], 10, null)).toEqual({ points: [], target: null });
  });
});
