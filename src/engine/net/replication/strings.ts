/**
 * Replicated string behavior fields (ADR 0068): `@field(String, { replicate: true })` on a ghost's
 * behaviors. Ghost layouts (`layout.ts`) are numeric records, delta-compressed per field; strings
 * don't fit them, so they travel on their own, whole, when they change.
 *
 * The server checks each ghost's string fields once per snapshot it sends, and sends each open
 * connection the values that differ from what that connection was last sent (all of them the first
 * time it sees a ghost), in one reliable `net.ghostStrings` message:
 *
 * ```
 * varuint  entry count, then per entry:
 *   varuint ghost id, string component id, varuint which of the node's components of that
 *   class (0 = first), string field name, string value
 * ```
 *
 * Snapshots are unreliable and these are reliable, so either may arrive first: the client keeps
 * the newest value of each field per ghost id and writes them to the ghost's node when it's found
 * or made, and again whenever new values arrive. Values are capped at `MAX_STR_BYTES` like `str`
 * RPC fields; a longer one is cut (and warned about once).
 */
import type { Component } from "../../core/Component";
import { getComponentClass, getComponentId, getFields, type ComponentClass } from "../../core/registry";
import type { World } from "../../core/World";
import type { GameObject } from "../../scene/GameObject";
import type { BitReader } from "../codec";
import { MAX_STR_BYTES } from "../messages";
import type { Replicated } from "../Replicated";
import { registerNetMessage, type NetPeer, type NetSession } from "../session";

/** The message kind carrying changed string fields. */
export const GHOST_STRINGS = registerNetMessage("net.ghostStrings");

const fieldCache = new Map<ComponentClass, readonly string[]>();
const encoder = new TextEncoder();
const warned = new Set<string>();

/** A behavior class's replicated String fields, cached. */
export function stringFields(type: ComponentClass): readonly string[] {
  let out = fieldCache.get(type);
  if (!out) {
    out = getFields(type)
      .filter((f) => f.type === String && (f.options?.replicate || f.options?.predicted))
      .map((f) => f.name);
    fieldCache.set(type, out);
  }
  return out;
}

/** "component#index.field" */
type Key = string;

interface Entry {
  readonly component: string;
  readonly index: number;
  readonly field: string;
  readonly value: string;
}

/** A ghost's replicated strings now, by key. */
function readStrings(node: GameObject, rep: Replicated): Map<Key, Entry> {
  const out = new Map<Key, Entry>();
  if (!node.isValid) return out;
  const seen = new Map<ComponentClass, number>();
  for (const c of node.world._componentsOf(node.entity)) {
    const type = c.constructor as ComponentClass;
    const index = seen.get(type) ?? 0;
    seen.set(type, index + 1);
    if (c === (rep as Component)) continue;
    const fields = stringFields(type);
    if (fields.length === 0) continue;
    const component = getComponentId(type);
    if (!component) continue;
    for (const field of fields) {
      const raw = (c as unknown as Record<string, unknown>)[field];
      const value = clip(typeof raw === "string" ? raw : raw == null ? "" : String(raw), `${component}.${field}`);
      out.set(`${component}#${index}.${field}`, { component, index, field, value });
    }
  }
  return out;
}

function clip(value: string, what: string): string {
  if (value.length * 3 <= MAX_STR_BYTES || encoder.encode(value).byteLength <= MAX_STR_BYTES) return value;
  if (!warned.has(what)) {
    warned.add(what);
    console.warn(`[myco] ${what} is over ${MAX_STR_BYTES} bytes; replicated strings are cut to that.`);
  }
  let cut = value;
  while (encoder.encode(cut).byteLength > MAX_STR_BYTES) cut = cut.slice(0, -1);
  return cut;
}

/** @internal Server: what each connection was last sent, per ghost. */
export class ServerStrings {
  private readonly sent = new WeakMap<NetPeer, Map<number, Map<Key, string>>>();

  /**
   * Send each open connection the string fields that changed since it was last sent them.
   * `ghosts`: every live ghost; `despawned`: ids that went this tick.
   */
  send(session: NetSession, ghosts: Iterable<{ readonly id: number; readonly node: GameObject; readonly rep: Replicated }>, despawned: readonly number[]): void {
    const now: { id: number; strings: Map<Key, Entry> }[] = [];
    for (const g of ghosts) {
      const strings = readStrings(g.node, g.rep);
      if (strings.size > 0) now.push({ id: g.id, strings });
    }
    for (const peer of session.openPeers()) {
      let known = this.sent.get(peer);
      if (!known) this.sent.set(peer, (known = new Map()));
      for (const id of despawned) known.delete(id);
      const changes: (Entry & { id: number })[] = [];
      for (const { id, strings } of now) {
        let last = known.get(id);
        if (!last) known.set(id, (last = new Map()));
        for (const [key, entry] of strings) {
          if (last.get(key) === entry.value) continue;
          last.set(key, entry.value);
          changes.push({ id, ...entry });
        }
      }
      if (changes.length === 0) continue;
      session.send(GHOST_STRINGS, peer, "reliable", (w) => {
        w.writeVarUint(changes.length);
        for (const c of changes) {
          w.writeVarUint(c.id);
          w.writeString(c.component);
          w.writeVarUint(c.index);
          w.writeString(c.field);
          w.writeString(c.value);
        }
      });
    }
  }
}

/** @internal Client: the newest string values per ghost, written to ghosts' nodes. */
export class ClientStrings {
  private readonly values = new Map<number, Map<Key, Entry>>();
  private readonly dirty = new Set<number>();

  /** Read one `net.ghostStrings` message. Ids in `despawned` are ignored. */
  read(r: BitReader, despawned: ReadonlySet<number>): void {
    const n = r.readVarUint();
    if (n > 100_000) throw new RangeError("too many replicated strings");
    for (let i = 0; i < n; i++) {
      const id = r.readVarUint();
      const component = r.readString();
      const index = r.readVarUint();
      const field = r.readString();
      const value = r.readString();
      if (despawned.has(id)) continue;
      let map = this.values.get(id);
      if (!map) this.values.set(id, (map = new Map()));
      map.set(`${component}#${index}.${field}`, { component, index, field, value });
      this.dirty.add(id);
    }
  }

  /** A ghost's node was found or made: write everything known for it. */
  placed(id: number): void {
    if (this.values.has(id)) this.dirty.add(id);
  }

  forget(id: number): void {
    this.values.delete(id);
    this.dirty.delete(id);
  }

  clear(): void {
    this.values.clear();
    this.dirty.clear();
  }

  /** Write new values to ghosts that have a node (`nodeOf`); others keep theirs until they do. */
  apply(world: World, nodeOf: (id: number) => GameObject | null): void {
    for (const id of [...this.dirty]) {
      const node = nodeOf(id);
      if (!node?.isValid || node.world !== world) continue;
      this.dirty.delete(id);
      for (const e of this.values.get(id)?.values() ?? []) {
        const type = getComponentClass(e.component);
        if (!type) continue;
        const target = node.getBehaviors(type as abstract new () => Component)[e.index] as unknown as Record<string, unknown> | undefined;
        if (target && stringFields(type).includes(e.field)) target[e.field] = e.value;
      }
    }
  }
}
