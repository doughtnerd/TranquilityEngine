// ADR 0168: the interactive-music types are importable from "myco" as types, so a script can annotate with them. ADR 0343
// retired the music format's node model and rules (the audio event format), so only the handle and event types remain.
import { describe, expect, expectTypeOf, it } from "vitest";
import * as myco from "myco";
import type {
  AudioEventHandle, AudioLatency, AudioPlaylistHandle, CalibrationApi, CalibrationResult, GridPoint, GridSpec, MusicEvent,
  MusicEventHandle, MusicHandle, MusicKind, MusicPositionAt, MusicSeekResult,
} from "myco";

describe("interactive-music types from myco", () => {
  it("names the handle and event types", () => {
    const onBeat = (e: MusicEvent): number => e.bar * e.beatsPerBar + e.beat;
    expectTypeOf(onBeat).parameter(0).toEqualTypeOf<MusicEvent>();
    expectTypeOf<MusicEvent["handle"]>().toEqualTypeOf<MusicEventHandle>();
    expectTypeOf<AudioEventHandle>().toExtend<MusicEventHandle>();
    expectTypeOf<AudioPlaylistHandle>().toExtend<MusicEventHandle>();
    expectTypeOf<MusicEventHandle["music"]>().toEqualTypeOf<MusicHandle | undefined>();
    expectTypeOf<MusicHandle["positionAt"]>().returns.toEqualTypeOf<MusicPositionAt>();
    expectTypeOf<MusicHandle["seek"]>().returns.toEqualTypeOf<MusicSeekResult>();
    expectTypeOf<MusicHandle["nextGrid"]>().returns.toEqualTypeOf<GridPoint | null>();
    expectTypeOf<Parameters<MusicHandle["nextGrid"]>[0]>().toEqualTypeOf<GridSpec>();
    expectTypeOf<Parameters<MusicEventHandle["onMusic"]>[0]>().toEqualTypeOf<MusicKind>();
    expectTypeOf<CalibrationApi["fromTaps"]>().returns.toEqualTypeOf<CalibrationResult>();
    expectTypeOf<AudioLatency["reliable"]>().toEqualTypeOf<boolean>();
  });

  it("adds no runtime exports", () => {
    for (const name of ["MusicEventHandle", "MusicHandle", "MusicEvent"]) {
      expect(name in myco).toBe(false);
    }
  });
});
