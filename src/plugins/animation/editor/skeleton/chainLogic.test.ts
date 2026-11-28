// The chain editor's model (ADR 0373; T54): edits of a `*.skelprofile.json` value, each validated through the profile parse
// rules (`parseSkeletonProfile`), so what an edit accepts is a profile the core's `Profile::validate` accepts and what it
// refuses names the rule. The document round trip (format, parse) is checked on every accepted result.
import { describe, expect, it } from "vitest";
import { refusalOf } from "../../../../editor/sdk";
import { emptySkeletonProfile, encodeSkeletonProfile, formatSkeletonProfile, parseSkeletonProfile, type SkeletonProfile } from "../../../../engine/animation/skeletonProfile";
import { addChain, addRole, moveChainRole, removeChain, removeRole, renameChain, renameProfile, renameRole, setChainIk, setChainKind, setChainRoles, setFlip, setMirror, setRange, setRequired, setRootRole } from "./chainLogic";

const ok = (r: { next: SkeletonProfile } | { refused: string }): SkeletonProfile => {
  if ("refused" in r) throw new Error(r.refused);
  // Every accepted profile survives the document round trip with no problem.
  const read = parseSkeletonProfile(JSON.parse(formatSkeletonProfile(r.next)));
  expect(read.problems).toEqual([]);
  expect(read.value).toEqual(r.next);
  return r.next;
};

/** A quadruped: Root, Hips, four legs of three roles, mirrored front and back. */
function quadruped(): SkeletonProfile {
  let p = renameProfile(emptySkeletonProfile(), "Quadruped") as { next: SkeletonProfile };
  let cur = p.next;
  for (const n of ["Hips", "FrontLeft", "FrontRight", "BackLeft", "BackRight", "Tail"]) cur = ok(addRole(cur, n));
  cur = ok(setMirror(cur, "FrontLeft", "FrontRight"));
  cur = ok(setMirror(cur, "BackLeft", "BackRight"));
  return cur;
}

describe("roles", () => {
  it("adds a role as a centre role and refuses an empty or repeated name", () => {
    const p = ok(addRole(emptySkeletonProfile(), "Hips"));
    expect(p.roles.map((r) => r.name)).toEqual(["Root", "Hips"]);
    expect(p.roles[1]).toMatchObject({ mirror: "Hips", flip: "auto", range: null, required: false });
    expect(refusalOf(addRole(p, "  "))).toMatch(/needs a name/);
    expect(refusalOf(addRole(p, "Hips"))).toMatch(/already exists/);
  });

  it("pairs two roles as mirrors, freeing their old partners", () => {
    let p = quadruped();
    expect(p.roles.find((r) => r.name === "FrontLeft")!.mirror).toBe("FrontRight");
    p = ok(setMirror(p, "FrontLeft", "BackRight"));
    expect(p.roles.find((r) => r.name === "FrontLeft")!.mirror).toBe("BackRight");
    expect(p.roles.find((r) => r.name === "BackRight")!.mirror).toBe("FrontLeft");
    expect(p.roles.find((r) => r.name === "FrontRight")!.mirror).toBe("FrontRight");
    expect(p.roles.find((r) => r.name === "BackLeft")!.mirror).toBe("BackLeft");
    p = ok(setMirror(p, "FrontLeft", null));
    expect(p.roles.find((r) => r.name === "BackRight")!.mirror).toBe("BackRight");
    expect(refusalOf(setMirror(p, "FrontLeft", "FrontLeft"))).toMatch(/own partner/);
    expect(refusalOf(setMirror(p, "FrontLeft", "Wing"))).toMatch(/no role "Wing"/);
  });

  it("removes a role from the chains, mirrors, root and hips; a chain left empty goes", () => {
    let p = quadruped();
    p = ok(addChain(p, "Front", "leg", ["FrontLeft"]));
    p = ok(setRootRole(p, "hips", "FrontRight"));
    const q = ok(removeRole(p, "FrontLeft"));
    expect(q.chains).toEqual([]);
    expect(q.roles.find((r) => r.name === "FrontRight")!.mirror).toBe("FrontRight");
    expect(ok(removeRole(p, "FrontRight")).hips).toBeNull();
    expect(refusalOf(removeRole(emptySkeletonProfile(), "Root"))).toMatch(/at least one role/);
  });

  it("renames a role everywhere it is named", () => {
    let p = quadruped();
    p = ok(addChain(p, "Legs", "leg", ["FrontLeft", "FrontRight"]));
    p = ok(setRootRole(p, "hips", "FrontLeft"));
    const q = ok(renameRole(p, "FrontLeft", "ForeL"));
    expect(q.roles.find((r) => r.name === "FrontRight")!.mirror).toBe("ForeL");
    expect(q.chains[0].roles).toEqual(["ForeL", "FrontRight"]);
    expect(q.hips).toBe("ForeL");
    expect(refusalOf(renameRole(p, "FrontLeft", "Hips"))).toMatch(/already exists/);
    expect(ok(renameRole(p, "Tail", "Tail"))).toBe(p);
  });

  it("sets flip, required and a joint range, refusing a range outside the limits", () => {
    let p = quadruped();
    p = ok(setFlip(p, "FrontLeft", "x"));
    p = ok(setRequired(p, "Hips", true));
    p = ok(setRange(p, "FrontLeft", { swingY: 60, swingZ: 30, twistMin: -20, twistMax: 20 }));
    expect(p.roles.find((r) => r.name === "FrontLeft")).toMatchObject({ flip: "x", range: { swingY: 60, swingZ: 30, twistMin: -20, twistMax: 20 } });
    expect(p.roles.find((r) => r.name === "Hips")!.required).toBe(true);
    expect(ok(setRange(p, "FrontLeft", null)).roles.find((r) => r.name === "FrontLeft")!.range).toBeNull();
    expect(refusalOf(setRange(p, "FrontLeft", { swingY: 200, swingZ: 0, twistMin: 0, twistMax: 0 }))).toMatch(/0 to 180/);
    expect(refusalOf(setRange(p, "FrontLeft", { swingY: 10, swingZ: 0, twistMin: 20, twistMax: -20 }))).toMatch(/minimum first/);
    expect(refusalOf(setRange(p, "FrontLeft", { swingY: Number.NaN, swingZ: 0, twistMin: 0, twistMax: 0 }))).toMatch(/needs numbers/);
    expect(refusalOf(setFlip(p, "FrontLeft", "w" as never))).toMatch(/flip must be/);
  });

  it("root and hips can't be the same role", () => {
    const p = ok(setRootRole(quadruped(), "root", "Root"));
    expect(p.root).toBe("Root");
    expect(refusalOf(setRootRole(p, "hips", "Root"))).toMatch(/can't be the same/);
    expect(ok(setRootRole(p, "root", null)).root).toBeNull();
  });
});

describe("chains", () => {
  it("adds a chain, with roles in order, and names the rule it breaks", () => {
    let p = quadruped();
    p = ok(addChain(p, "Spine", "spine", ["Hips", "Tail"]));
    expect(p.chains).toEqual([{ name: "Spine", kind: "spine", roles: ["Hips", "Tail"], ik: false }]);
    expect(refusalOf(addChain(p, "Spine", "spine", ["Hips"]))).toMatch(/already exists/);
    expect(refusalOf(addChain(p, "Empty", "custom", []))).toMatch(/at least one role/);
    expect(refusalOf(addChain(p, "Bad", "custom", ["Wing"]))).toMatch(/isn't a role/);
    expect(refusalOf(addChain(p, "Twice", "custom", ["Hips", "Hips"]))).toMatch(/already in the chain/);
    expect(refusalOf(addChain(p, "Kind", "wing" as never, ["Hips"]))).toMatch(/kind must be/);
  });

  it("an IK chain needs three roles (the parse rule)", () => {
    let p = ok(addChain(quadruped(), "Leg", "leg", ["FrontLeft", "BackLeft"]));
    expect(refusalOf(setChainIk(p, "Leg", true))).toMatch(/IK chain needs three roles/);
    p = ok(setChainRoles(p, "Leg", ["FrontLeft", "BackLeft", "Tail"]));
    p = ok(setChainIk(p, "Leg", true));
    expect(p.chains[0].ik).toBe(true);
    expect(refusalOf(setChainRoles(p, "Leg", ["FrontLeft", "BackLeft"]))).toMatch(/IK chain needs three roles/);
  });

  it("renames, retypes, reorders and removes chains", () => {
    let p = ok(addChain(quadruped(), "Legs", "leg", ["FrontLeft", "FrontRight", "BackLeft"]));
    p = ok(addChain(p, "Tail", "custom", ["Tail"]));
    p = ok(renameChain(p, "Legs", "Front"));
    p = ok(setChainKind(p, "Front", "arm"));
    p = ok(moveChainRole(p, "Front", 0, 1));
    expect(p.chains[0]).toMatchObject({ name: "Front", kind: "arm", roles: ["FrontRight", "FrontLeft", "BackLeft"] });
    expect(refusalOf(moveChainRole(p, "Front", 0, -1))).toMatch(/already first/);
    expect(refusalOf(moveChainRole(p, "Front", 2, 1))).toMatch(/already last/);
    expect(refusalOf(renameChain(p, "Front", "Tail"))).toMatch(/already exists/);
    expect(refusalOf(setChainKind(p, "Nope", "arm"))).toMatch(/no chain "Nope"/);
    p = ok(removeChain(p, "Tail"));
    expect(p.chains.map((c) => c.name)).toEqual(["Front"]);
  });
});

describe("the profile as the core takes it", () => {
  it("a profile built by the edits encodes for the core (MYCOPROF)", () => {
    const p = ok(addChain(quadruped(), "Legs", "leg", ["FrontLeft", "FrontRight"]));
    const e = encodeSkeletonProfile(p);
    expect("bytes" in e && e.bytes.length > 0).toBe(true);
  });
});
