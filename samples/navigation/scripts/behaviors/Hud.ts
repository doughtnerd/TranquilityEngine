import { GameBehavior, GameObject, Navigation, Text, Time, behavior } from "myco";
import type { AgentSpawner } from "../data";
import { Course } from "./Course";
import { Crowd } from "./Crowd";
import { GateTimer } from "./GateTimer";
import { GroupLeader } from "./GroupLeader";
import { Streamer } from "./Streamer";
import { Tour } from "./Tour";

const LABELS: Record<string, string> = {
  walker: "Walkers",
  flyer: "Flyers",
  walkFly: "Walk-and-fly",
  jumper: "Jumpers",
  climber: "Climbers",
  walkerGroup: "Walker group",
  flyerGroup: "Flyer group",
  walkFlyGroup: "Walk-and-fly group",
};

/** Every agent spawner in the current World (crowds, groups, courses). */
export function spawners(): AgentSpawner[] {
  return [...GameObject.findObjectsOfType(Crowd), ...GameObject.findObjectsOfType(GroupLeader), ...GameObject.findObjectsOfType(Course)];
}

/**
 * The status panel (on its node's Text): the loaded chunks, the goal, the gate, and each kind of agent with how
 * many are moving, waiting for a chunk to load, and have arrived. Rebuilt four times a second, not every frame.
 */
@behavior("navdemo.Hud")
export class Hud extends GameBehavior {
  private timer = 0;

  update(): void {
    this.timer -= Time.unscaledDeltaTime;
    if (this.timer > 0) return;
    this.timer = 0.25;
    const text = this.node.getBehavior(Text);
    if (text) text.text = this.lines().join("\n");
  }

  lines(): string[] {
    const lines: string[] = [];
    const streamer = Streamer.find();
    if (streamer) {
      const loaded = streamer.loadedNames;
      lines.push(`Chunks loaded (${loaded.length}/9): ${loaded.join(", ") || "none"}${streamer.streamByDistance ? "" : "  [streaming off]"}`);
    }
    lines.push(`Navigation: ${Navigation.isReady ? `${Navigation.loadedChunks.length} chunks in the runtime` : "loading…"}`);
    const tour = Tour.find();
    if (tour) lines.push(`Goal: ${tour.waypointName} (moves in ${Math.ceil(tour.timeLeft)} s)`);
    const gate = GateTimer.find();
    if (gate) lines.push(`Gate: ${gate.open ? "open" : "closed"} (${Math.ceil(gate.timeLeft)} s)`);
    const byKind = new Map<string, { agents: number; moving: number; waiting: number; arrivals: number }>();
    for (const s of spawners()) {
      const row = byKind.get(s.kind) ?? { agents: 0, moving: 0, waiting: 0, arrivals: 0 };
      for (const a of s.agents) {
        row.agents++;
        if (a.isWaitingForChunk) row.waiting++;
        else if (a.velocity.length > 0.3) row.moving++;
      }
      row.arrivals += s.arrivals;
      byKind.set(s.kind, row);
    }
    for (const [kind, r] of byKind) lines.push(`${LABELS[kind] ?? kind}: ${r.agents}  moving ${r.moving}  waiting ${r.waiting}  arrivals ${r.arrivals}`);
    lines.push("WASD pan · Q/E orbit · R/F tilt · Z/X zoom · C follow goal · G next goal · H gate · 1-9 chunks · 0 clear · L streaming");
    return lines;
  }
}
