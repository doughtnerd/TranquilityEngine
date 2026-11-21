// ADR 0166 R7: the seek's position grammar and its refusals, on the fake backend (`testing.ts`), as `transition.test.ts`.
// Clock: 120 bpm 4/4, a 120 s clip; A plays from 1.1 (stamped from now 1 + the 100 ms first lead).
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAudioBackend } from "../backend";
import { makeFakeBackend, type FakeBackend, endAudioSession, musicFrameAt, musicFrameStep } from "../testing";
import type { EventInstance } from "../events/eventRuntime";
import { parseAudioEvent } from "../../../../engine/audio/eventFormat";
import type { MusicNode, MusicSwitchNode } from "../../../../engine/audio/musicFormat";
import type { MusicClipFacts } from "../../../../engine/audio/musicValidate";
import { createMusicPlayer, disposeMusicPlayer, type MusicPlayer } from "./musicSystem";
import { setSegmentClipSource } from "./segmentRun";
import { planTick, requestStart } from "./planner";
import { requestTransition } from "./transition";
import { seekMusic } from "./seek";
import { refuseStart, stopPlayer } from "./musicPlayer";

const RATE = 48_000;
const L = 1 / 30;
const DT = 1 / 60;
const facts = (): MusicClipFacts => ({ frames: 120 * RATE, rate: RATE, channels: 2, gapless: true });

type Raw = Record<string, unknown>;
const seg = (id: string, extra: Raw = {}): Raw => ({ type: "segment", id, value: id, tracks: [{ name: "t0", clip: `music/${id}0.ogg` }, { name: "t1", clip: `music/${id}1.ogg` }], ...extra });
function root(children: Raw[] = [seg("A"), seg("B")]): MusicSwitchNode {
  const { value } = parseAudioEvent({ format: "myco.audioevent@1", bus: "Music", root: { type: "musicSwitch", id: "sw", parameter: "zone", children, transitions: [{ exit: "bar" }] } });
  if (!value.musicRoot) throw new Error("not a music root");
  return value.musicRoot as MusicSwitchNode;
}
const child = (r: MusicSwitchNode, id: string): MusicNode => r.children.find((c) => c.id === id)!;

let b: FakeBackend;
function rig(): void {
  b = makeFakeBackend();
  setAudioBackend(b);
  b.lookahead = L;
  setSegmentClipSource({ url: (p) => p, settings: () => ({ volume: 1, stream: true }), bus: (o) => o ?? "Master", facts: () => facts() });
  b.advanceTo(1);
}
const instance = (): EventInstance =>
  ({ group: 7, world: 1, path: "music.audioevent", asset: { bus: "Music", volume: 1 }, getParameter: () => undefined }) as unknown as EventInstance;
function playing(r: MusicSwitchNode): MusicPlayer {
  const player = createMusicPlayer(instance(), r);
  requestStart(player, { to: child(r, "A"), reason: "start", grid: "immediate", notBefore: Number.NaN, startFrame: 0 }, musicFrameAt(b, 1));
  b.music!.setPrimed(player.planned!.run.group);
  planTick(player, musicFrameAt(b, 1));
  planTick(player, musicFrameAt(b, 1.2));
  expect(player.state).toBe("playing");
  return player;
}
const tick = (player: MusicPlayer, now: number): void => {
  musicFrameStep(b, now);
};

afterEach(() => {
  endAudioSession();
  setAudioBackend(null);
  vi.restoreAllMocks();
});

describe("seekMusic", () => {
  it("plans an immediate change at the asked file frame and reports its landing time", () => {
    rig();
    const player = playing(root());
    const res = seekMusic(player, "3:2:0"); // bar 3 beat 2: 4 s + 0.5 s
    // The lead (1.25 Ê + L + Δ̄ for streamed stems not primed yet: 0.1 s) and an asap start's frame of slack (Δ̄, F-25).
    expect(res).toEqual({ ok: true, time: expect.closeTo(1.2 + 0.1 + DT, 9) });
    expect(player.transition?.immediate?.fadeSeconds).toBe(0.005);
    expect(player.planned?.run.startFrame).toBe(Math.round(4.5 * RATE));
    expect(player.planned?.run.node.id).toBe("A");
  });

  it("is read in the segment that plays when the seek lands: the incoming one after the cancel point", () => {
    rig();
    const r = root([seg("A"), seg("B", { tempo: [{ at: "1:1:0", bpm: 60, beatsPerBar: 4, beatUnit: 4 }] })]);
    const player = playing(r);
    const t = requestTransition(player, child(r, "B"), musicFrameAt(b, 1.5))!;
    b.music!.setPrimed(t.incoming!.run.group);
    tick(player, 1.6);
    expect(t.state).toBe("stamped");
    for (let n = 1.6 + DT; n < t.cancelBy + DT; n += DT) tick(player, n);
    expect(t.state).toBe("running"); // committed: the seek queues behind it, and bar 2 is 4 s at B's 60 bpm
    const res = seekMusic(player, "2:1:0");
    expect(res).toEqual({ ok: true, time: expect.closeTo(t.exitAt, 9) });
    expect(t.after?.immediate?.startFrame).toBe(4 * RATE);
    expect(t.after?.to.id).toBe("B");
  });

  it("replaces a change still before its cancel point, in the playing segment", () => {
    rig();
    const r = root();
    const player = playing(r);
    const t = requestTransition(player, child(r, "B"), musicFrameAt(b, 1.5))!;
    expect(seekMusic(player, "2:1:0").ok).toBe(true);
    expect(t.state).toBe("cancelled");
    expect(player.transition?.to.id).toBe("A");
  });

  it("is invalid for a beat the metre doesn't have and for text that isn't a position, and changes nothing", () => {
    rig();
    const player = playing(root());
    const invalid = { ok: false, reason: "invalid", permanent: true };
    expect(seekMusic(player, "2:5:0")).toEqual(invalid); // 4/4
    expect(seekMusic(player, "soon")).toEqual(invalid);
    expect(seekMusic(player, "2:1:960")).toEqual(invalid);
    expect(player.transition).toBeNull();
  });

  it("is notPlaying for good once the music is stopping, stopped or refused, or its player is gone", async () => {
    rig();
    const gone = { ok: false, reason: "notPlaying", permanent: true };
    const stopped = playing(root());
    stopPlayer(stopped);
    expect(seekMusic(stopped, "2:1:0")).toEqual(gone);
    disposeMusicPlayer(stopped, null);
    expect(seekMusic(stopped, "2:1:0")).toEqual(gone);
    const refused = createMusicPlayer(instance(), root());
    refuseStart(refused);
    expect(seekMusic(refused, "2:1:0")).toEqual(gone);
    const orphan = createMusicPlayer(instance(), root());
    endAudioSession();
    expect(seekMusic(orphan, "2:1:0")).toEqual(gone);
  });

  it("is a temporary notPlaying while the first segment hasn't started", () => {
    rig();
    const r = root();
    const player = createMusicPlayer(instance(), r);
    expect(seekMusic(player, "2:1:0")).toEqual({ ok: false, reason: "notPlaying", permanent: false });
    requestStart(player, { to: child(r, "A"), reason: "start", grid: "immediate", notBefore: Number.NaN, startFrame: 0 }, musicFrameAt(b, 1));
    b.music!.setPrimed(player.planned!.run.group);
    planTick(player, musicFrameAt(b, 1)); // stamped for 1.1, not sounding yet
    expect(seekMusic(player, "2:1:0")).toEqual({ ok: false, reason: "notPlaying", permanent: false });
    planTick(player, musicFrameAt(b, 1.2));
    expect(seekMusic(player, "2:1:0").ok).toBe(true);
  });

  it("is a temporary poolFull when no rings are free now, leaves no plan, and succeeds once they are", () => {
    rig();
    const player = playing(root());
    b.music!.admitResult = { ok: false, reason: "poolFull", permanent: false };
    expect(seekMusic(player, "2:1:0")).toEqual({ ok: false, reason: "poolFull", permanent: false });
    expect(player.transition).toBeNull();
    expect(player.planned).toBeNull();
    expect(player.state).toBe("playing");
    b.music!.admitResult = { ok: true };
    expect(seekMusic(player, "2:1:0").ok).toBe(true);
  });

  it("is a permanent neverFits when the group can never hold a second set beside the playing one", () => {
    rig();
    const player = playing(root());
    b.music!.ringPool = 3; // two streamed stems playing and two more to prime: 4 > 3
    expect(seekMusic(player, "2:1:0")).toEqual({ ok: false, reason: "neverFits", permanent: true });
    expect(player.transition).toBeNull();
    expect(player.state).toBe("playing");
  });
});
