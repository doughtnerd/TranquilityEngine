/**
 * Match Worlds (ADR 0068): the server World a lobby creates for each game. `Match.current` in a
 * match World says which room it's for, its settings and its players; `end(results)` hands the
 * players back to their room.
 *
 * The match World admits only connections whose handshake carries a ticket the lobby issued for
 * it (one per player, used once; `NetSession.admit`). Each frame (`engine.MatchUpdate`) it matches
 * open connections to players by ticket, filling in `connectionId`. It ends on its own if no player
 * connects within `joinTimeout` (30 s), or once every human who connected has left; the lobby then
 * destroys it.
 */
import { World } from "../../core/World";
import { ensureSession, netSession } from "../session";

/** One player slot of a match. */
export interface MatchPlayer {
  /** The player's slot in the room (0-based). */
  readonly slot: number;
  /** The member's name; for a bot, whatever the game names it (empty until then). */
  name: string;
  /** True for a slot the lobby filled with a bot (`fillWithBots`). */
  readonly bot: boolean;
  /** The id of this player's connection (`Connection.id`) once it's open; 0 before, after it closes, and for bots. */
  readonly connectionId: number;
}

/** A match World's view of its match (`Match.current`). */
export interface MatchInfo {
  /** The match's id (its World is named `Match <id>`). */
  readonly id: number;
  /** The room it was started from. */
  readonly roomId: number;
  /** The room's settings when it started. */
  readonly settings: Readonly<Record<string, string>>;
  /** One per slot, by slot: the room's members, and bots in empty slots when the lobby fills them. */
  readonly players: readonly MatchPlayer[];
  /** True once `end` was called (or the match ended on its own). */
  readonly ended: boolean;
  /** Close the match: its players go back to their room, which gets `results` (e.g. `{ winner: "Anne" }`). */
  end(results?: Readonly<Record<string, string>>): void;
}

class Player implements MatchPlayer {
  connectionId = 0;
  /** Its connection has been open at some point. */
  joined = false;
  constructor(
    readonly slot: number,
    public name: string,
    readonly bot: boolean,
    readonly ticket: string,
  ) {}
}

/** @internal A match World's state. */
export class MatchState implements MatchInfo {
  ended = false;
  results: Record<string, string> = {};
  /** Why it ended on its own ("" if the game ended it). */
  endReason = "";
  readonly players: Player[];
  private readonly used = new Set<string>();
  private readonly startedAt: number;

  constructor(
    readonly world: World,
    readonly id: number,
    readonly roomId: number,
    readonly settings: Readonly<Record<string, string>>,
    players: readonly { slot: number; name: string; bot: boolean; ticket: string }[],
    readonly joinTimeout: number,
    /** False once the lobby that made it is gone: the match then destroys itself. */
    readonly lobbyAlive: () => boolean,
    readonly destroySelf: () => void,
  ) {
    this.players = players.map((p) => new Player(p.slot, p.name, p.bot, p.ticket));
    this.startedAt = world.time.realtimeSinceStartup;
    // Only connections with an unused ticket for this match get in.
    ensureSession(world).admit = (ticket) => {
      const player = ticket ? this.players.find((p) => !p.bot && p.ticket === ticket) : undefined;
      if (!player) return `The match World "${world.name}" only admits players with a ticket from its lobby.`;
      if (this.used.has(ticket)) return `That ticket for "${world.name}" was already used (a match can't be rejoined).`;
      this.used.add(ticket);
      return null;
    };
  }

  end(results: Readonly<Record<string, string>> = {}): void {
    if (this.ended) return;
    this.ended = true;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(results ?? {})) out[String(k)] = String(v);
    this.results = out;
  }

  /** `engine.MatchUpdate`: connections to players, and ending on its own. */
  update(): void {
    if (!this.lobbyAlive()) {
      this.end();
      this.destroySelf();
      return;
    }
    if (this.ended) return;
    const peers = netSession(this.world)?.openPeers() ?? [];
    const humans = this.players.filter((p) => !p.bot);
    for (const p of humans) {
      const peer = peers.find((x) => x.ticket === p.ticket && x.node?.isValid);
      p.connectionId = peer ? peer.id : 0;
      if (peer) p.joined = true;
    }
    const joined = humans.filter((p) => p.joined);
    if (joined.length === 0) {
      if (this.world.time.realtimeSinceStartup - this.startedAt > this.joinTimeout) {
        this.endReason = `No player joined within ${this.joinTimeout} s.`;
        this.end();
      }
    } else if (humans.every((p) => p.connectionId === 0)) {
      this.endReason = "Every player left.";
      this.end();
    }
  }
}

const matches = new WeakMap<World, MatchState>();

/** @internal Make `world` a match World. */
export function _setMatch(world: World, state: MatchState): void {
  matches.set(world, state);
}

/** @internal The match state of `world`, if it's a match World. */
export function _matchOf(world: World): MatchState | null {
  return matches.get(world) ?? null;
}

/**
 * Match Worlds (ADR 0068). `Match.current` is the current World's match, or null in a World a
 * lobby didn't create for a match.
 *
 * ```ts
 * const match = Match.current;
 * for (const p of match?.players ?? []) if (p.bot) p.name = `Captain ${p.slot + 1}`;
 * match?.end({ winner: "Anne" });
 * ```
 */
export class Match {
  private constructor() {}

  /** The current World's match, or null if it isn't a match World. */
  static get current(): MatchInfo | null {
    const world = World.active;
    return world ? (matches.get(world) ?? null) : null;
  }
}
