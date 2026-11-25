#!/usr/bin/env node
// The Babylon comparison for the animation core's budget scenarios: the same 80-bone humanoid and the same idle, walk and
// run keys as `native/anim/crates/anim-wasm/bench_budgets.mjs`, played by Babylon.js's own animation system in Node
// (NullEngine, nothing drawn), timed the same way, printed in the same format.
//
//   node tools/anim-bench/babylon.mjs [--rounds N] [--frames N] [--only substring] [--gap MS] [--busy MS] [--regen]
//
// Each character is a Babylon `Skeleton` of 80 `Bone`s (the rest pose as each bone's local matrix) and one
// `AnimationGroup` per clip it plays: a `Vector3` `position`, `Quaternion` `rotationQuaternion` and `Vector3` `scaling`
// `Animation` per bone, 31 linear keys at 30 Hz, looping (a channel whose keys never change is left out, as our compressor
// drops it). The `Animation`s are shared by every character, as our clip data is. A frame is `scene.animate()` (every
// animatable advances and writes its bones; weighted groups blend) then `prepare(true)` on every skeleton: each bone's
// final matrix (local × parent) times its inverse bind, into the skeleton's matrix array, which is what our core's
// evaluate ends with (the skinning palette). `useConstantAnimationDeltaTime` steps 16 ms a frame.
//
// Scenarios, and what to compare each with (`bench_budgets.mjs`):
// - one_clip_80: 100 characters, walk ↔ our one_clip_80;
// - crossfade_80: 100 characters, walk and run at 0.5 each ↔ our crossfade_80;
// - blend3_80: 100 characters, idle, walk and run at 0.2, 0.5, 0.3 (a blend space's three samples, without sync, the
//   state machine, the slot or inertialization) ↔ below our locomotion_80, which does all of those;
// - clips_300: 300 characters, walk ↔ our one_clip_80 with `--characters 300 --max-instances 512 --max-bones 256`.
// There is no equivalent of the rig (grounder, look-at) or motion matching in Babylon, so those aren't compared.
//
// `--gap MS` and `--busy MS` are bench_budgets.mjs's: an idle wait (a timer) and CPU-bound work before each timed frame.
// The keys come from `cargo run --release -p anim-bench --example raw_clips` (generated into native/anim/target/
// bench-fixtures/ the first time, or with --regen; never committed), so this needs the Rust toolchain once.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const animRoot = fileURLToPath(new URL("../../native/anim/", import.meta.url));
const rawFile = fileURLToPath(new URL("../../native/anim/target/bench-fixtures/humanoid80_raw.json", import.meta.url));

/** Each scenario: its characters and the clips each plays with their weights. */
const SCENARIOS = {
  one_clip_80: { characters: 100, clips: [["walk", 1]] },
  crossfade_80: { characters: 100, clips: [["walk", 0.5], ["run", 0.5]] },
  blend3_80: { characters: 100, clips: [["idle", 0.2], ["walk", 0.5], ["run", 0.3]] },
  clips_300: { characters: 300, clips: [["walk", 1]] },
};

const child = opt("child", null);
if (child) await runChild(child);
else runParent();

function runParent() {
  if (args.includes("--regen") || !existsSync(rawFile)) {
    console.log("generating the raw clips (cargo run --release -p anim-bench --example raw_clips)...");
    execFileSync("cargo", ["run", "--release", "-q", "-p", "anim-bench", "--example", "raw_clips", "--", rawFile], { cwd: animRoot, stdio: "inherit" });
  }
  const rounds = Number(opt("rounds", 5));
  const only = opt("only", null);
  const pass = ["frames", "gap", "busy"].flatMap((k) => (opt(k, null) === null ? [] : [`--${k}`, opt(k)]));
  for (const name of Object.keys(SCENARIOS)) {
    if (only && !name.includes(only)) continue;
    const lines = [];
    for (let r = 0; r < rounds; r++) {
      const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--child", name, ...pass], { encoding: "utf8" });
      const line = JSON.parse(out.trim().split("\n").pop());
      if (!line.moved) throw new Error(`${name}: the skeletons didn't animate, so the timing means nothing`);
      lines.push(line);
    }
    const med = (key) => lines.map((l) => l[key]).sort((a, b) => a - b)[Math.floor(lines.length / 2)];
    const ms = lines.map((l) => l.ms).sort((a, b) => a - b);
    const median = med("ms");
    const spread = Math.round(((ms[ms.length - 1] - ms[0]) / median) * 100);
    console.log(
      `${name.padEnd(18)} median ${median.toFixed(3)} ms  range ${ms[0].toFixed(3)}–${ms[ms.length - 1].toFixed(3)} (${spread}%)  ` +
        `(Babylon: animate ${med("animate").toFixed(2)} + prepare ${med("prepare").toFixed(2)} ms, ${lines[0].animatables} animatables)`,
    );
  }
}

async function runChild(name) {
  const { NullEngine } = await import("@babylonjs/core/Engines/nullEngine.js");
  const { Scene } = await import("@babylonjs/core/scene.js");
  const { Skeleton } = await import("@babylonjs/core/Bones/skeleton.js");
  const { Bone } = await import("@babylonjs/core/Bones/bone.js");
  const { Animation } = await import("@babylonjs/core/Animations/animation.js");
  const { AnimationGroup } = await import("@babylonjs/core/Animations/animationGroup.js");
  await import("@babylonjs/core/Animations/animatable.js"); // the scene's animate and beginAnimation
  const { Matrix, Quaternion, Vector3 } = await import("@babylonjs/core/Maths/math.vector.js");
  // Babylon logs a banner line on stdout; the parent reads the last line only.
  const scenario = SCENARIOS[name];
  const raw = JSON.parse(readFileSync(rawFile, "utf8"));
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useConstantAnimationDeltaTime = true;

  // One set of Animations per clip, shared by every character: per bone, the channels whose keys change.
  const CHANNELS = [
    { property: "position", type: Animation.ANIMATIONTYPE_VECTOR3, at: 0, make: (k, o) => new Vector3(k[o], k[o + 1], k[o + 2]) },
    { property: "rotationQuaternion", type: Animation.ANIMATIONTYPE_QUATERNION, at: 3, make: (k, o) => new Quaternion(k[o], k[o + 1], k[o + 2], k[o + 3]) },
    { property: "scaling", type: Animation.ANIMATIONTYPE_VECTOR3, at: 7, make: (k, o) => new Vector3(k[o], k[o + 1], k[o + 2]) },
  ];
  const width = (c) => (c.type === Animation.ANIMATIONTYPE_QUATERNION ? 4 : 3);
  const clipAnimations = {};
  for (const [clip] of scenario.clips) {
    const { rate, frames, tracks } = raw.clips[clip];
    clipAnimations[clip] = tracks.map((keys, bone) =>
      CHANNELS.flatMap((c) => {
        let changes = false;
        for (let f = 1; f < frames && !changes; f++) for (let i = 0; i < width(c); i++) if (keys[f * 10 + c.at + i] !== keys[c.at + i]) changes = true;
        if (!changes) return [];
        const anim = new Animation(`${clip}.${bone}.${c.property}`, c.property, rate, c.type, Animation.ANIMATIONLOOPMODE_CYCLE);
        anim.setKeys(Array.from({ length: frames }, (_, f) => ({ frame: f, value: c.make(keys, f * 10 + c.at) })));
        return [anim];
      }),
    );
  }

  const skeletons = [];
  for (let n = 0; n < scenario.characters; n++) {
    const skeleton = new Skeleton(`character${n}`, `character${n}`, scene);
    skeleton.useTextureToStoreBoneMatrices = false;
    const bones = [];
    for (const [i, b] of raw.bones.entries()) {
      const local = Matrix.Compose(new Vector3(...b.s), new Quaternion(...b.r), new Vector3(...b.t));
      const bone = new Bone(`b${i}`, skeleton, b.parent < 0 ? null : bones[b.parent], local);
      bone.rotationQuaternion = new Quaternion(...b.r); // so rotation animations write a quaternion
      bones.push(bone);
    }
    for (const [clip, weight] of scenario.clips) {
      const group = new AnimationGroup(`character${n}.${clip}`, scene);
      clipAnimations[clip].forEach((anims, bone) => anims.forEach((a) => group.addTargetedAnimation(a, bones[bone])));
      group.start(true);
      // A lone clip keeps Babylon's unweighted path (weight −1); only blends set weights.
      if (scenario.clips.length > 1) group.setWeightForAllAnimatables(weight);
    }
    skeleton.prepare(true);
    skeletons.push(skeleton);
  }

  let tAnimate = 0;
  let tPrepare = 0;
  const step = () => {
    const a = performance.now();
    scene.animate();
    const b = performance.now();
    for (let i = 0; i < skeletons.length; i++) skeletons[i].prepare(true);
    tAnimate += b - a;
    tPrepare += performance.now() - b;
  };
  const frames = Number(opt("frames", 300));
  const warm = 120;
  for (let i = 0; i < warm; i++) step();
  tAnimate = tPrepare = 0;
  const gap = Number(opt("gap", 0));
  const busy = Number(opt("busy", 0));
  let ms = 0;
  let sink = 0;
  if (gap > 0 || busy > 0) {
    for (let i = 0; i < frames; i++) {
      if (gap > 0) await new Promise((done) => setTimeout(done, gap));
      for (const until = performance.now() + busy; performance.now() < until; ) for (let k = 0; k < 1000; k++) sink += Math.sqrt(k + sink) * 1e-9;
      const t0 = performance.now();
      step();
      ms += (performance.now() - t0) / frames;
    }
  } else {
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) step();
    ms = (performance.now() - t0) / frames;
  }
  const split = { animate: tAnimate / frames, prepare: tPrepare / frames };
  // A check that the skeletons really animate: the first character's palette must change between frames.
  const before = Float32Array.from(skeletons[0].getTransformMatrices(null));
  step();
  const moved = skeletons[0].getTransformMatrices(null).some((v, i) => v !== before[i]);
  console.log(JSON.stringify({ ms, ...split, moved, animatables: scene.animatables.length, ...(sink < 0 ? { sink } : {}) }));
}
