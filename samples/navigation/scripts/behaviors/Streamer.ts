import { GameBehavior, GameObject, Input, NavAgent, SceneManager, Time, behavior, field } from "myco";

type ChunkState = "unloaded" | "loading" | "loaded";
type Force = "none" | "loaded" | "unloaded";

interface Chunk {
  index: number;
  path: string;
  name: string;
  /** The chunk's square, world x and z (min, max). */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  state: ChunkState;
  scene: GameObject | null;
  force: Force;
  /** Horizontal distance to the nearest agent at the last check. */
  distance: number;
}

/**
 * Streams the chunk scenes around the agents (Foxfire's StreamingDemoStreamer): a chunk loads, additively, when an
 * agent comes within `loadDistance` of its square, and unloads once every agent is past `unloadDistance`. Loading
 * a chunk scene adds its NavChunk to the World's navigation, which stitches it to the loaded neighbours; unloading
 * removes it. Navigation needs nothing from this script: any way of loading scenes works.
 *
 * Keys: 1-9 force a chunk loaded or unloaded (again: back to distance; 1 is south-west, like a numpad), 0 clears
 * the forced chunks, L turns distance streaming on or off.
 */
@behavior("navdemo.Streamer")
export class Streamer extends GameBehavior {
  /** The chunk scenes, south-west to north-east (rows of three, south first). */
  @field([String]) chunks: string[] = [];
  @field([String]) names: string[] = [];
  @field(Number) chunkSize = 128;
  @field(Number) chunkHeight = 48;
  @field(Number) loadDistance = 24;
  /** More than `loadDistance`, so a chunk doesn't load and unload over and over at the boundary. */
  @field(Number) unloadDistance = 40;
  /** Seconds between checks of the agents' positions. */
  @field(Number) checkInterval = 0.25;
  @field(Boolean) streamByDistance = true;

  private states: Chunk[] = [];
  private timer = 0;
  private checked = false;
  /** Loads and unloads so far (the HUD and tests read them). */
  loads = 0;
  unloads = 0;

  /** The streamer in the current World, if any. */
  static find(): Streamer | null {
    return GameObject.findObjectOfType(Streamer);
  }

  /** The chunks' states, south-west first. */
  get chunkStates(): readonly { name: string; path: string; state: ChunkState; force: Force; distance: number }[] {
    return this.states;
  }

  /**
   * True once the chunks near the agents at the start have loaded (no chunk is loading): the crowds wait for it
   * before picking their first goals, so their first paths are planned across the loaded chunks.
   */
  get settled(): boolean {
    return this.checked && this.states.every((c) => c.state !== "loading") && this.states.some((c) => c.state === "loaded");
  }

  /** The names of the loaded chunks. */
  get loadedNames(): string[] {
    return this.states.filter((c) => c.state === "loaded").map((c) => c.name);
  }

  awake(): void {
    const half = this.chunkSize / 2;
    this.states = this.chunks.map((path, i) => {
      const x = ((i % 3) - 1) * this.chunkSize;
      const z = (Math.floor(i / 3) - 1) * this.chunkSize; // north is +z
      return { index: i, path, name: this.names[i] ?? path, minX: x - half, maxX: x + half, minZ: z - half, maxZ: z + half, state: "unloaded", scene: null, force: "none", distance: Infinity };
    });
  }

  update(): void {
    for (let i = 0; i < this.states.length && i < 9; i++) {
      if (!Input.getKeyDown(String(i + 1))) continue;
      const c = this.states[i];
      // Pressed: force the opposite of what it is; pressed again: back to distance.
      c.force = c.force !== "none" ? "none" : c.state === "loaded" || c.state === "loading" ? "unloaded" : "loaded";
      this.apply(c);
    }
    if (Input.getKeyDown("0")) for (const c of this.states) c.force = "none";
    if (Input.getKeyDown("l")) this.streamByDistance = !this.streamByDistance;
  }

  fixedUpdate(): void {
    this.timer -= Time.fixedDeltaTime;
    if (this.timer > 0) return;
    this.timer = this.checkInterval;
    this.measure();
    for (const c of this.states) this.apply(c);
    this.checked = true;
  }

  onDestroy(): void {
    for (const c of this.states) if (c.scene?.isValid) SceneManager.unload(c.scene);
  }

  /** Each chunk's horizontal distance to the nearest agent. */
  private measure(): void {
    for (const c of this.states) c.distance = Infinity;
    for (const agent of GameObject.findObjectsOfType(NavAgent)) {
      const p = agent.node.transform?.worldPosition;
      if (!p) continue;
      for (const c of this.states) {
        const dx = Math.max(c.minX - p.x, 0, p.x - c.maxX);
        const dz = Math.max(c.minZ - p.z, 0, p.z - c.maxZ);
        const d = Math.hypot(dx, dz);
        if (d < c.distance) c.distance = d;
      }
    }
  }

  private apply(c: Chunk): void {
    let want: boolean | null = null; // null: leave it as it is
    if (c.force !== "none") want = c.force === "loaded";
    else if (this.streamByDistance) want = c.distance <= this.loadDistance ? true : c.distance > this.unloadDistance ? false : null;
    if (want === true && c.state === "unloaded") this.load(c);
    else if (want === false && c.state === "loaded") this.unload(c);
  }

  private load(c: Chunk): void {
    c.state = "loading";
    SceneManager.load(c.path, { additive: true }).then(
      (scene) => {
        if (!this.node.isValid) {
          SceneManager.unload(scene);
          return;
        }
        c.scene = scene;
        c.state = "loaded";
        this.loads++;
      },
      (err: unknown) => {
        c.state = "unloaded";
        console.error(`[navigation sample] couldn't load ${c.path}:`, err);
      },
    );
  }

  private unload(c: Chunk): void {
    if (c.scene?.isValid) SceneManager.unload(c.scene);
    c.scene = null;
    c.state = "unloaded";
    this.unloads++;
  }
}
