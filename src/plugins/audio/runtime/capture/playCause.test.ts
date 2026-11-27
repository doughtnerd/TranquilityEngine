// ADR 0435: while a recorder's sink is installed, a playlist instance's `eventStart` carries its cause: the request
// (`Audio.play`, `AudioSource`…), the GameObject it is for, the behaviour hook and the defined system that asked. Driven
// through `Audio.play`, an `AudioSource` and a defined system on the fake backend.
import { afterEach, describe, expect, it } from "vitest";
import { Audio } from "../Audio";
import { AudioSource } from "../AudioSource";
import { eventKit, pla, sample } from "../playlists/testKit";
import { NULL_PROFILE_SINK, type ProfileCause } from "../mix/profileSink";
import { taps } from "../mix/profileTaps";
import { recordingSink } from "../mix/recordingSink";
import { GameBehavior } from "../../../../engine/core/Component";
import { GameObject } from "../../../../engine/scene/GameObject";
import { defineSystem, _undefineSystem } from "../../../../engine/core/systems";

const kit = eventKit();
const SYSTEM = "test.playCause.waves";
const IMPACT = { "impact.playlist.json": pla("clip", [sample("a.wav")]) };

afterEach(() => {
  taps.sink = NULL_PROFILE_SINK;
  _undefineSystem(SYSTEM);
});

class BikeAudio extends GameBehavior {
  private played = false;
  update(): void {
    if (this.played) return;
    this.played = true;
    Audio.play("impact.playlist.json");
  }
}

/** The causes the recorder was given, one per eventStart. */
function causes(rec: ReturnType<typeof recordingSink>): (ProfileCause | null | undefined)[] {
  return rec.of("eventStart").map((c) => c[2] as ProfileCause | null | undefined);
}

describe("an instance's cause (ADR 0435)", () => {
  it("Audio.play from a behaviour's hook names the request, the behaviour's GameObject and its hook", async () => {
    await kit.boot(IMPACT);
    const rec = recordingSink();
    taps.sink = rec.sink;
    const player = GameObject.create("Player");
    const bike = GameObject.create("Bike");
    bike.setParent(player);
    bike.addBehavior(BikeAudio);
    kit.frame();
    const [cause] = causes(rec);
    expect(cause).toMatchObject({ trigger: "Audio.play", behaviour: "BikeAudio.update", system: null });
    expect(cause!.node).toBe("/s/Player/Bike"); // under the loaded scene "s"
  });

  it("Audio.play outside any hook names only the request", async () => {
    await kit.boot(IMPACT);
    const rec = recordingSink();
    taps.sink = rec.sink;
    Audio.play("impact.playlist.json");
    expect(causes(rec)).toEqual([{ trigger: "Audio.play", node: null, behaviour: null, system: null }]);
  });

  it("Audio.play from a defined system names the system", async () => {
    let once = false;
    defineSystem({ name: SYSTEM, phase: "update", run: () => { if (!once) { once = true; Audio.play("impact.playlist.json"); } } });
    await kit.boot(IMPACT);
    const rec = recordingSink();
    taps.sink = rec.sink;
    kit.frame();
    expect(causes(rec)).toEqual([{ trigger: "Audio.play", node: null, behaviour: null, system: SYSTEM }]);
  });

  it("an AudioSource names itself and its GameObject", async () => {
    await kit.boot(IMPACT);
    const rec = recordingSink();
    taps.sink = rec.sink;
    const horn = GameObject.create("Horn");
    const source = horn.addBehavior(AudioSource);
    source.clip = "impact.playlist.json";
    source.play();
    const [cause] = causes(rec);
    expect(cause).toMatchObject({ trigger: "AudioSource", behaviour: null, system: null });
    expect(cause!.node).toBe("/s/Horn");
  });
});
