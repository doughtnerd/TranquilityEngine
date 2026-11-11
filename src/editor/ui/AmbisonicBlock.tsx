// The Ambisonic block of an audio clip's import settings (ADR 0162 §2.4, E6).
import { useEffect, useState } from "preact/hooks";
import type { AmbisonicConvention } from "../../engine/scene/importSettings";
import type { ImportSettingsViewProps } from "../sdk/contributions";
import { audioSummaryFor } from "../thumbnails";
import { AMBISONIC_HELP, multichannelWarning, orderChoice, setAmbisonicConvention, setAmbisonicOrder, toggleAmbisonic, type AmbisonicOrderChoice } from "./ambisonicBlockLogic";
import "./assetInspector.css";

/** The clip's channel count, once read; null while unknown. */
function useChannels(path: string): number | null {
  const [channels, setChannels] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    setChannels(null);
    audioSummaryFor(path).then(
      (s) => live && setChannels(s?.channels ?? null),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [path]);
  return channels;
}

export function AmbisonicBlock(props: Pick<ImportSettingsViewProps, "path" | "draft" | "set">) {
  const { draft, set } = props;
  const channels = useChannels(props.path);
  const a = draft.ambisonic;
  const warning = multichannelWarning(channels, a);
  return (
    <>
      <label class="import-row" title={AMBISONIC_HELP.block}>
        <span>Ambisonic</span>
        <input type="checkbox" aria-label="Ambisonic" checked={!!a} onChange={(e) => set(toggleAmbisonic((e.currentTarget as HTMLInputElement).checked))} />
      </label>
      {channels !== null && (
        <div class="import-row">
          <span>Channels</span>
          <span>{channels}</span>
        </div>
      )}
      {a && (
        <>
          <label class="import-row" title={AMBISONIC_HELP.order}>
            <span>Order</span>
            <select aria-label="Ambisonic order" value={orderChoice(a)} onChange={(e) => set(setAmbisonicOrder(a, (e.currentTarget as HTMLSelectElement).value as AmbisonicOrderChoice))}>
              <option value="auto">Auto</option>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
            </select>
          </label>
          <label class="import-row" title={AMBISONIC_HELP.convention}>
            <span>Convention</span>
            <select aria-label="Ambisonic convention" value={a.convention} onChange={(e) => set(setAmbisonicConvention(a, (e.currentTarget as HTMLSelectElement).value as AmbisonicConvention))}>
              <option value="ambix">AmbiX</option>
              <option value="fuma">FuMa</option>
            </select>
          </label>
        </>
      )}
      {warning && (
        <p class="asset-inspector-problems" role="alert">
          {warning}
        </p>
      )}
    </>
  );
}
