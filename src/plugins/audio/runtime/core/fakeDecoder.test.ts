// L-D1ba: the fake decoder's music-group half (ADR 0166 §4.6, C8): open, `groupOpened`, retarget, cancel.
import { describe, expect, it } from "vitest";
import type { DecodeHint, MusicReply, PrimeGroupMember } from "../decoder/protocol";
import type { StreamReply } from "../decoder/decoderClient";
import { fakeDecoder } from "./fakeDecoder";

const clip = () => ({ frames: 4, channels: 1, sampleRate: 48_000, channelData: [new Float32Array(4)] });
const member = (streamId: number, over: Partial<PrimeGroupMember> = {}): PrimeGroupMember => ({
  streamId, epoch: 1, asset: `music/stem${streamId}.wav`, bytes: new ArrayBuffer(8), hint: 1 as DecodeHint, startFrame: 0, loop: true, music: true, ...over,
});
function rig() {
  const fake = fakeDecoder(clip);
  const streams: StreamReply[] = [];
  const music: MusicReply[] = [];
  fake.onStream((r) => void streams.push(r));
  fake.onMusic((r) => void music.push(r));
  return { fake, streams, music };
}

describe("fakeDecoder music groups (L-D1ba)", () => {
  it("primeGroup opens each member: streamOpened per member, then one groupOpened listing them without errors", () => {
    const { fake, streams, music } = rig();
    fake.primeGroup({ instance: 1, group: 7, retarget: false, members: [member(11), member(12)] });
    expect(streams.map((r) => r.type)).toEqual(["streamOpened", "streamOpened"]);
    expect(music).toHaveLength(1);
    expect(music[0]).toMatchObject({ type: "groupOpened", group: 7 });
    expect(fake.openGroups().get(7)?.size).toBe(2);
  });

  it("retarget restarts open members at the new startFrame and epoch, and opens members not open yet", () => {
    const { fake, music } = rig();
    fake.primeGroup({ instance: 1, group: 7, retarget: false, members: [member(11), member(12)] });
    fake.primeGroup({ instance: 1, group: 7, retarget: true, members: [member(11, { epoch: 2, startFrame: 960 }), member(13, { epoch: 2 })] });
    const g = fake.openGroups().get(7)!;
    expect(g.get(11)).toMatchObject({ epoch: 2, startFrame: 960 });
    expect([...g.keys()].sort()).toEqual([11, 12, 13]);
    expect(music.filter((r) => r.type === "groupOpened")).toHaveLength(2);
  });

  it("retarget ignores an epoch that is not newer than the member's", () => {
    const { fake } = rig();
    fake.primeGroup({ instance: 1, group: 7, retarget: false, members: [member(11, { epoch: 5 })] });
    fake.primeGroup({ instance: 1, group: 7, retarget: true, members: [member(11, { epoch: 5, startFrame: 960 })] });
    expect(fake.openGroups().get(7)!.get(11)).toMatchObject({ epoch: 5, startFrame: 0 });
  });

  it("cancelGroup emits streamClosed for each member, forgets the group, and ignores an unknown group", () => {
    const { fake, streams } = rig();
    fake.primeGroup({ instance: 1, group: 7, retarget: false, members: [member(11), member(12)] });
    streams.length = 0;
    fake.cancelGroup(7);
    expect(streams).toEqual([{ type: "streamClosed", streamId: 11 }, { type: "streamClosed", streamId: 12 }]);
    expect(fake.openGroups().has(7)).toBe(false);
    fake.cancelGroup(99);
    expect(streams).toHaveLength(2);
  });

  it("records each primeGroup message without its members' bytes", () => {
    const { fake } = rig();
    fake.primeGroup({ instance: 1, group: 7, retarget: false, members: [member(11)], protect: ["a.wav"] });
    expect(fake.primed).toEqual([{ instance: 1, group: 7, retarget: false, protect: ["a.wav"] }]);
  });
});
