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
 */
export class LinkApplier {
  private links: readonly LinkConfig[] = [];
  private readonly connections = new WeakMap<World, LinkRecord>();
  private deferred: LinkConfig[] = [];

  constructor(private readonly worlds: LinkWorlds) {}

  /** Connect every link whose Worlds exist, in order, waiting for each; a failed connection rejects. */
  async startUp(links: readonly LinkConfig[]): Promise<void> {
    this.links = links;
    for (const link of links) {
      const connected = this.connect(link);
      if (connected instanceof Promise) await connected;
    }
  }

  /** Links `world` completes now that it exists: connected as if the script had called `connect` right after creating it. */
  worldCreated(world: World): void {
    for (const link of this.links) {
      if ((link.from === world.name || link.to === world.name) && !this.applyNow(link)) this.deferred.push(link);
    }
  }

  /** Once per frame: links that waited for a client's old connection to close. */
  retryDeferred(): void {
    if (this.deferred.length) this.deferred = this.deferred.filter((link) => !this.applyNow(link));
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
