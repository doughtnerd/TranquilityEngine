import { Audio, GameBehavior, Lobby, Time, UIView, behavior, type LobbyRoom } from "myco";
import { TEAM_COLORS } from "../data";
import { ARENAS, BOT_NAMES, MATCH_LENGTHS, SHIP_COUNTS, arenaOf, forgetLeftMatch, leftMatchEarly, shipsOf } from "../lobby";

const NAME_KEY = "pirates.name";
const SERVER_KEY = "pirates.server";
/** Seats a room has. */
const SLOTS = 8;
/** Seconds an error stays up. */
const ERROR_SECONDS = 8;

/** A room setting the host steps through with < and >: one row of the settings list. */
interface Setting {
  key: string;
  label: string;
  choices: readonly string[];
  name(value: string): string;
}

const SETTINGS: readonly Setting[] = [
  { key: "arena", label: "Arena", choices: ARENAS.map((a) => a.key), name: (v) => arenaOf({ arena: v }).name },
  { key: "length", label: "Match length", choices: MATCH_LENGTHS.map((l) => l.key), name: (v) => MATCH_LENGTHS.find((l) => l.key === v)?.name ?? `${v} s` },
  { key: "ships", label: "Ships", choices: SHIP_COUNTS, name: (v) => `${v} ships` },
];

/** A crew row: a player in their slot, or a bot filling an empty one. */
interface Seat {
  slot: number;
  name: string;
  tag: string;
  swatch: string;
  me: boolean;
  bot: boolean;
}

function load(key: string): string {
  try {
    return globalThis.localStorage?.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function save(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Private windows and headless runs keep nothing.
  }
}

/** The menu's state as its component (ui/Menu.svelte) draws it: what the lobby says, read each frame. */
interface MenuState {
  where: string;
  status: string;
  error: string;
  screen: "home" | "room" | null;
  sailing: boolean;
  rooms: { code: string; label: string }[];
  showLocal: boolean;
  room: {
    title: string;
    code: string;
    seats: Seat[];
    settingsTitle: string;
    settings: { key: string; label: string; value: string }[];
    canSet: boolean;
    results: { title: string; lines: string[] } | null;
    status: string;
    ready: boolean;
    host: boolean;
  } | null;
}

/**
 * The main menu and the room view (ADR 0068), over the sea (scenes/menu.scene.json). The screens are
 * a Svelte component (ADR 0419), ui/Menu.svelte, mounted by the node's UIView. Its props: `menu`, what
 * the script reads from `Lobby` each frame (the screen the lobby is in, the open rooms, the crew, the
 * settings and the results); `fields`, the name, room code and server address fields (bound both
 * ways); and `on`, what the buttons do.
 *
 * While a match plays, the lobby pauses this World and the match World takes the screen; when the
 * match ends, this World resumes and shows the room with the results.
 */
@behavior("pirates.Menu")
export class Menu extends GameBehavior {
  /** Where the lobby is: "local", or a server's address. */
  private address = "local";
  /** The name the lobby knows us by (reconnect when the field changes). */
  private connectedName = "";
  /** An action waiting for the lobby connection. */
  private pending: (() => void) | null = null;
  /** Practice: start the room as soon as we're its host. */
  private startWhenHost = false;
  private shownError = "";
  private errorSince = 0;
  private view!: UIView;
  /** The state last passed to the view, as JSON. */
  private shown = "";

  start(): void {
    this.view = this.node.getBehavior(UIView)!;
    this.view.props = {
      menu: this.state(),
      fields: { name: load(NAME_KEY) || `Captain ${10 + Math.floor(Math.random() * 90)}`, code: "", url: load(SERVER_KEY) || defaultServer() },
      on: {
        quickMatch: () => this.act(() => Lobby.quickMatch()),
        practice: () =>
          this.act(() => {
            Lobby.createRoom({ name: "Practice", public: false });
            this.startWhenHost = true;
          }),
        createRoom: () => this.act(() => Lobby.createRoom({ name: `${this.name()}'s room`, public: true })),
        joinCode: () => {
          const wanted = this.fields().code.trim().toUpperCase();
          if (wanted) this.act(() => Lobby.joinRoom(wanted));
        },
        joinRoom: (code: string) => this.act(() => Lobby.joinRoom(code)),
        joinServer: () => {
          const address = this.fields().url.trim();
          if (!address) return;
          save(SERVER_KEY, address);
          this.connect(/^wss?:\/\//i.test(address) ? address : `ws://${address}`);
        },
        local: () => this.connect("local"),
        ready: () => Lobby.setReady(!this.ready()),
        start: () => {
          if (Lobby.me?.host) Lobby.start();
        },
        leave: () => {
          this.startWhenHost = false;
          Lobby.leaveRoom();
        },
        step: (key: string, by: number) => this.step(key, by),
      },
    };
    this.connect("local");
  }

  update(): void {
    const state = Lobby.state;
    if (this.pending && state === "lobby") {
      const action = this.pending;
      this.pending = null;
      action();
    }
    if (this.startWhenHost && state === "room" && Lobby.me?.host) {
      this.startWhenHost = false;
      Lobby.start();
    }
    const menu = this.state();
    const json = JSON.stringify(menu);
    if (json !== this.shown) {
      this.shown = json;
      this.view.props.menu = menu;
    }
  }

  /** What the menu shows now. */
  private state(): MenuState {
    const state = Lobby.state;
    const room = Lobby.room;
    const inRoom = (state === "room" || state === "starting") && room !== null;
    return {
      ...this.header(),
      screen: inRoom ? "room" : state !== "match" ? "home" : null,
      sailing: state === "match" || this.startWhenHost,
      rooms: inRoom ? [] : this.rooms(),
      showLocal: this.address !== "local",
      room: inRoom ? this.room(room!) : null,
    };
  }

  // --- home ---------------------------------------------------------------------------------------

  private rooms(): { code: string; label: string }[] {
    return Lobby.rooms
      .filter((r) => r.state !== "playing" && r.members < r.maxPlayers)
      .slice(0, 4)
      .map((r) => ({ code: r.code, label: `${r.name}  -  ${arenaOf(r.settings).name}  -  ${r.members}/${r.maxPlayers}` }));
  }

  // --- the room -----------------------------------------------------------------------------------

  private room(room: LobbyRoom): NonNullable<MenuState["room"]> {
    const me = Lobby.me;
    const host = !!me?.host;

    // Crew: players by slot, then the bots that fill the empty places up to the ship count.
    let bots = Math.max(0, shipsOf(room.settings) - room.members.length);
    const seats: Seat[] = [];
    for (let slot = 0; slot < SLOTS; slot++) {
      const member = room.members.find((m) => m.slot === slot);
      if (!member && bots === 0) continue;
      if (!member) bots--;
      seats.push({
        slot,
        name: member ? `${member.name}${member.slot === me?.slot ? " (you)" : ""}` : `${BOT_NAMES[slot]} (bot)`,
        tag: member ? [member.host ? "Host" : "", member.ready ? "Ready" : ""].filter(Boolean).join("  ") : "",
        swatch: TEAM_COLORS[slot].slice(0, 7) + (member ? "" : "73"), // bots' swatches at 45%
        me: !!member && member.slot === me?.slot,
        bot: !member,
      });
    }

    // The host's settings: one row per setting, its < and > only for the host (the stylesheet hides them otherwise).
    const settings = SETTINGS.map((s) => {
      const value = room.settings[s.key] ?? s.choices[0];
      return { key: s.key, label: s.label, value: s.name(value) };
    });

    // The last match's results.
    const r = room.results;
    const results = r ? { title: r.winner ? `${r.winner} is the King of Pirates!` : "The match is over", lines: r.winner ? [1, 2, 3, 4].filter((i) => r[String(i)]).map((i) => `${i}.  ${r[String(i)]}`) : [r.reason ?? ""] } : null;

    // Status and buttons.
    if (room.state !== "playing") forgetLeftMatch();
    let status: string;
    if (room.state === "countdown") status = `Setting sail in ${room.countdown}...`;
    else if (room.state === "playing" && leftMatchEarly()) status = "You left the match. The others sail on; the results come here when it ends.";
    else if (room.state === "playing") status = "Setting sail...";
    else if (room.quick) status = "Quick match: setting sail soon. Bots take the empty places.";
    else if (host) status = room.members.length > 1 ? "Start when you like, or when everyone is ready." : "Start when you like: bots take the empty places.";
    else status = "Ready up: the match starts when every captain is ready.";
    return {
      title: room.name,
      code: room.public ? `Room code ${room.code}  -  open to all` : `Room code ${room.code}  -  private`,
      seats,
      settingsTitle: host ? "Settings" : "Settings (the host picks)",
      settings,
      canSet: host && room.state !== "playing",
      results,
      status,
      ready: this.ready(),
      host,
    };
  }

  private step(key: string, by: number): void {
    const room = Lobby.room;
    const s = SETTINGS.find((x) => x.key === key);
    if (!room || !s || !Lobby.me?.host || room.state === "playing") return;
    const i = s.choices.indexOf(room.settings[key] ?? s.choices[0]);
    Lobby.setSetting(key, s.choices[(i + by + s.choices.length) % s.choices.length]);
    this.click();
  }

  private ready(): boolean {
    const me = Lobby.me;
    return Lobby.room?.members.find((m) => m.slot === me?.slot)?.ready ?? false;
  }

  // --- header and footer --------------------------------------------------------------------------

  private header(): { where: string; status: string; error: string } {
    const state = Lobby.state;
    const status: Record<string, string> = {
      offline: "Offline",
      connecting: "Connecting...",
      lobby: Lobby.rooms.length ? `${Lobby.rooms.length} open room${Lobby.rooms.length === 1 ? "" : "s"}` : "Connected",
      room: "In a room",
      starting: "Setting sail...",
      match: "At sea",
    };

    const error = Lobby.error;
    if (error !== this.shownError) {
      this.shownError = error;
      this.errorSince = Time.realtimeSinceStartup;
    }
    return {
      where: this.address === "local" ? "Harbour: this computer" : `Harbour: ${this.address}`,
      status: status[state] ?? state,
      error: error && Time.realtimeSinceStartup - this.errorSince < ERROR_SECONDS ? error : "",
    };
  }

  // --- the lobby connection -----------------------------------------------------------------------

  private connect(address: string): void {
    this.address = address;
    this.connectedName = this.name();
    this.pending = null;
    this.startWhenHost = false;
    Lobby.connect(address, { name: this.connectedName });
  }

  /** Run `action` once the lobby is connected under the current name (reconnecting if needed). */
  private act(action: () => void): void {
    this.click();
    const name = this.name();
    save(NAME_KEY, name);
    if (Lobby.state === "offline" || (Lobby.state === "lobby" && name !== this.connectedName)) this.connect(this.address);
    this.pending = action;
  }

  private name(): string {
    return this.fields().name.trim() || "Captain";
  }

  /** The name, room code and server address fields, as the player typed them (the view binds them). */
  private fields(): { name: string; code: string; url: string } {
    return this.view.props.fields as { name: string; code: string; url: string };
  }

  // --- UI helpers ---------------------------------------------------------------------------------

  private click(): void {
    Audio.playOneShot("audio/ui_click.wav", { volume: 0.6 });
  }
}

/** The page's own host on the dedicated server's default port. */
function defaultServer(): string {
  const host = (globalThis as { location?: { hostname?: string } }).location?.hostname || "localhost";
  return `ws://${host}:7777`;
}
