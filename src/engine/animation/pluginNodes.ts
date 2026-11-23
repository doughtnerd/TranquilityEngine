/**
 * A third-party plugin's animation nodes in its `plugin.json` (ADR 0370 "Third-party graph and rig nodes", T45t):
 *
 * ```json
 * "animationNodes": [{ "module": "nodes/sway.wasm", "budget": 200000 }]
 * ```
 *
 * Each entry is a wasm node module (built with `anim-plugin-sdk`), a path inside the plugin, and an optional
 * instruction budget: the fuel one node instance may use per evaluation (`anim-meter`'s weighted instructions). A call
 * gets `budget × count + NODE_FUEL.base` fuel (D78: count is 1). Read without running plugin code (like audio's section,
 * ADR 0352), by the plugin discovery (`plugins/thirdParty.ts`), the exporter (which meters the modules into the build)
 * and the runtime loader (which reads a module's budget from its plugin's `plugin.json`).
 *
 * Lenient: a bad entry is dropped and a bad budget takes the default, each with one problem line; the parse never
 * throws and never refuses the plugin. The limits are declared here, once.
 *
 * Pure. Internal: not public API.
 */

/** @internal Fuel limits (tripwires against runaway modules, not design limits: raise them with a reason). */
export const NODE_FUEL = Object.freeze({
  /**
   * The default per-instance budget. The sample's sway node uses about 220 per bone (18,000 on 80 bones), so this
   * leaves room for heavier solvers on large rigs while still stopping a runaway loop within a millisecond or so.
   */
  default: 1_000_000,
  /** The largest per-instance budget a plugin may declare. */
  max: 50_000_000,
  /** Fuel added to every call: the call's fixed cost (the SDK's dispatch) whatever the instance count. */
  base: 1_000,
});

/** @internal Node modules per plugin. */
export const MAX_NODE_MODULES = 64;

/** @internal One declared node module. */
export interface AnimationNodeModuleDecl {
  /** The module's path inside the plugin (`nodes/sway.wasm`). */
  readonly module: string;
  /** Fuel per node instance per evaluation. */
  readonly budget: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const insidePlugin = (path: string) => path !== "" && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..");

/**
 * @internal Reads a manifest's `animationNodes` value: the usable entries, and one line per problem (`where: message`).
 */
export function parseAnimationNodes(raw: unknown): { readonly modules: readonly AnimationNodeModuleDecl[]; readonly problems: readonly string[] } {
  const problems: string[] = [];
  const modules: AnimationNodeModuleDecl[] = [];
  if (raw === undefined) return { modules, problems };
  if (!Array.isArray(raw)) return { modules, problems: ['animationNodes: must be a list, such as [{ "module": "nodes/sway.wasm" }]; ignored'] };
  if (raw.length > MAX_NODE_MODULES) problems.push(`animationNodes: at most ${MAX_NODE_MODULES} modules; the rest are ignored`);
  raw.slice(0, MAX_NODE_MODULES).forEach((e: unknown, i) => {
    const where = `animationNodes[${i}]`;
    const entry = typeof e === "string" ? { module: e } : e;
    if (!isRecord(entry)) return void problems.push(`${where}: must be an object with a "module"; ignored`);
    const m = entry.module;
    if (typeof m !== "string" || !insidePlugin(m.replace(/^\.\//, "")) || !m.toLowerCase().endsWith(".wasm")) {
      return void problems.push(`${where}.module: must be the path of a .wasm file inside the plugin; ignored`);
    }
    const module = m.replace(/^\.\//, "");
    if (modules.some((x) => x.module === module)) return void problems.push(`${where}.module: "${module}" is listed twice; the first is used`);
    let budget: number = NODE_FUEL.default;
    const b = entry.budget;
    if (b !== undefined) {
      if (typeof b === "number" && Number.isInteger(b) && b >= 1 && b <= NODE_FUEL.max) budget = b;
      else problems.push(`${where}.budget: must be a whole number from 1 to ${NODE_FUEL.max}; using ${NODE_FUEL.default}`);
    }
    modules.push(Object.freeze({ module, budget }));
  });
  return { modules, problems };
}

/** @internal A call's fuel: `budget × count + base`, as the `i64` the metered module's `myco_fuel_set` takes. */
export const callFuel = (budget: number, count: number): bigint => BigInt(budget) * BigInt(count) + BigInt(NODE_FUEL.base);
