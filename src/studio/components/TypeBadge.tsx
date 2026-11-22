// A playlist type badge (ADR 0335 `TypeBadge`): QUE, SW, 1D, 2D, LAY, CLP, SEQ or SMP in its kind's series colour,
// named in full for its tooltip and screen readers. Shared by the sound picker and the Studio's trees.
import type { PlaylistType } from "../../engine/audio/playlist/types";
import { badgeFor, playlistBadge, sampleBadge, type BadgeCode, type BadgeInfo } from "./typeBadgeModel";
import "./audioParts.css";

export type TypeBadgeProps =
  | { readonly code: BadgeCode }
  | { readonly playlist: PlaylistType; readonly axes?: 1 | 2 }
  | { readonly sample: true };

export function TypeBadge(props: TypeBadgeProps) {
  const info: BadgeInfo = "code" in props ? badgeFor(props.code) : "playlist" in props ? playlistBadge(props.playlist, props.axes) : sampleBadge();
  return (
    <span class={`studio-badge studio-series-${info.series}`} title={info.name} aria-label={info.name} role="img">
      {info.code}
    </span>
  );
}
