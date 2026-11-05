/**
 * The lobby service (ADR 0068): a server World that keeps rooms, readies them up and starts a
 * match World per game. Turned on by a World config's `"lobby"` (`engine.LobbyServer` hosts it on
 * the World's first frame) or `Lobby.host(world, options)`.
 *
 * Every lobby client World that connects says hello with its player's name; from then on it gets
 * its whole view (public rooms, its room, its slot) whenever that changes, and sends actions,
 * which the server applies or refuses with a reason (`protocol.ts`).
 *
 * Rooms: members ready up; when every member is ready (and there are at least `minPlayers`), the
 * room counts down `startCountdown` seconds and starts, unless someone unreadies, leaves or joins
 * meanwhile. The host can start at once once `minPlayers` is met. Quick-match rooms also start their
 * first match on their own `quickMatchWait` seconds after they were made; once it ends they're
 * ordinary rooms, so players coming back from a match stay in the room until they start again.
 *
 * Starting: a World from `matchTemplate`, named `Match <id>`, made a match World (`match.ts`) and
 * told to listen over the lobby's own transport at `/match/<id>` (on the lobby's port, ADR 0067);
 * each member then gets the address, a one-time ticket and `clientTemplate`. When the match ends,
 * the lobby destroys its World, sends the members its results and readies the room for another.
 */
import { templateConfig } from "../../core/bootstrap";
import type { World } from "../../core/World";
import type { WorldHandle } from "../../core/worlds";
import { createBitWriter, type BitReader } from "../codec";
import { netSession, type NetPeer, type NetSession } from "../session";
import { MatchState, _setMatch } from "./match";
import { C2S, S2C, cleanName, readMap, resolveLobbyOptions, writeMap, writeMatch, writeView, type LobbyOptions, type LobbyRoom, type LobbyRoomInfo, type LobbyRoomState, type ResolvedLobbyOptions } from "./protocol";
import { LOBBY_C2S, LOBBY_S2C, declaredBootstrap, engineOf, randomHex, type LobbyEngine } from "./wire";

const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

interface Client {
  readonly peer: NetPeer;
  name: string;
  /** Said hello: it gets state from now on. */
  hello: boolean;
  room: Room | null;
  slot: number;
  /** The last view sent, encoded, to send only changes. */
  lastSent: string;
}

interface Member {
  readonly client: Client;
  ready: boolean;
}

interface RunningMatch {
  readonly id: number;
  readonly handle: WorldHandle;
  readonly state: MatchState;
  /** Who was sent a ticket. */
  readonly clients: Set<Client>;
}

interface Room {
  readonly id: number;
  readonly code: string;
  name: string;
  readonly public: boolean;
  /** Starts on its own after `quickMatchWait`; cleared when its first match ends. */
  quick: boolean;
  readonly createdAt: number;
  settings: Record<string, string>;
  /** Members by slot; null for an empty slot. */
  readonly slots: (Member | null)[];
  hostSlot: number;
  state: LobbyRoomState;
  countdownEndsAt: number;
  match: RunningMatch | null;
  results: Record<string, string> | null;
}

/** @internal A lobby server World's state. */
export class LobbyServer {
  readonly options: ResolvedLobbyOptions;
  private readonly clients = new Map<NetPeer, Client>();
  private readonly rooms = new Map<number, Room>();
  private nextRoomId = 1;
  private nextMatchId = 1;
  private session: NetSession | null = null;
  /** Something changed since views were last sent. */
  private dirty = true;

  constructor(
    readonly world: World,
    options: LobbyOptions,
  ) {
    this.options = resolveLobbyOptions(options);
  }

  /** @internal Tests and tools: live rooms. */
  get roomCount(): number {
    return this.rooms.size;
  }

  private now(): number {
    return this.world.time.realtimeSinceStartup;
  }

  /** `engine.LobbyServer`: messages, room timers, ended matches, then views. */
  update(): void {
    const session = netSession(this.world);
    if (!session?.isServer) return; // not listening yet
    this.session = session;
    const open = new Set(session.openPeers());
    for (const [peer, client] of this.clients) {
      if (open.has(peer)) continue;
      this.clients.delete(peer);
      this.leaveRoom(client);
    }
    for (const m of session.drain(LOBBY_C2S)) {
      if (!open.has(m.peer)) continue;
      let client = this.clients.get(m.peer);
      if (!client) this.clients.set(m.peer, (client = { peer: m.peer, name: "Player", hello: false, room: null, slot: -1, lastSent: "" }));
      try {
        this.handle(client, m.reader());
      } catch (err) {
        this.refuse(client, `The lobby couldn't read that request: ${(err as Error).message}`);
      }
    }
    const now = this.now();
    for (const room of [...this.rooms.values()]) this.tick(room, now);
    this.sendViews(now);
  }

  // --- requests ---------------------------------------------------------------------------------

  private handle(client: Client, r: BitReader): void {
    const op = r.readVarUint();
    if (op === C2S.hello) {
      client.name = cleanName(r.readString(), "Player");
      client.hello = true;
      this.dirty = true;
      return;
    }
    if (!client.hello) return this.refuse(client, "Say hello first.");
    switch (op) {
      case C2S.quick:
        return this.quickMatch(client, readMap(r));
      case C2S.create: {
        const name = r.readString();
        const isPublic = r.readBool();
        const settings = readMap(r);
        return this.createRoom(client, name, isPublic, settings, false);
      }
      case C2S.join:
        return this.joinCode(client, r.readString());
      case C2S.leave:
        if (!client.room) return this.refuse(client, "You aren't in a room.");
        return this.leaveRoom(client);
      case C2S.ready:
        return this.setReady(client, r.readBool());
      case C2S.set:
        return this.setSetting(client, r.readString(), r.readString());
      case C2S.kick:
        return this.kick(client, r.readVarUint());
      case C2S.start:
        return this.hostStart(client);
      default:
        return this.refuse(client, `Unknown lobby request ${op}.`);
    }
  }

  private refuse(client: Client, reason: string): void {
    this.sendTo(client, (w) => {
      w.writeVarUint(S2C.error);
      w.writeString(reason);
    });
  }

  private sendTo(client: Client, write: (w: ReturnType<typeof createBitWriter>) => void): void {
    if (!this.session || client.peer.state !== "open") return;
    const w = createBitWriter();
    write(w);
    this.session.send(LOBBY_S2C, client.peer, "reliable", w.finish());
  }

  /** `requested` checked against the allowed settings, over the defaults (or `base`). Throws a reason. */
  private settingsFrom(requested: Readonly<Record<string, string>>, base?: Readonly<Record<string, string>>): Record<string, string> {
    const allowed = this.options.settings;
    const out: Record<string, string> = {};
    for (const [key, choices] of Object.entries(allowed)) out[key] = base?.[key] ?? choices[0];
    for (const [key, value] of Object.entries(requested)) {
      const choices = allowed[key];
      if (!choices) throw new Error(`There's no room setting "${key}"${Object.keys(allowed).length ? ` (settings: ${Object.keys(allowed).join(", ")})` : ""}.`);
      if (!choices.includes(value)) throw new Error(`"${value}" isn't allowed for "${key}" (choose ${choices.join(", ")}).`);
      out[key] = value;
    }
    return out;
  }

  private quickMatch(client: Client, wanted: Record<string, string>): void {
    let settings: Record<string, string>;
    try {
      settings = this.settingsFrom(wanted);
    } catch (err) {
      return this.refuse(client, (err as Error).message);
    }
    if (client.room) this.leaveRoom(client);
    // The fullest public room that's waiting, has room and matches the settings asked for.
    let best: Room | null = null;
    for (const room of this.rooms.values()) {
      if (!room.public || room.state !== "waiting" || members(room).length >= this.options.maxPlayers) continue;
      if (Object.entries(wanted).some(([k, v]) => room.settings[k] !== v)) continue;
      if (!best || members(room).length > members(best).length) best = room;
    }
    if (best) this.join(client, best);
    else this.createRoom(client, "Quick match", true, settings, true);
  }

  private createRoom(client: Client, name: string, isPublic: boolean, requested: Record<string, string>, quick: boolean): void {
    let settings: Record<string, string>;
    try {
      settings = this.settingsFrom(requested);
    } catch (err) {
      return this.refuse(client, (err as Error).message);
    }
    if (client.room) this.leaveRoom(client);
    const room: Room = {
      id: this.nextRoomId++,
      code: this.newCode(),
      name: cleanName(name, `${client.name}'s room`),
      public: isPublic,
      quick,
      createdAt: this.now(),
      settings,
      slots: new Array<Member | null>(this.options.maxPlayers).fill(null),
      hostSlot: 0,
      state: "waiting",
      countdownEndsAt: 0,
      match: null,
      results: null,
    };
    this.rooms.set(room.id, room);
    this.join(client, room);
  }

  private newCode(): string {
    const taken = new Set([...this.rooms.values()].map((r) => r.code));
    for (;;) {
      const bytes = new Uint8Array(5);
      globalThis.crypto.getRandomValues(bytes);
      const code = [...bytes].map((b) => CODE_LETTERS[b % CODE_LETTERS.length]).join("");
      if (!taken.has(code)) return code;
    }
  }

  private joinCode(client: Client, code: string): void {
    const wanted = code.trim().toUpperCase();
    const room = [...this.rooms.values()].find((r) => r.code === wanted);
    if (!room) return this.refuse(client, `There's no room with the code "${code}".`);
    if (client.room === room) return;
    if (room.state === "playing") return this.refuse(client, `Room ${room.code} is playing a match; join it when the match is over.`);
    if (members(room).length >= this.options.maxPlayers) return this.refuse(client, `Room ${room.code} is full (${this.options.maxPlayers} players).`);
    if (client.room) this.leaveRoom(client);
    this.join(client, room);
  }

  private join(client: Client, room: Room): void {
    const slot = room.slots.indexOf(null);
    if (slot < 0) return this.refuse(client, `Room ${room.code} is full.`);
    room.slots[slot] = { client, ready: false };
    if (members(room).length === 1) room.hostSlot = slot;
    client.room = room;
    client.slot = slot;
    this.dirty = true;
  }

  private leaveRoom(client: Client): void {
    const room = client.room;
    client.room = null;
    client.slot = -1;
    if (!room) return;
    const slot = room.slots.findIndex((m) => m?.client === client);
    if (slot >= 0) room.slots[slot] = null;
    const left = members(room);
    if (left.length === 0 && !room.match) this.rooms.delete(room.id);
    else if (room.hostSlot === slot && left.length > 0) room.hostSlot = room.slots.findIndex((m) => m !== null); // the host passes on
    this.dirty = true;
  }

  private member(client: Client): { room: Room; member: Member } | null {
    const room = client.room;
    const member = room?.slots[client.slot];
    return room && member && member.client === client ? { room, member } : null;
  }

  private setReady(client: Client, ready: boolean): void {
    const m = this.member(client);
    if (!m) return this.refuse(client, "You aren't in a room.");
    if (m.member.ready === ready) return;
    m.member.ready = ready;
    this.dirty = true;
  }

  private hostOnly(client: Client, what: string): Room | null {
    const m = this.member(client);
    if (!m) {
      this.refuse(client, "You aren't in a room.");
      return null;
    }
    if (m.room.hostSlot !== client.slot) {
      this.refuse(client, `Only the room's host can ${what}.`);
      return null;
    }
    return m.room;
  }

  private setSetting(client: Client, key: string, value: string): void {
    const room = this.hostOnly(client, "change its settings");
    if (!room) return;
    if (room.state === "playing") return this.refuse(client, "The room's settings can't change during a match.");
    try {
      room.settings = this.settingsFrom({ [key]: value }, room.settings);
    } catch (err) {
      return this.refuse(client, (err as Error).message);
    }
    this.dirty = true;
  }

  private kick(client: Client, slot: number): void {
    const room = this.hostOnly(client, "kick members");
    if (!room) return;
    const target = room.slots[slot];
    if (!target) return this.refuse(client, `There's nobody in slot ${slot}.`);
    if (target.client === client) return this.refuse(client, "You can't kick yourself; leave the room instead.");
    this.leaveRoom(target.client);
    this.refuse(target.client, `You were kicked from room ${room.code}.`);
  }

  private hostStart(client: Client): void {
    const room = this.hostOnly(client, "start the match");
    if (!room) return;
    if (room.state === "playing") return this.refuse(client, "The room is already playing.");
    const n = members(room).length;
    if (n < this.options.minPlayers) return this.refuse(client, `The room needs at least ${this.options.minPlayers} players to start (it has ${n}).`);
    this.start(room);
  }

  // --- room timers and matches ------------------------------------------------------------------

  private tick(room: Room, now: number): void {
    if (room.state === "playing") {
      const match = room.match!;
      if (match.state.ended || !match.handle.alive) this.endMatch(room, match);
      return;
    }
    const list = members(room);
    if (list.length === 0) {
      this.rooms.delete(room.id);
      this.dirty = true;
      return;
    }
    const ready = list.length >= this.options.minPlayers && list.every((m) => m.ready);
    if (room.state === "countdown") {
      if (!ready) {
        room.state = "waiting";
        this.dirty = true;
      } else if (now >= room.countdownEndsAt) this.start(room);
      return;
    }
    if (ready) {
      room.state = "countdown";
      room.countdownEndsAt = now + this.options.startCountdown;
      this.dirty = true;
      if (this.options.startCountdown <= 0) this.start(room);
    } else if (room.quick && now - room.createdAt >= this.options.quickMatchWait && (this.options.fillWithBots || list.length >= this.options.minPlayers)) {
      this.start(room);
    }
  }

  private start(room: Room): void {
    const engine = engineOf(this.world);
    if (!engine) return this.failStart(room, `The lobby World "${this.world.name}" doesn't belong to an Engine, so it can't create match Worlds.`);
    const listener = netSession(this.world)?.listening()[0];
    if (!listener) return this.failStart(room, `The lobby World "${this.world.name}" isn't listening.`);
    const id = this.nextMatchId++;
    const name = uniqueName(engine, `Match ${id}`);
    let handle: WorldHandle;
    try {
      const template = templateConfig(declaredBootstrap(engine) as never, this.options.matchTemplate);
      handle = engine.createWorld({ ...template, name });
    } catch (err) {
      return this.failStart(room, `The match World couldn't be created from template "${this.options.matchTemplate}": ${(err as Error).message}`);
    }
    const world = engine._world(name)!;
    const humans = room.slots.flatMap((m, slot) => (m ? [{ slot, client: m.client }] : []));
    const tickets = new Map(humans.map((h) => [h.client, randomHex(16)]));
    const players: { slot: number; name: string; bot: boolean; ticket: string }[] = [];
    for (let slot = 0; slot < this.options.maxPlayers; slot++) {
      const m = room.slots[slot];
      if (m) players.push({ slot, name: m.client.name, bot: false, ticket: tickets.get(m.client)! });
      else if (this.options.fillWithBots) players.push({ slot, name: "", bot: true, ticket: "" });
    }
    const lobby = this.world;
    const lobbyHandle = engine.findWorld(lobby.name);
    const state = new MatchState(world, id, room.id, { ...room.settings }, players, this.options.joinTimeout, () => !!lobbyHandle?.alive, () => handle.alive && handle.destroy());
    _setMatch(world, state);
    const match: RunningMatch = { id, handle, state, clients: new Set(humans.map((h) => h.client)) };
    room.match = match;
    room.state = "playing";
    for (const m of room.slots) if (m) m.ready = false;
    this.dirty = true;

    const path = `/match/${id}`;
    handle
      .listen(listener.transport, matchListenOptions(listener, path))
      .then((address) => {
        if (room.match !== match || !handle.alive) return;
        for (const client of match.clients) {
          if (client.room !== room) continue;
          this.sendTo(client, (w) => writeMatch(w, { matchId: id, transport: listener.transport, address, path, ticket: tickets.get(client)!, clientTemplate: this.options.clientTemplate }));
        }
      })
      .catch((err: Error) => {
        if (room.match !== match) return;
        console.error(`[myco] Lobby "${lobby.name}": match World "${name}" couldn't listen: ${err.message}`);
        state.endReason = `The match couldn't start: ${err.message}`;
        state.end();
      });
  }

  private failStart(room: Room, reason: string): void {
    console.error(`[myco] Lobby "${this.world.name}": ${reason}`);
    room.state = "waiting";
    for (const m of room.slots) if (m) m.ready = false;
    for (const m of members(room)) this.refuse(m.client, reason);
    this.dirty = true;
  }

  private endMatch(room: Room, match: RunningMatch): void {
    room.match = null;
    room.state = "waiting";
    // Players come back to the room after a match (ADR 0068): a quick room's own timer would start
    // another at once, so from here on it starts like any room (ready-up, or the host).
    room.quick = false;
    room.results = { ...match.state.results };
    if (match.state.endReason && Object.keys(room.results).length === 0) room.results = { reason: match.state.endReason };
    if (match.handle.alive) match.handle.destroy();
    for (const client of match.clients) {
      if (client.room !== room) continue;
      this.sendTo(client, (w) => {
        w.writeVarUint(S2C.matchEnd);
        w.writeVarUint(match.id);
        writeMap(w, room.results ?? {});
      });
    }
    if (members(room).length === 0) this.rooms.delete(room.id);
    this.dirty = true;
  }

  // --- views ------------------------------------------------------------------------------------

  private roomView(room: Room, now: number): LobbyRoom {
    return {
      id: room.id,
      code: room.code,
      name: room.name,
      public: room.public,
      quick: room.quick,
      hostSlot: room.hostSlot,
      maxPlayers: this.options.maxPlayers,
      minPlayers: this.options.minPlayers,
      state: room.state,
      countdown: room.state === "countdown" ? Math.max(0, Math.ceil(room.countdownEndsAt - now)) : 0,
      settings: room.settings,
      members: room.slots.flatMap((m, slot) => (m ? [{ slot, name: m.client.name, ready: m.ready, host: slot === room.hostSlot }] : [])),
      results: room.results,
    };
  }

  /** Send each client its view if it changed. Only re-encoded when something changed, or a countdown is running. */
  private sendViews(now: number): void {
    const counting = [...this.rooms.values()].some((r) => r.state === "countdown");
    if (!this.dirty && !counting) return;
    this.dirty = false;
    const rooms: LobbyRoomInfo[] = [...this.rooms.values()]
      .filter((r) => r.public)
      .map((r) => ({ code: r.code, name: r.name, members: members(r).length, maxPlayers: this.options.maxPlayers, state: r.state, settings: r.settings }));
    const views = new Map<Room, LobbyRoom>();
    for (const client of this.clients.values()) {
      if (!client.hello) continue;
      const room = client.room;
      let view: LobbyRoom | null = null;
      if (room) {
        view = views.get(room) ?? this.roomView(room, now);
        views.set(room, view);
      }
      const w = createBitWriter();
      writeView(w, { rooms, room: view, slot: client.slot, name: client.name });
      const bytes = w.finish();
      const key = bytes.join(",");
      if (key === client.lastSent) continue;
      client.lastSent = key;
      this.session?.send(LOBBY_S2C, client.peer, "reliable", bytes);
    }
  }
}

function members(room: Room): Member[] {
  return room.slots.filter((m): m is Member => m !== null);
}

/** `base`, or `base (2)`, `base (3)`… if a World of that name exists. */
function uniqueName(engine: LobbyEngine, base: string): string {
  let name = base;
  for (let i = 2; engine._world(name); i++) name = `${base} (${i})`;
  return name;
}

/**
 * Where a match listens: the lobby's own transport and port, at `path` (ADR 0067). Over WebSocket,
 * the lobby's host and real port (so a lobby on port 0 still shares it); over loopback, a path.
 */
function matchListenOptions(listener: { transport: string; address: string; listenedAt: string }, path: string): Record<string, unknown> {
  if (listener.transport === "loopback") return { path };
  let port: number | undefined;
  try {
    const url = new URL(listener.address);
    port = url.port ? Number(url.port) : undefined;
  } catch {
    // Not a URL: fall back to the default port (the dedicated server's).
  }
  const at = listener.listenedAt.trim();
  if (/^:?\d+(\/.*)?$/.test(at)) return port === undefined ? { path } : { port, path };
  try {
    const url = new URL(at.includes("://") ? at : `ws://${at}`);
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    return { ...(host ? { host } : {}), ...(port !== undefined ? { port } : url.port ? { port: Number(url.port) } : {}), path };
  } catch {
    return port === undefined ? { path } : { port, path };
  }
}

const servers = new WeakMap<World, LobbyServer>();
/** Worlds whose config was checked for `"lobby"`. */
const checked = new WeakSet<World>();

/** @internal Turn on the lobby service in `world`. Throws if it already has it or the options are invalid. */
export function hostLobby(world: World, options: LobbyOptions): LobbyServer {
  if (servers.has(world)) throw new Error(`World "${world.name}" already hosts a lobby.`);
  if (netSession(world)?.isClient) throw new Error(`World "${world.name}" is a network client; a lobby is a server World.`);
  const server = new LobbyServer(world, options);
  servers.set(world, server);
  checked.add(world);
  return server;
}

/** @internal The lobby service of `world`, if it has one. */
export function lobbyServerOf(world: World): LobbyServer | null {
  return servers.get(world) ?? null;
}

/** @internal The lobby a World's config turns on, hosted on its first frame (`engine.Lobby`). */
export function lobbyFromConfig(world: World): LobbyServer | null {
  if (checked.has(world)) return null;
  checked.add(world);
  const config = engineOf(world)?._worldConfig?.(world.name)?.lobby;
  if (!config) return null;
  try {
    return hostLobby(world, config);
  } catch (err) {
    console.error(`[myco] World "${world.name}" couldn't start its lobby: ${(err as Error).message}`);
    return null;
  }
}
