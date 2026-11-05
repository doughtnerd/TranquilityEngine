/**
 * The lobby's client side (ADR 0068). `Lobby` is static and page-wide: `Lobby.connect` makes a
 * hidden lobby client World (tagged `lobby-client`, no rendering or input, so no game system runs
 * in it) in the current World's Engine and connects it to a lobby server World. Its state is plain
 * data that menus poll (ADR 0017): `Lobby.state`, `Lobby.rooms`, `Lobby.room`, `Lobby.me`.
 *
 * When the lobby starts a match, the client makes a match client World from the lobby's
 * `clientTemplate`, named `Match <id> Client`, and connects it to the match World with its ticket.
 * Meanwhile the page's other Worlds that render are paused (not destroyed), and the match World
 * gets the screen; when the match ends (or the player leaves it), the match client World is
 * destroyed and the paused Worlds resume.
 *
 * `LobbyClient` is the instance behind `Lobby`; tests make several to play several players in one
 * process.
 */
import { templateConfig } from "../../core/bootstrap";
import { World } from "../../core/World";
import { _worldOf } from "../../core/WorldHandle";
import type { WorldConfig, WorldHandle } from "../../core/worlds";
import { defineBuiltinSystem } from "../../core/systems";
import { createBitWriter, type BitWriter } from "../codec";
import { netSession } from "../session";
import { _matchOf } from "./match";
import { hostLobby, lobbyFromConfig, lobbyServerOf } from "./server";
import { C2S, S2C, cleanName, readMap, readMatch, readView, writeMap, type LobbyMe, type LobbyOptions, type LobbyRoom, type LobbyRoomInfo, type LobbyState, type MatchTicket } from "./protocol";
import { LOBBY_C2S, LOBBY_S2C, declaredBootstrap, engineOf, type LobbyEngine } from "./wire";

/** The player as the lobby shows them to others. */
export interface LobbyProfile {
  readonly name: string;
}

/** Options for `Lobby.connect`. */
export interface LobbyConnectOptions {
  /** The transport: by default `"websocket"` for a `ws://` or `wss://` address, else `"loopback"`. */
  readonly transport?: string;
  /** Other link options for the lobby connection (timeouts, loopback conditions). */
  readonly link?: Readonly<Record<string, unknown>>;
}

/** The tag of hidden lobby client Worlds. */
export const LOBBY_CLIENT_TAG = "lobby-client";

const clients = new WeakMap<World, LobbyClient>();
/** Match client Worlds of every LobbyClient in the page: never paused for another player's match (hot-seat play). */
const matchClientWorlds = new WeakSet<WorldHandle>();

/** @internal One player's connection to a lobby. `Lobby` is the page-wide one. */
export class LobbyClient {
  private currentState: LobbyState = "offline";
  /** The last refusal or disconnect reason ("" for none). */
  error = "";
  private roomList: readonly LobbyRoomInfo[] = [];
  private currentRoom: LobbyRoom | null = null;
  private slot = -1;
  private myName = "";
  private engine: LobbyEngine | null = null;
  private world: WorldHandle | null = null;
  /** The lobby server World this client made for `"local"`, destroyed with it. */
  private localServer: WorldHandle | null = null;
  private address = "";
  private transport = "";
  private wasOpen = false;
  private match: { handle: WorldHandle; id: number; wasOpen: boolean } | null = null;
  /** Worlds paused while a match plays, resumed after. */
  private paused: WorldHandle[] = [];
  private detachView: (() => void) | null = null;

  /** Where the client is: offline, connecting, in the lobby, in a room, starting, or in a match. */
  get state(): LobbyState {
    this.checkAlive();
    return this.currentState;
  }

  /** Public rooms. */
  get rooms(): readonly LobbyRoomInfo[] {
    this.checkAlive();
    return this.roomList;
  }

  /** The room the player is in, or null. */
  get room(): LobbyRoom | null {
    this.checkAlive();
    return this.currentRoom;
  }

  /** The player's slot in their room and whether they're its host, or null outside a room. */
  get me(): LobbyMe | null {
    const room = this.room;
    if (!room || this.slot < 0) return null;
    return { slot: this.slot, host: room.hostSlot === this.slot, name: this.myName };
  }

  /** The match client World while a match plays, else null. */
  get matchWorld(): WorldHandle | null {
    return this.match?.handle.alive ? this.match.handle : null;
  }

  /** @internal Tests: the hidden lobby client World. */
  get lobbyWorld(): WorldHandle | null {
    return this.world?.alive ? this.world : null;
  }

  /**
   * Connect to a lobby. `address` is a lobby server's address (`"ws://host:7777"`), or `"local"`
   * to run the project's lobby World in this page over loopback (single-player and hot-seat play).
   * Returns at once; watch `state`.
   */
  connect(address: string, profile: LobbyProfile, options: LobbyConnectOptions = {}): void {
    if (this.world) this.disconnect();
    this.error = "";
    const current = World.active;
    const engine = current ? engineOf(current) : null;
    if (!engine) throw new Error("Lobby.connect needs an Engine: call it from a World's code (a script or system), after Engine.create.");
    this.engine = engine;
    this.myName = cleanName(profile?.name, "Player");
    try {
      let transport = options.transport ?? (/^wss?:\/\//i.test(address) ? "websocket" : "loopback");
      let target = address;
      if (address === "local") {
        transport = "loopback";
        target = this.startLocal(engine);
      }
      const world = engine.createWorld({ name: uniqueName(engine, "Lobby Client"), tags: [LOBBY_CLIENT_TAG], renders: false, input: false });
      this.world = world;
      clients.set(_worldOf(world)!, this);
      this.address = target;
      this.transport = transport;
      this.wasOpen = false;
      world.connect(target, transport, { ...(options.link ?? {}) });
      this.currentState = "connecting";
      this.send((w) => {
        w.writeVarUint(C2S.hello);
        w.writeString(this.myName);
      });
    } catch (err) {
      this.fail(`Couldn't connect to the lobby: ${(err as Error).message}`);
    }
  }

  /** Make (or find) this page's lobby server World and listen over loopback; its address. */
  private startLocal(engine: LobbyEngine): string {
    let handle = engine.worlds().find((h) => {
      const w = _worldOf(h);
      return !!w && (lobbyServerOf(w) !== null || !!engine._worldConfig?.(h.name)?.lobby);
    });
    if (!handle) {
      const config = lobbyConfig(engine);
      if (!config) throw new Error('the project has no World or template with a "lobby" config to run locally.');
      handle = engine.createWorld({ ...config, name: uniqueName(engine, config.name) });
      this.localServer = handle;
    }
    const world = _worldOf(handle)!;
    if (!lobbyServerOf(world)) {
      const options = engine._worldConfig?.(handle.name)?.lobby;
      if (options) hostLobby(world, options);
    }
    const session = netSession(world);
    const existing = session?.listening().find((l) => l.transport === "loopback");
    if (existing) return existing.address;
    void handle.listen("loopback").catch((err: Error) => this.fail(`The local lobby couldn't listen: ${err.message}`));
    return netSession(world)!.listening().find((l) => l.transport === "loopback")!.address;
  }

  /** Leave the lobby: the match client World, the hidden lobby World and a local lobby go. */
  disconnect(): void {
    this.leaveMatchWorld();
    const world = this.world;
    this.world = null;
    if (world?.alive) world.destroy();
    if (this.localServer?.alive) this.localServer.destroy();
    this.localServer = null;
    this.reset("offline");
  }

  // --- actions ----------------------------------------------------------------------------------

  /** Join the fullest public room waiting with these settings, or make one. */
  quickMatch(settings: Readonly<Record<string, string>> = {}): void {
    this.send((w) => {
      w.writeVarUint(C2S.quick);
      writeMap(w, settings);
    });
  }

  /** Make a room and join it as its host. */
  createRoom(options: { name?: string; public?: boolean; settings?: Readonly<Record<string, string>> } = {}): void {
    this.send((w) => {
      w.writeVarUint(C2S.create);
      w.writeString(options.name ?? "");
      w.writeBool(options.public ?? true);
      writeMap(w, options.settings ?? {});
    });
  }

  /** Join a room by its code. */
  joinRoom(code: string): void {
    this.send((w) => {
      w.writeVarUint(C2S.join);
      w.writeString(String(code));
    });
  }

  leaveRoom(): void {
    this.send((w) => w.writeVarUint(C2S.leave));
  }

  setReady(ready: boolean): void {
    this.send((w) => {
      w.writeVarUint(C2S.ready);
      w.writeBool(!!ready);
    });
  }

  /** Host only: change a room setting. */
  setSetting(key: string, value: string): void {
    this.send((w) => {
      w.writeVarUint(C2S.set);
      w.writeString(String(key));
      w.writeString(String(value));
    });
  }

  /** Host only: remove the member in `slot`. */
  kick(slot: number): void {
    this.send((w) => {
      w.writeVarUint(C2S.kick);
      w.writeVarUint(Math.max(0, Math.floor(slot)));
    });
  }

  /** Host only: start now (once the room has `minPlayers`). */
  start(): void {
    this.send((w) => w.writeVarUint(C2S.start));
  }

  /** Leave the match: its client World goes and the player is back in the room. */
  leaveMatch(): void {
    if (!this.match) return;
    this.leaveMatchWorld();
    this.currentState = this.currentRoom ? "room" : "lobby";
  }

  private send(write: (w: BitWriter) => void): void {
    const world = this.world?.alive ? _worldOf(this.world) : null;
    const session = world ? netSession(world) : null;
    if (!session?.serverPeer) {
      this.error = "The lobby isn't connected.";
      return;
    }
    const w = createBitWriter();
    write(w);
    session.send(LOBBY_C2S, "server", "reliable", w.finish());
  }

  // --- each frame -------------------------------------------------------------------------------

  /** `engine.LobbyClient`, in the hidden World: lobby messages, the connection and the match World. */
  update(world: World): void {
    const session = netSession(world);
    const peer = session?.serverPeer ?? null;
    if (peer?.state === "open") this.wasOpen = true;
    if (!peer || peer.state === "closed") {
      const reason = session?.closed.at(-1)?.reason ?? "the connection closed";
      this.fail(this.wasOpen ? `Lost the lobby connection: ${reason}` : `Couldn't connect to the lobby: ${reason}`);
      return;
    }
    for (const m of session!.drain(LOBBY_S2C)) {
      try {
        const r = m.reader();
        const op = r.readVarUint();
        if (op === S2C.state) {
          const view = readView(r);
          this.roomList = view.rooms;
          this.currentRoom = view.room;
          this.slot = view.slot;
          this.myName = view.name;
        } else if (op === S2C.error) {
          this.error = r.readString();
        } else if (op === S2C.match) {
          this.startMatch(readMatch(r));
        } else if (op === S2C.matchEnd) {
          const id = r.readVarUint();
          readMap(r); // the results are in the room's view too
          if (this.match?.id === id) this.leaveMatchWorld();
        }
      } catch (err) {
        this.error = `The lobby sent something unreadable: ${(err as Error).message}`;
      }
    }
    this.watchMatch();
    if (this.match) this.currentState = "match";
    else if (!this.wasOpen) this.currentState = "connecting";
    else if (!this.currentRoom) this.currentState = "lobby";
    else this.currentState = this.currentRoom.state === "waiting" ? "room" : "starting";
  }

  private startMatch(m: MatchTicket): void {
    const engine = this.engine;
    if (!engine) return;
    this.leaveMatchWorld();
    if (!m.clientTemplate) {
      this.error = "The lobby has no clientTemplate, so this page can't join its match.";
      return;
    }
    let handle: WorldHandle;
    try {
      const template = templateConfig(declaredBootstrap(engine) as never, m.clientTemplate);
      handle = engine.createWorld({ ...template, name: uniqueName(engine, `Match ${m.matchId} Client`) });
    } catch (err) {
      this.error = `Couldn't create the match client World from template "${m.clientTemplate}": ${(err as Error).message}`;
      return;
    }
    this.match = { handle, id: m.matchId, wasOpen: false };
    matchClientWorlds.add(handle);
    try {
      handle.connect(this.matchAddress(m), m.transport, { ticket: m.ticket });
    } catch (err) {
      this.error = `Couldn't join the match: ${(err as Error).message}`;
      this.leaveMatchWorld();
      return;
    }
    this.takeScreen(engine, handle);
  }

  /** The match's address from here: over a URL, the lobby's URL with the match's path (so proxies and wss:// carry over). */
  private matchAddress(m: MatchTicket): string {
    if (m.transport === this.transport && /^wss?:\/\//i.test(this.address)) {
      try {
        const url = new URL(this.address);
        url.pathname = m.path;
        url.search = "";
        return url.toString();
      } catch {
        // Fall through to the server's address.
      }
    }
    return m.address;
  }

  /** The match client World's connection went: back to the room. */
  private watchMatch(): void {
    const match = this.match;
    if (!match) return;
    const world = _worldOf(match.handle);
    if (!world) {
      this.leaveMatchWorld();
      return;
    }
    const session = netSession(world);
    const peer = session?.serverPeer ?? null;
    if (peer?.state === "open") match.wasOpen = true;
    if (!peer || peer.state === "closed") {
      const reason = session?.closed.at(-1)?.reason ?? "";
      if (reason && !match.wasOpen) this.error = `Couldn't join the match: ${reason}`;
      this.leaveMatchWorld();
    }
  }

  /** Pause the page's other rendering Worlds and give the match World the screen. */
  private takeScreen(engine: LobbyEngine, match: WorldHandle): void {
    const states = engine._viewStates?.() ?? [];
    for (const s of states) {
      const handle = engine.findWorld(s.name);
      if (!handle || handle === match || matchClientWorlds.has(handle) || handle.hasTag(LOBBY_CLIENT_TAG) || !s.renders || s.paused) continue;
      handle.pause();
      this.paused.push(handle);
    }
    // In a page with a canvas, draw the match World over the paused one (an Engine draws one World
    // per surface, ADR 0032), and give it the keyboard.
    const e = engine as unknown as { container?: HTMLElement | null; _attachView?(name: string, element: HTMLElement): () => void; _focusInput?(name: string | null): void };
    const wants = states.length === 0 || engine._viewStates?.().find((s) => s.name === match.name)?.renders;
    if (!wants || !e.container || typeof document === "undefined" || !e._attachView) return;
    try {
      const container = e.container;
      if (getComputedStyle(container).position === "static") container.style.position = "relative";
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:absolute;inset:0;";
      container.appendChild(overlay);
      const detach = e._attachView(match.name, overlay);
      e._focusInput?.(match.name);
      this.detachView = () => {
        try {
          detach();
          e._focusInput?.(null);
        } catch {
          // The Engine is gone.
        }
        overlay.remove();
      };
    } catch (err) {
      console.warn(`[myco] The match World couldn't take the screen: ${(err as Error).message}`);
    }
  }

  private leaveMatchWorld(): void {
    const match = this.match;
    this.match = null;
    this.detachView?.();
    this.detachView = null;
    if (match?.handle.alive) match.handle.destroy();
    for (const h of this.paused.splice(0)) if (h.alive) h.resume();
  }

  private fail(reason: string): void {
    this.error = reason;
    this.leaveMatchWorld();
    const world = this.world;
    this.world = null;
    if (world?.alive) world.destroy();
    this.reset("offline");
    this.error = reason;
  }

  private reset(state: LobbyState): void {
    this.currentState = state;
    this.roomList = [];
    this.currentRoom = null;
    this.slot = -1;
    this.wasOpen = false;
  }

  /** The hidden World went with its Engine: offline. */
  private checkAlive(): void {
    if (this.world && !this.world.alive) {
      this.world = null;
      this.leaveMatchWorld();
      this.reset("offline");
    }
  }
}

/** `base`, or `base 2`, `base 3`… if a World of that name exists. */
function uniqueName(engine: LobbyEngine, base: string): string {
  let name = base;
  for (let i = 2; engine._world(name); i++) name = `${base} ${i}`;
  return name;
}

/** The project's lobby World config: a template with `"lobby"`, else a start-up World with one. */
function lobbyConfig(engine: LobbyEngine): WorldConfig | null {
  const declared = declaredBootstrap(engine) as { worlds?: readonly WorldConfig[]; templates?: Readonly<Record<string, Omit<WorldConfig, "name"> & { name?: string }>> } | undefined;
  if (!declared || typeof declared !== "object") return null;
  for (const [key, t] of Object.entries(declared.templates ?? {})) {
    if (t.lobby) return templateConfig(declared as never, key);
  }
  return declared.worlds?.find((w) => w.lobby) ?? null;
}

/**
 * Lobbies and matchmaking (ADR 0068), client side: static and page-wide, usable from any World.
 * Menus poll its state.
 *
 * ```ts
 * Lobby.connect("ws://play.example.com:7777", { name: "Anne" });  // or "local"
 * Lobby.quickMatch({ arena: "bay" });
 * if (Lobby.state === "room") Lobby.setReady(true);
 * ```
 */
export class Lobby {
  private constructor() {}

  /** @internal The page-wide client. */
  static readonly _client = new LobbyClient();

  /** Turn on the lobby service in a server World (as a World config's `"lobby"` does). */
  static host(world: WorldHandle, options: LobbyOptions): void {
    const w = _worldOf(world);
    if (!w) throw new Error(`Lobby.host: World "${world.name}" isn't a live World of an Engine.`);
    hostLobby(w, options);
  }

  /** Connect to a lobby server (`"ws://host:7777"`), or `"local"` to run the project's lobby World in this page. Returns at once. */
  static connect(address: string, profile: LobbyProfile, options?: LobbyConnectOptions): void {
    Lobby._client.connect(address, profile, options);
  }

  static disconnect(): void {
    Lobby._client.disconnect();
  }

  /** `"offline" | "connecting" | "lobby" | "room" | "starting" | "match"`. */
  static get state(): LobbyState {
    return Lobby._client.state;
  }

  /** The last refusal or disconnect reason ("" for none). */
  static get error(): string {
    return Lobby._client.error;
  }

  /** Public rooms: code, name, member count, settings. */
  static get rooms(): readonly LobbyRoomInfo[] {
    return Lobby._client.rooms;
  }

  /** The room the player is in (members, ready flags, host, settings, countdown), or null. */
  static get room(): LobbyRoom | null {
    return Lobby._client.room;
  }

  /** The player's slot and whether they host their room, or null outside a room. */
  static get me(): LobbyMe | null {
    return Lobby._client.me;
  }

  /** The match client World while a match plays, else null. */
  static get matchWorld(): WorldHandle | null {
    return Lobby._client.matchWorld;
  }

  static quickMatch(settings?: Readonly<Record<string, string>>): void {
    Lobby._client.quickMatch(settings);
  }

  static createRoom(options?: { name?: string; public?: boolean; settings?: Readonly<Record<string, string>> }): void {
    Lobby._client.createRoom(options);
  }

  static joinRoom(code: string): void {
    Lobby._client.joinRoom(code);
  }

  static leaveRoom(): void {
    Lobby._client.leaveRoom();
  }

  static setReady(ready: boolean): void {
    Lobby._client.setReady(ready);
  }

  /** Host only. */
  static setSetting(key: string, value: string): void {
    Lobby._client.setSetting(key, value);
  }

  /** Host only. */
  static kick(slot: number): void {
    Lobby._client.kick(slot);
  }

  /** Host only: start once the room has `minPlayers`. */
  static start(): void {
    Lobby._client.start();
  }

  /** Leave the running match and go back to the room. */
  static leaveMatch(): void {
    Lobby._client.leaveMatch();
  }
}

// One built-in for every part of the lobby, in every World (it does nothing in most): a lobby
// server World's rooms (hosted from its config on its first frame), a match World's players, and a
// hidden lobby client World's messages. After the network receive, so this frame's messages are in.
defineBuiltinSystem({
  name: "engine.Lobby",
  phase: "update",
  after: ["engine.NetReceive"],
  before: ["engine.UpdateScripts"],
  run: (world) => {
    (lobbyServerOf(world) ?? lobbyFromConfig(world))?.update();
    _matchOf(world)?.update();
    clients.get(world)?.update(world);
  },
});

