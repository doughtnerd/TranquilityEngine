// "In this take" (ADR 0348 "The Take screen"; the prototype's Playlists in this take, spec §4.5.3): each playlist the open
// take plays, as one row button (its folder / name, its instance count) that opens it on Playlists.
import { EmptyState } from "../../../editor/ui/EmptyState";

export interface PlaylistInTakeRow {
  readonly path: string;
  /** Folder / name ("events / engine"). */
  readonly label: string;
  readonly count: number;
}

export interface PlaylistsInTakeProps {
  /** The rows; null with no take open. */
  readonly rows: readonly PlaylistInTakeRow[] | null;
  onOpen(path: string): void;
}

export function PlaylistsInTake(props: PlaylistsInTakeProps) {
  if (!props.rows) return <EmptyState compact title="No take open" body="The playlists, events and samples a take plays show here, each with its instance count." />;
  if (props.rows.length === 0) return <p class="tk-note">This take plays nothing.</p>;
  return (
    <ul class="tk-playlists" aria-label="Playlists in this take">
      {props.rows.map((r) => (
        <li key={r.path}>
          <button type="button" class="tk-pl-row" title={`Open in Playlists: ${r.path}`} onClick={() => props.onOpen(r.path)}>
            <span class="tk-pl-name">{r.label}</span>
            <span class="tk-pl-count">{r.count === 1 ? "1 instance" : `${r.count} instances`}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
