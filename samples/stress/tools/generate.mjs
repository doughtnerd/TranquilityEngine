// Writes the Stress sample's committed data, deterministically (a rerun rewrites identical files):
//   audio/emit-*.wav     four short mono loops for the moving spatial emitters (48 kHz)
//   audio/stream-*.wav   four looping clips that stream (16 kHz mono, with .meta.json sidecars saying so)
//   scenes/main.scene.json   the listener, 24 orbiting emitters, 8 streams and the driver node
//   project.json "audio".buses   32 buses with effects (the file's other keys are kept as they are)
//
//   node samples/stress/tools/generate.mjs
//
// The storm's clips (about 64 MB of them) are not committed: scripts/clips.ts synthesises them in the page.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TAU = Math.PI * 2;

function wav(samples, rate) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const make = (seconds, rate, fn) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => fn(i / rate));
function rng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

// --- Audio -----------------------------------------------------------------------------------------------------------
mkdirSync(join(root, "audio"), { recursive: true });
const files = [];
// Emitters: whole cycles in 0.5 s, so each loop repeats without a click. Different timbres so the HRTF has something to place.
const EMIT = [
  (t) => 0.4 * Math.sin(TAU * 440 * t) + 0.2 * Math.sin(TAU * 880 * t),
  (t) => 0.35 * Math.sin(TAU * 300 * t) * (0.6 + 0.4 * Math.sin(TAU * 4 * t)),
  (t) => (0.3 * (Math.sin(TAU * 220 * t) + Math.sin(TAU * 330 * t) + Math.sin(TAU * 660 * t))) / 1.5,
  (t) => 0.3 * Math.sin(TAU * 1200 * t + 3 * Math.sin(TAU * 8 * t)),
];
EMIT.forEach((fn, i) => files.push([`audio/emit-${i}.wav`, wav(make(0.5, 48000, fn), 48000)]));
// Streams: 5 s at 16 kHz (the decoder resamples while streaming); a slow arpeggio per file, loop-clean (zero at both ends).
const NOTES = [
  [220, 277, 330, 440],
  [247, 294, 370, 494],
  [196, 262, 330, 392],
  [262, 330, 392, 523],
];
NOTES.forEach((notes, i) => {
  const n = rng(10 + i);
  files.push([
    `audio/stream-${i}.wav`,
    wav(
      make(5, 16000, (t) => {
        const k = Math.floor(t / 1.25) % 4;
        const u = t - Math.floor(t / 1.25) * 1.25;
        const env = Math.min(1, u / 0.01, Math.max(0, 1.25 - u) / 0.05) * Math.exp(-u * 1.5);
        return 0.5 * env * (Math.sin(TAU * notes[k] * t) + 0.3 * Math.sin(TAU * 2 * notes[k] * t)) + 0.01 * n() * env;
      }),
      16000,
    ),
  ]);
  files.push([`audio/stream-${i}.wav.meta.json`, Buffer.from('{\n  "format": "myco.import@1",\n  "stream": true\n}\n')]);
});
for (const [name, data] of files) {
  writeFileSync(join(root, name), data);
  console.log(`${name}  ${data.length} bytes`);
}

// --- Buses -----------------------------------------------------------------------------------------------------------
// Master, 4 mixes under it and 27 leaves under the mixes (32, the limit). Every bus but Master has a high-pass, a
// low-pass and a compressor; 8 of the leaves also send to the reverb. The storm plays on the leaves.
const LEAVES = 27;
const buses = [{ name: "Master", volume: 1, mute: false, effects: [] }];
const fx = (i, reverb) => [
  { type: "highpass", frequency: 30 + (i % 8) * 10, q: 0.707 },
  { type: "lowpass", frequency: 14000 + (i % 5) * 1500, q: 0.707 },
  { type: "compressor", threshold: -20 - (i % 4) * 2, knee: 20, ratio: 3 + (i % 3), attack: 0.005, release: 0.2 },
  ...(reverb ? [{ type: "reverb", send: Math.round((0.15 + (i % 4) * 0.05) * 100) / 100 }] : []),
];
for (let m = 0; m < 4; m++) buses.push({ name: `Mix${m}`, parent: "Master", volume: 1, mute: false, effects: fx(m, false) });
for (let i = 0; i < LEAVES; i++) {
  buses.push({ name: `Bus${String(i).padStart(2, "0")}`, parent: `Mix${i % 4}`, volume: 0.8, mute: false, effects: fx(i + 4, i % 3 === 0 && i < 24) });
}
const projectPath = join(root, "project.json");
const project = JSON.parse(readFileSync(projectPath, "utf8"));
project.audio.buses = buses;
writeFileSync(projectPath, JSON.stringify(project, null, 2) + "\n");
console.log(`project.json: ${buses.length} buses`);

// --- Scene -----------------------------------------------------------------------------------------------------------
const leaf = (i) => `Bus${String(i % LEAVES).padStart(2, "0")}`;
const nodes = [
  {
    id: "camera",
    name: "Camera",
    components: [
      { type: "engine.Transform", data: { position: [0, 6, 14], rotation: [-22, 0, 0] } },
      { type: "engine.Camera", data: { projection: "perspective", fieldOfView: 55 } },
      { type: "engine.AudioListener", data: {} },
    ],
  },
  {
    id: "sun",
    name: "Sun",
    components: [
      { type: "engine.Transform", data: { position: [0, 8, 0], rotation: [-55, 35, 0] } },
      { type: "engine.Light", data: { type: "directional", intensity: 1.2 } },
    ],
  },
  { id: "stress", name: "Stress (storm, bus churn, readout, soak)", transform: false, components: [{ type: "stress.Stress", data: {} }] },
];
for (let i = 0; i < 24; i++) {
  nodes.push({
    id: `emitter${i}`,
    name: `Emitter ${i}`,
    components: [
      { type: "engine.Transform", data: { position: [0, 0.5 + (i % 5) * 0.8, 0] } },
      { type: "engine.MeshRenderer", data: { mesh: "builtin:sphere" } },
      {
        type: "engine.AudioSource",
        data: {
          clip: `asset:audio/emit-${i % 4}.wav`,
          loop: true,
          volume: 0.25,
          pitch: 0.75 + (i % 7) * 0.2,
          playOnAwake: true,
          spatial: true,
          minDistance: 2,
          maxDistance: 40,
          output: leaf(i * 5 + 1),
        },
      },
      // Radii 3..25 m, 0.05..0.45 turns per second, every other one the other way round.
      { type: "stress.Orbit", data: { radius: 3 + (i % 12), speed: (i % 2 ? 1 : -1) * (0.05 + (i % 9) * 0.05), phase: i / 24 } },
    ],
  });
}
for (let i = 0; i < 8; i++) {
  const spatial = i % 2 === 0;
  nodes.push({
    id: `stream${i}`,
    name: `Stream ${i}`,
    components: [
      { type: "engine.Transform", data: { position: [0, 1, 0] } },
      {
        type: "engine.AudioSource",
        data: {
          clip: `asset:audio/stream-${i % 4}.wav`,
          loop: true,
          volume: 0.12,
          pitch: 1 + (i >> 2) * 0.5,
          playOnAwake: true,
          spatial,
          minDistance: 3,
          maxDistance: 50,
          output: leaf(i * 3 + 2),
        },
      },
      ...(spatial ? [{ type: "stress.Orbit", data: { radius: 8 + i * 2, speed: 0.12 + i * 0.03, phase: i / 8 } }] : []),
    ],
  });
}
const scene = { format: "myco.scene@2", settings: { physics: "3d" }, nodes };
mkdirSync(join(root, "scenes"), { recursive: true });
writeFileSync(join(root, "scenes", "main.scene.json"), JSON.stringify(scene, null, 2) + "\n");
console.log(`scenes/main.scene.json: ${nodes.length} nodes`);
