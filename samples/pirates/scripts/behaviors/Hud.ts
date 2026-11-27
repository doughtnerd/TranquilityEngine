import { Audio, Camera, GameBehavior, GameObject, Replicated, Time, Transform, UICanvas, UIView, Vector3, behavior, defineSystem } from "myco";
import { chartMarkers, chartPoint, compass, edgeMarker, edgeStatus, flagChartedBy, flagSeenBy, type MapMarker, type SeaShip } from "../awareness";
import { Battery, CLOUD_RADIUS, Obstacle, Phase, Pickup, PowerUp, RELOAD, RESULTS_SECONDS, SHIP_HP, TEAM_COLORS, cloudSpots, flag, game, inCloudAmong, myShip, ranking, ships, type CloudSpot, type ObstacleView, type PickupView, type ShipInfo } from "../data";
import { batteryLabels, controlsHelp } from "../controls";
import { HARBOUR_SNAPSHOT, STORM_PARAMETER, UI_CLICK } from "../sounds";
import { arenaRadius } from "../systems";

/** A ship's name on the scoreboard. */
export function captain(s: ShipInfo, names?: ReadonlyMap<number, string>): string {
  return names?.get(s.data.team) ?? (s.rep.isOwnedLocally ? "You" : s.data.bot ? `Bot ${s.data.team + 1}` : `Captain ${s.data.team + 1}`);
}

/** Names by team, from the lobby when there is one (lobby.ts sets it). */
let captainNames: (() => ReadonlyMap<number, string>) | null = null;
export function setCaptainNames(names: (() => ReadonlyMap<number, string>) | null): void {
  captainNames = names;
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The minimap's sea, in UI pixels (inside its border). */
const CHART = 160;
/** UI pixels the screen is designed for, upright (the HUD canvas scales with the canvas height). */
const UI_HEIGHT = 720;
/** Off-screen markers stay this far (UI pixels) inside the screen: clear of the clock above, and the power-ups, bars and help below. */
const MARKER_INSETS = { top: 72, right: 48, bottom: 196, left: 48 };
/** The leaderboard (top left) and the minimap (top right) in UI pixels, for markers to keep clear of: right or left edge, bottom. */
const BOARD = { right: 12 + 240, top: 12, rowHeight: 26, chrome: 8 * 2 + 16 };
const MINIMAP = { left: 12 + 176, bottom: 12 + 196 };
/** Rows the leaderboard and the results have at most. */
const BOARD_ROWS = 8;
const PICKUP_COLORS: Record<number, string> = { [PowerUp.wind]: "#66b3ff", [PowerUp.ghost]: "#b48cff", [PowerUp.storm]: "#8c99b0" };
/** The minimap's layers of dots, bottom to top, by the id of their element in ui/Hud.svelte. */
const LAYERS = ["land", "clouds", "pickups", "flag-dots", "ships"] as const;
type Layer = (typeof LAYERS)[number];

/** A minimap dot: its place, size and colours (UI pixels, CSS colours). */
interface Dot {
  left: number;
  top: number;
  size: number;
  round: number;
  fill: string;
  borderWidth: number;
  border: string;
}

/** A leaderboard row. */
interface BoardRow {
  team: number;
  rank: string;
  name: string;
  score: string;
  swatch: string;
  mine: boolean;
  sunk: boolean;
  holder: boolean;
}

/** A battery's box: its label, whether it's the chosen one, and its reload bar's width. */
interface BatteryView {
  label: string;
  chosen: boolean;
  reload: string;
}

/** A marker at the screen's edge: its top left corner in UI pixels, and its label. */
interface MarkerView {
  left: number;
  top: number;
  label: string;
}

/** What the HUD's component (ui/Hud.svelte) draws: its `hud` prop. */
interface HudState {
  clock: string;
  status: string;
  lines: string[];
  next: string;
  middle: string;
  powers: string;
  hull: { label: string; width: string; fill: string; swatch: string | null };
  port: BatteryView;
  starboard: BatteryView;
  /** The controls, with the player's own bindings for the device they last used. */
  help: string;
  board: BoardRow[];
  legend: string;
  dots: Record<Layer, Dot[]>;
  flagMarker: MarkerView | null;
  homeMarker: MarkerView | null;
  edge: { title: string; detail: string; background: string; opacity: number } | null;
  fog: string | null;
  leave: { open: boolean; canLeave: boolean; detail: string };
}

/**
 * The heads-up display. On the screen: the match clock (top middle); the leaderboard (top left:
 * rank, captain, score and the flag's holder, this captain's row highlighted); along the bottom
 * middle, power-ups in effect, then the port battery, the hull's health and the starboard battery,
 * then the controls; a line in the middle while sunk, and the results when the match ends. Over
 * it: a minimap (top right: the arena, its islands, fog clouds, power-ups, the flag and the ships
 * this captain's chart shows), a warning near and past the arena's edge, markers at the screen's
 * edge for the flag and (outside) the way back, a note while this ship hides in fog, and the
 * "Leave the match?" dialog (the `leave` action). It reads this client's ship and the replicated match.
 *
 * The screens are a Svelte component (ADR 0423), ui/Hud.svelte, mounted by the node's UIView: each
 * frame the script works out what it shows (texts, the leaderboard, the results, the minimap's dots,
 * bars, colours and marker positions) and passes it in as the `hud` prop when it changed; the
 * dialog's buttons call back through the `on` prop.
 */
@behavior("pirates.Hud", { worlds: ["client"] })
export class Hud extends GameBehavior {
  /**
   * True while the "Leave the match?" dialog is open: the `leave` action opens and closes it. The helm then
   * holds its course and doesn't fire (client.ts, `heldHelm`).
   */
  leaving = false;

  /**
   * Leaves the match for the room (lobby.ts sets it when this World is the page's lobby match);
   * without it the dialog has no Leave button.
   */
  leaveMatch: (() => void) | null = null;

  /** Replaces "Next match in…" under the results (a lobby's match says where players go next). */
  resultsNote: string | null = null;

  /** The arena's islands and rocks, as circles (`pirates.Chart` gathers them). */
  land: readonly { x: number; z: number; r: number }[] = [];

  private view: UIView | null = null;
  /** Whether the dialog was open last frame (focus and the snapshot change when it opens or closes). */
  private shownLeaving = false;
  /** This ship's hull last frame, to feel hits on a gamepad. */
  private lastHp = SHIP_HP;
  /** The state last passed to the view, as JSON. */
  private shown = "";

  start(): void {
    this.view = this.node.getBehavior(UIView);
    if (!this.view) return;
    this.view.props = {
      hud: this.state(),
      on: {
        stay: () => {
          if (!this.leaving) return;
          this.leaving = false;
          this.click();
        },
        leave: () => {
          if (!this.leaving || !this.leaveMatch) return;
          this.leaving = false;
          this.click();
          this.leaveMatch();
        },
      },
    };
  }

  /** Leaving the match puts the mix back: no harbour dip, no storm. */
  onDisable(): void {
    if (this.shownLeaving) Audio.clearSnapshot(0.4);
    this.shownLeaving = false;
    Audio.setParameter(STORM_PARAMETER, 0);
  }

  update(): void {
    if (!this.view) return;
    this.leaveKeys();
    const hud = this.state();
    const json = JSON.stringify(hud);
    if (json !== this.shown) {
      this.shown = json;
      // Changed values only, into the view's reactive state: Svelte redraws just what they show (the dots move every frame).
      const shown = this.view.props.hud as Record<string, unknown> | undefined;
      if (shown) patch(shown, hud as unknown as Record<string, unknown>);
      else this.view.props.hud = hud;
    }
    this.leaveShown();
  }

  /**
   * The "Leave the match?" dialog: the `leave` action (Escape, Start) opens and closes it, as does
   * Keep sailing; Leave goes back to the room. While it's open, Keep sailing has focus, so the
   * arrows or the d-pad move between its buttons, Enter or the south button presses one, and the
   * UI's cancel (Escape, the east button) closes it (ADR 0340).
   */
  private leaveKeys(): void {
    if (this.input.performed("leave")) this.leaving = !this.leaving;
    else if (this.leaving && this.view?.root?.as(UICanvas).canceled) this.leaving = false;
  }

  /** When the dialog opens or closes: Keep sailing takes or gives up focus, and the mix dips under it (the `Harbour` snapshot) or comes back. */
  private leaveShown(): void {
    if (this.leaving === this.shownLeaving) return;
    const stay = this.view?.query("#leave-stay");
    if (!stay) return; // not mounted yet: next frame
    this.shownLeaving = this.leaving;
    if (this.leaving) stay.focus();
    else stay.blur();
    if (this.leaving) Audio.snapshot(HARBOUR_SNAPSHOT, 0.25);
    else Audio.clearSnapshot(0.4);
  }

  /** What the HUD shows now. */
  private state(): HudState {
    const ship = myShip();
    const g = game();
    const names = captainNames?.();
    const hp = ship ? Math.max(0, ship.data.hp) : SHIP_HP;

    // A gamepad feels each hit on this ship.
    if (ship && hp < this.lastHp && ship.data.sunk <= 0) this.input.rumble(0.35 + 0.4 * Math.min(1, (this.lastHp - hp) / 25), 0.6, 160);
    this.lastHp = ship ? hp : SHIP_HP;

    // The controls, named with the player's own bindings for the device they last used.
    const labels = batteryLabels(this.input);
    const battery = ship?.data.battery ?? Battery.starboard;

    const powers: string[] = [];
    if (ship && ship.data.wind > 0) powers.push(`Wind in your sails ${Math.ceil(ship.data.wind)}s`);
    if (ship && ship.data.ghost > 0) powers.push(`Ghost ship ${Math.ceil(ship.data.ghost)}s - off enemy charts${ship.data.cloud ? " - F: drop a fog cloud" : ""}`);
    if (g && g.storm > 0) powers.push(g.stormTeam === ship?.data.team ? `Your storm ${Math.ceil(g.storm)}s` : `Stormy seas ${Math.ceil(g.storm)}s - beware lightning!`);

    // What this captain can tell: fog clouds hide other ships (and the flag with a hidden holder) on
    // the water and the chart; ghost ships are left off the chart (awareness.ts).
    const all = ships();
    const viewer = ship?.data.team ?? -1;
    const clouds = cloudSpots();
    const sea = all.map(seaShip);
    const f = flag();
    const theFlag = f ? { x: f.node.transform!.position.x, z: f.node.transform!.position.z, carrier: f.data.carrier } : null;
    const seenFlag = flagSeenBy(viewer, theFlag, sea, clouds);
    const chartedFlag = flagChartedBy(viewer, theFlag, sea, clouds);
    const order = ranking(all);

    let status = "";
    let lines: string[] = [];
    let next = "";
    if (!ship) status = "Raising the sails...";
    else if (g?.phase === Phase.over) {
      const winner = order.find((s) => s.data.team === g.winner);
      status = winner?.rep.isOwnedLocally ? "You are the King of Pirates!" : `${winner ? captain(winner, names) : "Nobody"} is the King of Pirates`;
      lines = order.map((s, i) => `${i + 1}.  ${captain(s, names)}   ${Math.floor(s.data.score)} pts   ${s.data.kills} sunk`);
      const left = Math.max(0, Math.ceil(RESULTS_SECONDS - g.results));
      next = this.resultsNote ?? (left > 0 ? `Next match in ${left}` : "");
    } else if (ship.data.sunk > 0) status = `Sunk! Back in ${Math.ceil(ship.data.sunk)}`;

    const afloat = !!ship && ship.data.sunk <= 0 && g?.phase === Phase.playing;
    const radius = arenaRadius();
    const markers = this.markers(ship, g?.phase === Phase.playing ? chartedFlag : null, afloat ? edgeStatus(ship.node.transform!.position.x, ship.node.transform!.position.z, radius) : null, order.length);
    const canLeave = !!this.leaveMatch;
    return {
      clock: g ? clock(g.phase === Phase.playing ? g.timeLeft : 0) : "",
      status,
      // Always eight lines, so the view keeps its elements; empty ones take no room (an empty text is 0 × 0, as in CSS).
      lines: Array.from({ length: BOARD_ROWS }, (_, i) => lines[i] ?? ""),
      next,
      middle: withAlpha("#0d1219", lines.length ? 0.85 : 0),
      powers: powers.join("   |   "),
      hull: { label: `Hull ${Math.ceil(hp)}`, width: `${Math.round((hp / SHIP_HP) * 100)}%`, fill: hp > 50 ? "#59cc4d" : hp > 25 ? "#e6a63d" : "#e6403d", swatch: ship ? TEAM_COLORS[ship.data.team] : null },
      port: this.battery(labels.port, battery === Battery.port, ship?.data.reloadPort ?? 0),
      starboard: this.battery(labels.starboard, battery === Battery.starboard, ship?.data.reloadStarboard ?? 0),
      help: controlsHelp(this.input),
      board: this.leaderboard(order, seenFlag?.carrier ?? -1, names),
      legend: chartedFlag
        ? chartedFlag.carrier < 0
          ? "Flag: loose"
          : `Flag: ${captainOf(all, chartedFlag.carrier, names)}`
        : seenFlag
          ? `Flag: ${captainOf(all, seenFlag.carrier, names)}, a ghost`
          : "Flag: hidden in the fog",
      dots: this.chart(viewer, sea, clouds, theFlag, radius),
      flagMarker: markers.flag,
      homeMarker: markers.home,
      edge: this.edge(afloat ? ship : null, radius),
      fog: this.fog(afloat ? ship : null, clouds),
      leave: { open: this.leaving, canLeave, detail: canLeave ? "A bot takes your ship's place." : "This match has no harbour to go back to." },
    };
  }

  /** The leaderboard: a row per captain, best first, with the flag on its holder's row (when it can be seen) and this captain's row lit. */
  private leaderboard(order: readonly ShipInfo[], holder: number, names: ReadonlyMap<number, string> | undefined): BoardRow[] {
    return order.slice(0, BOARD_ROWS).map((s, i) => ({
      team: s.data.team,
      rank: `${i + 1}.`,
      name: captain(s, names),
      score: String(Math.floor(s.data.score)),
      swatch: TEAM_COLORS[s.data.team] ?? "#ffffff",
      mine: s.rep.isOwnedLocally,
      sunk: s.data.sunk > 0,
      holder: s.data.team === holder,
    }));
  }

  private click(): void {
    Audio.play(UI_CLICK);
  }

  /** The minimap: land, fog clouds, power-ups, the loose flag and the ships this captain can see. */
  private chart(viewer: number, sea: readonly SeaShip[], clouds: readonly CloudSpot[], theFlag: { x: number; z: number; carrier: number } | null, radius: number): Record<Layer, Dot[]> {
    const pickups: { x: number; z: number; power: number }[] = [];
    for (const rep of GameObject.findObjectsOfType(Replicated)) {
      const data = rep.node.isValid ? (rep.node.getData(Pickup) as PickupView | null) : null;
      if (data) pickups.push({ x: rep.node.transform!.position.x, z: rep.node.transform!.position.z, power: data.kind });
    }
    const dots: Record<Layer, Dot[]> = { land: [], clouds: [], pickups: [], "flag-dots": [], ships: [] };
    const scale = CHART / (radius * 2);
    for (const o of this.land) dots.land.push(dot(o.x, o.z, radius, Math.max(3, o.r * 2 * scale), "#c9b47a", 1));
    for (const m of chartMarkers({ viewer, ships: sea, clouds, flag: theFlag, pickups })) {
      switch (m.kind) {
        case "cloud":
          dots.clouds.push(dot(m.x, m.z, radius, CLOUD_RADIUS * 2 * scale, "#dfe5ea", 0.55));
          break;
        case "pickup":
          dots.pickups.push(dot(m.x, m.z, radius, 6, PICKUP_COLORS[m.power] ?? "#ffffff", 1));
          break;
        case "flag":
          dots["flag-dots"].push(dot(m.x, m.z, radius, 9, "#ffd966", 1, "#3a2a00", 2));
          break;
        case "ship":
          dots.ships.push(dot(m.x, m.z, radius, m.mine ? 12 : 9, TEAM_COLORS[m.team] ?? "#ffffff", 1, m.holder ? "#ffd966" : m.mine ? "#ffffff" : "#10161d", m.holder || m.mine ? 2 : 1));
          break;
      }
    }
    return dots;
  }

  /** The banner near and past the arena's edge, or null inside. */
  private edge(ship: ShipInfo | null, radius: number): HudState["edge"] {
    const p = ship?.node.transform!.position;
    const at = p ? edgeStatus(p.x, p.z, radius) : null;
    if (!at || at.state === "inside") return null;
    const way = compass(at.homeX, at.homeZ);
    if (at.state === "outside") {
      const pulse = Math.round((0.75 + 0.25 * Math.sin(Time.time * 8)) * 20) / 20;
      return { title: "Return to the battle!", detail: `You're taking damage - steer ${way}`, background: withAlpha("#bf1f14", 0.88), opacity: pulse };
    }
    return { title: "The edge of the arena", detail: `Turn back ${way} - beyond it your hull takes damage`, background: withAlpha("#b3730f", 0.85), opacity: 1 };
  }

  /** The note while this ship is inside a fog cloud, or null. */
  private fog(ship: ShipInfo | null, clouds: readonly CloudSpot[]): string | null {
    const p = ship?.node.transform!.position;
    if (!p || !inCloudAmong(clouds, p.x, p.z)) return null;
    const own = inCloudAmong(clouds.filter((c) => c.team === ship!.data.team), p.x, p.z);
    return own ? "Your enemies can't see you" : "Hidden from all but the cloud's captain";
  }

  /** Markers at the screen's edge: the flag (or its holder) when it's off screen, and the way back when outside the arena. */
  private markers(ship: ShipInfo | null, seenFlag: { x: number; z: number; carrier: number } | null, at: ReturnType<typeof edgeStatus> | null, rows: number): { flag: MarkerView | null; home: MarkerView | null } {
    const out: { flag: MarkerView | null; home: MarkerView | null } = { flag: null, home: null };
    const camera = Camera.main;
    if (!camera) return out;
    // The camera's view: its middle is half the canvas, in canvas pixels; the HUD scales those to UI pixels.
    const middle = camera.worldToScreenPoint(camera.node.transform!.localToWorld.transformPoint({ x: 0, y: 0, z: 10 }));
    const width = middle.x * 2, height = middle.y * 2;
    const k = height > 0 ? UI_HEIGHT / height : 1;
    const uiWidth = width * k, uiHeight = height * k;
    let taken: { x: number; y: number } | null = null;
    const place = (marker: "flag" | "home", x: number, z: number, label: string): void => {
      const s = camera.worldToScreenPoint(new Vector3(x, 1, z));
      const m = edgeMarker(s.x * k, s.y * k, s.z, uiWidth, uiHeight, MARKER_INSETS);
      if (!m) return;
      // Two markers in one spot (the flag in the middle, seen from outside the arena): slide this one along the edge.
      if (taken && Math.abs(taken.x - m.x) < 64 && Math.abs(taken.y - m.y) < 64) {
        const onSide = m.x <= MARKER_INSETS.left + 1 || m.x >= uiWidth - MARKER_INSETS.right - 1;
        if (onSide) m.y = taken.y + (taken.y > uiHeight / 2 ? -66 : 66);
        else m.x = taken.x + (taken.x > uiWidth / 2 ? -70 : 70);
      }
      // Keep clear of the leaderboard (top left) and the minimap (top right): drop below them.
      const boardBottom = BOARD.top + BOARD.chrome + rows * BOARD.rowHeight;
      if (m.x - 32 < BOARD.right && m.y - 18 < boardBottom) m.y = boardBottom + 22;
      if (m.x + 32 > uiWidth - MINIMAP.left && m.y - 18 < MINIMAP.bottom) m.y = MINIMAP.bottom + 22;
      taken = m;
      out[marker] = { left: Math.round(m.x - 32), top: Math.round(m.y - 18), label };
    };
    const p = ship?.node.transform!.position;
    const distance = (x: number, z: number) => (p ? `${Math.round(Math.hypot(x - p.x, z - p.z))} m` : "");
    if (at?.state === "outside") place("home", 0, 0, "Battle");
    const mine = !!ship && !!seenFlag && seenFlag.carrier === ship.data.team;
    if (seenFlag && !mine) place("flag", seenFlag.x, seenFlag.z, distance(seenFlag.x, seenFlag.z));
    return out;
  }

  private battery(label: string, chosen: boolean, reload: number): BatteryView {
    return { label: reload > 0 ? `${label}  ${reload.toFixed(1)}s` : `${label}  ready`, chosen, reload: `${Math.round((1 - reload / RELOAD) * 100)}%` };
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Write `source`'s values into `target` where they differ, object by object and array item by item (arrays take its length). */
function patch(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const k of Object.keys(source)) {
    const m = merged(target[k], source[k]);
    if (target[k] !== m) target[k] = m;
  }
  for (const k of Object.keys(target)) if (!(k in source)) delete target[k];
}

function merged(current: unknown, next: unknown): unknown {
  if (Array.isArray(current) && Array.isArray(next)) {
    next.forEach((v, i) => {
      const m = merged(current[i], v);
      if (current[i] !== m) current[i] = m;
    });
    if (current.length > next.length) current.length = next.length;
    return current;
  }
  if (isRecord(current) && isRecord(next)) {
    patch(current, next);
    return current;
  }
  return next;
}

/** A minimap dot at (x, z), `size` UI pixels across, in a CSS colour with `alpha`. */
function dot(x: number, z: number, radius: number, size: number, fill: string, alpha: number, border = "#000000", borderWidth = 0): Dot {
  const at = chartPoint(x, z, radius, CHART);
  const s = Math.round(size * 2) / 2;
  return {
    left: Math.round((at.x - s / 2) * 2) / 2,
    top: Math.round((at.y - s / 2) * 2) / 2,
    size: s,
    round: s / 2,
    fill: withAlpha(fill, alpha),
    borderWidth,
    border,
  };
}

/** `#rrggbb` with an alpha (0 to 1) as `#rrggbbaa`; opaque stays `#rrggbb`. */
function withAlpha(hex: string, alpha: number): string {
  const rgb = hex.slice(0, 7);
  return alpha >= 1 ? rgb : rgb + Math.round(alpha * 255).toString(16).padStart(2, "0");
}

/** Gathers the arena's islands and rocks for the minimap (they don't move, but arenas change). */
defineSystem({
  name: "pirates.Chart",
  phase: "lateUpdate",
  worlds: ["client"],
  query: [Transform, Obstacle],
  run(rows) {
    const hud = GameObject.findObjectOfType(Hud);
    if (!hud) return;
    const out: { x: number; z: number; r: number }[] = [];
    for (const row of rows) {
      const w = row.transform.worldPosition;
      out.push({ x: w.x, z: w.z, r: (row.obstacle as ObstacleView).radius * row.transform.worldScale.x });
    }
    hud.land = out;
  },
});

function seaShip(s: ShipInfo): SeaShip {
  const p = s.node.transform!.position;
  return { team: s.data.team, x: p.x, z: p.z, sunk: s.data.sunk > 0, mine: s.rep.isOwnedLocally, ghost: s.data.ghost > 0 };
}

function captainOf(all: readonly ShipInfo[], team: number, names?: ReadonlyMap<number, string>): string {
  const s = all.find((x) => x.data.team === team);
  return s ? captain(s, names) : `Captain ${team + 1}`;
}
