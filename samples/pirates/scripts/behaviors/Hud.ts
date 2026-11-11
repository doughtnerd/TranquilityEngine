import { Audio, Camera, Color, GameBehavior, GameObject, Input, Replicated, Time, Transform, UIButton, UIPanel, UIText, Vector3, behavior, defineSystem, type UILength } from "myco";
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
/** Rows the leaderboard has. */
const BOARD_ROWS = 8;
const PICKUP_COLORS: Record<number, string> = { [PowerUp.wind]: "#66b3ff", [PowerUp.ghost]: "#b48cff", [PowerUp.storm]: "#8c99b0" };
const LAYERS = ["Land", "Clouds", "Pickups", "Flag", "Ships"] as const;
type Layer = (typeof LAYERS)[number];

/**
 * The heads-up display. On the screen: the match clock (top middle); the leaderboard (top left:
 * rank, captain, score and the flag's holder, this captain's row highlighted); along the bottom
 * middle, power-ups in effect, then the port battery, the hull's health and the starboard battery,
 * then the controls; a line in the middle while sunk, and the results when the match ends. Over
 * it: a minimap (top right: the arena, its islands, fog clouds, power-ups, the flag and the ships
 * this captain's chart shows), a warning near and past the arena's edge, markers at the screen's
 * edge for the flag and (outside) the way back, a note while this ship hides in fog, and the
 * "Leave the match?" dialog (Escape). It reads this client's ship and the replicated match; the
 * nodes it fills are found by path under the canvas.
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

  update(): void {
    this.leaveDialog();
    const ship = myShip();
    const g = game();
    const names = captainNames?.();
    const hp = ship ? Math.max(0, ship.data.hp) : SHIP_HP;
    const fill = this.node.find("Screen/Bottom/Bars/Hull/Bar/Fill")?.getBehavior(UIPanel);
    if (fill) {
      const width = `${Math.round((hp / SHIP_HP) * 100)}%`;
      if (fill.width !== width) fill.width = width;
      setColor(fill, "backgroundColor", hp > 50 ? "#59cc4d" : hp > 25 ? "#e6a63d" : "#e6403d");
    }
    this.text("Screen/Bottom/Bars/Hull/Label", `Hull ${Math.ceil(hp)}`);
    const swatch = this.node.find("Screen/Bottom/Bars/Hull/Swatch")?.getBehavior(UIPanel);
    if (swatch && ship) setColor(swatch, "backgroundColor", TEAM_COLORS[ship.data.team]);

    const battery = ship?.data.battery ?? Battery.starboard;
    this.battery("Screen/Bottom/Bars/Port", "[A] Port", battery === Battery.port, ship?.data.reloadPort ?? 0);
    this.battery("Screen/Bottom/Bars/Starboard", "Starboard [D]", battery === Battery.starboard, ship?.data.reloadStarboard ?? 0);

    const powers: string[] = [];
    if (ship && ship.data.wind > 0) powers.push(`Wind in your sails ${Math.ceil(ship.data.wind)}s`);
    if (ship && ship.data.ghost > 0) powers.push(`Ghost ship ${Math.ceil(ship.data.ghost)}s - off enemy charts${ship.data.cloud ? " - F: drop a fog cloud" : ""}`);
    if (g && g.storm > 0) powers.push(g.stormTeam === ship?.data.team ? `Your storm ${Math.ceil(g.storm)}s` : `Stormy seas ${Math.ceil(g.storm)}s - beware lightning!`);
    this.text("Screen/Bottom/Powers/Label", powers.join("   |   "));
    show(this.node.find("Screen/Bottom/Powers"), powers.length > 0);

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
    this.text("Screen/Top/ClockBox/Clock", g ? clock(g.phase === Phase.playing ? g.timeLeft : 0) : "");

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
    this.text("Screen/MiddleRow/Middle/Status", status);
    for (let i = 0; i < 8; i++) this.text(`Screen/MiddleRow/Middle/Line${i}`, lines[i] ?? "");
    this.text("Screen/MiddleRow/Middle/Next", next);
    const panel = this.node.find("Screen/MiddleRow/Middle")?.getBehavior(UIPanel);
    if (panel) setColor(panel, "backgroundColor", "#0d1219", lines.length ? 0.85 : 0);

    const afloat = !!ship && ship.data.sunk <= 0 && g?.phase === Phase.playing;
    const radius = arenaRadius();
    const legend = chartedFlag
      ? chartedFlag.carrier < 0
        ? "Flag: loose"
        : `Flag: ${captainOf(all, chartedFlag.carrier, names)}`
      : seenFlag
        ? `Flag: ${captainOf(all, seenFlag.carrier, names)}, a ghost`
        : "Flag: hidden in the fog";
    this.chart(viewer, sea, clouds, theFlag, radius, legend);
    this.edge(afloat ? ship : null, radius);
    this.fog(afloat ? ship : null, clouds);
    this.markers(ship, g?.phase === Phase.playing ? chartedFlag : null, afloat ? edgeStatus(ship.node.transform!.position.x, ship.node.transform!.position.z, radius) : null, order.length);
  }

  /** The "Leave the match?" dialog: Escape opens and closes it, as does Keep sailing; Leave goes back to the room. */
  private leaveDialog(): void {
    if (Input.getKeyDown("escape")) this.leaving = !this.leaving;
    const canLeave = !!this.leaveMatch;
    show(this.node.find("Leave/Box/Buttons/Leave"), canLeave);
    this.text("Leave/Box/Detail", canLeave ? "A bot takes your ship's place." : "This match has no harbour to go back to.");
    if (this.leaving && this.clicked("Leave/Box/Buttons/Stay")) {
      this.leaving = false;
      this.click();
    }
    if (this.leaving && canLeave && this.clicked("Leave/Box/Buttons/Leave")) {
      this.leaving = false;
      this.click();
      this.leaveMatch!();
    }
    show(this.node.find("Leave"), this.leaving);
  }

  /** The leaderboard: a row per captain, best first, with the flag on its holder's row (when it can be seen) and this captain's row lit. */
  private leaderboard(order: readonly ShipInfo[], holder: number, names: ReadonlyMap<number, string> | undefined): void {
    for (let i = 0; i < BOARD_ROWS; i++) {
      const s = order[i];
      const path = `Overlay/Leaderboard/Row${i}`;
      show(this.node.find(path), !!s);
      if (!s) continue;
      const mine = s.rep.isOwnedLocally;
      this.text(`${path}/Name`, captain(s, names));
      this.text(`${path}/Score`, String(Math.floor(s.data.score)));
      show(this.node.find(`${path}/Flag`), s.data.team === holder);
      const swatch = this.node.find(`${path}/Swatch`)?.getBehavior(UIPanel);
      if (swatch) setColor(swatch, "backgroundColor", TEAM_COLORS[s.data.team] ?? "#ffffff");
      const row = this.node.find(path)?.getBehavior(UIPanel);
      if (row) setColor(row, "backgroundColor", mine ? "#ffd966" : "#ffffff", mine ? 0.22 : 0);
      const name = this.node.find(`${path}/Name`)?.getBehavior(UIText);
      if (name) {
        const weight = mine ? "bold" : "normal";
        if (name.fontWeight !== weight) name.fontWeight = weight;
        const alpha = s.data.sunk > 0 ? 0.5 : 1;
        if (Math.abs(name.color.a - alpha) > 0.01) name.color = new Color(0.95, 0.93, 0.85, alpha);
      }
    }
  }

  private clicked(path: string): boolean {
    return this.node.find(path)?.getBehavior(UIButton)?.clicked ?? false;
  }

  private click(): void {
    Audio.playOneShot("audio/ui_click.wav", { volume: 0.6 });
  }

  /** Replaces "Next match in…" under the results (a lobby's match says where players go next). */
  resultsNote: string | null = null;

  /** The arena's islands and rocks, as circles (`pirates.Chart` gathers them). */
  land: readonly { x: number; z: number; r: number }[] = [];

  /** The minimap: land, fog clouds, power-ups, the loose flag and the ships this captain can see. */
  private chart(viewer: number, sea: readonly SeaShip[], clouds: readonly CloudSpot[], theFlag: { x: number; z: number; carrier: number } | null, radius: number, legend: string): void {
    if (!this.node.find("Overlay/Minimap/Chart")) return;
    const pickups: { x: number; z: number; power: number }[] = [];
    for (const rep of GameObject.findObjectsOfType(Replicated)) {
      const data = rep.node.isValid ? (rep.node.getData(Pickup) as PickupView | null) : null;
      if (data) pickups.push({ x: rep.node.transform!.position.x, z: rep.node.transform!.position.z, power: data.kind });
    }
    const used: Record<Layer, number> = { Land: 0, Clouds: 0, Pickups: 0, Flag: 0, Ships: 0 };
    const scale = CHART / (radius * 2);
    for (const o of this.land) this.dot("Land", used.Land++, o.x, o.z, radius, Math.max(3, o.r * 2 * scale), "#c9b47a", 1);
    for (const m of chartMarkers({ viewer, ships: sea, clouds, flag: theFlag, pickups })) this.marker(m, used, radius, scale);
    for (const layer of LAYERS) this.trim(layer, used[layer]);
    this.text("Overlay/Minimap/Legend", legend);
  }

  private marker(m: MapMarker, used: Record<Layer, number>, radius: number, scale: number): void {
    switch (m.kind) {
      case "cloud":
        this.dot("Clouds", used.Clouds++, m.x, m.z, radius, CLOUD_RADIUS * 2 * scale, "#dfe5ea", 0.55);
        break;
      case "pickup":
        this.dot("Pickups", used.Pickups++, m.x, m.z, radius, 6, PICKUP_COLORS[m.power] ?? "#ffffff", 1);
        break;
      case "flag":
        this.dot("Flag", used.Flag++, m.x, m.z, radius, 9, "#ffd966", 1, "#3a2a00", 2);
        break;
      case "ship":
        this.dot("Ships", used.Ships++, m.x, m.z, radius, m.mine ? 12 : 9, TEAM_COLORS[m.team] ?? "#ffffff", 1, m.holder ? "#ffd966" : m.mine ? "#ffffff" : "#10161d", m.holder || m.mine ? 2 : 1);
        break;
    }
  }

  /** Pooled minimap dots, by layer. */
  private readonly pools = new Map<Layer, UIPanel[]>();

  /** Place dot `i` of `layer` (created when the pool is short) at (x, z), `size` UI pixels across. */
  private dot(layer: Layer, i: number, x: number, z: number, radius: number, size: number, fill: string, alpha: number, border?: string, borderWidth = 0): void {
    let pool = this.pools.get(layer);
    if (!pool) this.pools.set(layer, (pool = []));
    while (pool.length <= i) {
      const parent = this.node.find(`Overlay/Minimap/Chart/${layer}`);
      if (!parent) return;
      const node = GameObject.create(`${layer} ${pool.length + 1}`, { parent });
      pool.push(node.addComponent(UIPanel, { positionType: "absolute" }));
    }
    const p = pool[i];
    if (!p.node.active) p.node.setActive(true);
    const at = chartPoint(x, z, radius, CHART);
    const s = Math.round(size * 2) / 2;
    setLength(p, "width", s);
    setLength(p, "height", s);
    setLength(p, "left", Math.round((at.x - s / 2) * 2) / 2);
    setLength(p, "top", Math.round((at.y - s / 2) * 2) / 2);
    if (p.borderRadius !== s / 2) p.borderRadius = s / 2;
    setColor(p, "backgroundColor", fill, alpha);
    if (p.borderWidth !== borderWidth) p.borderWidth = borderWidth;
    if (border) setColor(p, "borderColor", border);
  }

  /** Hide the dots of `layer` from `count` on. */
  private trim(layer: Layer, count: number): void {
    const pool = this.pools.get(layer) ?? [];
    for (let i = count; i < pool.length; i++) if (pool[i].node.active) pool[i].node.setActive(false);
  }

  /** The banner near and past the arena's edge. */
  private edge(ship: ShipInfo | null, radius: number): void {
    const banner = this.node.find("Overlay/Edge");
    if (!banner) return;
    const p = ship?.node.transform!.position;
    const at = p ? edgeStatus(p.x, p.z, radius) : null;
    show(banner, !!at && at.state !== "inside");
    if (!at || at.state === "inside") return;
    const box = this.node.find("Overlay/Edge/Box")?.getBehavior(UIPanel);
    const way = compass(at.homeX, at.homeZ);
    if (at.state === "outside") {
      this.text("Overlay/Edge/Box/Title", "Return to the battle!");
      this.text("Overlay/Edge/Box/Detail", `You're taking damage - steer ${way}`);
      if (box) {
        setColor(box, "backgroundColor", "#bf1f14", 0.88);
        const pulse = Math.round((0.75 + 0.25 * Math.sin(Time.time * 8)) * 20) / 20;
        if (box.opacity !== pulse) box.opacity = pulse;
      }
    } else {
      this.text("Overlay/Edge/Box/Title", "The edge of the arena");
      this.text("Overlay/Edge/Box/Detail", `Turn back ${way} - beyond it your hull takes damage`);
      if (box) {
        setColor(box, "backgroundColor", "#b3730f", 0.85);
        if (box.opacity !== 1) box.opacity = 1;
      }
    }
  }

  /** The note while this ship is inside a fog cloud. */
  private fog(ship: ShipInfo | null, clouds: readonly CloudSpot[]): void {
    const note = this.node.find("Overlay/Fog");
    if (!note) return;
    const p = ship?.node.transform!.position;
    const hidden = !!p && inCloudAmong(clouds, p.x, p.z);
    show(note, hidden);
    if (!hidden) return;
    const own = inCloudAmong(clouds.filter((c) => c.team === ship!.data.team), p!.x, p!.z);
    this.text("Overlay/Fog/Box/Detail", own ? "Your enemies can't see you" : "Hidden from all but the cloud's captain");
  }

  /** Markers at the screen's edge: the flag (or its holder) when it's off screen, and the way back when outside the arena. */
  private markers(ship: ShipInfo | null, seenFlag: { x: number; z: number; carrier: number } | null, at: ReturnType<typeof edgeStatus> | null, rows: number): void {
    const camera = Camera.main;
    const flagNode = this.node.find("Overlay/FlagMarker");
    const homeNode = this.node.find("Overlay/HomeMarker");
    if (!camera || !flagNode || !homeNode) return;
    // The camera's view: its middle is half the canvas, in canvas pixels; the HUD scales those to UI pixels.
    const middle = camera.worldToScreenPoint(camera.node.transform!.localToWorld.transformPoint({ x: 0, y: 0, z: 10 }));
    const width = middle.x * 2, height = middle.y * 2;
    const k = height > 0 ? UI_HEIGHT / height : 1;
    const uiWidth = width * k, uiHeight = height * k;
    let taken: { x: number; y: number } | null = null;
    const place = (node: GameObject, x: number, z: number, label: string): void => {
      const s = camera.worldToScreenPoint(new Vector3(x, 1, z));
      const m = edgeMarker(s.x * k, s.y * k, s.z, uiWidth, uiHeight, MARKER_INSETS);
      show(node, !!m);
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
      const panel = node.getBehavior(UIPanel);
      if (panel) {
        setLength(panel, "left", Math.round(m.x - 32));
        setLength(panel, "top", Math.round(m.y - 18));
      }
      this.text(`Overlay/${node.name}/Label`, label);
    };
    const p = ship?.node.transform!.position;
    const distance = (x: number, z: number) => (p ? `${Math.round(Math.hypot(x - p.x, z - p.z))} m` : "");
    if (at?.state === "outside") place(homeNode, 0, 0, "Battle");
    else show(homeNode, false);
    const mine = !!ship && !!seenFlag && seenFlag.carrier === ship.data.team;
    if (seenFlag && !mine) place(flagNode, seenFlag.x, seenFlag.z, distance(seenFlag.x, seenFlag.z));
    else show(flagNode, false);
  }

  private battery(path: string, label: string, chosen: boolean, reload: number): void {
    const panel = this.node.find(path)?.getBehavior(UIPanel);
    if (panel) {
      setColor(panel, "borderColor", chosen ? "#ffd966" : "#667080");
      if (panel.opacity !== (chosen ? 1 : 0.6)) panel.opacity = chosen ? 1 : 0.6;
    }
    this.text(`${path}/Label`, reload > 0 ? `${label}  ${reload.toFixed(1)}s` : `${label}  ready`);
    const fill = this.node.find(`${path}/Reload`)?.getBehavior(UIPanel);
    const width = `${Math.round((1 - reload / RELOAD) * 100)}%`;
    if (fill && fill.width !== width) fill.width = width;
  }

  private text(path: string, value: string): void {
    const t = this.node.find(path)?.getBehavior(UIText);
    if (t && t.text !== value) t.text = value;
  }
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

/** Show or hide a node, only when that changes. */
function show(node: GameObject | null | undefined, on: boolean): void {
  if (node && node.active !== on) node.setActive(on);
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
