// Animation graph assets at run time (ADR 0372; T32). An Animator's `graph` (`*.animgraph.json`) is fetched, parsed and
// compiled here by the graph compiler (`engine/animation/graphCompile.ts`, T30), with the skeleton's bone names (bone
// references by name), then loaded into the World's core and its asset strings bound (`graph_bind`): clips, masks
// (resolved to the skeleton's bones, `masks.ts`), linked graphs (loaded the same way, recursively), pose databases and
// plugin modules (T45t: through the node loader, `../nodes/loader.ts`, which loads a graph's modules before it compiles
// so plugin nodes pack the descriptor's named parameters). Compiles are cached page-wide by content (the source text and the bone names), loaded graphs per World
// by the same key plus the skeleton, and reference-counted: the last Animator releasing one releases what it bound.
//
// The host keeps the compile's tables (`GraphMeta`): parameter indices and kinds, request names, state machines with
// their states and the layer each runs in, slots, linked-graph slots and layers, so the API names everything by name
// and the core only sees indices. T40t–T42t add the rig's motion-warp windows (the compile's `ikTargets` and `rays`
// are in `compiled`), the parameters motion matching reads from the host, and the RETARGET nodes.
//
// Procedural bindings (T41t, T42t): a RETARGET node's map is made for the rig the graph loads for
// (`../retarget/maps.ts`: the map reference and the Skeleton's `retargetSource` name the source side), and its source
// graph is compiled and loaded for that map's source skeleton, not the target's. Pose databases load their baked
// `*.posedb.bin` with their clips bound (`../matching/posedb.ts`).
import { parseAnimGraph, type AnimGraph, type Condition, type GraphNode, type GraphParamType } from "../../../../../engine/animation/animGraph";
import { compileAnimGraph, type CompiledAnimGraph } from "../../../../../engine/animation/graphCompile";
import type { AnimationWorldCore } from "../../core/AnimationWorldCore";
import { resolveClip } from "../clipSources";
import { matchingInputs, type MatchingInputs } from "../matching/inputs";
import { acquirePoseDatabase } from "../matching/posedb";
import { acquireNodeModule, loadGraphNodeModules } from "../nodes/loader";
import { acquireRetargetMap, retargetNodes, type RetargetBinding } from "../retarget/maps";
import { warpWindows } from "../warp/windows";
import { readJsonAsset } from "./jsonAsset";
import { acquireMask, type MaskRig } from "./masks";
import { subAssetClip } from "../subAssetClips";
import { normalizeAssetPath } from "../../../../../engine/scene/assetPath";

/** @internal A state machine of a graph, as the host names it. */
export interface MachineMeta {
  /** The state machine node's id. */
  readonly node: string;
  /** State names, local index order. */
  readonly states: readonly string[];
  /** Each state's root node index in the compiled graph (-1: none). */
  readonly roots: readonly number[];
  /** The layer it runs in ("Base" or a layer's name), or null for a machine nested in another's state. */
  readonly layer: string | null;
  /** The entry state (local index): where the machine starts, silently (the core reports later entries only). */
  readonly entry: number;
  /** For a machine nested in another's state: that machine and state (entering it restarts this one at its entry). */
  readonly parent: { readonly machine: number; readonly state: number } | null;
}

/** @internal The host's tables of a compiled graph. */
export interface GraphMeta {
  readonly compiled: CompiledAnimGraph;
  /** Parameter name → index; `paramTypes[index]` its kind. */
  readonly params: ReadonlyMap<string, number>;
  readonly paramTypes: readonly GraphParamType[];
  /** Parameter index → whether it is declared `replicate` and `predicted` (ADR 0372, "Replication"; T33). */
  readonly paramReplication: readonly { readonly replicate: boolean; readonly predicted: boolean }[];
  /** Request name → string id. */
  readonly requests: ReadonlyMap<string, number>;
  readonly machines: readonly MachineMeta[];
  /** Layer name ("Base" too) or machine node id → the machine `travel`, `jump` and `state` address. */
  readonly layerMachines: ReadonlyMap<string, number>;
  /** Layer index (the input view's weight index) → its default weight. */
  readonly layerWeights: readonly number[];
  /** Linked-graph slot index → its default graph's project path ("": none). */
  readonly linkedDefaults: readonly string[];
  /** Motion-warp window name → its `motionWarp` node index (T40t, `../warp/windows.ts`). */
  readonly warps: ReadonlyMap<string, number>;
  /** The parameters the graph's pose-database nodes read from the host (T42t), or null without such nodes. */
  readonly matching: MatchingInputs | null;
  /** The RETARGET nodes' map and source-graph project paths (T41t). */
  readonly retargets: readonly { readonly map: string; readonly source: string }[];
}

/** @internal A graph loaded into one World's core for one skeleton, with what it bound. */
export interface LoadedGraph {
  readonly key: string;
  readonly path: string;
  readonly handle: number;
  readonly meta: GraphMeta;
  /** Asset handles this graph holds a reference to (clips, masks, pose databases, plugins). */
  readonly held: readonly number[];
  /** Linked graphs it loaded (defaults and graph-typed bindings), released with it. */
  readonly linked: readonly LoadedGraph[];
  /** Project path → handle of the graphs bound in it (link(null) puts a default back by its path). */
  readonly graphHandles: ReadonlyMap<string, number>;
  refs: number;
}

/**
 * @internal The rig a graph is loaded for: none (a zero-bone instance, D109) or a Skeleton's, with its
 * `retargetSource` (T41t; absent or "" for none).
 */
export type GraphRig = (MaskRig & { readonly retargetSource?: string }) | null;

/** Linked graphs nested deeper than this are refused (a cycle of links). */
const MAX_DEPTH = 4;

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** FNV-1a over a string's UTF-16 units (a content key; collisions also need the same length and bones). */
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

// ------------------------------------------------------------------------------------------------ meta

/** Children of a node in the source graph: inputs, state roots and bridges, chooser results. */
function childrenOf(n: GraphNode): string[] {
  const out = [...n.inputs];
  if (n.machine) {
    for (const s of n.machine.states) {
      if (s.root) out.push(s.root);
      for (const t of s.transitions) if (t.bridge) out.push(t.bridge);
    }
    for (const t of n.machine.anyState) if (t.bridge) out.push(t.bridge);
  }
  if (n.chooser) {
    for (const r of n.chooser.rows) out.push(r.result);
    if (n.chooser.fallback) out.push(n.chooser.fallback);
  }
  return out;
}

/** The state machines reached from `root` without passing through another (breadth-first). */
function machinesBelow(byId: ReadonlyMap<string, GraphNode>, root: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([root]);
  const queue = [root];
  while (queue.length) {
    const n = byId.get(queue.shift()!);
    if (!n) continue;
    if (n.kind === "stateMachine") {
      out.push(n.id);
      continue;
    }
    for (const c of childrenOf(n)) {
      if (!seen.has(c)) {
        seen.add(c);
        queue.push(c);
      }
    }
  }
  return out;
}

/** The first state machine reached from `root`, breadth-first (a layer's top machine). */
function topMachine(byId: ReadonlyMap<string, GraphNode>, root: string | null): string | null {
  if (!root) return null;
  const seen = new Set<string>([root]);
  const queue = [root];
  while (queue.length) {
    const n = byId.get(queue.shift()!);
    if (!n) continue;
    if (n.kind === "stateMachine") return n.id;
    for (const c of childrenOf(n)) {
      if (!seen.has(c)) {
        seen.add(c);
        queue.push(c);
      }
    }
  }
  return null;
}

function requestNames(g: AnimGraph): Set<string> {
  const names = new Set<string>();
  const visit = (c: Condition | null) => {
    if (!c) return;
    if ("all" in c) c.all.forEach(visit);
    else if ("any" in c) c.any.forEach(visit);
    else if ("request" in c && c.request) names.add(c.request);
  };
  for (const n of g.nodes) {
    if (n.machine) {
      for (const s of n.machine.states) s.transitions.forEach((t) => visit(t.if));
      n.machine.anyState.forEach((t) => visit(t.if));
    }
    n.chooser?.rows.forEach((r) => visit(r.if));
  }
  return names;
}

function metaOf(g: AnimGraph, compiled: CompiledAnimGraph): GraphMeta {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const byName = new Map(g.parameters.map((p) => [p.name, p]));
  const params = new Map<string, number>();
  const paramTypes: GraphParamType[] = [];
  const paramReplication: { replicate: boolean; predicted: boolean }[] = [];
  compiled.parameters.forEach((name, i) => {
    params.set(name, i);
    const p = byName.get(name);
    paramTypes.push(p?.type ?? "float");
    paramReplication.push({ replicate: p?.replicate ?? false, predicted: p?.predicted ?? false });
  });
  const requests = new Map<string, number>();
  for (const name of requestNames(g)) {
    const id = compiled.strings.indexOf(name);
    if (id >= 0) requests.set(name, id);
  }
  const tops = new Map<string, string>(); // machine node id → layer name
  const base = topMachine(byId, g.output);
  if (base) tops.set(base, "Base");
  for (const l of g.layers) {
    if (!compiled.layers.includes(l.name)) continue;
    const m = topMachine(byId, l.root);
    if (m && !tops.has(m)) tops.set(m, l.name);
  }
  const layerMachines = new Map<string, number>();
  const machineIndex = new Map(compiled.machines.map((m, i) => [m.node, i]));
  const parents = new Map<string, { machine: number; state: number }>();
  compiled.machines.forEach((m, i) => {
    const states = byId.get(m.node)?.machine?.states ?? [];
    m.states.forEach((name, si) => {
      const root = states.find((st) => st.name === name)?.root;
      if (root) for (const c of machinesBelow(byId, root)) if (c !== m.node && machineIndex.has(c) && !parents.has(c)) parents.set(c, { machine: i, state: si });
    });
  });
  const machines: MachineMeta[] = compiled.machines.map((m, i) => {
    const node = byId.get(m.node);
    const roots = m.states.map((name) => {
      const root = node?.machine?.states.find((s) => s.name === name)?.root ?? null;
      return root === null ? -1 : compiled.nodes.indexOf(root);
    });
    const layer = tops.get(m.node) ?? null;
    if (layer !== null && !layerMachines.has(layer)) layerMachines.set(layer, i);
    if (!layerMachines.has(m.node)) layerMachines.set(m.node, i);
    const entryName = node?.machine?.entry ?? m.states[0];
    const entry = Math.max(0, m.states.indexOf(entryName ?? ""));
    return { node: m.node, states: m.states, roots, layer, entry, parent: parents.get(m.node) ?? null };
  });
  const layerWeights = compiled.layers.map((name) => g.layers.find((l) => l.name === name)?.weight ?? 1);
  const linkedDefaults = compiled.linked.map((name) => {
    const n = g.nodes.find((x) => x.kind === "linked" && (x.linked?.name || x.id) === name);
    return n?.linked?.graph ? normalizeAssetPath(n.linked.graph) : "";
  });
  return {
    compiled, params, paramTypes, paramReplication, requests, machines, layerMachines, layerWeights, linkedDefaults,
    warps: warpWindows(g, compiled.nodes), matching: matchingInputs(g, compiled.parameters), retargets: retargetNodes(g),
  };
}

// ------------------------------------------------------------------------------------------------ compile cache

interface Compiled {
  readonly meta: GraphMeta;
  readonly key: string;
}

/** Compiles by content key (page-wide). */
const compiles = new Map<string, Compiled | null>();

function compileSource(path: string, raw: unknown, bones: readonly string[] | null, modules: string): Compiled | null {
  const text = JSON.stringify(raw) ?? "";
  const key = `${text.length}:${fnv(text)}:${fnv(bones ? bones.join("\n") : "\u0000none")}${modules ? `:${fnv(modules)}` : ""}`;
  if (compiles.has(key)) return compiles.get(key)!;
  const parsed = parseAnimGraph(raw, path);
  const compiled = compileAnimGraph(parsed.value, bones ? { bones } : {});
  const errors = [...parsed.problems, ...compiled.problems.filter((p) => p.severity === "error").map((p) => `${path}: ${p.path ? `${p.path}: ` : ""}${p.message}`)];
  if (errors.length) warnOnce(`problems:${key}`, `[myco] animation: the graph "${path}" has problems:\n  ${errors.slice(0, 8).join("\n  ")}${errors.length > 8 ? `\n  … and ${errors.length - 8} more` : ""}`);
  const out = compiled.bytes ? { meta: metaOf(parsed.value, compiled), key } : null;
  if (!out) warnOnce(`nobytes:${key}`, `[myco] animation: the graph "${path}" couldn't be compiled; its Animators stay at the bind pose.`);
  compiles.set(key, out);
  return out;
}

// ------------------------------------------------------------------------------------------------ per-World graphs

const loaded = new WeakMap<AnimationWorldCore, Map<string, Promise<LoadedGraph | null>>>();

async function readSource(path: string): Promise<{ value: unknown } | null> {
  try {
    return { value: await readJsonAsset(path) };
  } catch (err) {
    warnOnce(`fetch:${path}`, `[myco] animation: couldn't load the graph "${path}": ${String(err)}`);
    return null;
  }
}

/** The RETARGET nodes' maps for `rig` (T41t), by map path: made before the bindings, as their source graphs compile for them. */
async function retargetMaps(ns: AnimationWorldCore, meta: GraphMeta, rig: GraphRig, held: number[]): Promise<Map<string, RetargetBinding | null>> {
  const out = new Map<string, RetargetBinding | null>();
  if (!meta.retargets.length) return out;
  if (!rig) {
    warnOnce(`retarget-norig:${meta.retargets[0]!.map}`, `[myco] animation: a graph's retarget node needs the Animator to have a Skeleton; it plays nothing.`);
    return out;
  }
  const target = { ...rig, retargetSource: rig.retargetSource ?? "" };
  for (const r of meta.retargets) if (!out.has(r.map)) out.set(r.map, await acquireRetargetMap(ns, r.map, target, held));
  return out;
}

/**
 * One reference to a graph's clip, resolved as an Animator's plays resolve theirs (ADR 0371, T19): a flipbook, a model's
 * clip (`model.glb#Anim/Run`) or an authored `*.anim.json` built for the rig's skeleton, else a compiled file. 0 when it
 * can't load.
 */
async function acquireGraphClip(ns: AnimationWorldCore, path: string, rig: GraphRig): Promise<number> {
  const made = subAssetClip(path);
  if (made !== undefined) return made ? ns.acquire(made.key, "clip", { kind: "clip", bytes: made.bytes }) : 0;
  const resolved = await resolveClip(path, rig ? { ref: rig.path, bones: rig.info } : null);
  if (!resolved || !ns.open) return 0;
  return "path" in resolved ? ns.acquireFile(resolved.path, "clip") : ns.acquire(resolved.key, "clip", { kind: "clip", bytes: resolved.bytes });
}

/** Loads and binds one graph's assets; the handles it took go to `held`. */
async function bindAssets(ns: AnimationWorldCore, handle: number, meta: GraphMeta, rig: GraphRig, depth: number, held: number[], linked: LoadedGraph[], graphHandles: Map<string, number>): Promise<void> {
  const maps = await retargetMaps(ns, meta, rig, held);
  /** Source graph path → the rig its RETARGET node's map runs it on. */
  const sourceRigs = new Map<string, GraphRig>();
  for (const r of meta.retargets) {
    const b = maps.get(r.map);
    if (b && r.source && !sourceRigs.has(r.source)) sourceRigs.set(r.source, b.source);
  }
  await Promise.all(
    meta.compiled.bindings.map(async (b) => {
      const path = normalizeAssetPath(b.ref);
      let asset = 0;
      switch (b.asset) {
        case "plugin":
          asset = await acquireNodeModule(ns, path);
          if (asset) held.push(asset);
          break;
        case "clip":
          asset = await acquireGraphClip(ns, path, rig);
          if (asset) held.push(asset);
          else warnOnce(`bind:${path}`, `[myco] animation: couldn't load "${path}" for a graph; it plays as nothing.`);
          break;
        case "posedb":
          asset = await acquirePoseDatabase(ns, path, rig ? { ref: rig.path, bones: rig.info } : null, held);
          break;
        case "mask":
          if (!rig) break; // a zero-bone instance has no bones to mask
          asset = await acquireMask(ns, path, rig);
          if (asset) held.push(asset);
          break;
        case "graph": {
          // A RETARGET node's source graph runs on its map's source skeleton (T41t).
          const graphRig = sourceRigs.has(path) ? sourceRigs.get(path)! : rig;
          const g = depth + 1 > MAX_DEPTH ? null : await acquireGraph(ns, path, graphRig, depth + 1);
          if (depth + 1 > MAX_DEPTH) warnOnce(`depth:${path}`, `[myco] animation: linked graphs nest deeper than ${MAX_DEPTH} at "${path}"; not linked.`);
          if (g) {
            linked.push(g);
            asset = g.handle;
            graphHandles.set(path, g.handle);
          }
          break;
        }
        case "retargetMap":
          asset = maps.get(path)?.map ?? 0;
          break;
      }
      if (asset && ns.open) ns.core.bindGraph(handle, b.stringId, asset);
    }),
  );
}

async function load(ns: AnimationWorldCore, path: string, rig: GraphRig, depth: number, map: Map<string, Promise<LoadedGraph | null>>, raw: unknown): Promise<LoadedGraph | null> {
  const modules = await loadGraphNodeModules(raw);
  if (!ns.open) return null;
  const compiled = compileSource(path, raw, rig ? rig.info.names : null, modules);
  if (!compiled) return null;
  const key = `${compiled.key}|${rig ? `${rig.path}|${rig.profile}|${rig.retargetSource ?? ""}` : ""}`;
  const known = map.get(key);
  if (known) {
    const g = await known;
    if (g) g.refs++;
    return g;
  }
  const promise = (async (): Promise<LoadedGraph | null> => {
    const handle = ns.acquire(`graph\u0000${key}`, "graph", () => ({ kind: "graph", bytes: compiled.meta.compiled.bytes! }));
    if (!handle) {
      warnOnce(`refused:${key}`, `[myco] animation: the core refused the graph "${path}" (status ${ns.core.lastStatus()}).`);
      return null;
    }
    const held: number[] = [];
    const linked: LoadedGraph[] = [];
    const graphHandles = new Map<string, number>();
    await bindAssets(ns, handle, compiled.meta, rig, depth, held, linked, graphHandles);
    return { key, path, handle, meta: compiled.meta, held, linked, graphHandles, refs: 0 };
  })();
  map.set(key, promise);
  const g = await promise;
  if (!g) {
    if (map.get(key) === promise) map.delete(key);
    return null;
  }
  g.refs++;
  return g;
}

/**
 * @internal One reference to the graph `path` compiled for `rig` and loaded into `ns`, its assets bound; null (one
 * warning) when it can't be read, compiled or loaded. Release it with {@link releaseGraph}.
 */
export async function acquireGraph(ns: AnimationWorldCore, path: string, rig: GraphRig, depth = 0): Promise<LoadedGraph | null> {
  let map = loaded.get(ns);
  if (!map) loaded.set(ns, (map = new Map()));
  const source = await readSource(path);
  if (!source || !ns.open) return null;
  return load(ns, path, rig, depth, map, source.value);
}

/** @internal Drops one reference; the last releases the graph and everything it bound. */
export function releaseGraph(ns: AnimationWorldCore, g: LoadedGraph): void {
  if (--g.refs > 0) return;
  loaded.get(ns)?.delete(g.key);
  for (const h of g.held) ns.release(h);
  for (const l of g.linked) releaseGraph(ns, l);
  ns.release(g.handle);
}
