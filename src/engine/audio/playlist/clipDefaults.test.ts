import { describe, expect, it } from "vitest";
import { defaultSampleEdits } from "../sample/format";
import { defaultClipSync } from "./clipDefaults";
import { parsePlaylist } from "./format";

describe("defaultClipSync", () => {
  it("is true for a music sample only", () => {
    expect(defaultClipSync(defaultSampleEdits("music"))).toBe(true);
    for (const kind of ["oneshot", "loop", "sustain"] as const) expect(defaultClipSync(defaultSampleEdits(kind))).toBe(false);
    expect(defaultClipSync(null)).toBe(false);
    expect(defaultClipSync(undefined)).toBe(false);
  });

  it("leaves the file default alone: a clip without sync parses as false", () => {
    const { playlist } = parsePlaylist({ format: "myco.playlist@1", type: "sequence", entries: [], sequence: { tracks: [{ id: "t", kind: "audio", clips: [{ id: "c", sample: "music.wav", at: 0 }] }] } });
    expect(playlist.sequence!.tracks[0]!.clips[0]!.sync).toBe(false);
  });
});
