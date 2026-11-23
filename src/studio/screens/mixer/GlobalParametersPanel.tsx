// The Global parameters panel (decision log D19: the game parameters' authoring home now that Project Settings > Audio
// is retiring): `audio.json`'s `parameters` as the ADR 0304 parameter cards (numeric with min, max, default and seek
// speed, or labelled with labels and a default). Each edit is one undo step of `audio.json` (the Mixer's document); a
// rename also renames the automation and snapshot conditions reading it (same step) and the playlists and events
// using it (the project file module, as a bus rename does). Playlist-local parameters stay in the Playlists inspector.
// The Mixer shows it beside its test values; the Playlists screen offers it in its panel catalog.
import type { ReadonlySignal } from "@preact/signals";
import type { AudioProject } from "../../../engine/audio/project/types";
import type { EditResult } from "../../../plugins/audio/editor/editResult";
import { ParameterCards } from "../../../plugins/audio/editor/ParameterCard";
import { globalParameterList, parameterUsesInMix, renamedParameter } from "./globalParameters";

/** What the panel edits through: the Mixer's session, or the Playlists screen's adapter over the same document. */
export interface GlobalParametersHost {
  readonly project: ReadonlySignal<AudioProject>;
  readonly readOnly: boolean;
  /** `audio.json`'s path, for `data-asset-document` (the History panel and Ctrl+Z follow it). */
  readonly path?: string;
  /** Apply an edit as one undo step of `audio.json` (a refusal is reported); whether it applied. */
  commit(result: EditResult<AudioProject>, label: string): boolean;
  /** After a rename applied: rename the parameter in the files outside `audio.json`. */
  renamed?(from: string, to: string): void;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The remove button's tooltip: what goes with the parameter. */
function removeTitle(p: AudioProject, name: string): string {
  const uses = parameterUsesInMix(p, name);
  const gone = [uses.automation && plural(uses.automation, "automation lane"), uses.conditions && plural(uses.conditions, "snapshot condition")].filter(Boolean);
  return `Remove ${name}${gone.length ? `, with the ${gone.join(" and ")} reading it` : ""}. Playlists that use it keep their settings (Undo brings it back).`;
}

export function GlobalParametersPanel(props: { host: GlobalParametersHost }) {
  const { host } = props;
  const p = host.project.value;
  return (
    <div class="mx-frame mx-global-params" data-asset-document={host.path} aria-label="Global parameters">
      <ParameterCards
        list={globalParameterList}
        holder={p}
        readOnly={host.readOnly}
        hint="What the game sets: snapshot conditions, automation and playlists read them"
        empty="No global parameters yet. Add one the game sets (a threat level, a surface, the time of day)."
        removeTitle={(q) => removeTitle(p, q.name)}
        apply={(result, label) => {
          const before = host.project.peek();
          if (!host.commit(result, label) || "refused" in result) return;
          const r = renamedParameter(before.parameters, result.next.parameters);
          if (r) host.renamed?.(r.from, r.to);
        }}
      />
    </div>
  );
}
