// Playlist JSON shared by the playlist format, references and lint tests. Test data only.

/** A Queue of footsteps: linked, embedded and wrapped entries. */
export const QUEUE = {
  format: "myco.playlist@1",
  type: "queue",
  output: "SFX",
  playback: { plays: "oneShot", maxInstances: 4, whenFull: "stealQuietest", cooldown: 0.05, chance: 0.9, delay: 0, priority: 100 },
  volume: -3, pitch: 0, volumeRandom: [-2, 0], pitchRandom: [-1, 1],
  effects: [{ id: "fx1", type: "lowpass", on: true, params: { cutoff: 8000 } }],
  automation: [
    { id: "a1", target: "fx:fx1:cutoff", input: { parameter: "Speed" }, curve: [[0, 8000], [10, 2000]] },
    { id: "a2", target: "volume", input: "voiceTime", curve: [[0, -6], [1, 0]] },
  ],
  spatial: { attenuation: "audio/attenuation/feet.attenuation.json", occlusion: true, doppler: 0.5, spread: null },
  parameters: [{ name: "Speed", min: 0, max: 10, default: 0, seekSpeed: 0 }],
  stingers: [],
  entries: [
    { playlist: "audio/footsteps/dirt_01.playlist.json", weight: 2 },
    { embedded: { type: "clip", entries: [{ sample: "audio/dirt_02.wav", trim: [0.01, 0.4], loop: "off" }] }, volume: -2, curves: { pitch: { input: { parameter: "Speed" }, curve: [[0, 0], [10, 2]] } } },
  ],
  queue: { pick: "shuffle", avoidRepeat: 2, continuous: null },
};

/** A Switch with change rules, a transition and a stinger. */
export const SWITCH = {
  format: "myco.playlist@1",
  type: "switch",
  parameters: [{ name: "State", labels: ["explore", "combat", "boss"], default: "explore" }],
  stingers: [{ trigger: "victory", playlist: { playlist: "audio/music/victory.playlist.json" }, at: "bar", ifLate: "nextGrid", dontRepeat: 4 }],
  entries: [
    { playlist: "audio/music/explore.playlist.json" },
    { playlist: "audio/music/combat.playlist.json" },
  ],
  switch: {
    parameter: "State",
    map: { explore: 0, combat: 1, boss: null },
    labelGain: { combat: 2 },
    onChange: { when: "bar", how: "crossfade", length: { beats: 2 } },
    rules: [
      { from: "explore", to: "combat", when: "exit", how: "transition", length: { beats: 1 }, transition: { playlist: "audio/music/bridge.playlist.json" } },
      { from: "*", to: "explore", when: "now", how: "cut", length: { ms: 0 } },
    ],
  },
};

/** A Sequence with an audio track, a playlist track, loops, markers and automation. */
export const SEQUENCE = {
  format: "myco.playlist@1",
  type: "sequence",
  playback: { plays: "untilStopped" },
  parameters: [{ name: "brake", min: 0, max: 1, default: 0, seekSpeed: 0 }],
  entries: [],
  sequence: {
    length: 4,
    tempo: { bpm: 120, meter: "4/4" },
    tracks: [
      {
        id: "t1", name: "Skid", kind: "audio", color: 2, volume: -1,
        effects: [{ id: "e1", type: "delay", on: true, params: { time: 120 } }],
        automation: [{ id: "a1", target: "fx:e1:mix", input: { parameter: "brake" }, curve: [[0, 0], [1, 40]] }],
        clips: [
          {
            id: "c1", sample: "audio/brake_skid.wav", at: 0, length: 2.6, sync: true,
            loops: { l1: { active: "parameter", binding: { parameter: "brake", op: ">", value: 0.1 }, reentry: "reenter" } },
            hiddenMarkers: ["m2"],
            effects: [{ id: "e2", type: "gain", on: true, params: { gain: -3 } }],
            automation: [{ id: "a1", target: "volume", input: "clipTime", curve: [[0, -12], [0.2, 0, "easeOut"]] }],
          },
        ],
      },
      {
        id: "t2", name: "Layer", kind: "playlist", color: "#ff8800", output: "Vehicles",
        clips: [
          { id: "c2", playlist: "audio/hover/whine.playlist.json", at: 0.5, length: 3 },
          { id: "c3", playlist: { type: "clip", entries: [{ sample: "audio/hiss.wav" }] }, at: 1, length: 1, enabled: false },
        ],
      },
    ],
    loops: [{ id: "h1", start: 1.6, end: 1.6, active: "held", exit: "jump", exitFadeMs: 40, reentry: "ignore" }],
    markers: [{ id: "m1", name: "Lock-up", at: 0.3 }],
  },
};

/** A Blend over speed with a voice envelope. */
export const BLEND = {
  format: "myco.playlist@1",
  type: "blend",
  parameters: [{ name: "speed", min: 0, max: 100, default: 0, seekSpeed: 50 }],
  entries: [
    { playlist: "audio/wind/low.playlist.json", x: 10, atZeroWeight: "continue" },
    { playlist: "audio/wind/high.playlist.json", x: 90 },
  ],
  blend: {
    axes: [{ parameter: "speed" }], fade: "layer", curve: "linear", follow: "hold",
    envelope: { mode: "morph", low: { attackMs: 5, decayMs: 50, sustain: 0.8, releaseMs: 300 }, high: { attackMs: 1, decayMs: 20, sustain: 1, releaseMs: 100 } },
  },
};
