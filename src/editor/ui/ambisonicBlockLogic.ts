// The Ambisonic block's logic (ADR 0162 §2.4, E6): the edits it makes to an audio clip's import
// settings and the warning it shows. Kept apart from the view so both are testable without a DOM.
import type { AmbisonicConvention, AmbisonicImport, ImportSettings } from "../../engine/scene/importSettings";

/** What an order choice reads: Auto infers it from the channel count, so the sidecar omits it. */
export type AmbisonicOrderChoice = "auto" | "1" | "2" | "3";

export const AMBISONIC_HELP = {
  block: "A recording of the whole sound field around a point. The engine turns it as the listener turns, so sounds stay where they were recorded.",
  order: "How finely the field is recorded. Auto reads it from the channel count (4 channels is 1st order, 9 is 2nd, 16 is 3rd).",
  convention: "The channel layout the recording was made in. AmbiX is the common one (ACN order, SN3D); FuMa is the older B-format.",
} as const;

export const orderChoice = (a: AmbisonicImport): AmbisonicOrderChoice => (a.order === null ? "auto" : (String(a.order) as AmbisonicOrderChoice));

/** The edit for the toggle: on is the defaults (the sidecar then holds `"ambisonic": {}`), off drops the key. */
export const toggleAmbisonic = (on: boolean): Pick<ImportSettings, "ambisonic"> => ({ ambisonic: on ? { order: null, convention: "ambix" } : null });

export function setAmbisonicOrder(a: AmbisonicImport, choice: AmbisonicOrderChoice): Pick<ImportSettings, "ambisonic"> {
  return { ambisonic: { ...a, order: choice === "auto" ? null : (Number(choice) as 1 | 2 | 3) } };
}

export const setAmbisonicConvention = (a: AmbisonicImport, convention: AmbisonicConvention): Pick<ImportSettings, "ambisonic"> => ({ ambisonic: { ...a, convention } });

/** The clip registry's message for a clip over 2 channels with no ambisonic setting; null otherwise. */
export function multichannelWarning(channels: number | null, ambisonic: AmbisonicImport | null): string | null {
  if (channels === null || channels <= 2 || ambisonic) return null;
  return `${channels}-channel audio needs an ambisonic import setting (ADR 0162); multichannel mixes aren't supported`;
}
