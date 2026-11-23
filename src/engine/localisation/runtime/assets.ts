/**
 * Localised textures and fonts at runtime (ADR 0356 §10, T5): keeps `Assets`' language (the asset roots and the current
 * language's fallback chain, `setAssetLanguage`) in step with `Locale`, and takes part in its atomic switch:
 *
 * - **Preload** (a language participant): before a switch commits, the variants the new language resolves to for every
 *   localised reference loaded so far are fetched (bounded to 3 s, as fonts are), so swapping them doesn't wait on the
 *   network.
 * - **Swap**: when the language changes, every such reference whose variant changed is announced with
 *   `Assets.notifyChanged`, the signal runtimes that cache an asset's contents already drop it on; a texture or font
 *   loaded from then on is the new language's. Assets nothing has loaded yet resolve when they load.
 *
 * A pseudo-language resolves as the reference language. Nothing here is public API.
 */
import { Assets, fetchAssetBytes, localisedAssetRefs, setAssetLanguage } from "../../scene/Assets";
import { fallbackChain, type LanguageSettings } from "../languages";
import { isPseudoLanguage } from "../pseudo";
import { variantPath } from "../variants";
import { registerLanguageParticipant } from "./participants";

let settings: LanguageSettings | null = null;
/** The chain assets resolve through now. */
let assetChain: string[] | null = null;

/** The chain assets resolve through in language `code`. */
const chainOf = (s: LanguageSettings, code: string): string[] => fallbackChain(s, isPseudoLanguage(code) ? s.reference : code);

/** The file `ref` loads in `chain`. */
function variantOf(ref: string, s: LanguageSettings, chain: readonly string[]): string {
  return variantPath(ref, chain, s.assetRoots, (p) => Assets.has(p))?.path ?? ref;
}

/**
 * @internal `Locale` changed language (or was configured): assets resolve in `code` from now on, and the localised
 * references loaded so far whose file changed are announced (`Assets.notifyChanged`).
 */
export function localiseAssets(s: LanguageSettings, code: string): void {
  const previous = settings;
  const refs = localisedAssetRefs();
  const before = previous ? new Map(refs.map((r) => [r, variantOf(r, previous, assetChain ?? [])])) : null;
  settings = s;
  assetChain = chainOf(s, code);
  setAssetLanguage(s.assetRoots, assetChain);
  if (!before) return;
  for (const r of refs) if (before.get(r) !== variantOf(r, s, assetChain)) Assets.notifyChanged(r);
}


/** How long a switch waits for its textures and fonts to preload (ADR 0356 §5's font bound). */
const PRELOAD_TIMEOUT_MS = 3000;

/** Fetch the variants language `code` resolves to for the references loaded so far; settles within the bound. */
function preloadLanguage(code: string): Promise<void> {
  const s = settings;
  if (!s || s.assetRoots.length === 0) return Promise.resolve();
  const chain = chainOf(s, code);
  const current = assetChain ?? [];
  const urls = new Set<string>();
  for (const ref of localisedAssetRefs()) {
    const next = variantOf(ref, s, chain);
    if (next === variantOf(ref, s, current)) continue;
    let url: unknown;
    try {
      url = Assets.get(next);
    } catch {
      continue;
    }
    if (typeof url === "string") urls.add(url);
  }
  const loads = [...urls].map((url) => fetchAssetBytes(url).catch(() => undefined));
  if (loads.length === 0) return Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, PRELOAD_TIMEOUT_MS)));
  return Promise.race([Promise.all(loads).then(() => undefined), timeout]).finally(() => clearTimeout(timer));
}

registerLanguageParticipant({ name: "assets", prepare: preloadLanguage });
