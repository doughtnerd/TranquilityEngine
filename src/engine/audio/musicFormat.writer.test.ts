/**
 * The writer and `eventClips` for music nodes (F1b's skeleton; L-F1ba fills these, the cases are named and skipped).
 * Each case builds a raw event JSON object with a music root (see the fixtures F1b commits in the leaf's brief), then:
 *  - writer cases: `parseAudioEvent(raw)` -> `formatAudioEvent(value)` -> `JSON.parse` -> `parseAudioEvent` again;
 *    assert the second `value` deep-equals the first, the second parse has NO problems, and `formatAudioEvent` of the
 *    second value is byte-identical to the first text (idempotent);
 *  - clip cases: `eventClips(value)` equals an exact ordered array.
 * Placement, id and limit cases are F1b's own (`musicFormat.test.ts`), not here.
 */
import { describe, expect, it } from "vitest";
import { eventClips, eventRootNode, formatAudioEvent, parseAudioEvent } from "./eventFormat";

const FORMAT = "myco.audioevent@1";
/** The labelled parameter the fixtures declare, so that a `musicSwitch` on it reads with no problems. */
const STATE = { name: "State", labels: ["explore", "combat"], default: "explore" };

/** A minimal segment with one stem. */
const seg = (id: string, clip: string, extra: Record<string, unknown> = {}) => ({
  type: "segment", id, tracks: [{ name: "a", clip }], ...extra,
});

/** Parse, write, re-read; the second read must equal the first, have no problems and write the same text. */
function expectRoundTrip(raw: unknown) {
  const first = parseAudioEvent(raw);
  const text = formatAudioEvent(first.value);
  const second = parseAudioEvent(JSON.parse(text));
  expect(second.value).toEqual(first.value);
  expect(second.problems).toEqual([]);
  expect(formatAudioEvent(second.value)).toBe(text);
  return { first, text };
}

describe("music writer round trip (L-F1ba)", () => {
  it("L-F1ba: a playlist root of two segments round-trips (value equal, no problems, idempotent text)", () => {
    const raw = {
      format: FORMAT, bus: "Music",
      root: {
        type: "playlist", id: "list", mode: "random", rounds: 2, avoidRepeat: 1,
        children: [seg("a", "music/a.ogg"), seg("b", "music/b.ogg", { plays: 2 })],
      },
    };
    const { first } = expectRoundTrip(raw);
    expect(first.problems).toEqual([]);
    expect(eventRootNode(first.value)).toMatchObject({ type: "playlist", mode: "random", rounds: 2, avoidRepeat: 1 });
  });

  it("L-F1ba: a musicSwitch with a nested playlist child, a `library` and every optional key round-trips", () => {
    const raw = {
      format: FORMAT, bus: "Music", priority: 200, parameters: [STATE],
      root: {
        type: "musicSwitch", id: "world", parameter: "State", default: "explore",
        library: [seg("riser", "music/riser.ogg")],
        children: [
          {
            type: "segment", id: "explore", value: "explore", gridOffset: 0.5, volume: 0.8, volumeRandom: [-1, 1],
            tempo: [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }, { at: "9:1:0", bpm: 90, beatsPerBar: 3, beatUnit: 4 }],
            cues: [{ name: "entry", at: "1:1:0" }, { name: "hit", at: "3:3:0" }, { name: "exit", at: "end" }],
            entry: "entry", exit: "exit",
            regions: [{ id: "loop", from: "1:1:0", to: "9:1:0", count: 0, tailBeats: 4, while: { parameter: "Boss", is: "alive" } }],
            tracks: [{
              name: "drums", clip: "music/e-drums.ogg", alternatives: ["music/e-drums-b.ogg"], pick: "random", volume: 0.5, bus: "Drums",
              automation: [{ parameter: "Intensity", target: "volume", curve: [[0, 0], [1, 1]], quantize: "bar" }],
            }],
          },
          {
            type: "playlist", id: "fight", value: "combat", mode: "random", avoidRepeat: 1, rounds: 0, plays: 2,
            library: [seg("sting", "music/sting.ogg")],
            children: [
              seg("c1", "music/c1.ogg", { plays: 2, weight: 3 }),
              { type: "playlist", id: "inner", mode: "shuffle", rounds: 2, children: [seg("c2", "music/c2.ogg")] },
            ],
          },
        ],
      },
    };
    const { first, text } = expectRoundTrip(raw);
    expect(first.problems).toEqual([]);
    const root = JSON.parse(text).root;
    expect(root).toMatchObject({ type: "musicSwitch", id: "world", parameter: "State", default: "explore", library: [{ id: "riser" }] });
    expect(root.children[0].tracks[0]).toMatchObject({ pick: "random", volume: 0.5, bus: "Drums", automation: [{ quantize: "bar" }] });
    expect(root.children[1]).toMatchObject({ type: "playlist", id: "fight", value: "combat", mode: "random", avoidRepeat: 1, rounds: 0, plays: 2, library: [{ id: "sting" }] });
    expect(root.children[1].children[0]).toMatchObject({ id: "c1", plays: 2, weight: 3 });
    expect(root.children[1].children[1]).toMatchObject({ type: "playlist", id: "inner", mode: "shuffle", rounds: 2 });
  });

  it("L-F1ba: the writer never writes pitch, pitchRandom, delay, range, fade or automation on a music node (a pitched raw input re-reads with no problems)", () => {
    const raw = {
      format: FORMAT, bus: "Music",
      root: {
        type: "segment", id: "ign", pitch: 2, pitchRandom: [1, 2], delay: 0.5, range: [0, 1], fade: 0.25,
        automation: [{ parameter: "X", target: "volume", curve: [[0, 0], [1, 1]] }],
        tracks: [{ name: "a", clip: "music/a.ogg" }],
      },
    };
    const { first, text } = expectRoundTrip(raw);
    // One problem per ignored key on the node, each naming its path.
    for (const key of ["pitch", "pitchRandom", "delay", "range", "fade", "automation"]) {
      expect(first.problems.some((p) => p.startsWith(`root.${key}:`))).toBe(true);
    }
    expect(first.problems).toHaveLength(6);
    const root = JSON.parse(text).root;
    for (const key of ["pitch", "pitchRandom", "delay", "range", "fade", "automation"]) expect(root).not.toHaveProperty(key);
  });

  it("L-F1ba: defaults are omitted (playlist mode sequence, rounds 1, avoidRepeat 0, plays 1, weight 1) and `type`, `id` come first", () => {
    const raw = {
      format: FORMAT, bus: "Music",
      root: {
        type: "playlist", id: "pl", mode: "sequence", rounds: 1, avoidRepeat: 0,
        children: [{
          type: "segment", id: "s", plays: 1, weight: 1, volume: 1, gridOffset: 0,
          tracks: [{ name: "a", clip: "music/a.ogg", pick: "sequence", volume: 1, bus: "" }],
        }],
      },
    };
    const { first, text } = expectRoundTrip(raw);
    expect(first.problems).toEqual([]);
    const root = JSON.parse(text).root;
    expect(Object.keys(root).slice(0, 2)).toEqual(["type", "id"]);
    expect(Object.keys(root.children[0]).slice(0, 2)).toEqual(["type", "id"]);
    expect(root).toEqual({ type: "playlist", id: "pl", children: [{ type: "segment", id: "s", tracks: [{ name: "a", clip: "music/a.ogg" }] }] });
  });

  it("L-F1ba: an optional `id` on a 0158 node (clip, random...) is written and read back", () => {
    const raw = {
      format: FORMAT, bus: "Sfx",
      root: {
        type: "random", id: "pick1",
        children: [{ type: "clip", id: "boom", clip: "sfx/boom.ogg" }, { type: "clip", clip: "sfx/bang.ogg" }],
      },
    };
    const { first, text } = expectRoundTrip(raw);
    expect(first.problems).toEqual([]);
    expect(first.value.root).toMatchObject({ id: "pick1" });
    expect(first.value.root.type === "random" && first.value.root.children[0]).toMatchObject({ id: "boom" });
    const json = JSON.parse(text).root;
    expect(json).toMatchObject({ id: "pick1", children: [{ id: "boom", clip: "sfx/boom.ogg" }, { clip: "sfx/bang.ogg" }] });
    expect(json.children[1]).not.toHaveProperty("id");
  });

  it("L-F1ba: an event with no music nodes writes the same text as before F1b (a fixed golden string)", () => {
    const raw = {
      format: FORMAT,
      bus: "Sfx",
      root: {
        type: "layer",
        children: [
          { type: "clip", clip: "sfx/a.ogg" },
          { type: "random", children: [{ type: "clip", clip: "sfx/b.ogg", weight: 2 }, { type: "clip", clip: "sfx/c.ogg" }] },
        ],
      },
    };
    const { value, problems } = parseAudioEvent(raw);
    expect(problems).toEqual([]);
    expect(formatAudioEvent(value)).toBe(GOLDEN);
  });
});

describe("eventClips for music nodes (L-F1ba)", () => {
  it("L-F1ba: a segment root lists each track's clip then its alternatives, once each, in order", () => {
    const raw = {
      format: FORMAT, bus: "Music",
      root: {
        type: "segment", id: "s",
        tracks: [
          { name: "a", clip: "music/a.ogg", alternatives: ["music/a-b.ogg", "music/a-c.ogg"] },
          { name: "b", clip: "music/b.ogg", alternatives: ["music/a.ogg"] },
        ],
      },
    };
    const { value } = parseAudioEvent(raw);
    expect(eventClips(value)).toEqual(["music/a.ogg", "music/a-b.ogg", "music/a-c.ogg", "music/b.ogg"]);
  });

  it("L-F1ba: a playlist lists its children's clips in child order, nested containers depth first", () => {
    const raw = {
      format: FORMAT, bus: "Music",
      root: {
        type: "playlist", id: "pl",
        children: [
          seg("s1", "music/x.ogg"),
          { type: "playlist", id: "p2", children: [seg("s2", "music/y.ogg"), seg("s3", "music/z.ogg")] },
          seg("s4", "music/w.ogg"),
        ],
      },
    };
    const { value } = parseAudioEvent(raw);
    expect(eventClips(value)).toEqual(["music/x.ogg", "music/y.ogg", "music/z.ogg", "music/w.ogg"]);
  });

  it("L-F1ba: library segments' clips are listed after the container's children, and a clip shared with a child is listed once", () => {
    const raw = {
      format: FORMAT, bus: "Music", parameters: [STATE],
      root: {
        type: "musicSwitch", id: "ms", parameter: "State", default: "explore",
        library: [seg("riser", "music/riser.ogg"), seg("hit", "music/shared.ogg")],
        children: [
          seg("explore", "music/e.ogg", { value: "explore" }),
          seg("combat", "music/shared.ogg", { value: "combat" }),
        ],
      },
    };
    const { value } = parseAudioEvent(raw);
    expect(eventClips(value)).toEqual(["music/e.ogg", "music/shared.ogg", "music/riser.ogg"]);
  });

  it("L-F1ba: empty clip paths are skipped and an `asset:` prefix is stripped", () => {
    const raw = {
      format: FORMAT, bus: "Music",
      root: {
        type: "segment", id: "s",
        tracks: [
          { name: "a", clip: "asset:music/a.ogg", alternatives: ["asset:music/a-b.ogg", ""] },
          { name: "b", clip: "", alternatives: [] },
        ],
      },
    };
    const { value } = parseAudioEvent(raw);
    expect(eventClips(value)).toEqual(["music/a.ogg", "music/a-b.ogg"]);
  });

  it("L-F1ba: an event with no music nodes lists the same clips as before F1b", () => {
    const raw = {
      format: FORMAT, bus: "Sfx",
      root: {
        type: "layer",
        children: [
          { type: "clip", clip: "sfx/a.ogg" },
          { type: "random", children: [{ type: "clip", clip: "sfx/b.ogg" }, { type: "clip", clip: "sfx/a.ogg" }, { type: "clip", clip: "sfx/c.ogg" }] },
          { type: "clip", clip: "" },
        ],
      },
    };
    const { value } = parseAudioEvent(raw);
    expect(eventClips(value)).toEqual(["sfx/a.ogg", "sfx/b.ogg", "sfx/c.ogg"]);
  });
});

/** `formatAudioEvent` of the event in "an event with no music nodes" above, as written before F1b. */
const GOLDEN = `{
  "format": "myco.audioevent@1",
  "bus": "Sfx",
  "volume": 1,
  "pitch": 1,
  "volumeRandom": [
    0,
    0
  ],
  "pitchRandom": [
    0,
    0
  ],
  "priority": 128,
  "limit": {
    "maxInstances": 0,
    "steal": "oldest"
  },
  "cooldown": 0,
  "parameters": [],
  "automation": [],
  "root": {
    "volume": 1,
    "pitch": 1,
    "volumeRandom": [
      0,
      0
    ],
    "pitchRandom": [
      0,
      0
    ],
    "delay": 0,
    "automation": [],
    "weight": 1,
    "fade": 0,
    "type": "layer",
    "children": [
      {
        "volume": 1,
        "pitch": 1,
        "volumeRandom": [
          0,
          0
        ],
        "pitchRandom": [
          0,
          0
        ],
        "delay": 0,
        "automation": [],
        "weight": 1,
        "fade": 0,
        "type": "clip",
        "clip": "sfx/a.ogg",
        "loop": false,
        "startOffset": 0,
        "sustain": false
      },
      {
        "volume": 1,
        "pitch": 1,
        "volumeRandom": [
          0,
          0
        ],
        "pitchRandom": [
          0,
          0
        ],
        "delay": 0,
        "automation": [],
        "weight": 1,
        "fade": 0,
        "type": "random",
        "children": [
          {
            "volume": 1,
            "pitch": 1,
            "volumeRandom": [
              0,
              0
            ],
            "pitchRandom": [
              0,
              0
            ],
            "delay": 0,
            "automation": [],
            "weight": 2,
            "fade": 0,
            "type": "clip",
            "clip": "sfx/b.ogg",
            "loop": false,
            "startOffset": 0,
            "sustain": false
          },
          {
            "volume": 1,
            "pitch": 1,
            "volumeRandom": [
              0,
              0
            ],
            "pitchRandom": [
              0,
              0
            ],
            "delay": 0,
            "automation": [],
            "weight": 1,
            "fade": 0,
            "type": "clip",
            "clip": "sfx/c.ogg",
            "loop": false,
            "startOffset": 0,
            "sustain": false
          }
        ],
        "mode": "step",
        "gap": 0,
        "avoidRepeat": 0
      }
    ]
  }
}
`;
