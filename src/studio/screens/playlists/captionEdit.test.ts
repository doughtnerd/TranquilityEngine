// ADR 0343 §4, §6: the Playlists inspector's Caption field — set, change the gap, remove, refuse a bad key or gap, and
// the bracketed text a created key starts with; the result round-trips through the playlist writer.
import { describe, expect, it } from "vitest";
import { parsePlaylist, playlistToJson } from "../../../engine/audio/playlist/format";
import type { PlaylistBody } from "../../../engine/audio/playlist/types";
import { captionPlaceholder, setCaption } from "./captionEdit";
import { FIXTURE_PLAYLISTS } from "./playlistFixture";

const next = (r: { next: PlaylistBody } | { refused: string }): PlaylistBody => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};

describe("caption field", () => {
  it("sets, changes and removes a playlist's caption", () => {
    const body = FIXTURE_PLAYLISTS["audio/vehicles/engine.playlist.json"]!;
    const set = next(setCaption(body, " cc.door_slams "));
    expect(set.caption).toEqual({ key: "cc.door_slams", minGap: 0 });
    expect(next(setCaption(set, "cc.door_slams", 2)).caption).toEqual({ key: "cc.door_slams", minGap: 2 });
    expect(next(setCaption(next(setCaption(set, "cc.door_slams", 2)), "cc.bang")).caption).toEqual({ key: "cc.bang", minGap: 2 });
    expect(next(setCaption(set, "")).caption).toBeUndefined();
    expect(setCaption(set, "not a key")).toMatchObject({ refused: expect.stringContaining("isn't a string key") });
    expect(setCaption(set, "cc.x", 99)).toEqual({ refused: "the gap is 0 to 60 seconds" });
    expect(captionPlaceholder("cc.door_slams")).toBe("[door slams]");
  });

  it("round-trips through the playlist file", () => {
    const body = next(setCaption(FIXTURE_PLAYLISTS["audio/vehicles/engine.playlist.json"]!, "cc.engine", 1.5));
    const back = parsePlaylist(playlistToJson(body)).playlist;
    expect(back.caption).toEqual({ key: "cc.engine", minGap: 1.5 });
  });
});
