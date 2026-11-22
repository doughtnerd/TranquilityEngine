/**
 * Internal (ADR 0338 §7, §8, amended by 0344): the main-thread side of plugin effects on the audio core. The core backend
 * owns one (`coreBackend.ts`'s `effectPlugins` capability); it keeps the registry, gives each effect type its core index
 * `e` (its kind is `FX_PLUGIN_BASE + e`, which `effectKinds.ts` answers through `bindPluginKinds`), sends each module to
 * the worklet's glue (`worklet/effectGlue.ts`) as transferred bytes, replays every module after a hard rebuild (before
 * the core's own replay), and turns the glue's events into `Audio.debug().plugins` rows, one warning per plugin and
 * reason, and capture events.
 *
 * Indices are stable per effect type for the host's life (a reload keeps `e`), so configurations sent before a reload
 * still name the effect; the glue answers the old instances' handles `STALE` and the core asks for new ones.
 */
import type { PluginEffectDecl } from "../../../../engine/audio/effects/types";
import type { AudioEffectPlugins, EffectPluginLoad, EffectPluginModule } from "../backend";
import type { AudioPluginDebug, AudioPluginFaultReason } from "../debugTypes";
import type { ProfileSink } from "../mix/profileSink";
import { bindPluginKinds } from "../core/effectKinds";
import { FX_PLUGIN_BASE, FX_PLUGINS_MAX } from "../wire.generated";
import { FX_FAULT_REASONS, type FxControlMessage, type FxEffectEntry, type FxShellEvent } from "../worklet/effectGlue";

/** What the host needs of the core backend. */
export interface EffectPluginHostDeps {
  /** Posts a control message to the current worklet node (`CoreLink.postControl`). */
  post(message: FxControlMessage, transfer: Transferable[]): void;
  /** One warning per key. */
  warnOnce(key: string, line: string): void;
  /** The capture's sink (`NULL_PROFILE_SINK` while none runs). */
  profile(): ProfileSink;
  /**
   * The kinds plugin types encode to changed (a registration, a removal): the backend sends its bus tree again, so a
   * bus that names a plugin effect runs it (instances opened before keep what they were given).
   */
  kindsChanged(): void;
}

/** The core's glide modes for an effect's parameters: bit i log2 (`scale: "log"`), bit 16 + i stepped (`smooth: false`). */
export function glideModes(decl: PluginEffectDecl): number {
  let modes = 0;
  decl.spec.params.forEach((p, i) => {
    if (i >= 16) return;
    if (p.smooth === false) modes |= 1 << (16 + i);
    else if (p.scale === "log") modes |= 1 << i;
  });
  return modes >>> 0;
}

interface Registered {
  readonly id: number;
  readonly module: EffectPluginModule;
  /** A copy of the bytes: each post transfers one, so a rebuild can send them again. */
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly entries: readonly FxEffectEntry[];
  state: "loading" | "live" | "failed";
  error?: string;
  warmUps: number;
  memoryBytes: number;
  settle: ((load: EffectPluginLoad) => void) | null;
}

interface Row {
  e: number;
  state: "live" | "disabled";
  /** Reset sent: stats the glue posted before it handled the reset (still "disabled") don't turn the row off again. */
  resetting: boolean;
  instances: number;
  inUse: number;
  instructions: number;
  faults: Record<AudioPluginFaultReason, number>;
  starved: number;
  noInstance: number;
  memoryBytes: number;
}

const zeroFaults = (): Record<AudioPluginFaultReason, number> => ({ trap: 0, budget: 0, grow: 0, nonFinite: 0, range: 0 });

export class EffectPluginHost implements AudioEffectPlugins {
  private readonly modules = new Map<number, Registered>();
  /** Effect type → its core index, for the host's life. */
  private readonly indices = new Map<string, number>();
  private readonly byIndex = new Map<number, { type: string; reg: Registered }>();
  private readonly rows = new Map<number, Row>();
  private nextId = 1;
  private readonly unbind: () => void;
  private disposed = false;

  constructor(private readonly deps: EffectPluginHostDeps) {
    this.unbind = bindPluginKinds((type) => this.kindOf(type));
  }

  /** The core kind of `type` (`FX_PLUGIN_BASE + e`), or 0 when no live or loading module holds it. */
  kindOf(type: string): number {
    const e = this.indices.get(type);
    if (e === undefined) return 0;
    const at = this.byIndex.get(e);
    return at && at.reg.state !== "failed" ? FX_PLUGIN_BASE + e : 0;
  }

  register(module: EffectPluginModule): Promise<EffectPluginLoad> {
    if (this.disposed) return Promise.resolve({ ok: false, error: "the audio core was disposed" });
    // A reload: the plugin's same module goes first (its indices stay).
    for (const [id, r] of this.modules) if (r.module.plugin === module.plugin && r.module.module === module.module) this.drop(id);
    const entries: FxEffectEntry[] = [];
    for (const decl of module.effects) {
      const e = this.indexFor(decl.spec.type);
      if (e === null) return Promise.resolve({ ok: false, error: `${module.plugin}: more than ${FX_PLUGINS_MAX} plugin effects are registered` });
      entries.push({ e, type: decl.spec.type, kind: decl.kind, budget: decl.instructionsPerFrame, maxInstances: decl.maxInstances, modes: glideModes(decl) });
    }
    const id = this.nextId++;
    const reg: Registered = { id, module, bytes: Uint8Array.from(module.bytes), entries, state: "loading", warmUps: 0, memoryBytes: 0, settle: null };
    this.modules.set(id, reg);
    for (const entry of entries) this.byIndex.set(entry.e, { type: entry.type, reg });
    const done = new Promise<EffectPluginLoad>((resolve) => {
      reg.settle = resolve;
    });
    this.send(reg);
    this.deps.kindsChanged();
    return done;
  }

  unregister(plugin: string): void {
    let dropped = false;
    for (const [id, r] of this.modules) {
      if (r.module.plugin !== plugin) continue;
      this.drop(id);
      dropped = true;
    }
    if (dropped) this.deps.kindsChanged();
  }

  reset(type: string): void {
    const e = this.indices.get(type);
    if (e === undefined || !this.byIndex.has(e)) return;
    const row = this.rows.get(e);
    if (row) {
      row.state = "live";
      row.resetting = true;
    }
    this.deps.post({ type: "fxReset", e: [e] }, []);
  }

  health(): readonly AudioPluginDebug[] {
    const out: AudioPluginDebug[] = [];
    for (const [e, { type, reg }] of this.byIndex) {
      const row = this.rows.get(e);
      const entry = reg.entries.find((x) => x.e === e)!;
      out.push({
        plugin: reg.module.plugin,
        type,
        module: reg.module.module,
        e,
        state: reg.state === "live" ? (row?.state ?? "live") : reg.state,
        warmUps: reg.warmUps,
        instances: row?.instances ?? (reg.state === "live" ? entry.maxInstances : 0),
        inUse: row?.inUse ?? 0,
        instructionsPerQuantum: row?.instructions ?? 0,
        faults: row ? { ...row.faults } : zeroFaults(),
        starved: row?.starved ?? 0,
        noInstance: row?.noInstance ?? 0,
        memoryBytes: row?.memoryBytes ?? reg.memoryBytes,
        ...(reg.error !== undefined ? { error: reg.error } : {}),
      });
    }
    return out.sort((a, b) => a.e - b.e);
  }

  /** A shell event from the worklet (the core backend forwards every one). */
  onShellEvent(event: FxShellEvent | { readonly type: string }): void {
    switch (event.type) {
      case "fxLoaded":
        return this.loaded(event as Extract<FxShellEvent, { type: "fxLoaded" }>);
      case "pluginFault":
        return this.fault(event as Extract<FxShellEvent, { type: "pluginFault" }>);
      case "fxStats":
        return this.stats(event as Extract<FxShellEvent, { type: "fxStats" }>);
    }
  }

  /**
   * After a hard rebuild (a new node and core): every module goes to the new glue again, before the core's replay, so
   * the replayed configurations find their effects (their slots pass through until each is live again).
   */
  replay(): void {
    this.rows.clear();
    for (const reg of this.modules.values()) {
      if (reg.state === "failed") continue;
      reg.state = "loading";
      this.send(reg);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unbind();
    for (const reg of this.modules.values()) reg.settle?.({ ok: false, error: "the audio core was disposed" });
    this.modules.clear();
    this.byIndex.clear();
    this.rows.clear();
  }

  // ---------------------------------------------------------------------------------------------------------------

  private indexFor(type: string): number | null {
    const known = this.indices.get(type);
    if (known !== undefined) return known;
    const taken = new Set(this.indices.values());
    for (let e = 0; e < FX_PLUGINS_MAX; e++) {
      if (!taken.has(e)) {
        this.indices.set(type, e);
        return e;
      }
    }
    return null;
  }

  private send(reg: Registered): void {
    const bytes = reg.bytes.slice().buffer;
    this.deps.post({ type: "fxLoad", id: reg.id, plugin: reg.module.plugin, bytes, effects: reg.entries }, [bytes]);
  }

  private drop(id: number): void {
    const reg = this.modules.get(id);
    if (!reg) return;
    this.modules.delete(id);
    for (const entry of reg.entries) {
      if (this.byIndex.get(entry.e)?.reg === reg) this.byIndex.delete(entry.e);
      this.rows.delete(entry.e);
    }
    reg.settle?.({ ok: false, error: `${reg.module.plugin}'s module ${reg.module.module} was replaced or removed before it loaded` });
    reg.settle = null;
    this.deps.post({ type: "fxUnload", id }, []);
  }

  private loaded(event: Extract<FxShellEvent, { type: "fxLoaded" }>): void {
    const reg = this.modules.get(event.id);
    if (!reg) return;
    if (event.ok) {
      reg.state = "live";
      reg.warmUps = event.warmUps;
      reg.memoryBytes = event.memoryBytes;
      reg.settle?.({ ok: true, effects: reg.entries.map((x) => ({ type: x.type, e: x.e })) });
    } else {
      reg.state = "failed";
      reg.error = event.error;
      this.deps.kindsChanged();
      this.deps.warnOnce(`plugin-load:${reg.module.plugin}:${reg.module.module}`, `audio: the plugin ${reg.module.plugin}'s module ${reg.module.module} didn't load (${event.error}); its effects pass audio through.`);
      reg.settle?.({ ok: false, error: event.error });
    }
    reg.settle = null;
  }

  private fault(event: Extract<FxShellEvent, { type: "pluginFault" }>): void {
    const at = this.byIndex.get(event.e);
    if (!at) return;
    const row = this.rows.get(event.e) ?? this.blankRow(event.e, at.reg);
    row.faults[event.reason]++;
    if (event.disabled) row.state = "disabled";
    this.rows.set(event.e, row);
    const plugin = at.reg.module.plugin;
    this.deps.warnOnce(
      `plugin-fault:${plugin}:${event.reason}`,
      `audio: the plugin effect ${at.type} (${plugin}) faulted (${FAULT_TEXT[event.reason]}: ${event.message}); that block passed through dry.${event.disabled ? " It faulted three times within a second and is off until it is reset." : ""} This is warned once per plugin and reason.`,
    );
    if (event.disabled) this.deps.warnOnce(`plugin-disabled:${at.type}`, `audio: the plugin effect ${at.type} (${plugin}) is off after three faults within a second; it passes audio through until it is reset.`);
    this.deps.profile().pluginFault?.(at.type, event.reason, event.instance);
  }

  private stats(event: Extract<FxShellEvent, { type: "fxStats" }>): void {
    for (const r of event.rows) {
      const at = this.byIndex.get(r.e);
      if (!at) continue;
      const row = this.rows.get(r.e) ?? this.blankRow(r.e, at.reg);
      if (row.resetting && r.state === "disabled") continue;
      row.resetting = false;
      row.state = r.state;
      row.instances = r.instances;
      row.inUse = r.inUse;
      row.instructions = r.instructions;
      for (const reason of FX_FAULT_REASONS) row.faults[reason] = Math.max(row.faults[reason], r.faults[reason]);
      row.starved = r.starved;
      row.noInstance = r.noInstance;
      row.memoryBytes = r.memoryBytes;
      this.rows.set(r.e, row);
    }
  }

  private blankRow(e: number, reg: Registered): Row {
    return { e, state: "live", resetting: false, instances: reg.entries.find((x) => x.e === e)?.maxInstances ?? 0, inUse: 0, instructions: 0, faults: zeroFaults(), starved: 0, noInstance: 0, memoryBytes: reg.memoryBytes };
  }
}

const FAULT_TEXT: Readonly<Record<AudioPluginFaultReason, string>> = {
  trap: "it trapped",
  budget: "it ran past its instruction budget",
  grow: "it grew its memory while processing",
  nonFinite: "it put out a non-finite sample",
  range: "it put out a sample beyond ±64",
};
