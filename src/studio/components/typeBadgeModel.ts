// Playlist type badges (ADR 0349 `TypeBadge`, ADR 0343 playlist types): the short code a tree row or the sound picker
// shows for a playlist's type (a Blend by its axis count) or a sample, its full name for the tooltip, and the colour
// tone each kind is drawn in (ui-pass decisions, following the owner's prototype: CLP violet, QUE pink, SW amber, 1D
// teal, 2D green, SEQ blue, LAY neutral; theme tokens, so Appearance themes them). "—" is the placeholder of an empty
// sound chip (nothing picked yet).
import type { PlaylistType } from "../../engine/audio/playlist/types";

export type BadgeCode = "QUE" | "SW" | "1D" | "2D" | "LAY" | "CLP" | "SEQ" | "SMP" | "—";

/** A badge's colour: one per kind, `neutral` for the layer, a sample and the placeholder. */
export type BadgeTone = "clip" | "queue" | "switch" | "blend1" | "blend2" | "sequence" | "layer" | "sample" | "none";

export interface BadgeInfo {
  readonly code: BadgeCode;
  /** The tooltip and accessible name ("Queue playlist"). */
  readonly name: string;
  /** Its colour (`.studio-badge.tone-<tone>`). */
  readonly tone: BadgeTone;
}

const BADGES: Readonly<Record<BadgeCode, BadgeInfo>> = {
  QUE: { code: "QUE", name: "Queue playlist", tone: "queue" },
  SW: { code: "SW", name: "Switch playlist", tone: "switch" },
  "1D": { code: "1D", name: "Blend playlist, one axis", tone: "blend1" },
  "2D": { code: "2D", name: "Blend playlist, two axes", tone: "blend2" },
  LAY: { code: "LAY", name: "Layer playlist", tone: "layer" },
  CLP: { code: "CLP", name: "Clip playlist", tone: "clip" },
  SEQ: { code: "SEQ", name: "Sequence", tone: "sequence" },
  SMP: { code: "SMP", name: "Sample", tone: "sample" },
  "—": { code: "—", name: "No sound", tone: "none" },
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

/** The placeholder badge of an empty sound chip ("—", "No sound"). */
export const placeholderBadge = (): BadgeInfo => BADGES["—"];

/** The badge for a code. */
export const badgeFor = (code: BadgeCode): BadgeInfo => BADGES[code];
