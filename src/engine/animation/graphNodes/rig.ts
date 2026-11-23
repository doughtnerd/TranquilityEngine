/**
 * Node family `rig` (`anim-graph/src/rig/mod.rs`): one rig-stack entry per node, each calling an `anim-rig` solver.
 * Every block starts with the head (words 0–3: weight, weight parameter, weight curve, LOD skip), then the kind's
 * words (the Rust module's `two_bone`, `chain`, `full_body`, `aim`, `grounder`, `spring`, `copy`, `limit_rotation`,
 * `limit_position`, `damp`, `stride`, `orientation`, `motion_warp` and `distance` tables). Bones are indices or Humanoid
 * role names (`ROLE | role`); IK targets are slot names the compiler numbers. Angles are radians except joint ranges
 * (degrees, as `JOINT_RANGES`). Internal: not public API.
 */
import { I, kind, NONE, P, type NodeFamilyCatalogue, type NodePacker, type NodeParamSchema } from "./schema";

const MAX_CHAIN = 16;
const MAX_FEET = 4;
const MAX_AIM_JOINTS = 8;
const MAX_LIST = 32;
const MAX_SPRING_BONES = 16;
const MAX_COLLIDERS = 16;
const MAX_BODY_CHAINS = 8;
const PI = Math.PI;

const HEAD: NodeParamSchema[] = [
  P.animated("weight", 1, "The node's weight; a float parameter multiplies it.", { unit: "ratio", min: 0, max: 1 }),
  P.name("weightCurve", "A curve of the input's timing clip, sampled at its playhead, that multiplies the weight.", { hashed: true }),
  P.int("lodSkip", 0, "Skipped while the instance's rig LOD level is ≥ this (0: never).", { min: 0 }),
];

function head(p: NodePacker): void {
  const [w, q] = p.animated("weight");
  p.f32(w);
  p.push(q, p.name("weightCurve"), p.int("lodSkip") ?? 0);
}

const up = (name = "up", doc = "Model up (zero: +Y).") => P.vec3(name, [0, 0, 0], doc);
const vec = (p: NodePacker, name: string) => p.vec(name).forEach((c) => p.f32(c));

/** A counted list: its length (checked against `min`..`max`), then its words. */
function counted(p: NodePacker, name: string, min: number, max: number, per = 1): number[] {
  const words = p.list(name);
  const n = Math.floor(words.length / per);
  // The packer already truncated the list to its `maxItems` (with a problem).
  if (n < min || words.length % per !== 0) p.problem(`needs ${min}–${max} ${per > 1 ? `groups of ${per}` : "entries"}, has ${words.length / per}.`, name);
  return words.slice(0, Math.min(n, max) * per);
}

/** The Humanoid limb chains `twoBoneIk`'s `chain` may name (root, mid, tip roles). */
const LIMBS: Record<string, readonly string[]> = {
  LeftArm: ["LeftUpperArm", "LeftLowerArm", "LeftHand"],
  RightArm: ["RightUpperArm", "RightLowerArm", "RightHand"],
  LeftLeg: ["LeftUpperLeg", "LeftLowerLeg", "LeftFoot"],
  RightLeg: ["RightUpperLeg", "RightLowerLeg", "RightFoot"],
};

/** Look-at and aim joints: per joint its bone, share and limit. */
function joints(p: NodePacker): number[] {
  const bones = counted(p, "bones", 1, MAX_AIM_JOINTS);
  const shares = p.list("shares");
  const limits = p.list("limits");
  const one = 0x3f800000;
  const out: number[] = [];
  bones.forEach((b, j) => out.push(b, shares[j] ?? one, limits[j] ?? 0));
  return out;
}

const jointParams = (): NodeParamSchema[] => [
  P.list("bones", "boneList", "The joints, root to end.", { minItems: 1, maxItems: MAX_AIM_JOINTS }),
  P.list("shares", "floatList", "Each joint's share of the turn, in [0, 1] (absent: 1).", { unit: "ratio", min: 0, max: 1 }),
  P.list("limits", "floatList", "Each joint's limit (≤ 0: free).", { unit: "radians" }),
];
const aimCommon = (): NodeParamSchema[] => [
  P.target("target", "The target slot."),
  P.float("upWeight", 0, "Up alignment.", { unit: "ratio", min: 0, max: 1 }),
  P.float("maxAngle", PI, "Clamp cone half-angle.", { unit: "radians", min: 0 }),
  P.vec3("forward", [0, 0, 0], "The bones' local forward axis (zero: +Z)."),
  P.vec3("up", [0, 0, 0], "The bones' local up axis (zero: +Y)."),
  P.vec3("goalUp", [0, 0, 0], "The model-space direction up axes are kept toward (zero: none)."),
];
function packAimCommon(p: NodePacker): void {
  p.push(p.target("target"));
  p.f32(p.num("upWeight"));
  p.f32(p.num("maxAngle"));
  vec(p, "forward");
  vec(p, "up");
  vec(p, "goalUp");
}
const legs = (doc: string) => P.list("legs", "boneList", doc, { minItems: 3, maxItems: 3 * MAX_FEET });

export const RIG_NODES: NodeFamilyCatalogue = {
  family: "rig",
  kinds: [
    kind("rig", "twoBoneIk", 0, "Two-bone IK (arm, leg).", I.one(), [
      ...HEAD,
      P.enum("chain", ["none", ...Object.keys(LIMBS)], "A Humanoid limb giving root, mid and tip as roles (each still overridable)."),
      P.bone("root", "The limb root (upper arm, thigh)."),
      P.bone("mid", "The mid bone (forearm, shin)."),
      P.bone("tip", "The tip (hand, foot)."),
      P.target("target", "The target slot."),
      P.target("pole", "A target slot whose position is the pole (none: keep the animated bend plane)."),
      P.enum("tipMode", ["inherit", "maintain", "target"], "The tip keeps its local rotation, its animated model rotation, or turns to the target's."),
      P.float("soft", 0, "Soft-IK band as a fraction of the reach (0: hard).", { unit: "ratio", min: 0, max: 1 }),
      P.float("maxStretch", 1, "Largest stretch (1: none).", { unit: "multiplier", min: 1 }),
    ], (p) => {
      head(p);
      const limb = Object.values(LIMBS)[p.choice("chain") - 1];
      for (const [i, part] of (["root", "mid", "tip"] as const).entries()) p.push(!p.has(part) && limb ? p.boneByName(limb[i]) : p.bone(part));
      p.push(p.target("target"), p.target("pole"), p.choice("tipMode"));
      p.f32(p.num("soft"));
      p.f32(p.num("maxStretch"));
    }),
    ...(["ccd", "fabrik"] as const).map((k, i) => kind("rig", k, 1 + i, i === 0 ? "Cyclic coordinate descent IK over a chain." : "FABRIK over a chain.", I.one(), [
      ...HEAD,
      P.target("target", "The target slot (for the chain's last bone)."),
      P.int("iterations", 16, "Iterations.", { min: 1 }),
      P.float("tolerance", 0.001, "Tolerance.", { unit: "meters", min: 0 }),
      P.bool("limits", false, "Apply the skeleton's joint limits to every chain bone."),
      P.list("bones", "boneList", "The bones, root to tip.", { minItems: 2, maxItems: MAX_CHAIN }),
    ], (p) => {
      head(p);
      p.push(p.target("target"), p.int("iterations") ?? 16);
      p.f32(p.num("tolerance"));
      p.push(p.bool("limits") ? 1 : 0);
      const bones = counted(p, "bones", 2, MAX_CHAIN);
      p.push(bones.length, ...bones);
    })),
    kind("rig", "fullBodyIk", 3, "Full-body IK: chains from the Humanoid roles or explicit, with effector slots.", I.one(), [
      ...HEAD,
      P.int("iterations", 8, "Iterations.", { min: 1 }),
      P.float("tolerance", 0.001, "Tolerance.", { unit: "meters", min: 0 }),
      P.float("bodyPull", 0.5, "Body pull.", { unit: "ratio", min: 0, max: 1 }),
      P.target("rootTarget", "The root (hips) effector's target slot."),
      P.target("comTarget", "The centre-of-mass target slot (its position weight is the pull)."),
      P.vec3("comUp", [0, 0, 0], "The centre of mass pulls only across this up axis (zero: in 3D)."),
      P.enum("mode", ["humanoid", "explicit"], "Chains from the Humanoid profile's roles, or from the explicit lists."),
      P.target("chestTarget", "Humanoid: the spine end's effector slot."),
      P.target("leftFootTarget", "Humanoid: the left foot's effector slot."),
      P.target("rightFootTarget", "Humanoid: the right foot's effector slot."),
      P.target("headTarget", "Humanoid: the head's effector slot."),
      P.target("leftHandTarget", "Humanoid: the left hand's effector slot."),
      P.target("rightHandTarget", "Humanoid: the right hand's effector slot."),
      P.bone("rootBone", "Explicit: the root bone."),
      P.list("chainParents", "intList", "Explicit: per chain, the earlier chain it branches from (-1: the root).", { maxItems: MAX_BODY_CHAINS }),
      P.list("chainTargets", "targetList", "Explicit: per chain, its effector slot.", { maxItems: MAX_BODY_CHAINS }),
      P.list("chainLengths", "intList", "Explicit: per chain, its bone count (≥ 2).", { maxItems: MAX_BODY_CHAINS }),
      P.list("chainBones", "boneList", "Explicit: every chain's bones in turn (the first is the sub-base: the root or the parent chain's last bone)."),
    ], (p) => {
      head(p);
      p.push(p.int("iterations") ?? 8);
      p.f32(p.num("tolerance"));
      p.f32(p.num("bodyPull"));
      p.push(p.target("rootTarget"), p.target("comTarget"));
      vec(p, "comUp");
      if (p.choice("mode") === 0) {
        p.push(1, NONE, 0);
        for (const t of ["chestTarget", "leftFootTarget", "rightFootTarget", "headTarget", "leftHandTarget", "rightHandTarget"]) p.push(p.target(t));
        return;
      }
      const lengths = p.list("chainLengths");
      const parents = p.list("chainParents");
      const targets = p.list("chainTargets");
      const bones = p.list("chainBones");
      if (lengths.length < 1 || lengths.length > MAX_BODY_CHAINS) p.problem(`explicit mode needs 1–${MAX_BODY_CHAINS} chains, has ${lengths.length}.`, "chainLengths");
      p.push(0, p.bone("rootBone"), Math.min(lengths.length, MAX_BODY_CHAINS));
      let at = 0;
      for (const [c, k] of lengths.slice(0, MAX_BODY_CHAINS).entries()) {
        if (k < 2) p.problem(`chain ${c} needs at least 2 bones.`, "chainLengths");
        const parent = parents[c];
        p.push(parent === undefined || parent >= c ? NONE : parent, targets[c] ?? NONE, k);
        for (let b = 0; b < k; b++) p.push(bones[at + b] ?? NONE);
        at += k;
      }
      if (at !== bones.length) p.problem(`the chains name ${at} bones, the list has ${bones.length}.`, "chainBones");
    }),
    kind("rig", "lookAt", 4, "Look-at over a joint chain (spine, neck, head).", I.one(), [...HEAD, ...aimCommon(), ...jointParams()], (p) => {
      head(p);
      packAimCommon(p);
      const j = joints(p);
      p.push(j.length / 3, ...j);
    }),
    kind("rig", "aim", 5, "Aims a bone (a weapon) at the target by turning a joint chain.", I.one(), [
      ...HEAD, ...aimCommon(),
      P.bone("aimBone", "The aim bone (a descendant of the last joint, or it)."),
      P.int("iterations", 4, "Iterations.", { min: 1 }),
      ...jointParams(),
    ], (p) => {
      head(p);
      packAimCommon(p);
      p.push(p.bone("aimBone"), p.int("iterations") ?? 4);
      const j = joints(p);
      p.push(j.length / 3, ...j);
    }),
    kind("rig", "grounder", 6, "Foot grounder: rays per foot, foot and pelvis placement.", I.one(), [
      ...HEAD,
      P.bone("pelvis", "The pelvis."),
      P.int("rayBase", null, "The first of the instance's ray rows it uses, one per foot (none: assigned by the compiler).", { min: 0, max: 7 }),
      up(),
      P.float("rayHeight", 0.5, "Ray start above the foot.", { unit: "meters", min: 0 }),
      P.float("rayDepth", 0.5, "Ray reach below the foot.", { unit: "meters", min: 0 }),
      P.float("maxStep", 0.5, "Largest foot raise or drop.", { unit: "meters", min: 0 }),
      P.float("maxFootAngle", PI / 4, "Largest foot tilt.", { unit: "radians", min: 0 }),
      P.float("footRotationWeight", 1, "Share of the ground tilt the feet take.", { unit: "ratio", min: 0, max: 1 }),
      P.float("footHalfLife", 0.05, "Foot smoothing half-life.", { unit: "seconds", min: 0 }),
      P.float("pelvisHalfLife", 0.1, "Pelvis smoothing half-life.", { unit: "seconds", min: 0 }),
      P.float("maxPelvisDown", 0.5, "Largest pelvis drop.", { unit: "meters", min: 0 }),
      P.float("maxPelvisUp", 0, "Largest pelvis raise.", { unit: "meters", min: 0 }),
      legs("Per foot: thigh, shin and foot (1–4 feet)."),
    ], (p) => {
      head(p);
      const feet = counted(p, "legs", 1, MAX_FEET, 3);
      p.push(p.bone("pelvis"), p.has("rayBase") ? (p.int("rayBase") ?? 0) : p.rays(feet.length / 3));
      vec(p, "up");
      for (const n of ["rayHeight", "rayDepth", "maxStep", "maxFootAngle", "footRotationWeight", "footHalfLife", "pelvisHalfLife", "maxPelvisDown", "maxPelvisUp"]) p.f32(p.num(n));
      p.push(feet.length / 3, ...feet);
    }),
    kind("rig", "springChain", 7, "A spring (jiggle) chain with colliders.", I.one(), [
      ...HEAD,
      P.float("stiffness", 60, "Stiffness, 1/s².", { min: 0 }),
      P.float("damping", 6, "Damping, 1/s.", { min: 0 }),
      P.float("drag", 0.5, "Drag, 1/s.", { min: 0 }),
      P.vec3("gravity", [0, -9.81, 0], "World gravity."),
      P.float("maxAngle", PI, "Largest swing from the animated direction.", { unit: "radians", min: 0 }),
      P.float("radius", 0, "Particle radius.", { unit: "meters", min: 0 }),
      P.float("maxStep", 1 / 120, "Longest substep.", { unit: "seconds", min: 0 }),
      P.int("maxSubsteps", 8, "Most substeps per update.", { min: 1 }),
      P.float("teleport", 2, "Anchor jump that resets the chain.", { unit: "meters", min: 0 }),
      P.list("bones", "boneList", "The bones, anchor first.", { minItems: 2, maxItems: MAX_SPRING_BONES }),
      P.list("colliderBones", "boneList", "Per collider, its bone.", { maxItems: MAX_COLLIDERS }),
      P.list("colliderShapes", "nameList", "Per collider, \"sphere\" or \"capsule\"."),
      P.list("colliderA", "floatList", "Per collider, point a (x, y, z in the bone's space): the sphere's centre or the capsule's first end."),
      P.list("colliderB", "floatList", "Per collider, point b (x, y, z): the capsule's other end."),
      P.list("colliderRadius", "floatList", "Per collider, its radius.", { unit: "meters", min: 0 }),
    ], (p) => {
      head(p);
      for (const n of ["stiffness", "damping", "drag"]) p.f32(p.num(n));
      vec(p, "gravity");
      for (const n of ["maxAngle", "radius", "maxStep"]) p.f32(p.num(n));
      p.push(p.int("maxSubsteps") ?? 8);
      p.f32(p.num("teleport"));
      const bones = counted(p, "bones", 2, MAX_SPRING_BONES);
      const cb = counted(p, "colliderBones", 0, MAX_COLLIDERS);
      const shapes = shapeWords(p);
      const a = p.list("colliderA"), b = p.list("colliderB"), r = p.list("colliderRadius");
      p.push(bones.length, cb.length, ...bones);
      cb.forEach((bone, c) => p.push(bone, shapes[c] ?? 0, ...[0, 1, 2].map((k) => a[3 * c + k] ?? 0), ...[0, 1, 2].map((k) => b[3 * c + k] ?? 0), r[c] ?? 0));
    }),
    kind("rig", "copy", 8, "Copies a bone's transform onto another (copy constraint).", I.one(), [
      ...HEAD,
      P.bone("source", "The source bone."),
      P.bone("target", "The target bone."),
      P.enum("space", ["local", "model"], "Copy in local or model space."),
      P.float("positionWeight", 1, "Position weight.", { unit: "ratio", min: 0, max: 1 }),
      P.float("rotationWeight", 1, "Rotation weight.", { unit: "ratio", min: 0, max: 1 }),
      P.float("scaleWeight", 1, "Scale weight.", { unit: "ratio", min: 0, max: 1 }),
      P.vec3("positionOffset", [0, 0, 0], "Position offset in the source's frame."),
      P.quat("rotationOffset", [0, 0, 0, 1], "Rotation offset after the copied rotation."),
      P.vec3("scaleOffset", [1, 1, 1], "Scale multiplier."),
    ], (p) => {
      head(p);
      p.push(p.bone("source"), p.bone("target"), p.choice("space"));
      for (const n of ["positionWeight", "rotationWeight", "scaleWeight"]) p.f32(p.num(n));
      for (const n of ["positionOffset", "rotationOffset", "scaleOffset"]) vec(p, n);
    }),
    kind("rig", "limitRotation", 9, "Clamps bones' rotations to a swing-twist range.", I.one(), [
      ...HEAD,
      P.enum("source", ["skeleton", "explicit"], "Each bone's `JOINT_RANGES` entry, or the explicit range."),
      P.float("swingY", 45, "Explicit: swing half-axis about local Y.", { unit: "degrees", min: 0, max: 180 }),
      P.float("swingZ", 45, "Explicit: swing half-axis about local Z.", { unit: "degrees", min: 0, max: 180 }),
      P.float("twistMin", -45, "Explicit: twist minimum about local X.", { unit: "degrees", min: -180, max: 180 }),
      P.float("twistMax", 45, "Explicit: twist maximum.", { unit: "degrees", min: -180, max: 180 }),
      P.list("bones", "boneList", "The bones.", { minItems: 1, maxItems: MAX_LIST }),
    ], (p) => {
      head(p);
      p.push(p.choice("source"));
      for (const n of ["swingY", "swingZ", "twistMin", "twistMax"]) p.f32(p.num(n));
      const bones = counted(p, "bones", 1, MAX_LIST);
      p.push(bones.length, ...bones);
    }),
    kind("rig", "limitPosition", 10, "Clamps a bone's position to a box or sphere.", I.one(), [
      ...HEAD,
      P.bone("bone", "The bone."),
      P.enum("space", ["local", "model"], "Its local translation or its model position."),
      P.enum("shape", ["box", "sphere"], "Per-axis or radial clamp."),
      P.vec3("a", [0, 0, 0], "The box's minimum or the sphere's centre."),
      P.vec3("b", [0, 0, 0], "The box's maximum."),
      P.float("radius", 0, "The sphere's radius.", { unit: "meters", min: 0 }),
    ], (p) => {
      head(p);
      p.push(p.bone("bone"), p.choice("space"), p.choice("shape"));
      vec(p, "a");
      vec(p, "b");
      p.f32(p.num("radius"));
    }),
    kind("rig", "damp", 11, "Damps a bone's motion (half-lives).", I.one(), [
      ...HEAD,
      P.bone("bone", "The bone."),
      P.float("positionHalfLife", 0, "Position half-life (≤ 0: none).", { unit: "seconds" }),
      P.float("rotationHalfLife", 0, "Rotation half-life (≤ 0: none).", { unit: "seconds" }),
    ], (p) => {
      head(p);
      p.push(p.bone("bone"));
      p.f32(p.num("positionHalfLife"));
      p.f32(p.num("rotationHalfLife"));
    }),
    kind("rig", "strideWarp", 12, "Stride warping: scales the stride along the movement direction.", I.one(), [
      ...HEAD,
      P.bone("pelvis", "The pelvis."),
      P.animated("scale", 1, "Stride scale.", { unit: "multiplier", min: 0 }),
      P.parameter("speed", ["float"], "The character's ground speed: the scale is it over the timing clip's root speed."),
      P.vec3("direction", [0, 0, 0], "Movement direction (zero: +Z)."),
      P.parameter("directionParameter", ["vec3"], "A vec3 parameter giving the direction instead."),
      up(),
      P.float("pelvisWeight", 1, "Share of the needed pelvis drop.", { unit: "ratio", min: 0, max: 1 }),
      P.float("maxPelvisDrop", 0.2, "Largest pelvis drop.", { unit: "meters", min: 0 }),
      P.float("maxReach", 0.995, "Longest leg extension as a fraction of its length.", { unit: "ratio", min: 0, max: 1 }),
      legs("Per leg: root, mid and tip bones (1–4 legs)."),
    ], (p) => {
      head(p);
      p.push(p.bone("pelvis"));
      const [s, q] = p.animated("scale");
      p.f32(s);
      p.push(q, p.parameter("speed"));
      vec(p, "direction");
      p.push(p.parameter("directionParameter"));
      vec(p, "up");
      for (const n of ["pelvisWeight", "maxPelvisDrop", "maxReach"]) p.f32(p.num(n));
      const l = counted(p, "legs", 1, MAX_FEET, 3);
      p.push(l.length / 3, ...l);
    }),
    kind("rig", "orientationWarp", 13, "Orientation warping: turns the lower body toward the movement direction.", I.one(), [
      ...HEAD,
      P.bone("pelvis", "The pelvis."),
      P.animated("angle", 0, "Turn about up.", { unit: "radians" }),
      P.parameter("directionParameter", ["vec3"], "A vec3 parameter with the movement direction (model space): the angle is the heading to it."),
      P.float("maxAngle", PI / 2, "Largest turn.", { unit: "radians", min: 0 }),
      up(),
      P.list("bones", "boneList", "The spine bones, from the pelvis up.", { minItems: 1, maxItems: MAX_LIST }),
      P.list("shares", "floatList", "One share per spine bone (absent: even).", { unit: "ratio", min: 0, max: 1 }),
    ], (p) => {
      head(p);
      p.push(p.bone("pelvis"));
      const [a, q] = p.animated("angle");
      p.f32(a);
      p.push(q, p.parameter("directionParameter"));
      p.f32(p.num("maxAngle"));
      vec(p, "up");
      const bones = counted(p, "bones", 1, MAX_LIST);
      p.push(bones.length, ...bones);
      const shares = p.list("shares");
      if (shares.length > 0) {
        if (shares.length !== bones.length) p.problem(`needs one share per bone (${bones.length}), has ${shares.length}.`, "shares");
        for (let i = 0; i < bones.length; i++) p.push(shares[i] ?? 0);
      }
    }),
    kind("rig", "motionWarp", 14, "Motion warping: bends root motion so a window of the clip ends at a target.", I.one(), [
      ...HEAD,
      P.enum("window", ["markers", "times"], "The window from cue markers, or from explicit times."),
      P.name("startMarker", "Markers: the cue marker that opens the window.", { hashed: true }),
      P.name("endMarker", "Markers: the cue marker that closes it (the first after the start).", { hashed: true }),
      P.float("startTime", 0, "Times: the window's start.", { unit: "seconds", min: 0 }),
      P.float("endTime", 0, "Times: the window's end.", { unit: "seconds", min: 0 }),
      up("up", "Up for the yaw correction (zero: +Y)."),
    ], (p) => {
      head(p);
      const window = p.choice("window");
      p.push(window);
      if (window === 0) p.push(p.name("startMarker"), p.name("endMarker"));
      else {
        p.f32(p.num("startTime"));
        p.f32(p.num("endTime"));
      }
      vec(p, "up");
    }),
    kind("rig", "distanceMatch", 15, "Distance matching: plays its input at the rate that matches travelled distance.", I.one(), [
      ...HEAD,
      P.enum("mode", ["speed", "stop"], "Cover `speed × dt` per step, or land the clip's stop where the character stops."),
      P.parameter("parameter", ["float"], "The character's ground speed (speed mode) or the distance left to its stop (stop mode)."),
      P.float("minRate", 0.5, "Lowest rate.", { unit: "multiplier", min: 0 }),
      P.float("maxRate", 2, "Highest rate.", { unit: "multiplier", min: 0 }),
      P.name("marker", "Stop mode: the cue marker where the clip's stop is (none: its end).", { hashed: true }),
    ], (p) => {
      head(p);
      p.push(p.choice("mode"), p.parameter("parameter"));
      p.f32(p.num("minRate"));
      p.f32(p.num("maxRate"));
      p.push(p.name("marker"));
    }),
  ],
};

function shapeWords(p: NodePacker): number[] {
  return p.texts("colliderShapes").map((s, i) => {
    if (s === "sphere") return 0;
    if (s === "capsule") return 1;
    p.problem(`collider ${i}'s shape ${JSON.stringify(s)} isn't "sphere" or "capsule"; using "sphere".`, "colliderShapes");
    return 0;
  });
}
