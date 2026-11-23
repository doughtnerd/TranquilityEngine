// The project folders the Studio's trees and pickers show (UI pass T5), through the filter's own interface.
import { describe, expect, it } from "vitest";
import { contentFolders } from "./projectFolders";

const isAudio = (p: string) => /\.(wav|ogg|mp3|flac)$|\.playlist\.json$/i.test(p);

describe("project folders in the Studio", () => {
  it("leaves out a new project's scenes and scripts (and hidden folders), keeps the user's own, empty or not", () => {
    const folders = ["scenes", "scripts", "scripts/ai", ".myco", ".myco/thumbnails", "GameSFX", "GameSFX/Footsteps", "New folder"];
    const files = ["project.json", "scenes/main.scene.json", "scripts/Player.ts", "GameSFX/Footsteps/wood_1.wav"];
    expect(contentFolders(folders, files, isAudio)).toEqual(["GameSFX", "GameSFX/Footsteps", "New folder"]);
  });

  it("shows a content folder that holds audio, with its ancestors", () => {
    const folders = ["scenes", "scenes/level1", "scenes/level1/sfx", "scripts"];
    const files = ["scenes/level1/sfx/door.wav", "scripts/Player.ts"];
    expect(contentFolders(folders, files, isAudio)).toEqual(["scenes", "scenes/level1", "scenes/level1/sfx"]);
  });

  it("asks the caller what counts: a playlists tree ignores samples there", () => {
    const folders = ["scripts", "Music"];
    const files = ["scripts/stinger.wav"];
    expect(contentFolders(folders, files, (p) => p.endsWith(".playlist.json"))).toEqual(["Music"]);
    expect(contentFolders(folders, files, isAudio)).toEqual(["scripts", "Music"]);
  });
});
