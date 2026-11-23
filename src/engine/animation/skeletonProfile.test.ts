// Skeleton profiles (`myco.skelprofile@1`, ADR 0371, 0372) through their parse, write and the core encoding: the parse
// makes `anim-retarget`'s `Profile::validate` rules hold, and `encodeSkeletonProfile` writes `encode.rs`'s `MYCOPROF`
// layout byte for byte (the expected bytes below are written out from that layout's table, for the same two-role
// profile as `anim-retarget/tests/profile.rs`'s `tiny()`).
import { describe, expect, it } from "vitest";
import { emptySkeletonProfile, encodeSkeletonProfile, formatSkeletonProfile, parseSkeletonProfile, SKELETON_PROFILE_LIMITS, skeletonProfileToJson, type SkeletonProfile } from "./skeletonProfile";

/** `tiny()` of the Rust tests: two roles, one chain, hips = A. */
const TINY_JSON = {
  format: "myco.skelprofile@1",
  name: "T",
  roles: [
    { name: "A", range: { swingY: 10, swingZ: 20, twistMin: -5, twistMax: 5 }, required: true },
    { name: "B", flip: "x" },
  ],
  chains: [{ name: "C", kind: "custom", roles: ["A", "B"] }],
  hips: "A",
};

const f32le = (v: number) => [...new Uint8Array(new Float32Array([v]).buffer)];
const TINY_BYTES = [
  ...[0x4d, 0x59, 0x43, 0x4f, 0x50, 0x52, 0x4f, 0x46], // "MYCOPROF"
  1, 0, 0, 0, // version 1
  2, 0, // 2 roles
  1, 0, // 1 chain
  0xff, 0xff, // root: none
  0, 0, // hips: role 0
  1, 0x54, // name "T"
  1, 0x41, 0, 0, 0xff, 3, ...f32le(10), ...f32le(20), ...f32le(-5), ...f32le(5), // A: mirror 0, flip auto, range + required
  1, 0x42, 1, 0, 1, 0, // B: mirror 1, flip X, no flags
  1, 0x43, 6, 0, 2, 0, 0, 0, 1, 0, // C: custom, no IK, roles [0, 1]
];

function quadruped(): SkeletonProfile {
  return {
    format: "myco.skelprofile@1",
    name: "Quadruped",
    roles: [
      { name: "Root", mirror: "Root", flip: "auto", range: null, required: false },
      { name: "Hips", mirror: "Hips", flip: "none", range: null, required: true },
      { name: "LeftFrontLeg", mirror: "RightFrontLeg", flip: "x", range: { swingY: 60, swingZ: 30, twistMin: -20, twistMax: 20 }, required: true },
      { name: "RightFrontLeg", mirror: "LeftFrontLeg", flip: "x", range: { swingY: 60, swingZ: 30, twistMin: -20, twistMax: 20 }, required: true },
      { name: "LeftFrontKnee", mirror: "RightFrontKnee", flip: "y", range: null, required: false },
      { name: "RightFrontKnee", mirror: "LeftFrontKnee", flip: "z", range: null, required: false },
      { name: "LeftFrontPaw", mirror: "LeftFrontPaw", flip: "auto", range: null, required: false },
    ],
    chains: [
      { name: "LeftFront", kind: "leg", roles: ["LeftFrontLeg", "LeftFrontKnee", "LeftFrontPaw"], ik: true },
      { name: "Spine", kind: "spine", roles: ["Hips"], ik: false },
    ],
    root: "Root",
    hips: "Hips",
  };
}

describe("skeleton profiles (myco.skelprofile@1)", () => {
  it("round-trip roles, mirrors, flips, joint ranges, chains, root and hips", () => {
    expect(parseSkeletonProfile(JSON.parse(formatSkeletonProfile(quadruped())))).toEqual({ value: quadruped(), problems: [] });
    expect(parseSkeletonProfile(JSON.parse(formatSkeletonProfile(emptySkeletonProfile())))).toEqual({ value: emptySkeletonProfile(), problems: [] });
  });

  it("write only what differs from the defaults", () => {
    const json = skeletonProfileToJson(quadruped());
    expect((json.roles as unknown[])[0]).toEqual({ name: "Root" });
    expect((json.roles as unknown[])[6]).toEqual({ name: "LeftFrontPaw" });
    expect((json.chains as unknown[])[1]).toEqual({ name: "Spine", kind: "spine", roles: ["Hips"] });
    expect(skeletonProfileToJson(parseSkeletonProfile(TINY_JSON).value)).toEqual(TINY_JSON);
  });

  const one = (extra: Record<string, unknown>) => parseSkeletonProfile({ format: "myco.skelprofile@1", roles: [{ name: "A" }, { name: "B" }, { name: "C" }], ...extra });

  it.each<[string, Record<string, unknown>, string]>([
    ["a role without a name", { roles: [{ name: "A" }, {}] }, "roles[1].name: a role must have a name; dropped."],
    ["a repeated role", { roles: [{ name: "A" }, { name: "A" }] }, 'roles[1].name: role "A" is already defined; dropped.'],
    ["a name over 255 bytes", { roles: [{ name: "A" }, { name: "é".repeat(128) }] }, "roles[1].name: longer than 255 bytes; the role is dropped."],
    ["a mirror naming no role", { roles: [{ name: "A", mirror: "Z" }] }, 'roles[0].mirror: "Z" isn\'t a role; "A" is a centre role.'],
    ["a one-way mirror", { roles: [{ name: "A", mirror: "B" }, { name: "B" }] }, 'roles: "A" mirrors "B", which mirrors "B"; "A" is a centre role.'],
    ["an unknown flip", { roles: [{ name: "A", flip: "w" }] }, 'roles[0].flip: must be one of none, x, y, z, auto; using "auto".'],
    ["a swing over 180", { roles: [{ name: "A", range: { swingY: 200, swingZ: 0, twistMin: 0, twistMax: 0 } }] }, "roles[0].range.swingY: 200 is outside 0..180; using 180."],
    ["twists backwards", { roles: [{ name: "A", range: { swingY: 0, swingZ: 0, twistMin: 10, twistMax: -10 } }] }, "roles[0].range: twistMin was above twistMax; swapped."],
    ["a chain naming no role", { chains: [{ name: "X", kind: "arm", roles: ["A", "Q"] }] }, 'chains[0].roles[1]: "Q" isn\'t a role; dropped.'],
    ["a chain repeating a role", { chains: [{ name: "X", kind: "arm", roles: ["A", "A"] }] }, 'chains[0].roles[1]: "A" is already in the chain; dropped.'],
    ["an empty chain", { chains: [{ name: "X", kind: "arm", roles: [] }] }, "chains[0]: a chain needs at least one role; dropped."],
    ["a short IK chain", { chains: [{ name: "X", kind: "arm", roles: ["A", "B"], ik: true }] }, "chains[0].ik: an IK chain needs three roles; IK is off."],
    ["an unknown chain kind", { chains: [{ name: "X", kind: "tail", roles: ["A"] }] }, 'chains[0].kind: must be one of spine, arm, leg, finger, head, twist, custom; using "custom".'],
    ["root naming no role", { root: "Q" }, 'root: "Q" isn\'t a role; none.'],
    ["root and hips the same", { root: "A", hips: "A" }, "hips: root and hips can't be the same role; hips is none."],
    ["no roles", { roles: [] }, "roles: a profile needs at least one role."],
  ])("make a rule hold, with one problem: %s", (_label, extra, problem) => {
    expect(one(extra).problems).toEqual([problem]);
  });

  it("hold the role and chain limits", () => {
    const roles = Array.from({ length: SKELETON_PROFILE_LIMITS.roles + 1 }, (_, i) => ({ name: `r${i}` }));
    const read = parseSkeletonProfile({ format: "myco.skelprofile@1", roles });
    expect(read.value.roles).toHaveLength(SKELETON_PROFILE_LIMITS.roles);
    expect(read.problems).toEqual([`roles: at most ${SKELETON_PROFILE_LIMITS.roles} roles; the rest are dropped.`]);
    const chains = Array.from({ length: SKELETON_PROFILE_LIMITS.chains + 1 }, (_, i) => ({ name: `c${i}`, kind: "custom", roles: ["A"] }));
    expect(one({ chains }).problems).toEqual([`chains: at most ${SKELETON_PROFILE_LIMITS.chains} chains; the rest are dropped.`]);
  });
});

describe("the core profile encoding (MYCOPROF)", () => {
  it("writes encode.rs's layout byte for byte", () => {
    const read = parseSkeletonProfile(TINY_JSON);
    expect(read.problems).toEqual([]);
    const enc = encodeSkeletonProfile(read.value);
    expect("bytes" in enc && [...enc.bytes]).toEqual(TINY_BYTES);
  });

  it("writes every role flag, flip and chain kind", () => {
    const enc = encodeSkeletonProfile(quadruped());
    if (!("bytes" in enc)) throw new Error(enc.problem);
    const b = enc.bytes;
    const v = new DataView(b.buffer);
    expect(String.fromCharCode(...b.subarray(0, 8))).toBe("MYCOPROF");
    expect([v.getUint32(8, true), v.getUint16(12, true), v.getUint16(14, true), v.getUint16(16, true), v.getUint16(18, true)]).toEqual([1, 7, 2, 0, 1]);
    // name "Quadruped" (9 bytes), then role 0 "Root": mirror 0, flip auto, no flags.
    expect([...b.subarray(20, 30)]).toEqual([9, ...new TextEncoder().encode("Quadruped")]);
    expect([...b.subarray(30, 39)]).toEqual([4, ..."Root".split("").map((c) => c.charCodeAt(0)), 0, 0, 0xff, 0]);
    // The last chain: "Spine", kind spine (0), no IK, one role (1).
    expect([...b.subarray(b.length - 12)]).toEqual([5, ..."Spine".split("").map((c) => c.charCodeAt(0)), 0, 0, 1, 0, 1, 0]);
  });

  it.each<[string, (p: SkeletonProfile) => SkeletonProfile, string]>([
    ["no roles", (p) => ({ ...p, roles: [] }), "a profile has 1..1024 roles (it has 0)"],
    ["a one-way mirror", (p) => ({ ...p, roles: p.roles.map((r, i) => (i === 2 ? { ...r, mirror: "Root" } : r)) }), 'the mirror map isn\'t an involution at "LeftFrontLeg"'],
    ["a bad range", (p) => ({ ...p, roles: p.roles.map((r, i) => (i === 0 ? { ...r, range: { swingY: -1, swingZ: 0, twistMin: 0, twistMax: 0 } } : r)) }), 'role "Root" has an invalid joint range'],
    ["a short IK chain", (p) => ({ ...p, chains: [{ name: "X", kind: "arm", roles: ["Hips"], ik: true }] }), 'IK chain "X" needs three roles'],
    ["root equal to hips", (p) => ({ ...p, hips: "Root" }), "root and hips are the same role"],
  ])("refuses a profile the core would refuse: %s", (_label, change, problem) => {
    expect(encodeSkeletonProfile(change(quadruped()))).toEqual({ problem });
  });
});
