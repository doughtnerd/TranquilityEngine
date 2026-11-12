#!/usr/bin/env node
// S4 question 1b: bus order vs sidechain order. Reads samples/*/project.json (audio.buses, audio.ducking) and, for each
// ducking rule and for every possible (trigger, target) pair, says whether today's core order (bus.rs `order`: depth,
// deepest first, ties by bus index) computes the trigger bus before the target bus. If not, a detector tapped on the trigger's
// output reads the previous quantum (128 frames, 2.67 ms). Also: whether a topological order with the sidechain edges added
// (trigger before target) exists, i.e. whether the delay can be removed at BUS_CONFIG time instead of accepted.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../samples/", import.meta.url));
const out = [];
for (const name of readdirSync(root)) {
  const f = `${root}${name}/project.json`;
  if (!existsSync(f)) continue;
  const audio = JSON.parse(readFileSync(f, "utf8")).audio;
  if (!audio?.buses?.length) continue;
  const buses = audio.buses;
  const idx = new Map(buses.map((b, i) => [b.name, i]));
  const parent = buses.map((b, i) => (b.parent === undefined ? -1 : (idx.get(b.parent) ?? 0)));
  const depth = buses.map((_, i) => { let d = 0, b = i; while (parent[b] !== -1) { b = parent[b]; d++; } return d; });
  // today's order: depth descending, ties by index (stable insertion sort in bus.rs)
  const order = [...buses.keys()].sort((a, b) => depth[b] - depth[a] || a - b);
  const pos = new Map(order.map((b, k) => [b, k]));
  const isAncestor = (a, b) => { for (let x = parent[b]; x !== -1; x = parent[x]) if (x === a) return true; return false; };
  const pairs = { total: 0, triggerFirst: 0, delayed: 0, triggerIsAncestor: 0 };
  for (let t = 0; t < buses.length; t++) for (let g = 0; g < buses.length; g++) {
    if (t === g) continue;
    pairs.total++;
    if (isAncestor(t, g)) pairs.triggerIsAncestor++;
    else if (pos.get(t) < pos.get(g)) pairs.triggerFirst++;
    else pairs.delayed++;
  }
  // with the rule edges added, Kahn's algorithm over (child -> parent) + (trigger -> target) edges
  const topo = (rules) => {
    const edges = []; buses.forEach((_, i) => { if (parent[i] !== -1) edges.push([i, parent[i]]); });
    for (const r of rules) edges.push([idx.get(r.trigger), idx.get(r.target)]);
    const indeg = buses.map(() => 0); edges.forEach(([, to]) => indeg[to]++);
    const q = [...buses.keys()].filter((i) => indeg[i] === 0), res = [];
    while (q.length) { const n = q.shift(); res.push(n); for (const [a, b] of edges) if (a === n && --indeg[b] === 0) q.push(b); }
    return res.length === buses.length ? res : null;
  };
  const rules = (audio.ducking ?? []).map((r) => {
    const t = idx.get(r.trigger), g = idx.get(r.target);
    const a = isAncestor(t, g);
    return {
      target: r.target, trigger: r.trigger, targetDepth: depth[g], triggerDepth: depth[t], attackMs: r.attack * 1000, releaseMs: r.release * 1000, amount: r.amount,
      triggerComputedFirst: !a && pos.get(t) < pos.get(g),
      verdict: a ? "trigger is an ancestor of the target: a cycle, must read last quantum" : pos.get(t) < pos.get(g) ? "no delay (trigger deeper or earlier)" : "DELAYED one quantum (2.67 ms) under today's order",
      reorderableAtConfig: topo([r]) !== null,
    };
  });
  out.push({ sample: name, buses: buses.length, maxDepth: Math.max(...depth), orderToday: order.map((i) => buses[i].name).slice(0, 8).join(",") + (buses.length > 8 ? ",..." : ""), rules, allPairs: pairs, allRulesReorderable: topo(audio.ducking ?? []) !== null });
}
console.log(JSON.stringify(out, null, 1));
