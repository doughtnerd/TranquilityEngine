// ADR 0168: the interactive-music types are importable from "myco" as types, so a script can annotate with them.
import { describe, expect, expectTypeOf, it } from "vitest";
import * as myco from "myco";
import type {
  AudioEventHandle, AudioLatency, CalibrationApi, CalibrationResult, GridPoint, GridSpec, MusicAutomation, MusicContainerNode,
  MusicCue, MusicEvent, MusicEventHandle, MusicHandle, MusicKind, MusicNode, MusicPositionAt, MusicRegion, MusicSeekResult,
  MusicSwitchNode, MusicTrack, PlaylistNode, SegmentNode, StingerDef, TempoMarker, TransitionRule,
  AutomationQuantize, FadeCurve, IfTooLate, MusicAutomationTarget, MusicNodeType, PlaylistMode, RegionCondition,
  StingerAt, TrackPick, TransitionBridge, TransitionEnter, TransitionExit, TransitionFade,
} from "myco";

describe("interactive-music types from myco", () => {
  it("names the handle and event types", () => {
    const onBeat = (e: MusicEvent): number => e.bar * e.beatsPerBar + e.beat;
    expectTypeOf(onBeat).parameter(0).toEqualTypeOf<MusicEvent>();
    expectTypeOf<MusicEvent["handle"]>().toEqualTypeOf<MusicEventHandle>();
    expectTypeOf<AudioEventHandle>().toExtend<MusicEventHandle>();
    expectTypeOf<MusicEventHandle["music"]>().toEqualTypeOf<MusicHandle | undefined>();
    expectTypeOf<MusicHandle["positionAt"]>().returns.toEqualTypeOf<MusicPositionAt>();
    expectTypeOf<MusicHandle["seek"]>().returns.toEqualTypeOf<MusicSeekResult>();
    expectTypeOf<MusicHandle["nextGrid"]>().returns.toEqualTypeOf<GridPoint | null>();
    expectTypeOf<Parameters<MusicHandle["nextGrid"]>[0]>().toEqualTypeOf<GridSpec>();
    expectTypeOf<Parameters<MusicEventHandle["onMusic"]>[0]>().toEqualTypeOf<MusicKind>();
    expectTypeOf<CalibrationApi["fromTaps"]>().returns.toEqualTypeOf<CalibrationResult>();
    expectTypeOf<AudioLatency["reliable"]>().toEqualTypeOf<boolean>();
  });

  it("names the format node types", () => {
    expectTypeOf<MusicNode>().toEqualTypeOf<SegmentNode | PlaylistNode | MusicSwitchNode>();
    expectTypeOf<MusicContainerNode>().toEqualTypeOf<PlaylistNode | MusicSwitchNode>();
    expectTypeOf<SegmentNode["tempo"]>().toEqualTypeOf<TempoMarker[]>();
    expectTypeOf<SegmentNode["cues"]>().toEqualTypeOf<MusicCue[]>();
    expectTypeOf<SegmentNode["regions"]>().toEqualTypeOf<MusicRegion[]>();
    expectTypeOf<SegmentNode["tracks"]>().toEqualTypeOf<MusicTrack[]>();
    expectTypeOf<MusicTrack["automation"]>().toEqualTypeOf<MusicAutomation[]>();
    expectTypeOf<MusicTrack["pick"]>().toEqualTypeOf<TrackPick>();
    expectTypeOf<MusicRegion["while"]>().toEqualTypeOf<RegionCondition | undefined>();
    expectTypeOf<MusicAutomation["target"]>().toEqualTypeOf<MusicAutomationTarget>();
    expectTypeOf<MusicAutomation["quantize"]>().toEqualTypeOf<AutomationQuantize | undefined>();
    expectTypeOf<PlaylistNode["mode"]>().toEqualTypeOf<PlaylistMode>();
    expectTypeOf<MusicNode["type"]>().toEqualTypeOf<MusicNodeType>();
    expectTypeOf<MusicContainerNode["transitions"]>().toEqualTypeOf<TransitionRule[]>();
    expectTypeOf<MusicContainerNode["stingers"]>().toEqualTypeOf<StingerDef[]>();
    expectTypeOf<TransitionRule["exit"]>().toEqualTypeOf<TransitionExit>();
    expectTypeOf<TransitionRule["enter"]>().toEqualTypeOf<TransitionEnter>();
    expectTypeOf<TransitionRule["fadeOut"]>().toEqualTypeOf<TransitionFade>();
    expectTypeOf<TransitionFade["curve"]>().toEqualTypeOf<FadeCurve>();
    expectTypeOf<NonNullable<TransitionRule["bridge"]>>().toEqualTypeOf<TransitionBridge>();
    expectTypeOf<StingerDef["at"]>().toEqualTypeOf<StingerAt>();
    expectTypeOf<StingerDef["ifTooLate"]>().toEqualTypeOf<IfTooLate>();
  });

  it("adds no runtime exports", () => {
    for (const name of ["MusicEventHandle", "SegmentNode", "TransitionRule", "StingerDef", "MusicNode"]) {
      expect(name in myco).toBe(false);
    }
  });
});
