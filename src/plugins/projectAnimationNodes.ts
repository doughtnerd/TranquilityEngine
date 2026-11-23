// A project's third-party animation nodes in the editor (ADR 0370 "Third-party graph and rig nodes"; T45t). On every
// project code load and reload (`thirdPartyEditor.ts`), from the plan of the project's plugins (`planPluginCode`):
//
// - the node loader gets the editor module's fuel pass (`anim-meter` in `anim-editor-wasm`), so project modules, which
//   are stored unmetered, are metered when they load (cached by content), in edit mode and in Play alike;
// - every enabled usable plugin's declared modules (`plugin.json`'s `animationNodes`) are loaded, so their descriptors
//   join the node catalogue's registry: `pluginNodeKinds()` and `onPluginNodeKindsChanged()` in
//   `engine/animation/graphNodes/plugin.ts` are what the graph editor (T51) lists node kinds and builds cards from;
// - modules no longer declared (a plugin turned off or removed, an entry deleted) leave the catalogue;
// - each plugin's lenient `animationNodes` problems are warned once.
//
// Editor code only.
import { loadAnimationCompiler } from "./animation/editor/compile/compiler";
import { loadNodeModule, setNodeModuleMeter, unloadNodeModule } from "./animation/runtime/features/nodes/loader";
import { pluginModulePath, type FoundPlugin } from "./thirdParty";

/** The plan's part this needs. */
export interface AnimationNodePlan {
  readonly plugins: readonly FoundPlugin[];
  readonly enabled: ReadonlySet<string>;
}

/** Module paths this loaded for the open project. */
let declared = new Set<string>();
const warned = new Set<string>();

const meter = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const out = (await loadAnimationCompiler()).meterNodeModule(bytes);
  if ("error" in out) throw new Error(out.error);
  return out.bytes;
};

/**
 * Applies the plan's animation node modules (see the file header). Resolves to how many modules loaded. Never throws:
 * a module that can't load was warned about once by the loader.
 */
export async function applyProjectAnimationNodes(plan: AnimationNodePlan): Promise<number> {
  setNodeModuleMeter(meter);
  const next = new Set<string>();
  for (const p of plan.plugins) {
    for (const line of p.warnings ?? []) {
      const key = `${p.where}: ${line}`;
      if (!warned.has(key)) {
        warned.add(key);
        console.warn(`[myco] ${p.where}: ${line}`);
      }
    }
    if (p.source.kind !== "project" || !plan.enabled.has(p.manifest.name)) continue;
    for (const m of p.manifest.animationNodes ?? []) next.add(pluginModulePath(p, m.module));
  }
  for (const path of declared) if (!next.has(path)) unloadNodeModule(path);
  declared = next;
  const loaded = await Promise.all([...next].map((path) => loadNodeModule(path).catch(() => null)));
  return loaded.filter((m) => m !== null).length;
}

/** The project closed: its modules leave the catalogue. */
export function clearProjectAnimationNodes(): void {
  for (const path of declared) unloadNodeModule(path);
  declared = new Set();
}
