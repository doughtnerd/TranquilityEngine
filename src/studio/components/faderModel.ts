// A fader's rules (ADR 0335 `Fader`, ADR 0330 "Gain"): levels in dB from −60 (silence) to +6 in 0.5 dB steps, drawn
// linear in dB along the track as the prototype's mixer does (0 dB sits at 60/66 of the travel), the keys a slider
// has, and how a level is written ("−∞" at the floor, a signed figure otherwise).
import { MIN_DB } from "../../engine/audio/project/gain";

/** The fader's floor, silence (the mix's `MIN_DB`). */
export const FADER_MIN_DB = MIN_DB;
/** The fader's top. */
export const FADER_MAX_DB = 6;
/** One step, dB. */
export const FADER_STEP_DB = 0.5;
/** Shift+arrow and Page Up/Down move this far, dB. */
export const FADER_BIG_STEP_DB = 3;
/** What a double-click and the 0 key return to. */
export const FADER_UNITY_DB = 0;

const SPAN = FADER_MAX_DB - FADER_MIN_DB;

/** `db` held to the fader's range. */
export const clampFaderDb = (db: number): number => (Number.isFinite(db) ? Math.min(FADER_MAX_DB, Math.max(FADER_MIN_DB, db)) : db === Infinity ? FADER_MAX_DB : FADER_MIN_DB);

/** `db` on the fader's 0.5 dB grid, within its range. */
export const snapFaderDb = (db: number): number => clampFaderDb(Math.round(clampFaderDb(db) / FADER_STEP_DB) * FADER_STEP_DB) + 0;

/** Where `db` sits along the travel, 0 (floor) to 1 (top). A level outside the range sits at its end. */
export const dbToPosition = (db: number): number => (clampFaderDb(db) - FADER_MIN_DB) / SPAN;

/** The level at `position` (0..1 along the travel), snapped to the grid. */
export const positionToDb = (position: number): number => snapFaderDb(FADER_MIN_DB + Math.min(1, Math.max(0, position)) * SPAN);

/**
 * The level a pointer at `(x, y)` sets on a fader whose track is `rect`: left to right for a horizontal fader, bottom
 * to top for a vertical one.
 */
export function pointerToDb(rect: { left: number; top: number; width: number; height: number }, x: number, y: number, orientation: "horizontal" | "vertical"): number {
  if (orientation === "horizontal") return positionToDb(rect.width > 0 ? (x - rect.left) / rect.width : 0);
  return positionToDb(rect.height > 0 ? 1 - (y - rect.top) / rect.height : 0);
}

/**
 * The level a key moves `db` to, or null when the key isn't a fader key: arrows step 0.5 dB (Shift 3 dB), Page Up and
 * Page Down 3 dB, Home the top, End the floor, 0 unity.
 */
export function faderKey(db: number, key: string, shift = false): number | null {
  const step = shift ? FADER_BIG_STEP_DB : FADER_STEP_DB;
  switch (key) {
    case "ArrowUp":
    case "ArrowRight":
      return snapFaderDb(db + step);
    case "ArrowDown":
    case "ArrowLeft":
      return snapFaderDb(db - step);
    case "PageUp":
      return snapFaderDb(db + FADER_BIG_STEP_DB);
    case "PageDown":
      return snapFaderDb(db - FADER_BIG_STEP_DB);
    case "Home":
      return FADER_MAX_DB;
    case "End":
      return FADER_MIN_DB;
    case "0":
      return FADER_UNITY_DB;
    default:
      return null;
  }
}

/** A level as the mixer writes it: "−∞" at or below the floor, else signed with one decimal ("+3.0", "−6.5", "0.0"). */
export function formatDb(db: number): string {
  if (!(db > FADER_MIN_DB)) return "−∞";
  const r = Math.round(db * 10) / 10;
  if (r === 0) return "0.0";
  return `${r > 0 ? "+" : "−"}${Math.abs(r).toFixed(1)}`;
}

/** A typed level: a number (a leading "+", "−" or "-" allowed, "dB" ignored) or "-inf"/"−∞" for the floor; null otherwise. Snapped. */
export function parseDb(text: string): number | null {
  const t = text.trim().replace(/db$/i, "").trim().replace(/^−/, "-");
  if (/^-?(inf|∞)$/i.test(t)) return FADER_MIN_DB;
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? snapFaderDb(n) : null;
}

/** A second level a fader draws as a tick (ADR 0330): the level with VCAs, or the base level while a snapshot is edited. */
export interface FaderGhost {
  readonly db: number;
  /** What it is, as the tick's tooltip ("With VCAs: −6.0 dB"). */
  readonly title?: string;
  /** Which tick; each kind has its own colour, so both can show at once. */
  readonly kind: "vca" | "base";
}

/**
 * The ticks a fader draws from its props: the single `ghostDb` (drawn as a VCA tick, its original meaning) and then
 * `ghosts`. A tick that isn't a number is left out, and so is a second tick of a kind already drawn (the first wins).
 */
export function faderGhosts(ghostDb: number | null | undefined, ghostTitle: string | undefined, ghosts: readonly FaderGhost[] | null | undefined): FaderGhost[] {
  const all: FaderGhost[] = ghostDb != null ? [{ db: ghostDb, title: ghostTitle, kind: "vca" }] : [];
  for (const g of ghosts ?? []) all.push(g);
  const out: FaderGhost[] = [];
  for (const g of all) if (typeof g.db === "number" && !Number.isNaN(g.db) && !out.some((x) => x.kind === g.kind)) out.push(g);
  return out;
}
