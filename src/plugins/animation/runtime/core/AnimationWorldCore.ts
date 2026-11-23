// One World's namespace in the page's animation core (ADR 0370: "Worlds, the editor viewport and play mode are
// namespaces in it"): a World id, the instances created in it, the asset references it holds, its command writer and
// the frame its stages share. Made by the `AnimationCore` World service (`service.ts`) the first time the World needs
// animation, closed when the World is torn down: its instances are destroyed and its asset references dropped (assets
// no other World holds go idle, and are released when the Engine is disposed: see `AnimationCore`).
import type { World } from "../../../../engine/core/World";
import { Assets, fetchAssetBytes } from "../../../../engine/scene/Assets";
import { PASS_FIXED, PASS_NORMAL, STATUS_STALE_HANDLE } from "../wasm/wire/core";
import type { AnimationFrame } from "../stages/frame";
import type { AnimationAssetKind, AnimationAssetSource, AnimationCore } from "./AnimationCore";
import { CommandWriter, type CommandSink } from "./commands";

/** Asset kinds made from one file's bytes, which `acquireFile` can fetch. */
export type AnimationFileKind = "skeleton" | "clip" | "graph" | "posedb" | "profile" | "plugin";

/** File fetches in flight, by URL, shared by every World. */
const fetching = new Map<string, Promise<Uint8Array | null>>();

/** @internal A World's animation namespace. */
export class AnimationWorldCore {
  /** The World id the core knows this World by. */
  readonly id: number;
  /** Commands the gather sub-steps queue for this World's next evaluate. */
  readonly commands = new CommandWriter();
  private readonly instances = new Set<number>();
  /** Asset handle → references this World holds. */
  private readonly refs = new Map<number, number>();
  private readonly sink: CommandSink;
  private readonly frame: { world: World; core: AnimationWorldCore; dt: number; unscaledDt: number; fixed: boolean; pass: number };
  private closed = false;

  constructor(
    readonly world: World,
    readonly core: AnimationCore,
  ) {
    this.id = core.openWorld();
    this.sink = { memory: () => core.buffer(), commandsPtr: () => core.commandsPtr(), writeInputs: (len) => core.writeInputs(len) };
    this.frame = { world, core: this, dt: 0, unscaledDt: 0, fixed: false, pass: PASS_NORMAL };
  }

  /** False once the World was torn down: every call is then a no-op answering 0. */
  get open(): boolean {
    return !this.closed;
  }

  /**
   * @internal The stage frame for this World (one object, reused: valid for the stage run it was made for). In a fixed
   * step `dt` is `fixedDeltaTime` for scaled and unscaled Animators alike.
   */
  frameFor(dt: number, fixed: boolean): AnimationFrame {
    const f = this.frame;
    f.dt = dt;
    f.fixed = fixed;
    f.pass = fixed ? PASS_FIXED : PASS_NORMAL;
    f.unscaledDt = fixed ? dt : this.world.time.unscaledDeltaTime;
    return f;
  }

  // --- Assets ---------------------------------------------------------------------------------------------------

  /** One reference to an asset for this World (see `AnimationCore.acquire`). Returns its handle, or 0. */
  acquire(key: string, kind: AnimationAssetKind, source: AnimationAssetSource | (() => AnimationAssetSource)): number {
    if (this.closed) return 0;
    return this.counted(this.core.acquire(key, kind, source));
  }

  private counted(handle: number): number {
    if (handle !== 0) this.refs.set(handle, (this.refs.get(handle) ?? 0) + 1);
    return handle;
  }

  /**
   * One reference to the project file `path` loaded as `kind`, keyed by its URL: fetched through `Assets` (read from
   * disk on the dedicated server) unless some World already holds it. Resolves to its handle, or 0 when the file is
   * missing, the core refused it, or this World closed meanwhile.
   */
  async acquireFile(path: string, kind: AnimationFileKind): Promise<number> {
    let url: string;
    try {
      url = Assets.url(path);
    } catch (err) {
      console.error(`[myco] animation: couldn't load "${path}":`, err);
      return 0;
    }
    if (this.closed) return 0;
    const loaded = this.core.acquireLoaded(url, kind);
    if (loaded !== 0) return this.counted(loaded);
    return this.fileHandle(url, path, kind);
  }

  private async fileHandle(url: string, path: string, kind: AnimationFileKind): Promise<number> {
    let pending = fetching.get(url);
    if (!pending) {
      pending = fetchAssetBytes(url).catch((err: unknown) => {
        console.error(`[myco] animation: couldn't load "${path}":`, err);
        return null;
      });
      fetching.set(url, pending);
      const clear = () => void (fetching.get(url) === pending && fetching.delete(url));
      pending.then(clear, clear);
    }
    const bytes = await pending;
    if (!bytes || this.closed) return 0;
    return this.acquire(url, kind, { kind, bytes });
  }

  /** Drops one of this World's references to an asset. Returns false when it held none. */
  release(handle: number): boolean {
    const n = this.refs.get(handle);
    if (!n) return false;
    if (n === 1) this.refs.delete(handle);
    else this.refs.set(handle, n - 1);
    return this.core.release(handle);
  }

  // --- Instances --------------------------------------------------------------------------------------------------

  /** Creates an instance in this World (graph 0: the implicit graph). Returns its handle, or 0 (`core.lastStatus()`). */
  createInstance(skeleton: number, graph = 0): number {
    if (this.closed) return 0;
    const h = this.core.createInstance(this.id, skeleton, graph);
    if (h !== 0) this.instances.add(h);
    return h;
  }

  /** Destroys one of this World's instances. Returns a status (`STATUS_STALE_HANDLE` when it isn't one). */
  destroyInstance(handle: number): number {
    if (!this.instances.delete(handle)) return STATUS_STALE_HANDLE;
    return this.core.destroyInstance(handle);
  }

  /** Instances alive in this World. */
  get instanceCount(): number {
    return this.instances.size;
  }

  // --- The frame --------------------------------------------------------------------------------------------------

  /**
   * Applies this World's queued commands (one `write_inputs`), then evaluates its instances of `pass`. Returns the
   * state-change records waiting (read them with `core.stateChange` before another World's evaluate).
   */
  evaluate(pass: number, dtScaled: number, dtUnscaled: number): number {
    if (this.closed) return 0;
    this.commands.flush(this.sink);
    return this.core.evaluate(this.id, pass, dtScaled, dtUnscaled);
  }

  /** @internal World teardown: destroys the instances, drops the asset references and gives the World id back. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.instances) this.core.destroyInstance(h);
    this.instances.clear();
    for (const [handle, n] of this.refs) for (let i = 0; i < n; i++) this.core.release(handle);
    this.refs.clear();
    this.commands.clear();
    this.core.closeWorld(this.id);
  }
}
