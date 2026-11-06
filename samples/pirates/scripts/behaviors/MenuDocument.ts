import { Audio, GameBehavior, Lobby, Time, UIButton, UIDocument, behavior, type LobbyRoom, type UIDocumentElement } from "myco";
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

/**
 * The main menu and the room view (ADR 0068) as a UI document (ADR 0077): the same job as `Menu`
 * (scenes/menu.scene.json), with the screens in ui/menu.ui.xml and their look in ui/menu.ui.css.
 * Buttons and fields get handlers once; each frame the script reads `Lobby` into `ui.data` (the
 * markup's `{bindings}`), makes the open rooms, the crew, the settings and the results with
 * `ui.list()` when they change, and shows the screen the lobby is in (the `hidden` class).
 *
 * While a match plays, the lobby pauses this World and the match World takes the screen; when the
 * match ends, this World resumes and shows the room with the results.
 */
@behavior("pirates.MenuDocument")
export class MenuDocument extends GameBehavior {
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
  private ui!: UIDocument;
  private wired = false;
  /** What each list was last made from, to remake it only when that changes. */
  private made = new Map<string, string>();

  start(): void {
    this.ui = this.node.getBehavior(UIDocument)!;
    Object.assign(this.ui.data, { where: "", status: "", error: "", roomTitle: "", roomCode: "", settingsTitle: "", resultsTitle: "", roomStatus: "", readyLabel: "" });
    if (this.ui.root) this.wire();
    else void this.ui.ready.then(() => this.wire());
    this.connect("local");
  }

  /** Handlers on the document's buttons and fields (they're kept when the files hot-reload). */
  private wire(): void {
    const ui = this.ui;
    const name = this.el("#name");
    name.value = load(NAME_KEY) || `Captain ${10 + Math.floor(Math.random() * 90)}`;
    this.el("#url").value = load(SERVER_KEY) || defaultServer();

    this.el("#quick-match").on("click", () => this.act(() => Lobby.quickMatch()));
    this.el("#practice").on("click", () =>
      this.act(() => {
        Lobby.createRoom({ name: "Practice", public: false });
        this.startWhenHost = true;
      }),
    );
    this.el("#create-room").on("click", () => this.act(() => Lobby.createRoom({ name: `${this.name()}'s room`, public: true })));

    const code = this.el("#code");
    code.on("change", () => {
      const upper = code.value!.toUpperCase();
      if (upper !== code.value) code.value = upper;
    });
    const joinByCode = () => {
      const wanted = code.value!.trim();
      if (wanted) this.act(() => Lobby.joinRoom(wanted));
    };
    this.el("#join").on("click", joinByCode);
    code.on("submit", joinByCode);

    const url = this.el("#url");
    const joinServer = () => {
      const address = url.value!.trim();
      if (!address) return;
      save(SERVER_KEY, address);
      this.connect(/^wss?:\/\//i.test(address) ? address : `ws://${address}`);
    };
    this.el("#connect").on("click", joinServer);
    url.on("submit", joinServer);
    this.el("#local").on("click", () => this.connect("local"));

    this.el("#ready").on("click", () => Lobby.setReady(!this.ready()));
    this.el("#start").on("click", () => {
      if (Lobby.me?.host) Lobby.start();
    });
    this.el("#leave").on("click", () => {
      this.startWhenHost = false;
      Lobby.leaveRoom();
    });
    this.made.clear();
    this.wired = !!ui.root;
  }

  update(): void {
    if (!this.wired) return;
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
    const room = Lobby.room;
    const inRoom = (state === "room" || state === "starting") && room !== null;
    this.show("#home", !inRoom && state !== "match");
    this.show("#room", inRoom);
    this.show("#sailing", state === "match" || this.startWhenHost);
    if (inRoom) this.room(room!);
    else this.home();
    this.header();
  }

  // --- home ---------------------------------------------------------------------------------------

  private home(): void {
    const rooms = Lobby.rooms
      .filter((r) => r.state !== "playing" && r.members < r.maxPlayers)
      .slice(0, 4)
      .map((r) => ({ code: r.code, label: `${r.name}  -  ${arenaOf(r.settings).name}  -  ${r.members}/${r.maxPlayers}` }));
    this.list("#rooms", rooms, (row) => row.query("Button")!.on("click", (e) => this.act(() => Lobby.joinRoom((e.item as { code: string }).code))), "code");
    this.show("#rooms", rooms.length > 0);
    this.show("#no-rooms", rooms.length === 0);
    this.show("#local", this.address !== "local");
  }

  // --- the room -----------------------------------------------------------------------------------

  private room(room: LobbyRoom): void {
    const me = Lobby.me;
    const host = !!me?.host;
    const data = this.ui.data;
    data.roomTitle = room.name;
    data.roomCode = room.public ? `Room code ${room.code}  -  open to all` : `Room code ${room.code}  -  private`;

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
    const rows = this.list("#slots", seats, undefined, "slot");
    for (const row of rows) {
      const seat = row.item as Seat;
      row.classList.toggle("me", seat.me);
      row.classList.toggle("bot", seat.bot);
    }

    // The host's settings: one row per setting, its < and > only for the host (the stylesheet hides them otherwise).
    data.settingsTitle = host ? "Settings" : "Settings (the host picks)";
    const settings = SETTINGS.map((s) => {
      const value = room.settings[s.key] ?? s.choices[0];
      return { key: s.key, label: s.label, value: s.name(value) };
    });
    this.list("#setting-rows", settings, (row) => {
      row.query(".prev")!.on("click", (e) => this.step((e.item as { key: string }).key, -1));
      row.query(".next")!.on("click", (e) => this.step((e.item as { key: string }).key, 1));
    }, "key");
    const canSet = host && room.state !== "playing";
    for (const b of this.ui.queryAll(".step")) {
      const button = b.as(UIButton);
      if (button.interactable !== canSet) button.interactable = canSet;
    }

    // The last match's results.
    const results = room.results;
    this.show("#results", !!results);
    if (results) {
      data.resultsTitle = results.winner ? `${results.winner} is the King of Pirates!` : "The match is over";
      const lines = results.winner ? [1, 2, 3, 4].filter((i) => results[String(i)]).map((i) => `${i}.  ${results[String(i)]}`) : [results.reason ?? ""];
      this.list("#result-lines", lines.map((text) => ({ text })));
    }

    // Status and buttons.
    const ready = this.ready();
    if (room.state !== "playing") forgetLeftMatch();
    if (room.state === "countdown") data.roomStatus = `Setting sail in ${room.countdown}...`;
    else if (room.state === "playing" && leftMatchEarly()) data.roomStatus = "You left the match. The others sail on; the results come here when it ends.";
    else if (room.state === "playing") data.roomStatus = "Setting sail...";
    else if (room.quick) data.roomStatus = "Quick match: setting sail soon. Bots take the empty places.";
    else if (host) data.roomStatus = room.members.length > 1 ? "Start when you like, or when everyone is ready." : "Start when you like: bots take the empty places.";
    else data.roomStatus = "Ready up: the match starts when every captain is ready.";
    data.readyLabel = ready ? "Ready!" : "Ready?";
    this.el("#ready").classList.toggle("on", ready);
    this.show("#start", host);
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

  private header(): void {
    const state = Lobby.state;
    const data = this.ui.data;
    data.where = this.address === "local" ? "Harbour: this computer" : `Harbour: ${this.address}`;
    const status: Record<string, string> = {
      offline: "Offline",
      connecting: "Connecting...",
      lobby: Lobby.rooms.length ? `${Lobby.rooms.length} open room${Lobby.rooms.length === 1 ? "" : "s"}` : "Connected",
      room: "In a room",
      starting: "Setting sail...",
      match: "At sea",
    };
    data.status = status[state] ?? state;

    const error = Lobby.error;
    if (error !== this.shownError) {
      this.shownError = error;
      this.errorSince = Time.realtimeSinceStartup;
    }
    data.error = error && Time.realtimeSinceStartup - this.errorSince < ERROR_SECONDS ? error : "";
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
    return this.ui.query("#name")?.value?.trim() || "Captain";
  }

  // --- UI helpers ---------------------------------------------------------------------------------

  private click(): void {
    Audio.playOneShot("audio/ui_click.wav", { volume: 0.6 });
  }

  private el(selector: string): UIDocumentElement {
    const el = this.ui.query(selector);
    if (!el) throw new Error(`ui/menu.ui.xml has no "${selector}".`);
    return el;
  }

  /** Show or hide an element with the stylesheet's `.hidden` (`display: none`: it takes no space). */
  private show(selector: string, on: boolean): void {
    this.el(selector).classList.toggle("hidden", !on);
  }

  /** `ui.list()`, called again only when the items change. Returns the rows. */
  private list<T extends object>(selector: string, items: readonly T[], setup?: (row: UIDocumentElement, item: T) => void, key?: keyof T): UIDocumentElement[] {
    const made = JSON.stringify(items);
    if (this.made.get(selector) === made) return this.el(selector).children.filter((c) => c.item !== undefined);
    this.made.set(selector, made);
    return this.ui.list(selector, items, setup, key ? { key } : {});
  }
}

/** The page's own host on the dedicated server's default port. */
function defaultServer(): string {
  const host = (globalThis as { location?: { hostname?: string } }).location?.hostname || "localhost";
  return `ws://${host}:7777`;
}
