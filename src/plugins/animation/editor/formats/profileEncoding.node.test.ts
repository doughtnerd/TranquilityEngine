// A `*.skelprofile.json` reaches the core (ADR 0372 "Retargeting"): the engine's `encodeSkeletonProfile` bytes go through
// the committed wasm's `profile_decode` (`anim-retarget`'s `encode::decode`, which validates every rule), and the decoded
// profile's role count comes back from `guess_bone_map` on a committed skeleton fixture. A corrupted encoding is
// refused with `STATUS_BAD_ASSET`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as core from "../../runtime/wasm/wire/core";
import { guess_bone_map, init, initSync, last_status, profile_decode } from "../../runtime/wasm/myco_anim.js";
import { encodeSkeletonProfile, parseSkeletonProfile } from "../../../../engine/animation/skeletonProfile";

const PROFILE = {
  format: "myco.skelprofile@1",
  name: "Mini",
  roles: [
    { name: "Hips", required: true },
    { name: "Spine", range: { swingY: 30, swingZ: 30, twistMin: -15, twistMax: 15 } },
    { name: "LeftLeg", mirror: "RightLeg", flip: "x" },
    { name: "RightLeg", mirror: "LeftLeg", flip: "x" },
    { name: "LeftKnee", mirror: "RightKnee" },
    { name: "RightKnee", mirror: "LeftKnee" },
    { name: "LeftFoot", mirror: "RightFoot" },
    { name: "RightFoot", mirror: "LeftFoot" },
  ],
  chains: [
    { name: "Spine", kind: "spine", roles: ["Hips", "Spine"] },
    { name: "LeftLeg", kind: "leg", roles: ["LeftLeg", "LeftKnee", "LeftFoot"], ik: true },
    { name: "RightLeg", kind: "leg", roles: ["RightLeg", "RightKnee", "RightFoot"], ik: true },
  ],
  hips: "Hips",
};

describe("a custom skeleton profile in the core", () => {
  initSync({ module: readFileSync(new URL("../../runtime/wasm/myco_anim_bg.wasm", import.meta.url)) });
  const record = new Uint8Array(core.INIT.stride);
  const view = new DataView(record.buffer);
  view.setUint16(core.WIRE_HEADER.opcode, core.INIT.opcode, true);
  view.setUint16(core.WIRE_HEADER.version, core.INIT.version, true);
  view.setUint32(core.INIT.fields.maxInstances.offset, 1, true);
  view.setUint32(core.INIT.fields.maxBones.offset, 64, true);
  view.setUint32(core.INIT.fields.arenaInitialBytes.offset, 1 << 20, true);
  init(record);

  const parsed = parseSkeletonProfile(PROFILE);
  const enc = encodeSkeletonProfile(parsed.value);
  if (!("bytes" in enc)) throw new Error(enc.problem);

  it("decodes, with every role", () => {
    expect(parsed.problems).toEqual([]);
    const handle = profile_decode(enc.bytes);
    expect(handle, `status ${last_status()}`).not.toBe(0);
    const skeleton = new Uint8Array(readFileSync(new URL("../../runtime/wasm/fixtures/small.skel", import.meta.url)));
    const roles = guess_bone_map(skeleton, handle, new Uint16Array(64), new Float32Array(64));
    expect(roles, `status ${last_status()}`).toBe(PROFILE.roles.length);
  });

  it("refuses a corrupted encoding", () => {
    const bytes = enc.bytes.slice();
    bytes[12] = 0; // role count 0
    expect(profile_decode(bytes)).toBe(0);
    expect(last_status()).toBe(core.STATUS_BAD_ASSET);
  });
});
