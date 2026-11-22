import { connectWorlds, netSession } from "../net/session";
import type { World } from "./World";
import type { LinkConfig } from "./worlds";

/** What the link applier needs from its Engine. */
export interface LinkWorlds {
  /** The live World named `name`, or null. */
  find(name: string): World | null;
  /** Whether `world` is still one of the Engine's Worlds. */
  alive(world: World): boolean;
}

/**
 * Acts on a World a watched link names as its server, once it exists (ADR 0323): the dedicated server
 * listens where a link from a World it doesn't run says.
 */
export type LinkedWorldAction = (world: World, link: LinkConfig) => void;

/** Links someone else acts on (`watch`): the World each names as its server, when it's created at runtime. */
interface LinkWatch {
  readonly links: readonly LinkConfig[];
  readonly act: LinkedWorldAction;
}

/** The connection a link made for a client World: its server, and the client's server peer once connected. */
interface LinkRecord {
  readonly server: World;
  peer: unknown;
  /** While the server is still starting to listen (WebSocket): the peer comes later. */
  pending: boolean;
}

/**
 * A declarative bootstrap's links (ADR 0033, 0062): each `from` World connects to its `to` World once
 * both exist. Start-up links connect in order, awaited; links naming a World created later (a
 * Spawnable World) apply when it's created; a link whose client still holds a connection to a
 * destroyed server is retried each frame until that connection has closed.
 *
 * It is also the one place that notices "a World named in a link has appeared" for links this Engine
 * doesn't connect itself (`watch`, ADR 0323): the dedicated server's links from client Worlds it
 * skips, to the server templates it runs.
 */
export class LinkApplier {
  private links: readonly LinkConfig[] = [];
  private readonly connections = new WeakMap<World, LinkRecord>();
  private deferred: LinkConfig[] = [];
  private readonly watches: LinkWatch[] = [];
  /** Worlds created since the frame began that a watched link names: acted on at the next `beginFrame`. */
  private created: { world: World; link: LinkConfig; act: LinkedWorldAction }[] = [];

  constructor(private readonly worlds: LinkWorlds) {}

  /** Connect every link whose Worlds exist, in order, waiting for each; a failed connection rejects. */
  async startUp(links: readonly LinkConfig[]): Promise<void> {
    this.links = links;
    for (const link of links) {
      const connected = this.connect(link);
      if (connected instanceof Promise) await connected;
    }
  }

  /**
   * Have `act` called for each World created at runtime that one of `links` names as its server
   * (`to`), with the first such link. It's called at the start of the next frame, not at creation:
   * the code that created the World has run on by then (a lobby listens right after `createWorld`),
   * so `act` sees what that code did. A World destroyed before then is skipped. Returns the removal.
   */
  watch(links: readonly LinkConfig[], act: LinkedWorldAction): () => void {
    const entry: LinkWatch = { links, act };
    this.watches.push(entry);
    return () => {
      const i = this.watches.indexOf(entry);
      if (i >= 0) this.watches.splice(i, 1);
      this.created = this.created.filter((c) => c.act !== act);
    };
  }

  /** Links `world` completes now that it exists: connected as if the script had called `connect` right after creating it. */
  worldCreated(world: World): void {
    for (const link of this.links) {
      if ((link.from === world.name || link.to === world.name) && !this.applyNow(link)) this.deferred.push(link);
    }
    for (const { links, act } of this.watches) {
      const link = links.find((l) => l.to === world.name);
      if (link) this.created.push({ world, link, act });
    }
  }

  /**
   * Once per frame, before the Worlds step: links that waited for a client's old connection to
   * close, then the watched Worlds created since the last frame (failures are logged).
   */
  beginFrame(): void {
    if (this.deferred.length) this.deferred = this.deferred.filter((link) => !this.applyNow(link));
    if (!this.created.length) return;
    const created = this.created;
    this.created = [];
    for (const { world, link, act } of created) {
      if (!this.worlds.alive(world)) continue;
      try {
        act(world, link);
      } catch (err) {
        console.error(`[myco] Acting on World "${world.name}" for its link from "${link.from}" failed:`, err);
      }
    }
  }

  /** The server World a link connected `client` to, while that connection lasts or is still being made. */
  linkedServer(client: World): World | null {
    const record = this.connections.get(client);
    if (!record || !this.worlds.alive(record.server)) return null;
    if (record.pending) return record.server;
    const peer = netSession(client)?.serverPeer;
    return peer && peer === record.peer ? record.server : null;
  }

  /** A runtime link: connected, with failures logged. False to try again next frame. */
  private applyNow(link: LinkConfig): boolean {
    try {
      const connected = this.connect(link);
      if (connected === "retry") return false;
      connected?.catch((err) => console.error(`[myco] Link ${link.from} → ${link.to} over "${link.transport}" failed:`, err));
    } catch (err) {
      console.warn(`[myco] Link ${link.from} → ${link.to} not applied: ${(err as Error).message}`);
    }
    return true;
  }

  /**
   * Connect one link's client to its server, if both are alive and it isn't already. Returns the
   * connection (it rejects if connecting fails, after forgetting it), null when there's nothing to do,
   * or "retry" while the client still holds its connection to a server World that was destroyed (a
   * match restarted with `destroy()` then `createWorld()` in one frame), which closes during its next step.
   */
  private connect(link: LinkConfig): Promise<void> | null | "retry" {
    const client = this.worlds.find(link.from);
    const server = this.worlds.find(link.to);
    if (!client || !server) return null;
    const existing = this.connections.get(client);
    if (existing?.server === server) return null;
    if (netSession(client)?.serverPeer) {
      if (existing && !this.worlds.alive(existing.server)) return "retry";
      console.warn(`[myco] Link ${link.from} → ${link.to} not applied: World "${link.from}" is already connected to another server.`);
      return null;
    }
    const record: LinkRecord = { server, peer: null, pending: true };
    const connected = connectWorlds(client, server, link.transport, link.options ?? {});
    this.connections.set(client, record);
    const settle = () => {
      record.peer = netSession(client)?.serverPeer ?? null;
      record.pending = false;
    };
    settle();
    record.pending = record.peer === null;
    return connected.then(settle, (err: unknown) => {
      if (this.connections.get(client) === record) this.connections.delete(client);
      throw err;
    });
  }
}
