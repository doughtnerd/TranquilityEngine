// ADR 0362 item 4: folder colours in the project's Studio settings (`audio.json` `studio.folderColours`) — set, clear,
// follow a rename or move, and the file's round trip.
import { describe, expect, it } from "vitest";
import { audioProjectToJson, defaultAudioProject, parseAudioProject } from "../../../engine/audio/project/format";
import type { AudioProject } from "../../../engine/audio/project/types";
import { folderColour, folderColourCss, moveFolderColours, setFolderColour } from "./folderColours";

const next = (r: { next: AudioProject } | { refused: string }): AudioProject => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};

describe("folder colours", () => {
  it("set and clear a folder's colour; the block goes when the last one does", () => {
    const p = next(setFolderColour(defaultAudioProject(), "audio/sfx", "warning"));
    expect(p.studio).toEqual({ folderColours: { "audio/sfx": "warning" } });
    expect(folderColourCss(p, "audio/sfx")).toBe("var(--warning)");
    expect(folderColourCss(p, "audio")).toBeNull();
    expect(folderColour(next(setFolderColour(p, "audio/sfx", "#ABCDEF")), "audio/sfx")).toBe("#abcdef");
    expect(next(setFolderColour(p, "audio/sfx", null))).not.toHaveProperty("studio");
    expect(setFolderColour(p, "audio/sfx", "bright pink")).toEqual({ refused: expect.stringContaining("theme colour") });
    expect(setFolderColour(p, "", "warning")).toEqual({ refused: expect.any(String) });
  });

  it("follow a renamed or moved folder, its subfolders too", () => {
    let p = next(setFolderColour(defaultAudioProject(), "audio/sfx", "warning"));
    p = next(setFolderColour(p, "audio/sfx/steps", "danger"));
    p = next(setFolderColour(p, "audio/music", "accent"));
    const moved = moveFolderColours(p, "audio/sfx", "audio/effects");
    expect(moved.studio?.folderColours).toEqual({ "audio/effects": "warning", "audio/effects/steps": "danger", "audio/music": "accent" });
    expect(moveFolderColours(p, "audio/voice", "audio/vo")).toBe(p);
  });

  it("are kept in audio.json's studio block and read back; bad entries are dropped with a problem", () => {
    const p = next(setFolderColour(defaultAudioProject(), "audio/sfx", "series-6"));
    const json = audioProjectToJson(p);
    expect(json.studio).toEqual({ folderColours: { "audio/sfx": "series-6" } });
    expect(parseAudioProject(JSON.parse(JSON.stringify(json))).project.studio).toEqual(p.studio);
    expect(audioProjectToJson(defaultAudioProject())).not.toHaveProperty("studio");
    const bad = parseAudioProject({ ...json, studio: { folderColours: { "audio/sfx": "rgb(0,0,0)", "": "warning", "audio/ok/": "danger" } } });
    expect(bad.project.studio).toEqual({ folderColours: { "audio/ok": "danger" } });
    expect(bad.problems).toHaveLength(2);
  });
});
