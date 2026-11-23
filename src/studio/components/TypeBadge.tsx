// A playlist type badge (ADR 0349 `TypeBadge`): QUE, SW, 1D, 2D, LAY, CLP, SEQ or SMP in its kind's colour, named in
// full for its tooltip and screen readers, or the "—" placeholder of an empty sound chip (`placeholder`, or
// `code="—"`; `title` names it, default "No sound"). Shared by the sound picker and the Studio's trees.
import type { PlaylistType } from "../../engine/audio/playlist/types";
import { badgeFor, placeholderBadge, playlistBadge, sampleBadge, type BadgeCode, type BadgeInfo } from "./typeBadgeModel";
import "./audioParts.css";

export type TypeBadgeProps = (
  | { readonly code: BadgeCode }
  | { readonly playlist: PlaylistType; readonly axes?: 1 | 2 }
  | { readonly sample: true }
  | { readonly placeholder: true }
) & {
  /** Its tooltip and accessible name instead of the kind's ("Nothing picked yet"). */
  readonly title?: string;
};

function infoOf(props: TypeBadgeProps): BadgeInfo {
  if ("code" in props) return badgeFor(props.code);
  if ("playlist" in props) return playlistBadge(props.playlist, props.axes);
  if ("placeholder" in props) return placeholderBadge();
  return sampleBadge();
}

export function TypeBadge(props: TypeBadgeProps) {
  const info = infoOf(props);
  const name = props.title ?? info.name;
  return (
    <span class={`studio-badge tone-${info.tone}`} title={name} aria-label={name} role="img">
      {info.code}
    </span>
  );
}
