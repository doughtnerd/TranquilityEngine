// Third-party animation node modules in a build (ADR 0370 "Third-party graph and rig nodes"; T45t). Games never load
// the editor module, so they can't meter: the build meters every enabled project plugin's declared node module
// (`plugin.json`'s `animationNodes`) with the editor module's fuel pass and writes the metered bytes in place of the
// copied file, and the runtime loader (`plugins/animation/runtime/features/nodes/loader.ts`) instantiates them as they
// are. A module metered already ships as it is. The budgets stay in the shipped `plugin.json`, where the loader reads
// them. A disabled plugin's module files aren't shipped (its nodes pass their input through). npm plugins' modules
// aren't project files, which graphs reference nodes by, so a build logs and skips them.
import type { AnimationCompiler } from "../plugins/animation/editor/compile/compiler";
import { pluginModulePath, type FoundPlugin } from "../plugins/thirdParty";
import { copiedPath, type WebBuildPlan } from "./webBuild";

/** One node module a build ships: its project path and its plugin. */
export interface PlannedAnimationNodeModule {
  readonly source: string;
  readonly plugin: string;
}

/** The enabled project plugins' node modules, the module files of plugins that are off (left out), and npm ones skipped. */
export function planAnimationNodes(plugins: readonly FoundPlugin[], enabled: ReadonlySet<string>): { modules: PlannedAnimationNodeModule[]; leaveOut: Set<string>; skipped: string[] } {
  const modules: PlannedAnimationNodeModule[] = [];
  const leaveOut = new Set<string>();
  const skipped: string[] = [];
  for (const p of plugins) {
    for (const m of p.manifest.animationNodes ?? []) {
      const source = pluginModulePath(p, m.module);
      if (p.source.kind !== "project") skipped.push(`${p.manifest.name}: the animation node module ${source} is in an npm package, which graphs can't reference; it isn't shipped.`);
      else if (!enabled.has(p.manifest.name)) leaveOut.add(source);
      else modules.push({ source, plugin: p.manifest.name });
    }
  }
  return { modules, leaveOut, skipped };
}

export interface MeterNodesOptions {
  /** A project file's contents. */
  read(path: string): Promise<string | Uint8Array>;
  /** The editor's compile module (`loadAnimationCompiler`), loaded only when the build has a node module. */
  compiler(): Promise<AnimationCompiler>;
  log?(line: string): void;
}

const encoder = new TextEncoder();

/** Whether `bytes` is a module `anim-meter` metered (its marker section); false for one that doesn't compile. */
async function isMetered(bytes: Uint8Array): Promise<boolean> {
  try {
    return WebAssembly.Module.customSections(await WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>), "myco.metered").length > 0;
  } catch {
    return false; // the fuel pass says why it is refused
  }
}

/** The plan with each planned node module metered into `binaries` (written instead of its copy); see the file header. */
export async function withMeteredAnimationNodes(plan: WebBuildPlan, options: MeterNodesOptions): Promise<WebBuildPlan> {
  const planned = plan.animationNodes ?? [];
  if (planned.length === 0) return plan;
  const log = options.log ?? (() => {});
  const binaries = new Map(plan.binaries ?? []);
  let compiler: AnimationCompiler | null = null;
  for (const { source, plugin } of planned) {
    let bytes: Uint8Array;
    try {
      const v = await options.read(source);
      bytes = typeof v === "string" ? encoder.encode(v) : v;
    } catch (err) {
      log(`${source}: the plugin ${plugin}'s animation node module couldn't be read (${(err as Error)?.message ?? err}); its nodes pass their input through in the game.`);
      continue;
    }
    if (await isMetered(bytes)) {
      log(`${source}: metered already; shipped as it is.`);
      continue;
    }
    compiler ??= await options.compiler();
    const out = compiler.meterNodeModule(bytes);
    if ("error" in out) {
      log(`${source}: the plugin ${plugin}'s animation node module was refused (${out.error}); its nodes pass their input through in the game.`);
      continue;
    }
    binaries.set(copiedPath(source), out.bytes);
    log(`${source}: metered (${bytes.length} → ${out.bytes.length} bytes).`);
  }
  return { ...plan, binaries };
}
