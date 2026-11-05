/**
 * Lobbies (ADR 0068): options, snapshots and the wire format shared by the lobby server
 * (`server.ts`) and the lobby client (`client.ts`). Kept free of engine imports beyond the codec,
 * so `core/settings.ts` can validate a World's `lobby` config without pulling in netcode.
 *
 * ## Wire
 *
 * Two registered message kinds on the reliable channel (`wire.ts`): `lobby.c2s` from a lobby client
 * World to the lobby server World, and `lobby.s2c` back. Each body starts with a varuint op code;
 * strings are the codec's (UTF-8, varuint length), maps are a varuint count then key/value pairs.
 *
 * Client to server: `HELLO name`, `QUICK settings`, `CREATE name public settings`, `JOIN code`,
 * `LEAVE`, `READY bool`, `SET key value`, `KICK slot`, `START`.
 *
 * Server to client: `STATE` (the client's whole view: public rooms, its room, its slot; sent when it
 * changes), `ERROR reason` (a refused action), `MATCH id transport address path ticket
 * clientTemplate` (a match started: join it) and `MATCH_END id results`.
 */
import type { BitReader, BitWriter } from "../codec";

/** The lobby service's options: a server World's `"lobby"` config, or `Lobby.host(world, options)`. */
export interface LobbyOptions {
  /** The server template (ADR 0062) each match World is made from. Required. */
  matchTemplate: string;
  /** The client template players make their match client World from (sent to clients). */
  clientTemplate?: string;
  /** Room size. Default 8. */
  maxPlayers?: number;
  /** Members needed to start. Default 1. */
  minPlayers?: number;
  /** Empty slots up to `maxPlayers` are bots in the match. Default false. */
  fillWithBots?: boolean;
  /** Seconds between everyone being ready and the match starting. Default 3. */
  startCountdown?: number;
  /**
   * Room settings and their allowed values, e.g. `{ "arena": ["bay", "open", "maze"] }`: the first
   * value is the default. Or `{ "arena": { "choices": [...], "default": "open" } }`.
   */
  settings?: Readonly<Record<string, readonly string[] | { readonly choices: readonly string[]; readonly default?: string }>>;
  /** Seconds a quick-match room waits for more players before it starts on its own. Default 10. */
  quickMatchWait?: number;
  /** Seconds a match waits for its first player to connect before it ends. Default 30. */
  joinTimeout?: number;
}

/** `LobbyOptions` with every default filled in. */
export interface ResolvedLobbyOptions {
  readonly matchTemplate: string;
  readonly clientTemplate: string;
  readonly maxPlayers: number;
  readonly minPlayers: number;
  readonly fillWithBots: boolean;
  readonly startCountdown: number;
  /** Allowed values per setting; the default first. */
  readonly settings: Readonly<Record<string, readonly string[]>>;
  readonly quickMatchWait: number;
  readonly joinTimeout: number;
}

/** Where the client side of the lobby is (ADR 0068). */
export type LobbyState = "offline" | "connecting" | "lobby" | "room" | "starting" | "match";

/** A room's phase: waiting for players, counting down to start, or playing a match. */
export type LobbyRoomState = "waiting" | "countdown" | "playing";

/** A public room, as `Lobby.rooms` lists it. */
export interface LobbyRoomInfo {
  readonly code: string;
  readonly name: string;
  /** How many members it has. */
  readonly members: number;
  readonly maxPlayers: number;
  readonly state: LobbyRoomState;
  readonly settings: Readonly<Record<string, string>>;
}

/** A room member. */
export interface LobbyMember {
  readonly slot: number;
  readonly name: string;
  readonly ready: boolean;
  readonly host: boolean;
}

/** The room the player is in, as `Lobby.room` shows it. */
export interface LobbyRoom {
  readonly id: number;
  /** The 5-letter join code. */
  readonly code: string;
  readonly name: string;
  readonly public: boolean;
  /** Made by quick match: it starts on its own after `quickMatchWait`. */
  readonly quick: boolean;
  /** The host's slot. */
  readonly hostSlot: number;
  readonly maxPlayers: number;
  readonly minPlayers: number;
  readonly state: LobbyRoomState;
  /** Whole seconds left before the match starts, while `state` is `"countdown"`; else 0. */
  readonly countdown: number;
  readonly settings: Readonly<Record<string, string>>;
  /** Members by slot. */
  readonly members: readonly LobbyMember[];
  /** What the last match in this room passed to `Match.current.end(results)`, or null. */
  readonly results: Readonly<Record<string, string>> | null;
}

/** The player's place in their room, as `Lobby.me` shows it. */
export interface LobbyMe {
  readonly slot: number;
  readonly host: boolean;
  readonly name: string;
}

// --- options ------------------------------------------------------------------------------------

const OPTION_KEYS = ["matchTemplate", "clientTemplate", "maxPlayers", "minPlayers", "fillWithBots", "startCountdown", "settings", "quickMatchWait", "joinTimeout"];

/** Problems with a `lobby` config, as sentences starting with `where`. Empty if it's valid. */
export function lobbyOptionProblems(value: unknown, where = "lobby"): string[] {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${where} must be an object with at least matchTemplate.`];
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o)) if (!OPTION_KEYS.includes(key)) problems.push(`${where} has an unknown key "${key}" (known: ${OPTION_KEYS.join(", ")}).`);
  if (typeof o.matchTemplate !== "string" || o.matchTemplate.trim() === "") problems.push(`${where}.matchTemplate must name a server template.`);
  if (o.clientTemplate !== undefined && (typeof o.clientTemplate !== "string" || o.clientTemplate.trim() === "")) problems.push(`${where}.clientTemplate must name a client template.`);
  const int = (key: string, min: number, max: number) => {
    const v = o[key];
    if (v !== undefined && !(typeof v === "number" && Number.isInteger(v) && v >= min && v <= max)) problems.push(`${where}.${key} must be a whole number from ${min} to ${max}.`);
  };
  int("maxPlayers", 1, 64);
  int("minPlayers", 1, 64);
  if (typeof o.maxPlayers === "number" && typeof o.minPlayers === "number" && o.minPlayers > o.maxPlayers) problems.push(`${where}.minPlayers can't be more than maxPlayers.`);
  for (const key of ["startCountdown", "quickMatchWait", "joinTimeout"]) {
    const v = o[key];
    if (v !== undefined && !(typeof v === "number" && Number.isFinite(v) && v >= 0)) problems.push(`${where}.${key} must be a number of seconds, 0 or more.`);
  }
  if (o.fillWithBots !== undefined && typeof o.fillWithBots !== "boolean") problems.push(`${where}.fillWithBots must be true or false.`);
  if (o.settings !== undefined) {
    if (typeof o.settings !== "object" || o.settings === null || Array.isArray(o.settings)) problems.push(`${where}.settings must map setting names to lists of allowed values.`);
    else {
      for (const [key, spec] of Object.entries(o.settings)) {
        const choices = Array.isArray(spec) ? spec : typeof spec === "object" && spec !== null ? (spec as { choices?: unknown }).choices : undefined;
        if (!Array.isArray(choices) || choices.length === 0 || !choices.every((c) => typeof c === "string")) {
          problems.push(`${where}.settings.${key} must be a non-empty list of strings (or { choices, default }).`);
          continue;
        }
        const def = Array.isArray(spec) ? undefined : (spec as { default?: unknown }).default;
        if (def !== undefined && !(choices as unknown[]).includes(def)) problems.push(`${where}.settings.${key}.default must be one of its choices.`);
      }
    }
  }
  return problems;
}

/** Validate and fill in a lobby config. Throws, listing the problems, if it's invalid. */
export function resolveLobbyOptions(value: unknown): ResolvedLobbyOptions {
  const problems = lobbyOptionProblems(value);
  if (problems.length > 0) throw new Error(`Invalid lobby options:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  const o = value as LobbyOptions;
  const settings: Record<string, string[]> = {};
  for (const [key, spec] of Object.entries(o.settings ?? {})) {
    const choices = [...(Array.isArray(spec) ? (spec as readonly string[]) : (spec as { choices: readonly string[] }).choices)];
    const def = Array.isArray(spec) ? undefined : (spec as { default?: string }).default;
    settings[key] = def === undefined ? choices : [def, ...choices.filter((c) => c !== def)];
  }
  return {
    matchTemplate: o.matchTemplate,
    clientTemplate: o.clientTemplate ?? "",
    maxPlayers: o.maxPlayers ?? 8,
    minPlayers: Math.min(o.minPlayers ?? 1, o.maxPlayers ?? 8),
    fillWithBots: o.fillWithBots ?? false,
    startCountdown: o.startCountdown ?? 3,
    settings,
    quickMatchWait: o.quickMatchWait ?? 10,
    joinTimeout: o.joinTimeout ?? 30,
  };
}

// --- wire ---------------------------------------------------------------------------------------

/** Client-to-server op codes. */
export const C2S = { hello: 1, quick: 2, create: 3, join: 4, leave: 5, ready: 6, set: 7, kick: 8, start: 9 } as const;
/** Server-to-client op codes. */
export const S2C = { state: 1, error: 2, match: 3, matchEnd: 4 } as const;

const ROOM_STATES: readonly LobbyRoomState[] = ["waiting", "countdown", "playing"];

/** Longest player or room name, in characters. */
export const MAX_NAME_LENGTH = 32;

/** A name as the lobby keeps it: trimmed, control characters dropped, at most `MAX_NAME_LENGTH` characters; `fallback` if empty. */
export function cleanName(name: unknown, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const text = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  return [...text].slice(0, MAX_NAME_LENGTH).join("") || fallback;
}

export function writeMap(w: BitWriter, map: Readonly<Record<string, string>>): void {
  const entries = Object.entries(map);
  w.writeVarUint(entries.length);
  for (const [k, v] of entries) {
    w.writeString(k);
    w.writeString(v);
  }
}

export function readMap(r: BitReader): Record<string, string> {
  const n = r.readVarUint();
  if (n > 256) throw new RangeError("too many map entries");
  const out: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    const k = r.readString();
    out[k] = r.readString();
  }
  return out;
}

/** A client's whole view of the lobby (the `STATE` message). */
export interface LobbyView {
  readonly rooms: readonly LobbyRoomInfo[];
  readonly room: LobbyRoom | null;
  /** The player's slot in `room`, or -1. */
  readonly slot: number;
  /** The player's name, as the lobby has it. */
  readonly name: string;
}

export function writeView(w: BitWriter, view: LobbyView): void {
  w.writeVarUint(S2C.state);
  w.writeString(view.name);
  w.writeVarUint(view.rooms.length);
  for (const r of view.rooms) {
    w.writeString(r.code);
    w.writeString(r.name);
    w.writeVarUint(r.members);
    w.writeVarUint(r.maxPlayers);
    w.writeVarUint(ROOM_STATES.indexOf(r.state));
    writeMap(w, r.settings);
  }
  const room = view.room;
  w.writeBool(room !== null);
  if (!room) return;
  w.writeVarUint(view.slot);
  w.writeVarUint(room.id);
  w.writeString(room.code);
  w.writeString(room.name);
  w.writeBool(room.public);
  w.writeBool(room.quick);
  w.writeVarUint(room.hostSlot);
  w.writeVarUint(room.maxPlayers);
  w.writeVarUint(room.minPlayers);
  w.writeVarUint(ROOM_STATES.indexOf(room.state));
  w.writeVarUint(room.countdown);
  writeMap(w, room.settings);
  w.writeVarUint(room.members.length);
  for (const m of room.members) {
    w.writeVarUint(m.slot);
    w.writeString(m.name);
    w.writeBool(m.ready);
  }
  w.writeBool(room.results !== null);
  if (room.results) writeMap(w, room.results);
}

/** Read a `STATE` body (after its op code). */
export function readView(r: BitReader): LobbyView {
  const name = r.readString();
  const roomCount = r.readVarUint();
  if (roomCount > 100_000) throw new RangeError("too many rooms");
  const rooms: LobbyRoomInfo[] = [];
  for (let i = 0; i < roomCount; i++) {
    rooms.push({ code: r.readString(), name: r.readString(), members: r.readVarUint(), maxPlayers: r.readVarUint(), state: roomState(r.readVarUint()), settings: readMap(r) });
  }
  if (!r.readBool()) return { rooms, room: null, slot: -1, name };
  const slot = r.readVarUint();
  const id = r.readVarUint();
  const code = r.readString();
  const roomName = r.readString();
  const isPublic = r.readBool();
  const quick = r.readBool();
  const hostSlot = r.readVarUint();
  const maxPlayers = r.readVarUint();
  const minPlayers = r.readVarUint();
  const state = roomState(r.readVarUint());
  const countdown = r.readVarUint();
  const settings = readMap(r);
  const memberCount = r.readVarUint();
  if (memberCount > 64) throw new RangeError("too many members");
  const members: LobbyMember[] = [];
  for (let i = 0; i < memberCount; i++) {
    const s = r.readVarUint();
    members.push({ slot: s, name: r.readString(), ready: r.readBool(), host: s === hostSlot });
  }
  const results = r.readBool() ? readMap(r) : null;
  return { rooms, room: { id, code, name: roomName, public: isPublic, quick, hostSlot, maxPlayers, minPlayers, state, countdown, settings, members, results }, slot, name };
}

function roomState(i: number): LobbyRoomState {
  const s = ROOM_STATES[i];
  if (!s) throw new RangeError(`unknown room state ${i}`);
  return s;
}

/** A match to join (the `MATCH` message). */
export interface MatchTicket {
  readonly matchId: number;
  /** The transport the lobby (and so the match) listens over. */
  readonly transport: string;
  /** The match's address as the server knows it. */
  readonly address: string;
  /** Its path on the lobby's port (`/match/<id>`): clients joined to the lobby by URL resolve it against that. */
  readonly path: string;
  readonly ticket: string;
  readonly clientTemplate: string;
}

export function writeMatch(w: BitWriter, m: MatchTicket): void {
  w.writeVarUint(S2C.match);
  w.writeVarUint(m.matchId);
  w.writeString(m.transport);
  w.writeString(m.address);
  w.writeString(m.path);
  w.writeString(m.ticket);
  w.writeString(m.clientTemplate);
}

export function readMatch(r: BitReader): MatchTicket {
  return { matchId: r.readVarUint(), transport: r.readString(), address: r.readString(), path: r.readString(), ticket: r.readString(), clientTemplate: r.readString() };
}
