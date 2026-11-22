// "Create playlist from clips" in the Library (decision log D31's lost path): the new playlist's type, name, folder
// and entries, and the Library's selection that picks the samples, through their models.
import { describe, expect, it } from "vitest";
import { parsePlaylist, playlistToJson } from "../../../engine/audio/playlist/format";
import { clipsPlaylist } from "./clipsPlaylist";
import { createPlaylistLabel, libraryClick, menuTargets, type LibrarySelection } from "./libraryModel";

describe("clipsPlaylist", () => {
  it("one sample makes a Clip named after it, in its folder", () => {
    const p = clipsPlaylist(["sfx/door/creak.wav"])!;
    expect(p).toMatchObject({ name: "creak", folder: "sfx/door" });
    expect(p.value.type).toBe("clip");
    expect(p.value.entries).toEqual([expect.objectContaining({ kind: "sample", sample: "sfx/door/creak.wav", loop: "inherit" })]);
  });

  it("several make a Queue named after what they share, in the deepest folder they share; duplicates once", () => {
    const p = clipsPlaylist(["sfx/steps/footstep_01.wav", "sfx/steps/footstep_02.wav", "sfx/steps/grass/footstep_03.sample.json", "sfx/steps/footstep_01.wav"])!;
    expect(p).toMatchObject({ name: "footstep", folder: "sfx/steps" });
    expect(p.value.type).toBe("queue");
    // Each sample in an embedded Clip (a Queue's entries are playlists).
    const inner = (e: (typeof p.value.entries)[number]) => (e.kind === "embedded" && e.embedded.type === "clip" && e.embedded.entries[0]?.kind === "sample" ? e.embedded.entries[0].sample : "");
    expect(p.value.entries.map(inner)).toEqual(["sfx/steps/footstep_01.wav", "sfx/steps/footstep_02.wav", "sfx/steps/grass/footstep_03.sample.json"]);
    expect(parsePlaylist(playlistToJson(p.value)).problems).toEqual([]); // a valid file
  });

  it("with nothing shared it is named after the folder, else New playlist; none makes nothing", () => {
    expect(clipsPlaylist(["music/a.wav", "music/b.wav"])!.name).toBe("music");
    expect(clipsPlaylist(["a.wav", "zz.wav"])).toMatchObject({ name: "New playlist", folder: "" });
    expect(clipsPlaylist([])).toBeNull();
  });
});

describe("the Library's selection", () => {
  const order = ["a.wav", "b.wav", "c.wav", "d.wav"];
  const none: LibrarySelection = { selected: [], anchor: null };

  it("click selects one, Ctrl/⌘-click toggles, Shift-click selects the range from the anchor", () => {
    let s = libraryClick(none, order, "b.wav", {});
    expect(s.selected).toEqual(["b.wav"]);
    s = libraryClick(s, order, "d.wav", { range: true });
    expect(s.selected).toEqual(["b.wav", "c.wav", "d.wav"]);
    s = libraryClick(s, order, "c.wav", { toggle: true });
    expect(s.selected).toEqual(["b.wav", "d.wav"]);
    s = libraryClick(s, order, "a.wav", { range: true });
    expect(s.selected).toEqual(["a.wav", "b.wav", "c.wav"]);
  });

  it("a row's menu acts on the selection when the row is in it, else on the row; its label says what it makes", () => {
    const s: LibrarySelection = { selected: ["a.wav", "c.wav"], anchor: "c.wav" };
    expect(menuTargets(s, "c.wav")).toEqual(["a.wav", "c.wav"]);
    expect(menuTargets(s, "b.wav")).toEqual(["b.wav"]);
    expect(createPlaylistLabel(["a.wav", "c.wav"])).toBe("Create playlist from 2 samples");
    expect(createPlaylistLabel(["dir/kick.wav"])).toBe("Create playlist from “kick”");
  });
});
