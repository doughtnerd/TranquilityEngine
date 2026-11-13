// ADR 0171 (Rc3, api-and-models §5.6 kinds 8, 9, 10, 12): the event runtime's taps on the fake backend with a recording stub
// sink (eventStart, eventStop, parameter, stateChange), the null object's silence, and `syncSettings` (Ma1's refresh of the
// project's automation bindings).
import { describe, expect, it } from "vitest";
import { Audio } from "../index";
import { mixer } from "../../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import { NULL_PROFILE_SINK } from "../mix/profileSink";
import { taps } from "../mix/profileTaps";
import { recordingSink } from "../mix/recordingSink";
import { clip, ev, eventKit } from "./eventTestKit";
import { events } from "./eventRuntime";

const kit = eventKit();
const PARAMS = [{ name: "Speed", min: 0, max: 10, default: 0, seekSpeed: 0 }, { name: "Surface", labels: ["Grass", "Stone", "Mud"], default: "Grass" }];

function withSink<T>(fn: (stub: ReturnType<typeof recordingSink>) => T): T {
  const stub = recordingSink();
  taps.sink = stub.sink;
  try { return fn(stub); } finally { taps.sink = NULL_PROFILE_SINK; }
}

describe("event taps (§5.6 kinds 8, 9, 10, 12)", () => {
  it("an instance's start and stop carry its group, however it ended; a stop is reported once", async () => {
    await kit.boot({ "e.audioevent.json": ev(clip("a.wav"), { parameters: PARAMS }) });
    await withSink(async (stub) => {
      const h = Audio.play("e.audioevent.json")!;
      h.stop();
      h.stop();
      const starts = stub.of("eventStart");
      expect(starts).toHaveLength(1);
      expect(starts[0]![1]).toBe("e.audioevent.json");
      expect(stub.of("eventStop")).toEqual([[starts[0]![0]]]);
      expect(stub.calls.map((c) => c[0])).toEqual(["eventStart", "eventStop"]);
    });
  });

  it("an instance that ends on its own is reported when the runtime retires it", async () => {
    await kit.boot({ "e.audioevent.json": ev(clip("a.wav")) });
    await withSink(async (stub) => {
      Audio.play("e.audioevent.json");
      kit.fake.voices[0]!.end();
      events().update(1 / 60);
      events().play("e.audioevent.json"); // a play reaps ended instances
      expect(stub.of("eventStop")).toHaveLength(1);
    });
  });

  it("a global numeric parameter is a parameter record with no instance; a repeat of the value is none", async () => {
    await kit.boot({ "e.audioevent.json": ev(clip("a.wav")) }, { parameters: PARAMS });
    withSink((stub) => {
      Audio.setParameter("Speed", 4);
      Audio.setParameter("Speed", 4);
      expect(stub.calls).toEqual([["parameter", "Speed", 4, null]]);
    });
  });

  it("a global labelled parameter is a parameter record (the label's index) and a state change (the label)", async () => {
    await kit.boot({ "e.audioevent.json": ev(clip("a.wav")) }, { parameters: PARAMS });
    withSink((stub) => {
      Audio.setParameter("Surface", "Mud");
      expect(stub.calls).toEqual([["parameter", "Surface", 2, null], ["stateChange", "Surface", "Mud"]]);
    });
  });

  it("an instance's local parameters carry the instance's group", async () => {
    await kit.boot({ "e.audioevent.json": ev(clip("a.wav"), { parameters: PARAMS }) });
    await withSink(async (stub) => {
      const h = Audio.play("e.audioevent.json")!;
      const group = stub.of("eventStart")[0]![0];
      h.setParameter("Speed", 7);
      h.setParameter("Surface", "Stone");
      expect(stub.of("parameter")).toEqual([["Speed", 7, group], ["Surface", 1, group]]);
      expect(stub.of("stateChange")).toEqual([["Surface", "Stone"]]);
    });
  });

  it("with the null object nothing is reported and everything still plays", async () => {
    await kit.boot({ "e.audioevent.json": ev(clip("a.wav"), { parameters: PARAMS }) });
    expect(taps.sink).toBe(NULL_PROFILE_SINK);
    const h = Audio.play("e.audioevent.json")!;
    h.setParameter("Speed", 3);
    h.stop();
    expect(kit.fake.plays).toHaveLength(1);
  });
});

describe("syncSettings (Ma1)", () => {
  it("re-reads the project's automation bindings and binds each bus again, without a script touching a parameter", async () => {
    await kit.boot({ "e.audioevent.json": ev(clip("a.wav")) }, { parameters: [PARAMS[0]] });
    const bound: [string, number][] = [];
    (kit.fake as unknown as { automation: unknown }).automation = {
      defineCurve: () => {}, setParam: () => {}, releaseGroup: () => {},
      bindBus: (bus: string, bindings: readonly unknown[]) => bound.push([bus, bindings.length]),
    };
    events().syncSettings();
    expect(bound.filter(([b]) => b === "SFX")).toEqual([["SFX", 0]]);
    // A project edit adds an automation binding on SFX; nothing binds it until the runtime re-reads.
    const next = parseAudioSettings({
      buses: [{ name: "Master" }, { name: "SFX", parent: "Master" }],
      parameters: [PARAMS[0]],
      automation: [{ bus: "SFX", parameter: "Speed", target: "volume", curve: [[0, 0], [10, 1]] }],
    }).settings;
    mixer.configure(next);
    expect(bound.filter(([b]) => b === "SFX")).toEqual([["SFX", 0]]);
    events().syncSettings();
    expect(bound.filter(([b]) => b === "SFX")).toEqual([["SFX", 0], ["SFX", 1]]);
    events().syncSettings(); // settled: nothing more
    expect(bound.filter(([b]) => b === "SFX")).toHaveLength(2);
  });
});
