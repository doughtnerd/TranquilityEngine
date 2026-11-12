// ADR 0166 P8, G-2: the editor's asset save reaches the music runtime. `Assets.notifyChanged` (what `EditorProject` calls
// after a write) runs `noteAssetChanged`, which drops the backend's cached copies of the file (`invalidateClip`).
import { afterEach, describe, expect, it } from "vitest";
import { Assets } from "../../../../engine/scene/Assets";
import { setAudioBackend } from "../backend";
import { makeFakeBackend } from "../testing";
import "../AudioSource"; // registers the reload host and the asset listener

afterEach(() => setAudioBackend(null));

describe("asset changes reach the audio runtime (P8 wiring)", () => {
  it("a changed file is invalidated on the backend, by its normalised path", () => {
    const b = makeFakeBackend();
    const invalidated: string[] = [];
    Object.assign(b, { invalidateClip: (p: string) => void invalidated.push(p) });
    setAudioBackend(b);
    Assets.notifyChanged("music/stem.ogg");
    expect(invalidated).toEqual(["music/stem.ogg"]);
  });

  it("with no backend yet an edit drops nothing and creates none", () => {
    setAudioBackend(null);
    expect(() => Assets.notifyChanged("music/stem.ogg")).not.toThrow();
  });
});
