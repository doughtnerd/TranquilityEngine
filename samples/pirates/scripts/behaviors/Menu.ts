import { Audio, Color, GameBehavior, Lobby, Time, UIButton, UIInputField, UIPanel, UIText, behavior, type GameObject, type LobbyRoom } from "myco";
import { TEAM_COLORS } from "../data";
import { ARENAS, BOT_NAMES, MATCH_LENGTHS, SHIP_COUNTS, arenaOf, shipsOf } from "../lobby";

const NAME_KEY = "pirates.name";
const SERVER_KEY = "pirates.server";
/** Rows of open rooms and of crew the scene has. */
const ROOM_ROWS = 4;
const SLOT_ROWS = 8;
/** Seconds an error stays up. */
const ERROR_SECONDS = 8;

/** A room setting the host steps through with < and >. */
const SETTINGS: readonly { key: string; path: string; choices: readonly string[]; label(value: string): string }[] = [
  { key: "arena", path: "Arena", choices: ARENAS.map((a) => a.key), label: (v) => arenaOf({ arena: v }).name },
  { key: "length", path: "Length", choices: MATCH_LENGTHS.map((l) => l.key), label: (v) => MATCH_LENGTHS.find((l) => l.key === v)?.name ?? `${v} s` },
  { key: "ships", path: "Ships", choices: SHIP_COUNTS, label: (v) => `${v} ships` },
];

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
 * The main menu and the room view (ADR 0068), over the sea. It polls `Lobby` each frame and shows
 * the home screen (name, Quick Match, Practice, Create Room, join by code, open rooms, join a
 * server) or the room (crew and bots, ready flags, the host's settings, Start, Leave and the last
 * match's results). The page starts on a lobby of its own ("local"); Join Server switches to a
 * dedicated server's (`npm run server -- samples/pirates`).
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

  start(): void {
    const name = this.field("Screen/Home/Left/Name");
    if (name) {
      name.value = load(NAME_KEY) || `Captain ${10 + Math.floor(Math.random() * 90)}`;
      name.maxLength = 20;
    }
    const url = this.field("Screen/Home/Right/ServerRow/Url");
    if (url) url.value = load(SERVER_KEY) || defaultServer();
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
    const room = Lobby.room;
    const inRoom = (state === "room" || state === "starting") && room !== null;
    this.show("Screen/Home", !inRoom && state !== "match");
    this.show("Screen/Room", inRoom);
    this.show("Screen/Sailing", state === "match" || this.startWhenHost);
    if (inRoom) this.room(room!);
    else this.home();
    this.header();
  }

  // --- home ---------------------------------------------------------------------------------------

  private home(): void {
    const name = this.name();
    if (this.clicked("Screen/Home/Left/QuickMatch")) this.act(() => Lobby.quickMatch());
    if (this.clicked("Screen/Home/Left/Practice")) {
      this.act(() => {
        Lobby.createRoom({ name: "Practice", public: false });
        this.startWhenHost = true;
      });
    }
    if (this.clicked("Screen/Home/Left/CreateRoom")) this.act(() => Lobby.createRoom({ name: `${name}'s room`, public: true }));
    const code = this.field("Screen/Home/Left/JoinRow/Code");
    if (code && code.value !== code.value.toUpperCase()) code.value = code.value.toUpperCase();
    if (this.clicked("Screen/Home/Left/JoinRow/Join") || code?.submitted) {
      const wanted = code?.value.trim() ?? "";
      if (wanted) this.act(() => Lobby.joinRoom(wanted));
    }

    const rooms = Lobby.rooms.filter((r) => r.state !== "playing" && r.members < r.maxPlayers);
    for (let i = 0; i < ROOM_ROWS; i++) {
      const r = rooms[i];
      const path = `Screen/Home/Right/Room${i}`;
      this.show(path, !!r);
      if (!r) continue;
      this.text(`${path}/Label`, `${r.name}  -  ${arenaOf(r.settings).name}  -  ${r.members}/${r.maxPlayers}`);
      if (this.clicked(`${path}/Join`)) this.act(() => Lobby.joinRoom(r.code));
    }
    this.show("Screen/Home/Right/NoRooms", rooms.length === 0);

    const url = this.field("Screen/Home/Right/ServerRow/Url");
    if (this.clicked("Screen/Home/Right/ServerRow/Connect") || url?.submitted) {
      const address = url?.value.trim() ?? "";
      if (address) {
        save(SERVER_KEY, address);
        this.connect(/^wss?:\/\//i.test(address) ? address : `ws://${address}`);
      }
    }
    this.show("Screen/Home/Right/ServerRow/Local", this.address !== "local");
    if (this.clicked("Screen/Home/Right/ServerRow/Local")) this.connect("local");
  }

  // --- the room -----------------------------------------------------------------------------------

  private room(room: LobbyRoom): void {
    const me = Lobby.me;
    const host = !!me?.host;
    this.text("Screen/Room/Crew/RoomTitle", room.name);
    this.text("Screen/Room/Crew/RoomCode", room.public ? `Room code ${room.code}  -  open to all` : `Room code ${room.code}  -  private`);

    // Crew: players by slot, then the bots that fill the empty places up to the ship count.
    const ships = shipsOf(room.settings);
    let bots = Math.max(0, ships - room.members.length);
    for (let slot = 0; slot < SLOT_ROWS; slot++) {
      const path = `Screen/Room/Crew/Slot${slot}`;
      const member = room.members.find((m) => m.slot === slot);
      const bot = !member && bots > 0;
      if (bot) bots--;
      this.show(path, !!member || bot);
      if (!member && !bot) continue;
      const swatch = this.node.find(`${path}/Swatch`)?.getBehavior(UIPanel);
      if (swatch) setColor(swatch, "backgroundColor", TEAM_COLORS[slot], member ? 1 : 0.45);
      const label = this.node.find(`${path}/Name`)?.getBehavior(UIText);
      if (label) {
        const text = member ? `${member.name}${member.slot === me?.slot ? " (you)" : ""}` : `${BOT_NAMES[slot]} (bot)`;
        if (label.text !== text) label.text = text;
        const alpha = member ? 1 : 0.55;
        if (Math.abs(label.color.a - alpha) > 0.01) label.color = new Color(0.95, 0.93, 0.85, alpha);
      }
      this.text(`${path}/Tag`, member ? [member.host ? "Host" : "", member.ready ? "Ready" : ""].filter(Boolean).join("  ") : "");
      const row = this.node.find(path)?.getBehavior(UIPanel);
      if (row) setColor(row, "backgroundColor", "#ffffff", member?.slot === me?.slot ? 0.12 : 0.04);
    }

    // The host's settings.
    this.text("Screen/Room/Side/Settings/SettingsLabel", host ? "Settings" : "Settings (the host picks)");
    for (const s of SETTINGS) {
      const value = room.settings[s.key] ?? s.choices[0];
      const path = `Screen/Room/Side/Settings/${s.path}`;
      this.text(`${path}/Value`, s.label(value));
      for (const [button, step] of [["Prev", -1], ["Next", 1]] as const) {
        const b = this.button(`${path}/${button}`);
        if (!b) continue;
        const on = host && room.state !== "playing";
        if (b.visible !== on) b.visible = on;
        if (b.interactable !== on) b.interactable = on;
        if (on && b.clicked) {
          const i = s.choices.indexOf(value);
          Lobby.setSetting(s.key, s.choices[(i + step + s.choices.length) % s.choices.length]);
          this.click();
        }
      }
    }

    // The last match's results.
    const results = room.results;
    this.show("Screen/Room/Side/Results", !!results);
    if (results) {
      this.text("Screen/Room/Side/Results/ResultsTitle", results.winner ? `${results.winner} is the King of Pirates!` : "The match is over");
      const lines = results.winner ? [1, 2, 3, 4].map((i) => (results[String(i)] ? `${i}.  ${results[String(i)]}` : "")) : [results.reason ?? ""];
      for (let i = 0; i < 4; i++) this.text(`Screen/Room/Side/Results/Result${i}`, lines[i] ?? "");
    }

    // Status and buttons.
    const ready = room.members.find((m) => m.slot === me?.slot)?.ready ?? false;
    let status: string;
    if (room.state === "countdown") status = `Setting sail in ${room.countdown}...`;
    else if (room.state === "playing") status = "Setting sail...";
    else if (room.quick) status = "Quick match: setting sail soon. Bots take the empty places.";
    else if (host) status = room.members.length > 1 ? "Start when you like, or when everyone is ready." : "Start when you like: bots take the empty places.";
    else status = "Ready up: the match starts when every captain is ready.";
    this.text("Screen/Room/Side/RoomStatus", status);
    this.text("Screen/Room/Side/Buttons/Ready/Label", ready ? "Ready!" : "Ready?");
    const readyButton = this.button("Screen/Room/Side/Buttons/Ready");
    if (readyButton) setColor(readyButton, "backgroundColor", ready ? "#3f8f4a" : "#23303f");
    if (this.clicked("Screen/Room/Side/Buttons/Ready")) Lobby.setReady(!ready);
    this.show("Screen/Room/Side/Buttons/Start", host);
    if (host && this.clicked("Screen/Room/Side/Buttons/Start")) Lobby.start();
    if (this.clicked("Screen/Room/Side/Buttons/Leave")) {
      this.startWhenHost = false;
      Lobby.leaveRoom();
    }
  }

  // --- header and footer --------------------------------------------------------------------------

  private header(): void {
    const state = Lobby.state;
    const where = this.address === "local" ? "Harbour: this computer" : `Harbour: ${this.address}`;
    this.text("Screen/Header/Connection/Where", where);
    const status: Record<string, string> = {
      offline: "Offline",
      connecting: "Connecting...",
      lobby: Lobby.rooms.length ? `${Lobby.rooms.length} open room${Lobby.rooms.length === 1 ? "" : "s"}` : "Connected",
      room: "In a room",
      starting: "Setting sail...",
      match: "At sea",
    };
    this.text("Screen/Header/Connection/Status", status[state] ?? state);

    const error = Lobby.error;
    if (error !== this.shownError) {
      this.shownError = error;
      this.errorSince = Time.realtimeSinceStartup;
    }
    const showError = !!error && Time.realtimeSinceStartup - this.errorSince < ERROR_SECONDS;
    this.text("Screen/Footer/Error", showError ? error : "");
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
    return this.field("Screen/Home/Left/Name")?.value.trim() || "Captain";
  }

  // --- UI helpers ---------------------------------------------------------------------------------

  private click(): void {
    Audio.playOneShot("audio/ui_click.wav", { volume: 0.6 });
  }

  private find(path: string): GameObject | null {
    return this.node.find(path);
  }

  private button(path: string): UIButton | null {
    return this.find(path)?.getBehavior(UIButton) ?? null;
  }

  private field(path: string): UIInputField | null {
    return this.find(path)?.getBehavior(UIInputField) ?? null;
  }

  private clicked(path: string): boolean {
    return this.button(path)?.clicked ?? false;
  }

  private text(path: string, value: string): void {
    const t = this.find(path)?.getBehavior(UIText);
    if (t && t.text !== value) t.text = value;
  }

  private show(path: string, on: boolean): void {
    const node = this.find(path);
    if (node && node.active !== on) node.setActive(on);
  }
}

/** The page's own host on the dedicated server's default port. */
function defaultServer(): string {
  const host = (globalThis as { location?: { hostname?: string } }).location?.hostname || "localhost";
  return `ws://${host}:7777`;
}

/** Sets a colour field only when it differs, as a new value. */
function setColor(panel: UIPanel, field: "backgroundColor" | "borderColor", hex: string, alpha = 1): void {
  const current = panel[field];
  if (current && current.toHex().toLowerCase() === hex.slice(0, 7).toLowerCase() && Math.abs(current.a - alpha) < 0.01) return;
  const c = Color.from(hex.slice(0, 7));
  c.a = alpha;
  panel[field] = c;
}
