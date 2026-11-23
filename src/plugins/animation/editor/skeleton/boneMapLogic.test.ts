// The bone map editor's model (ADR 0373; T54): edits of a model sidecar's `animation.boneMap` and `profile`, refused with a
// reason or accepted, and the save round trip through the sidecar JSON (`myco.import@1`), including a guessed map the model
// imported with. The guess is the engine's installed guesser, faked here (the core itself is T41g's).
import { describe, expect, it } from "vitest";
import { refusalOf } from "../../../../editor/sdk";
import { defaultModelAnimationSettings, type ModelAnimationSettings } from "../../../../engine/animation/import/clips";
import type { ImportedSkeleton } from "../../../../engine/animation/import/skeleton";
import { defaultImportSettings, formatImportSettings, parseImportSettings } from "../../../../engine/scene/importSettings";
import { humanoidProfile } from "./humanoidProfile";
import { HUMANOID_ROLES } from "../../runtime/core/boneMap";
import { applyGuess, boneMapRows, boneNameMatch, clearBoneMap, guessFor, keepBoneMap, mirrorBoneMap, missingRequired, setBone, setProfile, sideSwapped, staleEntries } from "./boneMapLogic";

const profile = humanoidProfile();
const BONES = ["Armature", "mixamorig:Hips", "mixamorig:Spine", "mixamorig:LeftArm", "mixamorig:LeftForeArm", "mixamorig:RightArm", "mixamorig:RightForeArm", "mixamorig:Head", "Tail"];
const empty = (): ModelAnimationSettings => defaultModelAnimationSettings();
const ok = <T,>(r: { next: T } | { refused: string }): T => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};

const rest = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } as const;
const skeleton: ImportedSkeleton = { bones: BONES.map((name, i) => ({ name, parent: i - 1, rest })), inverseBinds: new Float32Array(12 * BONES.length), roles: BONES.map(() => null), profile: null };

/** What the sidecar holds after `a` is saved and read back. */
function saved(a: ModelAnimationSettings): ModelAnimationSettings | null {
  const text = formatImportSettings({ ...defaultImportSettings(), animation: a });
  const read = parseImportSettings(JSON.parse(text), "model.glb.meta.json");
  expect(read.problems).toEqual([]);
  return read.settings.animation;
}

describe("the Humanoid profile as a value", () => {
  it("has the core's roles in the core's order, mirror pairs and required roles", () => {
    expect(profile.roles.map((r) => r.name)).toEqual([...HUMANOID_ROLES]);
    expect(profile.roles.find((r) => r.name === "LeftHand")).toMatchObject({ mirror: "RightHand", required: true });
    expect(profile.roles.find((r) => r.name === "Hips")).toMatchObject({ mirror: "Hips", required: true });
    expect(profile.roles.find((r) => r.name === "Jaw")?.required).toBe(false);
    expect(profile).toMatchObject({ root: "Root", hips: "Hips" });
  });
});

describe("setting a bone", () => {
  it("maps a role to a bone and saves it in the sidecar (profile and boneMap)", () => {
    let a = ok(setBone(empty(), profile, BONES, "Hips", "mixamorig:Hips"));
    a = ok(setBone(a, profile, BONES, "Head", "mixamorig:Head"));
    const s = ok(setProfile(a, "asset:rigs/biped.skelprofile.json", { ...profile, name: "Biped" }));
    expect(saved(s)).toMatchObject({ profile: "asset:rigs/biped.skelprofile.json", boneMap: { Hips: "mixamorig:Hips", Head: "mixamorig:Head" } });
  });

  it("unmaps a role with null, and an empty map is left out of the sidecar", () => {
    const a = ok(setBone(empty(), profile, BONES, "Hips", "mixamorig:Hips"));
    const cleared = ok(setBone(a, profile, BONES, "Hips", null));
    expect(cleared.boneMap).toEqual({});
    expect(saved(cleared)).toBeNull();
  });

  it("refuses a role the profile lacks, a bone the skeleton lacks and a bone another role has", () => {
    const a = ok(setBone(empty(), profile, BONES, "Hips", "mixamorig:Hips"));
    expect(refusalOf(setBone(a, profile, BONES, "Wing", "Tail"))).toMatch(/isn't a role/);
    expect(refusalOf(setBone(a, profile, BONES, "Head", "Nope"))).toMatch(/no bone "Nope"/);
    expect(refusalOf(setBone(a, profile, BONES, "Spine", "mixamorig:Hips"))).toMatch(/already the Hips/);
  });

  it("changes nothing (the same value) when the role already has that bone", () => {
    const a = ok(setBone(empty(), profile, BONES, "Hips", "mixamorig:Hips"));
    expect(ok(setBone(a, profile, BONES, "Hips", "mixamorig:Hips"))).toBe(a);
  });
});

describe("the table", () => {
  it("lists every role with its bone, status, mirror partner, required flag and name match", () => {
    const a = ok(setBone(ok(setBone(empty(), profile, BONES, "Hips", "mixamorig:Hips")), profile, BONES, "LeftUpperArm", "mixamorig:LeftArm"));
    const rows = boneMapRows(profile, { ...a.boneMap, Head: "Gone" }, BONES);
    expect(rows).toHaveLength(profile.roles.length);
    expect(rows.find((r) => r.role === "Hips")).toMatchObject({ bone: "mixamorig:Hips", status: "mapped", required: true, mirror: null });
    expect(rows.find((r) => r.role === "Hips")!.match).toBe(1);
    expect(rows.find((r) => r.role === "LeftUpperArm")).toMatchObject({ status: "mapped", mirror: "RightUpperArm" });
    expect(rows.find((r) => r.role === "Head")).toMatchObject({ status: "missing", bone: "Gone" });
    expect(rows.find((r) => r.role === "Jaw")).toMatchObject({ status: "unmapped", bone: null, match: null });
  });

  it("warns of the required roles with no bone, and of entries naming roles or bones that are gone", () => {
    const a = ok(setBone(empty(), profile, BONES, "Hips", "mixamorig:Hips"));
    const missing = missingRequired(profile, a.boneMap, BONES);
    expect(missing).not.toContain("Hips");
    expect(missing).toEqual(expect.arrayContaining(["Spine", "Head", "LeftHand", "RightFoot"]));
    expect(missingRequired(profile, { ...a.boneMap, Head: "Gone" }, BONES)).toContain("Head");
    expect(staleEntries(profile, { Hips: "mixamorig:Hips", Wing: "Tail", Head: "Gone" }, BONES).sort()).toEqual(["Head", "Wing"]);
  });

  it("scores how well a bone's name matches its role", () => {
    expect(boneNameMatch("LeftUpperArm", "mixamorig:LeftArm")).toBeGreaterThan(0.5);
    expect(boneNameMatch("LeftLowerArm", "mixamorig:LeftForeArm")).toBe(1);
    expect(boneNameMatch("LeftUpperLeg", "thigh_L")).toBe(1);
    expect(boneNameMatch("Head", "Tail")).toBe(0);
  });
});

describe("auto-guess", () => {
  const guesser = async (_skel: Uint8Array, bones: readonly string[]) => ({ Hips: bones[1], Spine: bones[2], LeftUpperArm: bones[3], Head: bones[7], Wing: bones[8], Chest: "Gone" });

  it("fills the roles with no bone from the core's guess, keeping the ones set by hand", async () => {
    const guessed = await guessFor(skeleton, null, guesser);
    const start = ok(setBone(empty(), profile, BONES, "Spine", "mixamorig:LeftForeArm"));
    const a = ok(applyGuess(start, profile, BONES, guessed));
    expect(a.boneMap).toEqual({ Spine: "mixamorig:LeftForeArm", Hips: "mixamorig:Hips", LeftUpperArm: "mixamorig:LeftArm", Head: "mixamorig:Head" });
    expect(saved(a)?.boneMap).toEqual(a.boneMap);
  });

  it("clear then guess is a full redo", async () => {
    const a = ok(setBone(empty(), profile, BONES, "Spine", "mixamorig:LeftForeArm"));
    const redo = ok(applyGuess(ok(clearBoneMap(a)), profile, BONES, await guessFor(skeleton, null, guesser)));
    expect(redo.boneMap.Spine).toBe("mixamorig:Spine");
  });

  it("is refused with a reason when there is no guess, nothing fits, or the map is already empty to clear", async () => {
    expect(await guessFor(skeleton, null, null as never)).toBeNull();
    expect(refusalOf(applyGuess(empty(), profile, BONES, null))).toMatch(/couldn't guess/);
    expect(refusalOf(applyGuess(empty(), profile, BONES, {}))).toMatch(/no bones/);
    expect(refusalOf(applyGuess(empty(), profile, BONES, { Wing: "Tail", Chest: "Gone" }))).toMatch(/nothing the core guessed/);
    expect(refusalOf(clearBoneMap(empty()))).toMatch(/already empty/);
  });

  it("saves a guessed map the model imported with by keeping it in the draft", () => {
    const guessedAtImport = { Hips: "mixamorig:Hips", Head: "mixamorig:Head" };
    expect(empty().boneMap).toEqual({}); // the sidecar has none: the guess lives in memory (`boneMapSource: "guessed"`)
    const kept = ok(keepBoneMap(empty(), guessedAtImport));
    expect(saved(kept)?.boneMap).toEqual(guessedAtImport);
    expect(refusalOf(keepBoneMap(empty(), {}))).toMatch(/no bone map/);
  });
});

describe("mirror", () => {
  const start = () => ok(setBone(ok(setBone(empty(), profile, BONES, "LeftUpperArm", "mixamorig:LeftArm")), profile, BONES, "LeftLowerArm", "mixamorig:LeftForeArm"));

  it("copies the left bones to the right roles by swapping the side in the bone's name", () => {
    const a = ok(mirrorBoneMap(start(), profile, BONES, "left-to-right"));
    expect(a.boneMap).toMatchObject({ RightUpperArm: "mixamorig:RightArm", RightLowerArm: "mixamorig:RightForeArm" });
  });

  it("copies right to left", () => {
    const right = ok(setBone(empty(), profile, BONES, "RightUpperArm", "mixamorig:RightArm"));
    expect(ok(mirrorBoneMap(right, profile, BONES, "right-to-left")).boneMap.LeftUpperArm).toBe("mixamorig:LeftArm");
  });

  it("keeps a partner role that already has a bone, and refuses when nothing copies, saying why", () => {
    const both = ok(setBone(start(), profile, BONES, "RightUpperArm", "Tail"));
    const mirrored = ok(mirrorBoneMap(both, profile, BONES, "left-to-right")).boneMap;
    expect(mirrored).toMatchObject({ RightUpperArm: "Tail", RightLowerArm: "mixamorig:RightForeArm" });
    expect(refusalOf(mirrorBoneMap(empty(), profile, BONES, "left-to-right"))).toMatch(/no left role has a bone/);
    const head = ok(setBone(empty(), profile, BONES, "LeftHand", "Tail"));
    expect(refusalOf(mirrorBoneMap(head, profile, BONES, "left-to-right"))).toMatch(/no right role without a bone has a matching bone/);
    expect(refusalOf(mirrorBoneMap(start(), { ...profile, roles: [{ name: "A", mirror: "A", flip: "auto", range: null, required: false }] }, BONES, "left-to-right"))).toMatch(/no left roles/);
  });

  it("swaps the side of common bone names", () => {
    expect(sideSwapped("mixamorig:LeftArm", "Right")).toBe("mixamorig:RightArm");
    expect(sideSwapped("arm_L", "Right")).toBe("arm_R");
    expect(sideSwapped("L_arm", "Right")).toBe("R_arm");
    expect(sideSwapped("upperarm.l", "Right")).toBe("upperarm.r");
    expect(sideSwapped("LeftArm", "Left")).toBe("LeftArm");
    expect(sideSwapped("Hips", "Right")).toBeNull();
  });
});

describe("the profile", () => {
  it("changing it drops the entries for roles the new profile lacks", () => {
    const a = ok(setBone(ok(setBone(empty(), profile, BONES, "Hips", "mixamorig:Hips")), profile, BONES, "Head", "mixamorig:Head"));
    const quad = { ...profile, name: "Quad", roles: [{ name: "Hips", mirror: "Hips", flip: "auto" as const, range: null, required: true }] };
    const b = ok(setProfile(a, "asset:rigs/quad.skelprofile.json", quad));
    expect(b).toMatchObject({ profile: "asset:rigs/quad.skelprofile.json", boneMap: { Hips: "mixamorig:Hips" } });
    expect(ok(setProfile(b, null, profile)).profile).toBeNull();
    expect(refusalOf(setProfile(a, "x.skelprofile.json", { ...profile, roles: [] }))).toMatch(/no roles/);
  });
});
