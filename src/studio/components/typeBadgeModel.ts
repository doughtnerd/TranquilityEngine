// Playlist type badges (ADR 0349 `TypeBadge`, ADR 0343 playlist types): the short code a tree row or the sound picker
// shows for a playlist's type (a Blend by its axis count) or a sample, its full name for the tooltip, and the series
// colour each kind is drawn in (`--series-1..8`, so Appearance themes them).
import type { PlaylistType } from "../../engine/audio/playlist/types";

export type BadgeCode = "QUE" | "SW" | "1D" | "2D" | "LAY" | "CLP" | "SEQ" | "SMP";

export interface BadgeInfo {
  readonly code: BadgeCode;
  /** The tooltip and accessible name ("Queue playlist"). */
  readonly name: string;
  /** Which `--series-N` colour it is drawn in. */
  readonly series: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
}

const BADGES: Readonly<Record<BadgeCode, BadgeInfo>> = {
  QUE: { code: "QUE", name: "Queue playlist", series: 1 },
  SW: { code: "SW", name: "Switch playlist", series: 2 },
  "1D": { code: "1D", name: "Blend playlist, one axis", series: 3 },
  "2D": { code: "2D", name: "Blend playlist, two axes", series: 4 },
  LAY: { code: "LAY", name: "Layer playlist", series: 5 },
  CLP: { code: "CLP", name: "Clip playlist", series: 6 },
  SEQ: { code: "SEQ", name: "Sequence", series: 7 },
  SMP: { code: "SMP", name: "Sample", series: 8 },
};

/** What a playlist's badge says. `axes` is a Blend's axis count (1 when unknown). */
export function playlistBadge(type: PlaylistType, axes: 1 | 2 = 1): BadgeInfo {
  switch (type) {
    case "queue":
      return BADGES.QUE;
    case "switch":
      return BADGES.SW;
    case "blend":
      return axes === 2 ? BADGES["2D"] : BADGES["1D"];
    case "layer":
      return BADGES.LAY;
    case "clip":
      return BADGES.CLP;
    case "sequence":
      return BADGES.SEQ;
  }
}

/** A sample's badge. */
export const sampleBadge = (): BadgeInfo => BADGES.SMP;

/** The badge for a code. */
export const badgeFor = (code: BadgeCode): BadgeInfo => BADGES[code];
