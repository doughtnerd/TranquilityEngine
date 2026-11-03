// Multiplayer play mode and network tools (ADR 0033 §9). Pure where it can be, so it's
// unit-tested; playMode.ts, session.ts and the Network panel use it.
//
// - Play bootstrap: Play can run N client Worlds (1–4) plus T thin clients (0–8) without editing
//   project.json. The project's bootstrap is the model: its first client World (one that connects
//   to a server World over a link, preferably tagged `client`) is duplicated as `Client 1…N` and
//   `Thin 1…T`, each with that World's links, in place of the project's client Worlds. Server
//   Worlds, other Worlds and templates stay as they are.
// - The Host pattern (Unity's frontend, like `samples/arena`): a bootstrap with no links whose
//   server World is a `server`-tagged template the game creates at runtime (a Host button). Play
//   creates that template as a World up front (named as the game would create it, so the game's
//   `Engine.findWorld` finds it) and copies the project's client World (its first `client`-tagged
//   World, else its first World) as `Client 1…N` and `Thin 1…T`, each linked to it over loopback.
//   By default the copies load the server template's scenes instead of their own (a menu), so they
//   join the game straight away; `clientScenes: "own"` keeps their own.
//   A project with neither layout (or a code bootstrap) plays as it is.
// - Thin clients are client Worlds that don't render or take local input. They load the server
//   with synthetic input on every input stream the game defines (`defineInput`): `"random"` walks
//   each f32 field in -1..1 (steps of up to ±0.25 per write), rounds i32 fields of the same walk
//   (-1, 0 or 1), and presses u8 fields (1) one write in ten; `"zeros"` repeats zeros. A game with
//   no inputs gets none: its thin clients still connect, receive snapshots and ping.
// - Conditions: latency, jitter and loss on every loopback link of the playing Engine, both ways.
// - Stats: per-connection byte rates (overall and per kind of message) from the session counters.
import type { BootstrapConfig, BootstrapSetting, Engine, LinkConfig, WorldConfig } from "../engine";
import { inputStreams, setNetConditions, writeWorldInput, type NetPeerInfo, type NetTrafficInfo, type NetWorldInfo } from "../engine/editor";
import { uniqueName } from "./worldsConfig";

export const MAX_CLIENTS = 4;
export const MAX_THIN_CLIENTS = 8;

export type ThinInputMode = "random" | "zeros";

/** Host pattern: which scenes the client copies load: the server template's (join the game directly), or their own (a menu). */
export type ClientScenes = "server" | "own";

export interface NetPlayOptions {
  /** Client Worlds that render and take input, 1–4. */
  clients: number;
  /** Thin clients, 0–8. */
  thin: number;
  /** Host pattern only: the scenes the client copies load. Default `"server"`. */
  clientScenes?: ClientScenes;
}

/** A play-time bootstrap made from the project's, and the Worlds it made. */
export interface NetPlayBootstrap {
  bootstrap: BootstrapConfig;
  /** The rendering client Worlds, in order. */
  clients: string[];
  /** The thin clients, in order. */
  thin: string[];
  /** The project World the clients copy. */
  template: string;
  /** How the clients reach a server: the project's links, or (Host pattern) a server template Play created as a World. */
  pattern: "links" | "host";
  /** Host pattern: the server World Play created from the template; null for `links`. */
  server: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number.isFinite(n) ? n : lo)));

/**
 * The project's client World that multiplayer play copies, and every World it replaces: Worlds
 * that connect to another over a link and don't listen themselves. Null without such a layout.
 */
export function clientLayout(setting: BootstrapSetting | undefined): { template: WorldConfig; replaced: Set<string> } | null {
  if (!isRecord(setting) || !Array.isArray(setting.worlds) || !Array.isArray(setting.links) || setting.links.length === 0) return null;
  const config = setting as BootstrapConfig;
  const names = new Set(config.worlds.map((w) => w.name));
  const listening = new Set(config.links!.map((l) => l.to));
  const replaced = new Set(config.links!.filter((l) => names.has(l.from) && names.has(l.to) && !listening.has(l.from)).map((l) => l.from));
  const candidates = config.worlds.filter((w) => replaced.has(w.name));
  const template = candidates.find((w) => (w.tags ?? []).includes("client")) ?? candidates[0];
  return template ? { template, replaced } : null;
}

/**
 * The bootstrap Play uses for `options` (see the top of this file), or null when the project has
 * no client/server layout and plays as it is. Counts are clamped to 1–4 and 0–8.
 */
export function playBootstrap(setting: BootstrapSetting | undefined, options: NetPlayOptions): NetPlayBootstrap | null {
  const layout = clientLayout(setting);
  if (!layout) return hostBootstrap(setting, options);
  const config = setting as BootstrapConfig;
  const { template, replaced } = layout;
  const kept = config.worlds.filter((w) => !replaced.has(w.name));
  const taken = kept.map((w) => w.name);
  const name = (base: string) => {
    const n = uniqueName(base, taken);
    taken.push(n);
    return n;
  };
  const clients = Array.from({ length: clamp(options.clients, 1, MAX_CLIENTS) }, (_, i) => name(`Client ${i + 1}`));
  const thin = Array.from({ length: clamp(options.thin, 0, MAX_THIN_CLIENTS) }, (_, i) => name(`Thin ${i + 1}`));
  const made: WorldConfig[] = [
    ...clients.map((n) => ({ ...template, name: n })),
    ...thin.map((n) => ({ ...template, name: n, renders: false, input: false })),
  ];
  // The new Worlds go where the project's first client World was, so the World order (and the
  // default World, the first) stays the project's.
  const at = config.worlds.findIndex((w) => replaced.has(w.name));
  const before = config.worlds.slice(0, at).filter((w) => !replaced.has(w.name));
  const after = config.worlds.slice(at).filter((w) => !replaced.has(w.name));
  const links: LinkConfig[] = [
    ...config.links!.filter((l) => !replaced.has(l.from)),
    ...made.flatMap((w) => config.links!.filter((l) => l.from === template.name).map((l) => ({ ...l, from: w.name }))),
  ];
  return {
    bootstrap: { ...config, worlds: [...before, ...made, ...after], links },
    clients,
    thin,
    template: template.name,
    pattern: "links",
    server: null,
  };
}

/**
 * The Host pattern's layout (see the top of this file): the client World Play copies and the
 * server template it creates, or null when the bootstrap isn't laid out that way (it has links,
 * a server World of its own, or no `server`-tagged template).
 */
export function hostLayout(setting: BootstrapSetting | undefined): { client: WorldConfig; server: WorldConfig; templateKey: string } | null {
  if (!isRecord(setting) || !Array.isArray(setting.worlds)) return null;
  const config = setting as BootstrapConfig;
  if (Array.isArray(config.links) && config.links.length > 0) return null;
  const isServer = (w: { tags?: readonly string[] }) => (w.tags ?? []).includes("server");
  if (config.worlds.some(isServer)) return null;
  const entry = isRecord(config.templates) ? Object.entries(config.templates).find(([, t]) => isRecord(t) && isServer(t)) : undefined;
  const client = config.worlds.find((w) => (w.tags ?? []).includes("client")) ?? config.worlds[0];
  if (!entry || !client) return null;
  const [templateKey, template] = entry;
  return { client, server: { ...template, name: template.name ?? templateKey }, templateKey };
}

/** The Host pattern's play bootstrap, or null without that layout. */
function hostBootstrap(setting: BootstrapSetting | undefined, options: NetPlayOptions): NetPlayBootstrap | null {
  const layout = hostLayout(setting);
  if (!layout) return null;
  const config = setting as BootstrapConfig;
  const { client, server } = layout;
  const kept = config.worlds.filter((w) => w !== client);
  const taken = [...kept.map((w) => w.name), server.name];
  const name = (base: string) => {
    const n = uniqueName(base, taken);
    taken.push(n);
    return n;
  };
  const clients = Array.from({ length: clamp(options.clients, 1, MAX_CLIENTS) }, (_, i) => name(`Client ${i + 1}`));
  const thin = Array.from({ length: clamp(options.thin, 0, MAX_THIN_CLIENTS) }, (_, i) => name(`Thin ${i + 1}`));
  // Join directly: the copies load what the server loads (when its template names scenes).
  const scenes = (options.clientScenes ?? "server") === "server" && server.scenes !== undefined ? { scenes: [...server.scenes] } : {};
  const made: WorldConfig[] = [
    ...clients.map((n) => ({ ...client, ...scenes, name: n })),
    ...thin.map((n) => ({ ...client, ...scenes, name: n, renders: false, input: false })),
  ];
  const at = config.worlds.indexOf(client);
  const links: LinkConfig[] = made.map((w) => ({ from: w.name, to: server.name, transport: "loopback" }));
  return {
    // The server goes last, as when the game creates it after its client World.
    bootstrap: { ...config, worlds: [...kept.slice(0, at), ...made, ...kept.slice(at), server], links },
    clients,
    thin,
    template: client.name,
    pattern: "host",
    server: server.name,
  };
}

// --- thin clients' input ------------------------------------------------------------------------

/** Writes thin clients' synthetic input (see the top of this file); call `update` about once a frame. */
export interface ThinInput {
  update(): void;
}

export function createThinInput(engine: Engine, worlds: readonly string[], mode: ThinInputMode, random: () => number = Math.random): ThinInput {
  /** Random-walk positions by World, stream and field. */
  const walk = new Map<string, number>();
  return {
    update() {
      const streams = inputStreams();
      for (const world of worlds) {
        for (const stream of streams) {
          const values: Record<string, number> = {};
          for (const f of stream.fields) {
            if (mode === "zeros") {
              values[f.name] = 0;
              continue;
            }
            if (f.kind === "u8") {
              values[f.name] = random() < 0.1 ? 1 : 0;
              continue;
            }
            const key = `${world}|${stream.id}|${f.name}`;
            const v = Math.min(1, Math.max(-1, (walk.get(key) ?? 0) + (random() * 2 - 1) * 0.25));
            walk.set(key, v);
            values[f.name] = f.kind === "i32" ? Math.round(v) : v;
          }
          writeWorldInput(engine, world, stream.id, values);
        }
      }
    },
  };
}

// --- conditions ---------------------------------------------------------------------------------

/** The sliders' values. Loss is a percentage here; the transport takes a fraction. */
export interface NetConditionValues {
  latencyMs: number;
  jitterMs: number;
  lossPercent: number;
}

export const CONDITION_LIMITS: Readonly<NetConditionValues> = { latencyMs: 500, jitterMs: 100, lossPercent: 30 };

export const NO_CONDITIONS: Readonly<NetConditionValues> = { latencyMs: 0, jitterMs: 0, lossPercent: 0 };

/** Values in range (anything unreadable is 0). */
export function clampConditions(c: Partial<NetConditionValues>): NetConditionValues {
  const one = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : 0);
  return { latencyMs: one(c.latencyMs, CONDITION_LIMITS.latencyMs), jitterMs: one(c.jitterMs, CONDITION_LIMITS.jitterMs), lossPercent: one(c.lossPercent, CONDITION_LIMITS.lossPercent) };
}

export const conditionsOff = (c: NetConditionValues) => c.latencyMs === 0 && c.jitterMs === 0 && c.lossPercent === 0;

/** The slider values as a transport's link conditions (loss as a fraction). */
export function linkConditions(c: NetConditionValues): { latencyMs: number; jitterMs: number; loss: number } {
  const v = clampConditions(c);
  return { latencyMs: v.latencyMs, jitterMs: v.jitterMs, loss: v.lossPercent / 100 };
}

/** Simulate `c` on every loopback link of `engine`, both ways. Returns how many transports took it. */
export function applyNetConditions(engine: Engine, c: NetConditionValues): number {
  return setNetConditions(engine, linkConditions(c));
}

/**
 * `bootstrap` with `c` in every loopback link's options, so the links simulate it from their first
 * message (the handshake and tick sync included); null or a code bootstrap: as it is.
 */
export function withConditions(bootstrap: BootstrapSetting | undefined, c: NetConditionValues | null): BootstrapSetting | undefined {
  if (!c || !isRecord(bootstrap) || !Array.isArray(bootstrap.links)) return bootstrap;
  const config = bootstrap as BootstrapConfig;
  return { ...config, links: config.links!.map((l) => (l.transport === "loopback" ? { ...l, options: { ...l.options, ...linkConditions(c) } } : l)) };
}

// --- stats --------------------------------------------------------------------------------------

/** What the panel groups message kinds into. */
export type TrafficCategory = "snapshots" | "acks" | "inputs" | "RPCs" | "pings" | "handshake" | "other";

export const TRAFFIC_CATEGORIES: readonly TrafficCategory[] = ["snapshots", "acks", "inputs", "RPCs", "pings", "handshake", "other"];

export function trafficCategory(kind: string): TrafficCategory {
  if (kind === "net.snapshot") return "snapshots";
  if (kind === "net.snapshotAck") return "acks";
  if (kind.startsWith("net.input:")) return "inputs";
  if (kind === "net.rpc") return "RPCs";
  if (kind === "net.ping" || kind === "net.pong") return "pings";
  if (kind === "net.hello" || kind === "net.welcome") return "handshake";
  return "other";
}

/** Bytes by category. */
export function byCategory(traffic: NetTrafficInfo): Record<TrafficCategory, { bytes: number; messages: number }> {
  const out = Object.fromEntries(TRAFFIC_CATEGORIES.map((c) => [c, { bytes: 0, messages: 0 }])) as Record<TrafficCategory, { bytes: number; messages: number }>;
  for (const [kind, v] of Object.entries(traffic.byKind)) {
    const c = out[trafficCategory(kind)];
    c.bytes += v.bytes;
    c.messages += v.messages;
  }
  return out;
}

/** One direction's rate: bytes per second, overall and per category. */
export interface TrafficRate {
  bytesPerSecond: number;
  messagesPerSecond: number;
  byCategory: Record<TrafficCategory, number>;
}

/** One ghost type's share of a connection's snapshots (server side). */
export interface GhostTypeRate {
  readonly type: string;
  /** Bytes per second over the rate window. */
  readonly bytesPerSecond: number;
  /** Bytes since the connection opened. */
  readonly bytes: number;
}

export interface PeerStats extends NetPeerInfo {
  /** Identifies the connection across samples. */
  readonly key: string;
  readonly in: TrafficRate;
  readonly out: TrafficRate;
  /** Server: bandwidth per ghost type, highest rate first. Empty on a client. */
  readonly ghostTypeRates: readonly GhostTypeRate[];
}

export interface WorldStats extends Omit<NetWorldInfo, "peers"> {
  readonly peers: readonly PeerStats[];
}

/** Rates are averaged over about this long. */
const RATE_WINDOW_MS = 1000;

/**
 * Turns `netWorldInfo` snapshots into rates: each connection's counters are kept for about a
 * second, and its rate is the difference over that window.
 */
export class NetStatsSampler {
  private readonly history = new Map<string, { at: number; sent: NetTrafficInfo; received: NetTrafficInfo; ghostTypes: NetPeerInfo["ghostTypes"] }[]>();

  sample(worlds: readonly NetWorldInfo[], now: number): WorldStats[] {
    const seen = new Set<string>();
    const out = worlds.map((w) => ({
      ...w,
      peers: w.peers.map((p): PeerStats => {
        // A connection is its World, its id and its transport address (ids are 0 until the handshake).
        const key = `${w.world}|${p.id}|${p.remote}`;
        seen.add(key);
        const list = this.history.get(key) ?? [];
        list.push({ at: now, sent: p.sent, received: p.received, ghostTypes: p.ghostTypes ?? [] });
        while (list.length > 2 && now - list[1].at >= RATE_WINDOW_MS) list.shift();
        this.history.set(key, list);
        const first = list[0];
        return {
          ...p,
          key,
          in: rate(first.received, p.received, now - first.at),
          out: rate(first.sent, p.sent, now - first.at),
          ghostTypeRates: ghostTypeRates(first.ghostTypes, p.ghostTypes ?? [], now - first.at),
        };
      }),
    }));
    for (const key of [...this.history.keys()]) if (!seen.has(key)) this.history.delete(key);
    return out;
  }
}

function rate(from: NetTrafficInfo, to: NetTrafficInfo, ms: number): TrafficRate {
  const per = (n: number) => (ms > 0 ? (n * 1000) / ms : 0);
  const a = byCategory(from), b = byCategory(to);
  return {
    bytesPerSecond: per(to.bytes - from.bytes),
    messagesPerSecond: per(to.messages - from.messages),
    byCategory: Object.fromEntries(TRAFFIC_CATEGORIES.map((c) => [c, per(b[c].bytes - a[c].bytes)])) as Record<TrafficCategory, number>,
  };
}

/** Per ghost type: the bytes between two samples as a rate, plus the total; highest rate first (then most bytes). */
export function ghostTypeRates(from: NetPeerInfo["ghostTypes"], to: NetPeerInfo["ghostTypes"], ms: number): GhostTypeRate[] {
  const before = new Map(from.map((t) => [t.type, t.bytes]));
  return to
    .map((t) => ({ type: t.type, bytes: t.bytes, bytesPerSecond: ms > 0 ? ((t.bytes - (before.get(t.type) ?? 0)) * 1000) / ms : 0 }))
    .sort((a, b) => b.bytesPerSecond - a.bytesPerSecond || b.bytes - a.bytes || a.type.localeCompare(b.type));
}

/** A ghost type as the panel shows it: the file's name without folders or `.prefab.json`/`.scene.json`, then any node path. */
export function ghostTypeLabel(type: string): string {
  return type.replace(/[^#›]*?([^/#›]+?)(\.(prefab|scene))?\.json/, "$1");
}

/** `1234` → `"1.2 KB"`. */
export function formatBytes(n: number): string {
  if (n < 1000) return `${Math.round(n)} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} KB`;
  return `${(n / 1_000_000).toFixed(2)} MB`;
}
