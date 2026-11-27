// ADR 0434: one main-thread audio frame runs in one order, written once (`stepAudioFrame`): the mixer's update, then the
// backend frame (ADR 0270), then the playlist runtime. Pinned through the step's own interface, by what each part sees of
// the one before it: the backend's frame reads the mixer's clock already moved, and the playlists run after the backend's.
import { describe, expect, it } from "vitest";
import { Mixer } from "../../../engine/audio/mixer";
import { stepAudioFrame, type AudioFrameParts } from "./audioFrame";
import { ListenerFrame } from "./core/spatial";
import { makeFakeBackend } from "./testing";

describe("stepAudioFrame (ADR 0434)", () => {
  it("runs the mixer, then the backend frame, then the playlists, every frame", () => {
    const mixer = new Mixer();
    const seen: string[] = [];
    const backend = Object.assign(makeFakeBackend(), {
      update(dt: number) {
        seen.push(`backend dt=${dt} mixer=${mixer.time.toFixed(3)}`);
      },
    });
    const playlists = { update: (dt: number) => void seen.push(`playlists dt=${dt} mixer=${mixer.time.toFixed(3)}`) };
    const frame = new ListenerFrame();
    const parts: AudioFrameParts = { mixer, playlists, backend, frame };
    for (const dt of [0.016, 0.02]) {
      frame.set(null, 0, null, null, dt);
      stepAudioFrame(parts, dt);
    }
    expect(seen).toEqual([
      "backend dt=0.016 mixer=0.016",
      "playlists dt=0.016 mixer=0.016",
      "backend dt=0.02 mixer=0.036",
      "playlists dt=0.02 mixer=0.036",
    ]);
  });
});
