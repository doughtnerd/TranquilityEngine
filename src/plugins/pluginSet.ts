// The plugin set (ADR 0144): the one place that makes a set of plugins active for a host. A host (the
// player, the dedicated server, the editor, Vitest's setup) creates one with its activators, the set's
// adapters for each half: the runtime activator (`runtimeContext.ts`, including the stub that unclaims
// a disabled half's Components) and, in the editor only, the editor activator. `apply` then works out
// which plugins are enabled, orders them by dependencies, diffs against what is active, and activates
// or deactivates halves, under one failure policy. Plugins never see the set: they see only their
// per-half context (ADR 0134, 0135). Host-neutral: no editor imports, so the player and the server use it.
import { resolveEnabledPlugins } from "./enabled";
import type { PluginManifest } from "./manifest";
import { orderPlugins } from "./order";

/** A plugin half as the set sees it: a manifest and an `activate` taking the half's context. */
export interface PluginHalf {
  readonly manifest: PluginManifest;
  activate(context: never): void;
}

/** How the set drives one kind of half (an adapter over a half's context, ADR 0144). */
export interface HalfActivator<H extends PluginHalf = PluginHalf> {
  /** Activate `half` (its dependencies are active). Rolls back what it registered and rethrows when it throws. Nothing happens when it is already active. */
  activate(half: H): void;
  /** Undo everything the plugin's half registered (nothing when it isn't active). */
  deactivate(name: string): void;
  /** Runtime halves: a half that is off still runs, against a stub, so its decorated Components unregister (ADR 0133). */
  disable?(half: H): void;
  /** Whether the plugin's half is active, so a half deactivated outside the set (a test) is activated again. */
  isActive?(name: string): boolean;
}

/** A plugin a host knows (first- or third-party): its manifest and the halves it has for this host. */
export interface SetPlugin<R extends PluginHalf = PluginHalf, E extends PluginHalf = PluginHalf> {
  readonly manifest: PluginManifest;
  readonly runtime?: R;
  readonly editor?: E;
  /**
   * The modules the halves came from (a third-party plugin's loaded entries). A half whose module
   * changed since it activated (a script reload) is deactivated and activated again. Default: the half itself.
   */
  readonly modules?: { readonly runtime?: unknown; readonly editor?: unknown };
}

/** What kind of host applies the set. */
export interface HostTraits {
  /** The dedicated server: runtime halves whose manifest says `server: false` are off. */
  readonly server?: boolean;
  /** The editor: editor halves are active (needs an editor activator). */
  readonly editor?: boolean;
}

export interface ApplyInput<R extends PluginHalf = PluginHalf, E extends PluginHalf = PluginHalf> {
  /**
   * Every plugin the host knows, first- and third-party. Entries with the same name are one plugin (the
   * first entry's manifest, the first half of each kind). Runtime halves activate in the order their
   * entries are listed, then editor halves in theirs (dependencies first). Active plugins missing here are deactivated.
   */
  readonly plugins: readonly SetPlugin<R, E>[];
  /** The project's `plugins.disabled`. */
  readonly disabled?: Iterable<string>;
  readonly host?: HostTraits;
  /** Leave runtime halves exactly as they are (the editor during Play: the game keeps its plugins until Stop). */
  readonly keepRuntime?: boolean;
}

/** A plugin that couldn't be made active. */
export interface PluginSetProblem {
  readonly plugin: string;
  /** The half that threw, or "dependencies" (a dependency failed, or a cycle). */
  readonly where: "runtime" | "editor" | "dependencies";
  readonly message: string;
}

export interface ApplyResult {
  /** Plugins with at least one active half, in activation order. */
  readonly active: readonly string[];
  readonly problems: readonly PluginSetProblem[];
}

export interface PluginSet<R extends PluginHalf = PluginHalf, E extends PluginHalf = PluginHalf> {
  /**
   * Make the enabled plugins' halves the active ones. Unchanged active halves are kept. A half that
   * throws rolls back both halves of its plugin, and the plugins that need it are skipped. Never throws.
   */
  apply(input: ApplyInput<R, E>): ApplyResult;
  /** Plugins with at least one active half, in activation order. */
  active(): string[];
  /** Whether the plugin's `half` (default: either) is active through this set. */
  isActive(name: string, half?: Half): boolean;
}

type Half = "runtime" | "editor";
type Report = (plugin: string, where: PluginSetProblem["where"], message: string) => void;
const HALVES: readonly Half[] = ["runtime", "editor"];

interface ActiveHalf {
  readonly source: unknown;
}
type ActivePlugin = { manifest: PluginManifest } & { [K in Half]?: ActiveHalf };

/** A plugin with its halves gathered from every entry naming it; each half's position is the entry that gave it. */
interface Merged {
  readonly manifest: PluginManifest;
  readonly halves: { [K in Half]?: PluginHalf };
  readonly sources: { [K in Half]?: unknown };
  readonly position: Record<Half, number>;
}

function merge(plugins: readonly SetPlugin[]): Merged[] {
  const byName = new Map<string, Merged>();
  plugins.forEach((p, i) => {
    let m = byName.get(p.manifest.name);
    if (!m) byName.set(p.manifest.name, (m = { manifest: p.manifest, halves: {}, sources: {}, position: { runtime: i, editor: i } }));
    for (const half of HALVES) {
      const h = p[half];
      if (!h || m.halves[half]) continue;
      m.halves[half] = h;
      m.sources[half] = p.modules?.[half] ?? h;
      m.position[half] = i;
    }
  });
  return [...byName.values()];
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const depsOf = (m: PluginManifest) => Object.keys(m.dependencies ?? {});

/** A plugin set for one host, driving halves through `activators` (the editor host passes an editor activator too). */
export function createPluginSet<R extends PluginHalf = PluginHalf, E extends PluginHalf = PluginHalf>(activators: { readonly runtime?: HalfActivator<R>; readonly editor?: HalfActivator<E> }): PluginSet<R, E> {
  /** By name, in activation order (a plugin activates after what it needs, so reversed is dependents first). */
  const active = new Map<string, ActivePlugin>();
  const activatorOf = (half: Half) => activators[half] as HalfActivator<PluginHalf> | undefined;

  function apply(input: ApplyInput<R, E>): ApplyResult {
    const problems: PluginSetProblem[] = [];
    const report: Report = (plugin, where, message) => void problems.push({ plugin, where, message });
    try {
      run(input, report);
    } catch (err) {
      report("(plugins)", "dependencies", `The plugins couldn't be applied: ${messageOf(err)}`);
    }
    return { active: [...active.keys()], problems };
  }

  function run(input: ApplyInput<R, E>, report: Report): void {
    const host = input.host ?? {};
    const keepRuntime = !!input.keepRuntime;
    const plugins = merge(input.plugins);
    const byName = new Map(plugins.map((p) => [p.manifest.name, p]));
    const enabled = resolveEnabledPlugins(plugins.map((p) => p.manifest), input.disabled);

    const wants = (p: Merged | undefined, half: Half): boolean => {
      if (!p || !p.halves[half] || !activatorOf(half) || !enabled.has(p.manifest.name)) return false;
      if (half === "runtime") return !(host.server && p.manifest.server === false);
      return !!host.editor;
    };
    const touches = (half: Half) => half === "editor" || !keepRuntime;

    // Halves deactivated outside the set are forgotten, so they activate again.
    for (const [name, a] of active) {
      for (const half of HALVES) if (a[half] && activatorOf(half)?.isActive?.(name) === false) delete a[half];
      if (!a.runtime && !a.editor) active.delete(name);
    }

    // 1. Deactivate halves no longer wanted or whose module changed, and the same halves of the plugins that need them.
    const stale: Record<Half, Set<string>> = { runtime: new Set(), editor: new Set() };
    for (const [name, a] of active) {
      const p = byName.get(name);
      for (const half of HALVES) if (touches(half) && a[half] && (!wants(p, half) || p!.sources[half] !== a[half]!.source)) stale[half].add(name);
    }
    for (const half of HALVES) closeOverDependents(stale[half], half);
    for (const name of dependentsFirst()) {
      for (const half of ["editor", "runtime"] as const) if (stale[half].has(name)) deactivateHalf(name, half, report);
    }

    // 2. Runtime halves that are off run against the stub that unclaims their Components.
    if (!keepRuntime) {
      for (const p of plugins) if (!wants(p, "runtime")) disableRuntime(p, report);
    }

    // 3. Activate what is missing: every runtime half, then every editor half, each in dependency order (ties
    // keep the order the host listed that half in). A failure rolls back both halves of the plugin, and the
    // plugins that need it are skipped.
    const failed = new Set<string>();
    const on = plugins.filter((p) => enabled.has(p.manifest.name));
    for (const half of HALVES) {
      if (!touches(half)) continue;
      const listed = [...on].sort((a, b) => a.position[half] - b.position[half]);
      for (const p of order(listed, failed, keepRuntime, report)) {
        const name = p.manifest.name;
        if (failed.has(name)) continue;
        const blocked = depsOf(p.manifest).find((d) => failed.has(d));
        if (blocked) {
          failed.add(name);
          report(name, "dependencies", `${name} needs ${blocked}, which failed to activate`);
          rollBack(name, keepRuntime, report);
          if (!keepRuntime) disableRuntime(p, report);
          continue;
        }
        if (!wants(p, half) || active.get(name)?.[half]) continue;
        try {
          activatorOf(half)!.activate(p.halves[half]!);
          const a = active.get(name) ?? { manifest: p.manifest };
          a[half] = { source: p.sources[half] };
          active.set(name, a);
        } catch (err) {
          failed.add(name);
          report(name, half, `${name} failed to activate: ${messageOf(err)}`);
          rollBack(name, keepRuntime, report);
        }
      }
    }
  }

  /** Active plugins, those that need others before what they need. */
  function dependentsFirst(): string[] {
    const entries = [...active.values()];
    try {
      return orderPlugins(entries, new Set(entries.flatMap((a) => depsOf(a.manifest))))
        .map((a) => a.manifest.name)
        .reverse();
    } catch {
      return [...active.keys()].reverse();
    }
  }

  /** Add to `names` every active plugin whose `half` needs one of them, directly or not. */
  function closeOverDependents(names: Set<string>, half: Half): void {
    let grew = names.size > 0;
    while (grew) {
      grew = false;
      for (const [name, a] of active) {
        if (names.has(name) || !a[half]) continue;
        if (depsOf(a.manifest).some((d) => names.has(d))) (names.add(name), (grew = true));
      }
    }
  }

  function deactivateHalf(name: string, half: Half, report: Report): void {
    const a = active.get(name);
    if (!a?.[half]) return;
    delete a[half];
    if (!a.runtime && !a.editor) active.delete(name);
    try {
      activatorOf(half)!.deactivate(name);
    } catch (err) {
      report(name, half, `${name} failed to deactivate: ${messageOf(err)}`);
    }
  }

  /** Both halves of `name` (the editor half only with `keepRuntime`), and the same halves of active plugins that need it. */
  function rollBack(name: string, keepRuntime: boolean, report: Report): void {
    for (const half of ["editor", "runtime"] as const) {
      if (half === "runtime" && keepRuntime) continue;
      const names = new Set([name]);
      closeOverDependents(names, half);
      for (const n of dependentsFirst()) if (names.has(n)) deactivateHalf(n, half, report);
    }
  }

  function disableRuntime(p: Merged, report: Report): void {
    const disable = activatorOf("runtime")?.disable;
    if (!p.halves.runtime || !disable) return;
    try {
      disable(p.halves.runtime);
    } catch (err) {
      report(p.manifest.name, "runtime", `${p.manifest.name} failed to turn off: ${messageOf(err)}`);
    }
  }

  /** `plugins` in dependency order (`orderPlugins`). Plugins in a cycle are reported, added to `failed` and left out. */
  function order(plugins: readonly Merged[], failed: Set<string>, keepRuntime: boolean, report: Report): Merged[] {
    try {
      return orderPlugins(plugins);
    } catch {
      const byName = new Map(plugins.map((p) => [p.manifest.name, p]));
      const closure = (p: Merged) => {
        const out = new Map<string, Merged>();
        const visit = (q: Merged) => {
          if (out.has(q.manifest.name)) return;
          out.set(q.manifest.name, q);
          for (const d of depsOf(q.manifest)) if (byName.has(d)) visit(byName.get(d)!);
        };
        visit(p);
        return [...out.values()];
      };
      const ok: Merged[] = [];
      for (const p of plugins) {
        if (failed.has(p.manifest.name)) continue;
        try {
          orderPlugins(closure(p));
          ok.push(p);
        } catch (err) {
          failed.add(p.manifest.name);
          report(p.manifest.name, "dependencies", messageOf(err));
          rollBack(p.manifest.name, keepRuntime, report);
        }
      }
      return orderPlugins(ok);
    }
  }

  return {
    apply,
    active: () => [...active.keys()],
    isActive: (name, half) => {
      const a = active.get(name);
      return !!a && (half ? !!a[half] : true);
    },
  };
}

/** For hosts where a plugin that doesn't activate stops the game (the player, the server; ADR 0139): throw the first problem's message. */
export function throwOnPluginProblem(result: ApplyResult): void {
  if (result.problems.length > 0) throw new Error(result.problems[0].message);
}
