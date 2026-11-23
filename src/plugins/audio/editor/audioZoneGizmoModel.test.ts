// ADR 0347: the AudioZone gizmo's outline and the Inspector section's lines.
import { describe, expect, it } from "vitest";
import { UprightBox } from "../runtime/core/spatial";
import { audioZoneHeardLine, audioZoneNotices, audioZoneOutline } from "./audioZoneGizmoModel";

const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 6));

describe("audioZoneOutline", () => {
  it("draws the bottom and top rectangles and four edges, turned by the yaw", () => {
    const box = new UprightBox().set(10, 0, 4, 2, 90, 1, 5);
    const { volume, feather } = audioZoneOutline(box, "edge", 3);
    expect(volume).toHaveLength(6);
    expect(feather).toEqual([]);
    // Turned 90° right: the 4 m width lies along world z, the 2 m depth along world x.
    const bottom = volume[0]!;
    expect(bottom).toHaveLength(5);
    close(bottom[0]!, [11, 1, -2]);
    close(bottom[2]!, [9, 1, 2]);
    close(volume[1]![0]!, [11, 5, -2]);
    close(volume[2]![0]!, [11, 1, -2]);
    close(volume[2]![1]!, [11, 5, -2]);
  });

  it("an inside zone adds its feather ring at mid height", () => {
    const box = new UprightBox().set(0, 0, 2, 2, 0, 0, 4);
    const { feather } = audioZoneOutline(box, "inside", 3);
    expect(feather).toHaveLength(1);
    close(feather[0]![0]!, [4, 2, 4]);
    expect(audioZoneOutline(box, "inside", 0).feather).toEqual([]);
  });
});

describe("Inspector lines", () => {
  it("says how the zone is heard", () => {
    expect(audioZoneHeardLine({ heard: "inside", feather: 6 })).toContain("6 m");
    expect(audioZoneHeardLine({ heard: "edge", feather: 6 })).toContain("nearest point");
  });

  it("warns about a missing sound, a sound not in the project and a box without height", () => {
    const base = { sound: "", heard: "inside", bottom: 0, top: 10 } as const;
    expect(audioZoneNotices(base, null).map((n) => n.kind)).toEqual(["warning"]);
    expect(audioZoneNotices({ ...base, sound: "asset:rain.playlist.json" }, ["rain.playlist.json"])).toEqual([]);
    expect(audioZoneNotices({ ...base, sound: "x.wav" }, [])[0]!.text).toContain("not in the project");
    expect(audioZoneNotices({ ...base, sound: "x.wav", top: 0 }, null)[0]!.text).toContain("no height");
    expect(audioZoneNotices({ ...base, sound: "x.wav", heard: "edge" }, null)).toEqual([expect.objectContaining({ kind: "info" })]);
  });
});
