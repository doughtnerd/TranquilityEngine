// King of Pirates in a lobby (ADR 0068). project.json's "Lobby" template runs the lobby service;
// each room's match is a "Match" World (tagged "server" and "match") and each player's page joins it
// with a "MatchClient" World (tagged "client" and "match-client"). Neither template names a scene:
//
// - The match World loads the arena its room chose (`Match.current.settings.arena`), takes the
//   ship count and match length from the room's settings, gives each player's ship their room slot
//   as its team, names bots, tells every client the arena and the captains' names (RPCs), and when
//   the clock runs out shows the results for `LOBBY_RESULTS_SECONDS`, then ends the match with them
//   (`Match.current.end`): the players are back in their room, which shows the results.
// - The match client World loads the arena the server names and puts the captains' names and
//   "back to the harbour in…" on the HUD.
import { Connection, ConnectionState, GameObject, Match, SceneManager, defineRpc, defineSystem, str, u8, type MatchInfo } from "myco";
import { DEFAULT_SHIPS, MATCH_SECONDS, Phase, game, myShip, ships } from "./data";
import { Hud, setCaptainNames } from "./behaviors/Hud";
import { onMatchOver, setMatchLength, type MatchResult } from "./rules";
import { setPlayerTeam, setShipCount } from "./systems";

/** The arenas a room can choose (the lobby's `arena` setting), by key. */
export const ARENAS: readonly { readonly key: string; readonly name: string; readonly scene: string }[] = [
  { key: "bay", name: "Island Bay", scene: "scenes/island-bay.scene.json" },
  { key: "open", name: "Open Ocean", scene: "scenes/open-ocean.scene.json" },
  { key: "maze", name: "Rocky Maze", scene: "scenes/rocky-maze.scene.json" },
];

/** Match lengths a room can choose (the `length` setting, in seconds). */
export const MATCH_LENGTHS: readonly { readonly key: string; readonly name: string }[] = [
  { key: "120", name: "2 minutes" },
  { key: "180", name: "3 minutes" },
  { key: "300", name: "5 minutes" },
  { key: "480", name: "8 minutes" },
];

/** Ships in a match (the `ships` setting): players first, bots fill the rest. */
export const SHIP_COUNTS: readonly string[] = ["2", "3", "4", "5", "6", "7", "8"];

/** Bots' names, by team. */
export const BOT_NAMES: readonly string[] = ["Calico Jack", "Anne Bonny", "Blackbeard", "Mary Read", "Black Bart", "Grace O'Malley", "Ching Shih", "Red Legs"];

/** Seconds a lobby match shows its results before the players go back to their room. */
export const LOBBY_RESULTS_SECONDS = 8;

/** The arena for a room's settings (Island Bay when it names none). */
export function arenaOf(settings: Readonly<Record<string, string>> | null | undefined): (typeof ARENAS)[number] {
  return ARENAS.find((a) => a.key === settings?.arena) ?? ARENAS[0];
}

/** The ship count for a room's settings. */
export function shipsOf(settings: Readonly<Record<string, string>> | null | undefined): number {
  const n = Math.round(Number(settings?.ships));
  return Number.isFinite(n) && n >= 2 && n <= 8 ? n : DEFAULT_SHIPS;
}

/** The match length for a room's settings, in seconds. */
export function lengthOf(settings: Readonly<Record<string, string>> | null | undefined): number {
  const n = Number(settings?.length);
  return Number.isFinite(n) && n > 0 ? n : MATCH_SECONDS;
}

/** Server to client: the arena scene the match plays in. */
export const ArenaChosen = defineRpc("pirates.Arena", { scene: str });
/** Server to client: a captain's name, by team. */
export const CaptainNamed = defineRpc("pirates.Captain", { team: u8, name: str });

/** A ship's captain in a match: the player in that slot, or the bot's name. */
function captainName(match: MatchInfo, team: number, bot: boolean): string {
  if (bot) return BOT_NAMES[team % BOT_NAMES.length];
  return match.players.find((p) => p.slot === team && !p.bot)?.name || `Captain ${team + 1}`;
}

// --- the match World (server) -----------------------------------------------------------------------

// The room's settings decide the ship count; each player's ship sails under their slot's colours,
// and waits until the lobby has matched its connection to a player.
setShipCount(() => (Match.current ? shipsOf(Match.current.settings) : DEFAULT_SHIPS));
setPlayerTeam((connectionId) => {
  const match = Match.current;
  if (!match) return undefined;
  const player = match.players.find((p) => !p.bot && p.connectionId === connectionId);
  return player ? player.slot : "wait";
});

/** Each match's results, kept while they show. */
const pendingResults = new WeakMap<MatchInfo, Record<string, string>>();

onMatchOver((result: MatchResult) => {
  const match = Match.current;
  if (!match) return "restart"; // no lobby: show the results, then play again
  const order = result.order.map((r) => ({ ...r, name: captainName(match, r.team, r.bot) }));
  const out: Record<string, string> = { winner: order[0]?.name ?? "" };
  order.forEach((r, i) => (out[String(i + 1)] = `${r.name}${r.bot ? " (bot)" : ""}   ${r.score} pts   ${r.kills} sunk`));
  pendingResults.set(match, out);
  return "hold";
});

/** The room's match length, set before each World's clock runs (it's read when a match starts). */
defineSystem({
  name: "pirates.MatchLength",
  phase: "fixedUpdate",
  worlds: ["server"],
  before: ["pirates.Match"],
  run() {
    setMatchLength(Match.current ? lengthOf(Match.current.settings) : MATCH_SECONDS);
  },
});

interface ServerMatch {
  loading: boolean;
  /** Connections told the arena and the names. */
  told: Set<number>;
  /** The names last sent, to send again only when they change. */
  names: string;
}
const serverMatches = new WeakMap<object, ServerMatch>();

/**
 * A match World's setup and ending: loads the room's arena, names bots, tells clients the arena
 * and the captains, and ends the match once its results have shown.
 */
defineSystem({
  name: "pirates.LobbyMatch",
  phase: "update",
  worlds: ["match"],
  after: ["pirates.SpawnShips"],
  query: [Connection],
  run(rows, ctx) {
    const match = Match.current;
    if (!match || match.ended) return;
    let st = serverMatches.get(ctx.world);
    if (!st) serverMatches.set(ctx.world, (st = { loading: false, told: new Set(), names: "" }));
    const arena = arenaOf(match.settings);
    if (!st.loading) {
      st.loading = true;
      SceneManager.load(arena.scene).catch((err: Error) => console.error(`[pirates] The match couldn't load ${arena.scene}: ${err.message}`));
    }
    for (const p of match.players) if (p.bot && !p.name) p.name = BOT_NAMES[p.slot % BOT_NAMES.length];

    const captains = ships().map((s) => ({ team: s.data.team, name: captainName(match, s.data.team, s.data.bot !== 0) }));
    const key = captains.map((c) => `${c.team}:${c.name}`).join("|");
    const changed = key !== st.names;
    st.names = key;
    for (const row of rows) {
      const c = row.connection as { id: number; state: number };
      if (c.state !== ConnectionState.open) continue;
      const fresh = !st.told.has(c.id);
      if (fresh) {
        st.told.add(c.id);
        ArenaChosen.send({ scene: arena.scene }, row.node);
      }
      if (fresh || changed) for (const cap of captains) CaptainNamed.send(cap, row.node);
    }

    const g = game();
    const results = pendingResults.get(match);
    if (g && g.phase === Phase.over && results && g.results >= LOBBY_RESULTS_SECONDS) match.end(results);
  },
});

// --- the match client World -----------------------------------------------------------------------

interface ClientMatch {
  scene: string;
  names: Map<number, string>;
}
const clientMatches = new WeakMap<object, ClientMatch>();
/** Captains' names by the HUD they're shown on (one HUD per client World). */
const namesByHud = new WeakMap<Hud, ReadonlyMap<number, string>>();
setCaptainNames(() => {
  const hud = GameObject.findObjectOfType(Hud);
  return (hud && namesByHud.get(hud)) ?? new Map();
});

/** A match client World loads the arena the server names, and fills in the HUD's names and results note. */
defineSystem({
  name: "pirates.LobbyMatchClient",
  phase: "update",
  worlds: ["match-client"],
  run(_rows, ctx) {
    let st = clientMatches.get(ctx.world);
    if (!st) clientMatches.set(ctx.world, (st = { scene: "", names: new Map() }));
    for (const m of ArenaChosen.read()) {
      const arena = ARENAS.find((a) => a.scene === m.scene);
      if (!arena || st.scene === arena.scene) continue;
      st.scene = arena.scene;
      SceneManager.load(arena.scene).catch((err: Error) => console.error(`[pirates] The match couldn't load ${arena.scene}: ${err.message}`));
    }
    for (const m of CaptainNamed.read()) st.names.set(m.team, m.name);

    const hud = GameObject.findObjectOfType(Hud);
    if (!hud) return;
    const mine = myShip()?.data.team ?? -1;
    const names = new Map([...st.names].filter(([team]) => team !== mine)); // your own ship is "You"
    namesByHud.set(hud, names);
    const g = game();
    if (g?.phase === Phase.over) {
      const left = Math.max(0, Math.ceil(LOBBY_RESULTS_SECONDS - g.results));
      hud.resultsNote = left > 0 ? `Back to the harbour in ${left}` : "Back to the harbour";
    } else hud.resultsNote = null;
  },
});
