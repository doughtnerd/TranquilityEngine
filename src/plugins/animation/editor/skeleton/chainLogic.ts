// The chain editor's model (ADR 0373 "A chain editor for custom profiles"; T54): the edits of a `*.skelprofile.json`
// document (`myco.skelprofile@1`): roles (name, mirror, flip, joint range, required), chains (name, kind, roles in
// order, IK) and the root and hips roles. Each edit is a pure refused-or-next result (ADR 0307, 0313); the view applies
// it with `applyToDocument`, so it is one labelled undo step of the profile.
//
// **Validation is the profile parse's** (`parseSkeletonProfile`, which makes every `Profile::validate` rule hold): an
// edit builds the profile it asks for, writes it as JSON and parses it back; any problem the parse reports refuses the
// edit with that line, and an accepted edit is the parsed value. The edits fix up what they touch first (removing a role
// takes it out of the chains, the mirror pairs, root and hips), so only a real violation (a duplicate name, an IK chain of
// two roles) is refused.
import { accept, refuse, type EditResult } from "../../../../editor/sdk";
import { CHAIN_KINDS, FLIPS, parseSkeletonProfile, skeletonProfileToJson, type ChainKind, type Flip, type JointRange, type ProfileChain, type ProfileRole, type SkeletonProfile } from "../../../../engine/animation/skeletonProfile";

/** `next` through the parse rules: refused with the first problem, else the parsed value (`same` itself when nothing changed). */
export function validated(next: SkeletonProfile, same: SkeletonProfile): EditResult<SkeletonProfile> {
  const read = parseSkeletonProfile(JSON.parse(JSON.stringify(skeletonProfileToJson(next))));
  if (read.problems.length > 0) return refuse(read.problems[0]);
  return accept(JSON.stringify(skeletonProfileToJson(read.value)) === JSON.stringify(skeletonProfileToJson(same)) ? same : read.value);
}

const roleNamed = (p: SkeletonProfile, name: string): ProfileRole | undefined => p.roles.find((r) => r.name === name);
const mapRole = (p: SkeletonProfile, name: string, f: (r: ProfileRole) => ProfileRole): SkeletonProfile => ({ ...p, roles: p.roles.map((r) => (r.name === name ? f(r) : r)) });
const missingRole = (name: string) => refuse(`there is no role "${name}".`);

// --- the profile ---------------------------------------------------------------------------------------------------------

export function renameProfile(p: SkeletonProfile, name: string): EditResult<SkeletonProfile> {
  return validated({ ...p, name: name.trim() }, p);
}

/** Root and hips roles (null: none). Refused for an unknown role or the same role for both. */
export function setRootRole(p: SkeletonProfile, which: "root" | "hips", role: string | null): EditResult<SkeletonProfile> {
  if (role !== null && !roleNamed(p, role)) return missingRole(role);
  if (role !== null && role === (which === "root" ? p.hips : p.root)) return refuse("root and hips can't be the same role.");
  return validated({ ...p, [which]: role }, p);
}

// --- roles ---------------------------------------------------------------------------------------------------------------

/** A new centre role (free joint) at the end. Refused for an empty or repeated name. */
export function addRole(p: SkeletonProfile, name: string): EditResult<SkeletonProfile> {
  const n = name.trim();
  if (n === "") return refuse("a role needs a name.");
  if (roleNamed(p, n)) return refuse(`role "${n}" already exists.`);
  return validated({ ...p, roles: [...p.roles, { name: n, mirror: n, flip: "auto", range: null, required: false }] }, p);
}

/** Remove a role: out of every chain (a chain left empty goes too), its mirror partner becomes a centre role, root and hips forget it. */
export function removeRole(p: SkeletonProfile, name: string): EditResult<SkeletonProfile> {
  const role = roleNamed(p, name);
  if (!role) return missingRole(name);
  if (p.roles.length === 1) return refuse("a profile needs at least one role.");
  const chains = p.chains.map((c) => ({ ...c, roles: c.roles.filter((r) => r !== name) })).filter((c) => c.roles.length > 0).map((c) => (c.ik && c.roles.length < 3 ? { ...c, ik: false } : c));
  return validated({
    ...p,
    roles: p.roles.filter((r) => r.name !== name).map((r) => (r.mirror === name ? { ...r, mirror: r.name } : r)),
    chains,
    root: p.root === name ? null : p.root,
    hips: p.hips === name ? null : p.hips,
  }, p);
}

/** Rename a role everywhere it is named. */
export function renameRole(p: SkeletonProfile, from: string, to: string): EditResult<SkeletonProfile> {
  const n = to.trim();
  if (!roleNamed(p, from)) return missingRole(from);
  if (n === "") return refuse("a role needs a name.");
  if (n === from) return accept(p);
  if (roleNamed(p, n)) return refuse(`role "${n}" already exists.`);
  const re = (r: string) => (r === from ? n : r);
  return validated({
    ...p,
    roles: p.roles.map((r) => ({ ...r, name: re(r.name), mirror: re(r.mirror) })),
    chains: p.chains.map((c) => ({ ...c, roles: c.roles.map(re) })),
    root: p.root === null ? null : re(p.root),
    hips: p.hips === null ? null : re(p.hips),
  }, p);
}

/** Pair `role` with `partner` as left and right (or null: make it a centre role). Either one's old partner becomes a centre role. */
export function setMirror(p: SkeletonProfile, role: string, partner: string | null): EditResult<SkeletonProfile> {
  if (!roleNamed(p, role)) return missingRole(role);
  if (partner !== null && !roleNamed(p, partner)) return missingRole(partner);
  const target = partner ?? role;
  if (target === role && partner !== null) return refuse("a role can't be its own partner; choose none.");
  const old = new Set([roleNamed(p, role)!.mirror, partner === null ? "" : roleNamed(p, partner)!.mirror]);
  const roles = p.roles.map((r) => {
    if (r.name === role) return { ...r, mirror: target };
    if (partner !== null && r.name === partner) return { ...r, mirror: role };
    // The roles that pointed at either one before: centre roles now.
    if (old.has(r.name) && r.name !== role && r.name !== partner) return { ...r, mirror: r.name };
    return r;
  });
  return validated({ ...p, roles }, p);
}

export function setFlip(p: SkeletonProfile, role: string, flip: Flip): EditResult<SkeletonProfile> {
  if (!roleNamed(p, role)) return missingRole(role);
  if (!FLIPS.includes(flip)) return refuse(`flip must be one of ${FLIPS.join(", ")}.`);
  return validated(mapRole(p, role, (r) => ({ ...r, flip })), p);
}

export function setRequired(p: SkeletonProfile, role: string, required: boolean): EditResult<SkeletonProfile> {
  if (!roleNamed(p, role)) return missingRole(role);
  return validated(mapRole(p, role, (r) => ({ ...r, required })), p);
}

/** A role's joint range, degrees (null: free). Refused outside the profile's limits (swings 0..180, twists -180..180, min ≤ max). */
export function setRange(p: SkeletonProfile, role: string, range: JointRange | null): EditResult<SkeletonProfile> {
  if (!roleNamed(p, role)) return missingRole(role);
  if (range !== null) {
    const { swingY, swingZ, twistMin, twistMax } = range;
    if (![swingY, swingZ, twistMin, twistMax].every(Number.isFinite)) return refuse("a joint range needs numbers.");
    if (swingY < 0 || swingY > 180 || swingZ < 0 || swingZ > 180) return refuse("swings are 0 to 180 degrees.");
    if (twistMin < -180 || twistMax > 180 || twistMin > twistMax) return refuse("twist runs from -180 to 180 degrees, minimum first.");
  }
  return validated(mapRole(p, role, (r) => ({ ...r, range })), p);
}

// --- chains --------------------------------------------------------------------------------------------------------------

const chainNamed = (p: SkeletonProfile, name: string): ProfileChain | undefined => p.chains.find((c) => c.name === name);
const mapChain = (p: SkeletonProfile, name: string, f: (c: ProfileChain) => ProfileChain): SkeletonProfile => ({ ...p, chains: p.chains.map((c) => (c.name === name ? f(c) : c)) });
const missingChain = (name: string) => refuse(`there is no chain "${name}".`);

/** A new chain of `roles` (in order, at least one) at the end; chains run in this order, twists last. */
export function addChain(p: SkeletonProfile, name: string, kind: ChainKind, roles: readonly string[]): EditResult<SkeletonProfile> {
  const n = name.trim();
  if (n === "") return refuse("a chain needs a name.");
  if (chainNamed(p, n)) return refuse(`chain "${n}" already exists.`);
  if (!CHAIN_KINDS.includes(kind)) return refuse(`kind must be one of ${CHAIN_KINDS.join(", ")}.`);
  if (roles.length === 0) return refuse("a chain needs at least one role.");
  return validated({ ...p, chains: [...p.chains, { name: n, kind, roles: [...roles], ik: false }] }, p);
}

export function removeChain(p: SkeletonProfile, name: string): EditResult<SkeletonProfile> {
  return chainNamed(p, name) ? validated({ ...p, chains: p.chains.filter((c) => c.name !== name) }, p) : missingChain(name);
}

export function renameChain(p: SkeletonProfile, from: string, to: string): EditResult<SkeletonProfile> {
  const n = to.trim();
  if (!chainNamed(p, from)) return missingChain(from);
  if (n === "") return refuse("a chain needs a name.");
  if (n === from) return accept(p);
  if (chainNamed(p, n)) return refuse(`chain "${n}" already exists.`);
  return validated(mapChain(p, from, (c) => ({ ...c, name: n })), p);
}

export function setChainKind(p: SkeletonProfile, name: string, kind: ChainKind): EditResult<SkeletonProfile> {
  if (!chainNamed(p, name)) return missingChain(name);
  if (!CHAIN_KINDS.includes(kind)) return refuse(`kind must be one of ${CHAIN_KINDS.join(", ")}.`);
  return validated(mapChain(p, name, (c) => ({ ...c, kind })), p);
}

/** A chain's roles, start to end. Refused when empty, repeating a role or naming one the profile lacks (and an IK chain needs three). */
export function setChainRoles(p: SkeletonProfile, name: string, roles: readonly string[]): EditResult<SkeletonProfile> {
  const chain = chainNamed(p, name);
  if (!chain) return missingChain(name);
  if (roles.length === 0) return refuse("a chain needs at least one role.");
  const unknown = roles.find((r) => !roleNamed(p, r));
  if (unknown !== undefined) return missingRole(unknown);
  const dup = roles.find((r, i) => roles.indexOf(r) !== i);
  if (dup !== undefined) return refuse(`"${dup}" is already in the chain.`);
  return validated(mapChain(p, name, (c) => ({ ...c, roles: [...roles] })), p);
}

/** Move the role at `index` of a chain by `delta` places. Refused at either end. */
export function moveChainRole(p: SkeletonProfile, name: string, index: number, delta: -1 | 1): EditResult<SkeletonProfile> {
  const chain = chainNamed(p, name);
  if (!chain) return missingChain(name);
  const to = index + delta;
  if (index < 0 || index >= chain.roles.length || to < 0 || to >= chain.roles.length) return refuse(`the role is already ${delta < 0 ? "first" : "last"} in the chain.`);
  const roles = [...chain.roles];
  [roles[index], roles[to]] = [roles[to], roles[index]];
  return setChainRoles(p, name, roles);
}

/** IK on or off for a chain; an IK chain needs three roles. */
export function setChainIk(p: SkeletonProfile, name: string, ik: boolean): EditResult<SkeletonProfile> {
  if (!chainNamed(p, name)) return missingChain(name);
  return validated(mapChain(p, name, (c) => ({ ...c, ik })), p);
}
