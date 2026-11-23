/**
 * Which file a line key plays now (ADR 0354 §5): its table row (`lineRegistry.ts`) and its file in the current audio
 * language's fallback chain (`lineFile`: an explicit `files[c]`, else `<root>/<c>/<folder>/<file ?? key>.<ext>`).
 */
import { Assets } from "../../../../engine/scene/Assets";
import { lineFile, type LineFile, type LineLocation } from "../../../../engine/audio/localisation/lines/resolve";
import { audioChain, audioLocalisation } from "./languageState";
import { lineLocation } from "./lineRegistry";

export interface ResolvedLine {
  readonly key: string;
  readonly loc: LineLocation;
  /** The file and the language it is in; null when no language of the chain has one (0354 §3). */
  readonly file: LineFile | null;
}

const has = (p: string): boolean => Assets.has(p);

/** The line `key` in the current audio language; null when no line table defines the key. */
export function resolveLine(key: string): ResolvedLine | null {
  const loc = lineLocation(key);
  if (!loc) return null;
  return { key, loc, file: lineFile(loc.table, loc.line, audioChain(), audioLocalisation().roots, has) };
}
