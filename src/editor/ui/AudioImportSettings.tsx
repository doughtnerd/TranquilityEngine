// An audio clip's import settings (ADR 0040): the core `audio` kind's `importSettings` (ADR 0143),
// loaded the first time a clip is inspected. Its preview is the clip player (`AudioPreview`).
import type { ImportSettingsViewProps } from "../sdk/contributions";
import "./assetInspector.css";

/** The Import Settings card's rows for an audio clip. */
export function AudioImportSettings(props: ImportSettingsViewProps) {
  const { draft, set } = props;
  return (
    <>
        <label class="import-row">
          <span>Volume</span>
          <input
            type="number"
            min={0}
            step={0.05}
            aria-label="Volume"
            value={draft.volume}
            onChange={(e) => {
              const v = Number((e.currentTarget as HTMLInputElement).value);
              set({ volume: Number.isFinite(v) && v >= 0 ? v : 1 });
            }}
          />
        </label>
        <label class="import-row">
          <span>Stream</span>
          <input type="checkbox" aria-label="Stream" title="Decode in pieces while it plays instead of loading whole, for long music" checked={draft.stream} onChange={(e) => set({ stream: (e.currentTarget as HTMLInputElement).checked })} />
        </label>
    </>
  );
}
