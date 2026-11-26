import { describe, expect, it } from "vitest";
import { opensInAudioStudio, parseStudioHash, studioHash, studioScreenFor, studioUrl } from "./studioAssets";

describe("which files the Audio Studio opens", () => {
  it("maps each audio format to its screen, compound suffixes first", () => {
    expect(studioScreenFor("music/town.mp3")).toBe("samples");
    expect(studioScreenFor("sfx/Hit.WAV")).toBe("samples");
    expect(studioScreenFor("sfx/hit.sample.json")).toBe("samples");
    expect(studioScreenFor("events/jump.audioevent.json")).toBe("playlists");
    expect(studioScreenFor("music/level.playlist.json")).toBe("playlists");
    expect(studioScreenFor("tests/cave.audioscene.json")).toBe("spatial");
    expect(studioScreenFor("audio.json")).toBe("mixer");
    expect(studioScreenFor("recordings/boss.sporesample")).toBe("take");
  });

  it("leaves everything else to the editor", () => {
    for (const path of ["scenes/main.scene.json", "images/bird.png", "data/audio.json", "project.json", "notes.mp3.txt"]) {
      expect(opensInAudioStudio(path)).toBe(false);
    }
  });
});

describe("the Studio page's URL", () => {
  it("carries the project in the query and the screen and asset in the hash", () => {
    expect(studioUrl({ project: "C:\\Games\\My Game", asset: "music/a b.playlist.json" })).toBe(
      "studio.html?project=C%3A%5CGames%5CMy%20Game#/playlists/music/a%20b.playlist.json",
    );
    expect(studioUrl({ project: "/home/me/game", screen: "mixer" })).toBe("studio.html?project=%2Fhome%2Fme%2Fgame#/mixer");
    expect(studioUrl({ project: null })).toBe("studio.html");
    expect(studioUrl({ project: null, sample: "sound-lab", screen: "mixer" })).toBe("studio.html?sample=sound-lab#/mixer");
  });

  it("an explicit screen wins over the asset's", () => {
    expect(studioHash({ project: null, asset: "music/town.mp3", screen: "take" })).toBe("#/take/music/town.mp3");
  });

  it("reads back what it wrote, and ignores routes it doesn't know", () => {
    const hash = studioHash({ project: null, asset: "sfx/50% hit#2.wav" });
    expect(parseStudioHash(hash)).toEqual({ screen: "samples", asset: "sfx/50% hit#2.wav" });
    expect(parseStudioHash("#/mixer")).toEqual({ screen: "mixer", asset: null });
    expect(parseStudioHash("#/nowhere/x.wav")).toEqual({ screen: null, asset: null });
    expect(parseStudioHash("")).toEqual({ screen: null, asset: null });
    expect(parseStudioHash("#/samples/%E0%A4%A")).toEqual({ screen: "samples", asset: null });
  });
});
