// Action set assets in the editor (ADR 0433): the `*.actions.json` format as an asset kind reads it, the edits the
// Input dialog's set view makes (each a new value, so one history step), and the networking estimate it shows. The
// format's problems are the engine's own (`actionSetProblems`), so the editor says what the boot would log.
import { actionSetProblems, type ActionSetFile, type ActionSetFileAction } from "../engine/input/actionAssets";
import type { ActionKind } from "../engine/input/actions";
import type { AssetFormat, AssetProblem } from "./sdk/contributions";

export const ACTION_KINDS: readonly ActionKind[] = ["button", "axis", "vec2", "vec3"];

/** What each type reads, for the type menus. */
export const ACTION_KIND_LABELS: Record<ActionKind, string> = { button: "button (0 to 1)", axis: "axis (−1 to 1)", vec2: "vec2 (two axes)", vec3: "vec3 (three axes)" };

/** The value of a set made with New Action Set: one button, so the file is valid and shows "not mapped" at once. */
export const newActionSet = (id = "game.New"): ActionSetFile => ({ id, actions: [{ name: "action", type: "button" }] });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A file's JSON to a set. Anything readable is kept as written (an unknown field stays, reported), actions that
 * aren't objects are dropped; every problem `actionSetProblems` finds is reported with its field.
 */
export function parseActionSet(raw: unknown, path: string): { value: ActionSetFile; problems: AssetProblem[] } {
  if (raw === undefined) return { value: newActionSet(), problems: [] };
  if (!isRecord(raw)) return { value: { id: "", actions: [] }, problems: [{ message: `${path} isn't an action set: it should be an object with "id" and "actions".` }] };
  const actions = (Array.isArray(raw.actions) ? raw.actions : []).filter(isRecord).map((a) => ({ ...a, name: typeof a.name === "string" ? a.name : "", type: a.type }) as ActionSetFileAction);
  const value = { ...raw, id: typeof raw.id === "string" ? raw.id : "", actions } as ActionSetFile;
  return { value, problems: actionSetProblems(raw).map((p) => ({ message: p.field ? `${p.field}: ${p.message}` : p.message })) };
}

export const formatActionSet = (spec: ActionSetFile): string => `${JSON.stringify(spec, null, 2)}\n`;

export const actionSetFormat: AssetFormat<ActionSetFile> = { parse: parseActionSet, format: formatActionSet, empty: newActionSet, writeDelay: 300 };

// --- reading -------------------------------------------------------------------------------------

/** The set's actions A to Z by name (the file keeps the user's order). */
export const sortedActions = (spec: ActionSetFile): ActionSetFileAction[] => [...spec.actions].sort((a, b) => a.name.localeCompare(b.name));

/** The name in system rows when `key` isn't given: the id's last part, camel-cased (`game.PlayerActions` → `playerActions`), as `defineActions` makes it. */
export function defaultKey(id: string): string {
  const last = id.slice(id.lastIndexOf(".") + 1);
  return last ? last[0].toLowerCase() + last.slice(1) : "";
}

/** `base`, or `base2`, `base3`… : the first name no action of the set has. */
export function freeActionName(spec: ActionSetFile, base = "action"): string {
  const taken = new Set(spec.actions.map((a) => a.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`;
}

const ID = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Why `id` can't be a set's id (dotted names, not another set's), or null. */
export function whyNotSetId(id: string, others: readonly string[]): string | null {
  if (!ID.test(id)) return 'Use dotted names, like "game.PlayerActions".';
  if (others.includes(id)) return `Another set is called ${id}.`;
  return null;
}

/** Why `name` can't be an action's name in `spec` (letters, digits, underscores; unique in the set), or null. */
export function whyNotActionName(spec: ActionSetFile, name: string, current?: string): string | null {
  if (!NAME.test(name)) return "Use letters, digits and underscores, starting with a letter.";
  if (name !== current && spec.actions.some((a) => a.name === name)) return `The set already has an action called ${name}.`;
  return null;
}

// --- edits ---------------------------------------------------------------------------------------

const withActions = (spec: ActionSetFile, actions: ActionSetFileAction[]): ActionSetFile => ({ ...spec, actions });
const mapAction = (spec: ActionSetFile, name: string, f: (a: ActionSetFileAction) => ActionSetFileAction) => withActions(spec, spec.actions.map((a) => (a.name === name ? f(a) : a)));

/** `encoding` without `name`'s entry; the key goes when it's left empty. */
function withoutEncoding(spec: ActionSetFile, name: string): ActionSetFile {
  if (!spec.encoding || !(name in spec.encoding)) return spec;
  const { [name]: _, ...rest } = spec.encoding;
  const out: Record<string, unknown> = { ...spec, encoding: rest };
  if (Object.keys(rest).length === 0) delete out.encoding;
  return out as unknown as ActionSetFile;
}

export const setSetId = (spec: ActionSetFile, id: string): ActionSetFile => ({ ...spec, id });

/** The name in system queries; "" (or the default) drops the key. */
export function setSetKey(spec: ActionSetFile, key: string): ActionSetFile {
  const out: Record<string, unknown> = { ...spec };
  if (!key || key === defaultKey(spec.id)) delete out.key;
  else out.key = key;
  return out as unknown as ActionSetFile;
}

export const addAction = (spec: ActionSetFile, name: string, type: ActionKind): ActionSetFile => withActions(spec, [...spec.actions, { name, type }]);

export const removeAction = (spec: ActionSetFile, name: string): ActionSetFile => withoutEncoding(withActions(spec, spec.actions.filter((a) => a.name !== name)), name);

/** Rename an action; its encoding goes with it. */
export function renameAction(spec: ActionSetFile, from: string, to: string): ActionSetFile {
  if (from === to) return spec;
  const renamed = mapAction(spec, from, (a) => ({ ...a, name: to }));
  const enc = spec.encoding?.[from];
  if (!enc) return renamed;
  const { [from]: _, ...rest } = spec.encoding!;
  return { ...renamed, encoding: { ...rest, [to]: enc } };
}

/** Change an action's type. A button takes no precision, so its encoding goes. */
export function setActionType(spec: ActionSetFile, name: string, type: ActionKind): ActionSetFile {
  const next = mapAction(spec, name, (a) => ({ ...a, type }));
  return type === "button" ? withoutEncoding(next, name) : next;
}

/** An action's consume: undefined follows the default (yes). */
export function setActionConsume(spec: ActionSetFile, name: string, consume: boolean | undefined): ActionSetFile {
  return mapAction(spec, name, (a) => {
    const out: Record<string, unknown> = { ...a };
    if (consume === undefined) delete out.consume;
    else out.consume = consume;
    return out as unknown as ActionSetFileAction;
  });
}

export function setNetworked(spec: ActionSetFile, networked: boolean): ActionSetFile {
  const out: Record<string, unknown> = { ...spec };
  if (networked) out.networked = true;
  else delete out.networked;
  return out as unknown as ActionSetFile;
}

/** Resent ticks; undefined drops the key (the engine's default, `DEFAULT_REDUNDANCY`). */
export function setRedundancy(spec: ActionSetFile, redundancy: number | undefined): ActionSetFile {
  const out: Record<string, unknown> = { ...spec };
  if (redundancy === undefined) delete out.redundancy;
  else out.redundancy = redundancy;
  return out as unknown as ActionSetFile;
}

/** An analog action's precision (its quantize step); undefined sends it exact. */
export function setPrecision(spec: ActionSetFile, name: string, quantize: number | undefined): ActionSetFile {
  if (quantize === undefined) return withoutEncoding(spec, name);
  return { ...spec, encoding: { ...spec.encoding, [name]: { quantize } } };
}

// --- networking estimate -------------------------------------------------------------------------

/** Past ticks a networked set resends when it doesn't say (`DEFAULT_INPUT_REDUNDANCY` in net/input.ts). */
export const DEFAULT_REDUNDANCY = 3;

/** The precisions the set view offers: exact, or a quantize step for a value in −1..1 read as 16 or 8 bits of steps. */
export const PRECISIONS: readonly { readonly label: string; readonly quantize: number | undefined }[] = [
  { label: "Exact (32-bit)", quantize: undefined },
  { label: "16-bit", quantize: 1 / 32767 },
  { label: "8-bit", quantize: 1 / 127 },
];

/** Bytes of a LEB128 varint (7 bits a byte) holding the unsigned `n`. */
const varUintBytes = (n: number): number => Math.max(1, Math.ceil(Math.log2(n + 1) / 7));

const COMPONENTS: Record<ActionKind, number> = { button: 1, axis: 1, vec2: 2, vec3: 3 };

/**
 * The bytes one action adds to one input record at most, as `recordCodec` (net/codec.ts) writes a full record (no
 * delta against a baseline, which only makes it smaller):
 *
 *   bytes = components × valueBytes + phaseBytes
 *   valueBytes = 4 (an f32) exact, or varint(zigzag(round(1 / quantize))) for a quantized value in −1..1
 *   phaseBytes = varint(zigzag(511)) = 2 (the phase flags, an i32 written as a zigzag varint)
 *
 * A button's value is an f32 in 0..1 and is never quantized.
 */
export function actionUploadBytes(type: ActionKind, quantize?: number): number {
  const value = type !== "button" && quantize !== undefined && quantize > 0 ? varUintBytes(2 * Math.round(1 / quantize)) : 4;
  return COMPONENTS[type] * value + varUintBytes(2 * 511);
}

/** Each action's bytes per input, the set's bytes per input, and per packet: every packet carries the newest input and `redundancy` before it. */
export function uploadEstimate(spec: ActionSetFile): { perAction: Map<string, number>; perInput: number; perPacket: number; redundancy: number } {
  const perAction = new Map<string, number>();
  let perInput = 0;
  for (const a of spec.actions) {
    if (!ACTION_KINDS.includes(a.type)) continue;
    const bytes = actionUploadBytes(a.type, spec.encoding?.[a.name]?.quantize);
    perAction.set(a.name, bytes);
    perInput += bytes;
  }
  const redundancy = spec.redundancy ?? DEFAULT_REDUNDANCY;
  return { perAction, perInput, perPacket: perInput * (redundancy + 1), redundancy };
}
