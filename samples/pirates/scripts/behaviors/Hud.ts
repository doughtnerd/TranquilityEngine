import { Audio, Camera, Color, GameBehavior, GameObject, Input, Replicated, Time, Transform, UIDocument, UIPanel, Vector3, behavior, defineSystem, type UIDocumentElement, type UILength } from "myco";
import { chartMarkers, chartPoint, compass, edgeMarker, edgeStatus, flagChartedBy, flagSeenBy, type MapMarker, type SeaShip } from "../awareness";
import { Battery, CLOUD_RADIUS, Obstacle, Phase, Pickup, PowerUp, RELOAD, RESULTS_SECONDS, SHIP_HP, TEAM_COLORS, cloudSpots, flag, game, inCloudAmong, myShip, ranking, ships, type CloudSpot, type ObstacleView, type PickupView, type ShipInfo } from "../data";
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
/** The minimap's layers of dots, bottom to top, by the id of their element in ui/hud.ui.xml. */
const LAYERS = ["land", "clouds", "pickups", "flag-dots", "ships"] as const;
type Layer = (typeof LAYERS)[number];

/** A minimap dot: a row of a layer's list, its fields bound in the markup (UI pixels, CSS colours). */
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

/**
 * The heads-up display. On the screen: the match clock (top middle); the leaderboard (top left:
 * rank, captain, score and the flag's holder, this captain's row highlighted); along the bottom
 * middle, power-ups in effect, then the port battery, the hull's health and the starboard battery,
 * then the controls; a line in the middle while sunk, and the results when the match ends. Over
 * it: a minimap (top right: the arena, its islands, fog clouds, power-ups, the flag and the ships
 * this captain's chart shows), a warning near and past the arena's edge, markers at the screen's
 * edge for the flag and (outside) the way back, a note while this ship hides in fog, and the
 * "Leave the match?" dialog (Escape). It reads this client's ship and the replicated match.
 *
 * The screens are a UI document (ADR 0077, 0417): ui/hud.ui.xml, with their look in ui/hud.ui.css.
 * Texts are `{bindings}` filled from `ui.data`; the leaderboard, the results and the minimap's dots
 * are rows made with `ui.list()`; bars, colours and marker positions that change each frame are
 * written to the elements' fields; banners and the dialog are shown and hidden with `.hidden`.
 */
@behavior("pirates.Hud", { worlds: ["client"] })
export class Hud extends GameBehavior {
  /**
   * True while the "Leave the match?" dialog is open: Escape opens and closes it. The helm then
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

  private ui!: UIDocument;
  /** What each list was last made from, to call `list()` again only when that changes. */
  private made = new Map<string, string>();

  start(): void {
    this.ui = this.node.getBehavior(UIDocument)!;
    Object.assign(this.ui.data, {
      clock: "",
      status: "",
      next: "",
      powers: "",
      port: "",
      hull: "",
      starboard: "",
      legend: "",
      flagLabel: "",
      homeLabel: "Battle",
      edgeTitle: "",
      edgeDetail: "",
      fogDetail: "",
      leaveDetail: "",
    });
  }

  update(): void {
    if (!this.ui?.root) return; // the document is still loading
    this.leaveDialog();
    const data = this.ui.data;
    const ship = myShip();
    const g = game();
    const names = captainNames?.();
    const hp = ship ? Math.max(0, ship.data.hp) : SHIP_HP;
    const fill = this.panel("#hull-fill");
    const width = `${Math.round((hp / SHIP_HP) * 100)}%`;
    if (fill.width !== width) fill.width = width;
    setColor(fill, "backgroundColor", hp > 50 ? "#59cc4d" : hp > 25 ? "#e6a63d" : "#e6403d");
    data.hull = `Hull ${Math.ceil(hp)}`;
    if (ship) setColor(this.panel("#hull-swatch"), "backgroundColor", TEAM_COLORS[ship.data.team]);

    const battery = ship?.data.battery ?? Battery.starboard;
    this.battery("port", "[A] Port", battery === Battery.port, ship?.data.reloadPort ?? 0);
    this.battery("starboard", "Starboard [D]", battery === Battery.starboard, ship?.data.reloadStarboard ?? 0);

    const powers: string[] = [];
    if (ship && ship.data.wind > 0) powers.push(`Wind in your sails ${Math.ceil(ship.data.wind)}s`);
    if (ship && ship.data.ghost > 0) powers.push(`Ghost ship ${Math.ceil(ship.data.ghost)}s - off enemy charts${ship.data.cloud ? " - F: drop a fog cloud" : ""}`);
    if (g && g.storm > 0) powers.push(g.stormTeam === ship?.data.team ? `Your storm ${Math.ceil(g.storm)}s` : `Stormy seas ${Math.ceil(g.storm)}s - beware lightning!`);
    data.powers = powers.join("   |   ");
    this.show("#powers", powers.length > 0);

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
    this.leaderboard(order, seenFlag?.carrier ?? -1, names);
    data.clock = g ? clock(g.phase === Phase.playing ? g.timeLeft : 0) : "";

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
    data.status = status;
    // Always eight lines (empty ones too), so the middle keeps its size and place.
    this.list("#lines", Array.from({ length: BOARD_ROWS }, (_, i) => ({ text: lines[i] ?? "" })));
    data.next = next;
    setColor(this.panel("#middle"), "backgroundColor", "#0d1219", lines.length ? 0.85 : 0);

    const afloat = !!ship && ship.data.sunk <= 0 && g?.phase === Phase.playing;
    const radius = arenaRadius();
    data.legend = chartedFlag
      ? chartedFlag.carrier < 0
        ? "Flag: loose"
        : `Flag: ${captainOf(all, chartedFlag.carrier, names)}`
      : seenFlag
        ? `Flag: ${captainOf(all, seenFlag.carrier, names)}, a ghost`
        : "Flag: hidden in the fog";
    this.chart(viewer, sea, clouds, theFlag, radius);
    this.edge(afloat ? ship : null, radius);
    this.fog(afloat ? ship : null, clouds);
    this.markers(ship, g?.phase === Phase.playing ? chartedFlag : null, afloat ? edgeStatus(ship.node.transform!.position.x, ship.node.transform!.position.z, radius) : null, order.length);
  }

  /** The "Leave the match?" dialog: Escape opens and closes it, as does Keep sailing; Leave goes back to the room. */
  private leaveDialog(): void {
    if (Input.getKeyDown("escape")) this.leaving = !this.leaving;
    const canLeave = !!this.leaveMatch;
    this.show("#leave-go", canLeave);
    this.ui.data.leaveDetail = canLeave ? "A bot takes your ship's place." : "This match has no harbour to go back to.";
    if (this.leaving && this.el("#leave-stay").clicked) {
      this.leaving = false;
      this.click();
    }
    if (this.leaving && canLeave && this.el("#leave-go").clicked) {
      this.leaving = false;
      this.click();
      this.leaveMatch!();
    }
    this.show("#leave", this.leaving);
  }

  /** The leaderboard: a row per captain, best first, with the flag on its holder's row (when it can be seen) and this captain's row lit. */
  private leaderboard(order: readonly ShipInfo[], holder: number, names: ReadonlyMap<number, string> | undefined): void {
    const rows: BoardRow[] = order.slice(0, BOARD_ROWS).map((s, i) => ({
      team: s.data.team,
      rank: `${i + 1}.`,
      name: captain(s, names),
      score: String(Math.floor(s.data.score)),
      swatch: TEAM_COLORS[s.data.team] ?? "#ffffff",
      mine: s.rep.isOwnedLocally,
      sunk: s.data.sunk > 0,
      holder: s.data.team === holder,
    }));
    const made = this.list("#leaderboard", rows, "team");
    if (!made) return;
    for (const row of made) {
      const r = row.item as BoardRow;
      row.classList.toggle("mine", r.mine);
      row.classList.toggle("sunk", r.sunk);
      row.classList.toggle("holder", r.holder);
    }
  }

  private click(): void {
    Audio.playOneShot("audio/ui_click.wav", { volume: 0.6 });
  }

  /** The minimap: land, fog clouds, power-ups, the loose flag and the ships this captain can see. */
  private chart(viewer: number, sea: readonly SeaShip[], clouds: readonly CloudSpot[], theFlag: { x: number; z: number; carrier: number } | null, radius: number): void {
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
    for (const layer of LAYERS) this.list(`#${layer}`, dots[layer]);
  }

  /** The banner near and past the arena's edge. */
  private edge(ship: ShipInfo | null, radius: number): void {
    const p = ship?.node.transform!.position;
    const at = p ? edgeStatus(p.x, p.z, radius) : null;
    this.show("#edge", !!at && at.state !== "inside");
    if (!at || at.state === "inside") return;
    const box = this.panel("#edge-box");
    const way = compass(at.homeX, at.homeZ);
    const data = this.ui.data;
    if (at.state === "outside") {
      data.edgeTitle = "Return to the battle!";
      data.edgeDetail = `You're taking damage - steer ${way}`;
      setColor(box, "backgroundColor", "#bf1f14", 0.88);
      const pulse = Math.round((0.75 + 0.25 * Math.sin(Time.time * 8)) * 20) / 20;
      if (box.opacity !== pulse) box.opacity = pulse;
    } else {
      data.edgeTitle = "The edge of the arena";
      data.edgeDetail = `Turn back ${way} - beyond it your hull takes damage`;
      setColor(box, "backgroundColor", "#b3730f", 0.85);
      if (box.opacity !== 1) box.opacity = 1;
    }
  }

  /** The note while this ship is inside a fog cloud. */
  private fog(ship: ShipInfo | null, clouds: readonly CloudSpot[]): void {
    const p = ship?.node.transform!.position;
    const hidden = !!p && inCloudAmong(clouds, p.x, p.z);
    this.show("#fog", hidden);
    if (!hidden) return;
    const own = inCloudAmong(clouds.filter((c) => c.team === ship!.data.team), p!.x, p!.z);
    this.ui.data.fogDetail = own ? "Your enemies can't see you" : "Hidden from all but the cloud's captain";
  }

  /** Markers at the screen's edge: the flag (or its holder) when it's off screen, and the way back when outside the arena. */
  private markers(ship: ShipInfo | null, seenFlag: { x: number; z: number; carrier: number } | null, at: ReturnType<typeof edgeStatus> | null, rows: number): void {
    const camera = Camera.main;
    if (!camera) return;
    // The camera's view: its middle is half the canvas, in canvas pixels; the HUD scales those to UI pixels.
    const middle = camera.worldToScreenPoint(camera.node.transform!.localToWorld.transformPoint({ x: 0, y: 0, z: 10 }));
    const width = middle.x * 2, height = middle.y * 2;
    const k = height > 0 ? UI_HEIGHT / height : 1;
    const uiWidth = width * k, uiHeight = height * k;
    let taken: { x: number; y: number } | null = null;
    const place = (marker: "#flag-marker" | "#home-marker", x: number, z: number, label: string): void => {
      const s = camera.worldToScreenPoint(new Vector3(x, 1, z));
      const m = edgeMarker(s.x * k, s.y * k, s.z, uiWidth, uiHeight, MARKER_INSETS);
      this.show(marker, !!m);
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
      const panel = this.panel(marker);
      setLength(panel, "left", Math.round(m.x - 32));
      setLength(panel, "top", Math.round(m.y - 18));
      this.ui.data[marker === "#flag-marker" ? "flagLabel" : "homeLabel"] = label;
    };
    const p = ship?.node.transform!.position;
    const distance = (x: number, z: number) => (p ? `${Math.round(Math.hypot(x - p.x, z - p.z))} m` : "");
    if (at?.state === "outside") place("#home-marker", 0, 0, "Battle");
    else this.show("#home-marker", false);
    const mine = !!ship && !!seenFlag && seenFlag.carrier === ship.data.team;
    if (seenFlag && !mine) place("#flag-marker", seenFlag.x, seenFlag.z, distance(seenFlag.x, seenFlag.z));
    else this.show("#flag-marker", false);
  }

  private battery(id: "port" | "starboard", label: string, chosen: boolean, reload: number): void {
    const panel = this.panel(`#${id}`);
    setColor(panel, "borderColor", chosen ? "#ffd966" : "#667080");
    if (panel.opacity !== (chosen ? 1 : 0.6)) panel.opacity = chosen ? 1 : 0.6;
    this.ui.data[id] = reload > 0 ? `${label}  ${reload.toFixed(1)}s` : `${label}  ready`;
    const fill = this.panel(`#${id} .reload`);
    const width = `${Math.round((1 - reload / RELOAD) * 100)}%`;
    if (fill.width !== width) fill.width = width;
  }

  // --- UI helpers ---------------------------------------------------------------------------------

  private el(selector: string): UIDocumentElement {
    const el = this.ui.query(selector);
    if (!el) throw new Error(`ui/hud.ui.xml has no "${selector}".`);
    return el;
  }

  private panel(selector: string): UIPanel {
    return this.el(selector).as(UIPanel);
  }

  /** Show or hide an element with the stylesheet's `.hidden` (`display: none`). */
  private show(selector: string, on: boolean): void {
    this.el(selector).classList.toggle("hidden", !on);
  }

  /** `ui.list()`, called again only when the items change. Returns the rows when it was called. */
  private list<T extends object>(selector: string, items: readonly T[], key?: keyof T): UIDocumentElement[] | null {
    const made = JSON.stringify(items);
    if (this.made.get(selector) === made) return null;
    this.made.set(selector, made);
    return this.ui.list(selector, items, undefined, key ? { key } : {});
  }
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

/** Sets a length field only when it changes. */
function setLength(panel: UIPanel, field: "width" | "height" | "left" | "top", value: number): void {
  if (panel[field] !== value) panel[field] = value as UILength;
}

/** Sets a colour field only when it differs, as a new value (UI fields are compared, not watched). */
function setColor(panel: UIPanel, field: "backgroundColor" | "borderColor", hex: string, alpha = 1): void {
  const current = panel[field];
  if (current && current.toHex().toLowerCase() === hex.slice(0, 7).toLowerCase() && Math.abs(current.a - alpha) < 0.01) return;
  const c = Color.from(hex.slice(0, 7));
  c.a = alpha;
  panel[field] = c;
}
