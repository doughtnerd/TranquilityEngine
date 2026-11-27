/**
 * Action set assets (ADR 0417): an action set written as data, `*.actions.json`, one set per file.
 *
 * ```json
 * { "id": "game.PlayerActions",
 *   "actions": [{ "name": "jump", "type": "button" }, { "name": "move", "type": "vec2", "consume": true }],
 *   "networked": true, "redundancy": 3, "encoding": { "move": { "quantize": 0.007874 } } }
 * ```
 *
 * A file names its actions and networking, never controls: every binding is a mapping in a context
 * (`input/default.input.json` holds the everyday ones). `defineActionsFromData` registers the same
 * `ActionSetDef` `defineActions` makes in code, so players, pawns, rebinding and the net bridge see no
 * difference. An id an asset and code both define is the asset's (it's what the editor shows); the
 * clash is reported in the console.
 */
import { Assets } from "../scene/Assets";
import { _defineActionSet, actionSetSource, button, axis, vec2, vec3, type ActionKind, type ActionSetDef, type ActionSetOptions, type ActionSpec, type ActionType } from "./actions";

/** One action of a set file: its name, type, and whether a performing mapping consumes its controls. */
export interface ActionSetFileAction {
  readonly name: string;
  readonly type: ActionKind;
  readonly consume?: boolean;
}

/** A `*.actions.json` file (ADR 0417). */
export interface ActionSetFile {
  readonly id: string;
  readonly actions: readonly ActionSetFileAction[];
  /** The property name in system rows; default the id's last part, camel-cased. */
  readonly key?: string;
  readonly networked?: boolean;
  readonly redundancy?: number;
  readonly encoding?: Readonly<Record<string, { readonly quantize?: number }>>;
}

/** A problem with a set file, at the path of the value at fault (`actions.2.type`), as settings report theirs (ADR 0272). */
export interface ActionSetProblem {
  readonly field: string;
  readonly message: string;
}

export const ACTION_SET_EXTENSION = ".actions.json";

const KINDS: readonly ActionKind[] = ["button", "axis", "vec2", "vec3"];
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ID = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const SET_KEYS = ["id", "actions", "key", "networked", "redundancy", "encoding"];
const ACTION_KEYS = ["name", "type", "consume"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const describe = (v: unknown): string => (v === undefined ? "nothing" : JSON.stringify(v));

/** Every problem with a set file, each at its path; none means `defineActionsFromData` accepts it. */
export function actionSetProblems(spec: unknown): ActionSetProblem[] {
  const problems: ActionSetProblem[] = [];
  const add = (field: string, message: string) => problems.push({ field, message });
  if (!isRecord(spec)) return [{ field: "", message: `An action set must be an object with an id and actions (got ${describe(spec)}).` }];
  for (const k of Object.keys(spec)) if (!SET_KEYS.includes(k)) add(k, `"${k}" isn't an action set field (fields: ${SET_KEYS.join(", ")}).`);
  if (typeof spec.id !== "string" || !ID.test(spec.id)) add("id", `The id must be dotted names, like "game.PlayerActions" (got ${describe(spec.id)}).`);
  if (spec.key !== undefined && (typeof spec.key !== "string" || !NAME.test(spec.key))) add("key", `The name in system queries must be letters, digits and underscores (got ${describe(spec.key)}).`);
  if (spec.networked !== undefined && typeof spec.networked !== "boolean") add("networked", `networked must be true or false (got ${describe(spec.networked)}).`);
  if (spec.redundancy !== undefined && !(Number.isInteger(spec.redundancy) && (spec.redundancy as number) >= 0)) add("redundancy", `Resent ticks must be a whole number, 0 or more (got ${describe(spec.redundancy)}).`);
  const names = new Map<string, ActionKind | undefined>();
  if (!Array.isArray(spec.actions)) add("actions", `actions must be a list (got ${describe(spec.actions)}).`);
  else
    spec.actions.forEach((a: unknown, i) => {
      const at = `actions.${i}`;
      if (!isRecord(a)) return add(at, `Action ${i + 1} must be an object with a name and a type (got ${describe(a)}).`);
      for (const k of Object.keys(a)) if (!ACTION_KEYS.includes(k)) add(`${at}.${k}`, `"${k}" isn't an action field (fields: ${ACTION_KEYS.join(", ")}). Controls go in a context.`);
      if (typeof a.name !== "string" || !NAME.test(a.name)) add(`${at}.name`, `Action ${i + 1} needs a name of letters, digits and underscores (got ${describe(a.name)}).`);
      else if (names.has(a.name)) add(`${at}.name`, `There are two actions named "${a.name}".`);
      if (!KINDS.includes(a.type as ActionKind)) add(`${at}.type`, `Action ${i + 1}'s type must be one of ${KINDS.join(", ")} (got ${describe(a.type)}).`);
      if (a.consume !== undefined && typeof a.consume !== "boolean") add(`${at}.consume`, `consume must be true or false (got ${describe(a.consume)}).`);
      if (typeof a.name === "string" && !names.has(a.name)) names.set(a.name, KINDS.includes(a.type as ActionKind) ? (a.type as ActionKind) : undefined);
    });
  if (spec.encoding !== undefined) {
    if (!isRecord(spec.encoding)) add("encoding", `encoding must be an object of actions (got ${describe(spec.encoding)}).`);
    else
      for (const [name, enc] of Object.entries(spec.encoding)) {
        const at = `encoding.${name}`;
        if (!names.has(name)) add(at, `There's no action "${name}" to encode.`);
        else if (names.get(name) === "button") add(at, `"${name}" is a button; only analog actions (axis, vec2, vec3) take a precision.`);
        if (!isRecord(enc)) add(at, `${name}'s encoding must be an object like { "quantize": 0.01 } (got ${describe(enc)}).`);
        else {
          for (const k of Object.keys(enc)) if (k !== "quantize") add(`${at}.${k}`, `"${k}" isn't an encoding field (fields: quantize).`);
          if (enc.quantize !== undefined && !(typeof enc.quantize === "number" && enc.quantize > 0)) add(`${at}.quantize`, `The precision must be a number above 0 (got ${describe(enc.quantize)}).`);
        }
      }
  }
  return problems;
}

const FACTORIES = { button, axis, vec2, vec3 } as const;

/** The `defineActions` arguments a set file stands for. */
function toDefinition(file: ActionSetFile): { spec: ActionSpec; options: ActionSetOptions } {
  const spec: Record<string, ActionType> = {};
  for (const a of file.actions) spec[a.name] = a.consume === undefined ? FACTORIES[a.type]() : FACTORIES[a.type]({ consume: a.consume });
  const options: ActionSetOptions = {
    ...(file.key !== undefined ? { key: file.key } : {}),
    ...(file.networked !== undefined ? { networked: file.networked } : {}),
    ...(file.redundancy !== undefined ? { redundancy: file.redundancy } : {}),
    ...(file.encoding !== undefined ? { encoding: file.encoding } : {}),
  };
  return { spec, options };
}

/**
 * Register the action set a `*.actions.json` file describes (ADR 0417), as `defineActions` does a code one.
 * Throws with every problem `actionSetProblems` finds. Defining an id again replaces the set.
 */
export function defineActionsFromData(spec: ActionSetFile): ActionSetDef {
  const problems = actionSetProblems(spec);
  if (problems.length) throw new Error(`Action set ${typeof (spec as Partial<ActionSetFile>)?.id === "string" ? `"${spec.id}" ` : ""}has problems:\n${problems.map((p) => `- ${p.field ? `${p.field}: ` : ""}${p.message}`).join("\n")}`);
  const { spec: actions, options } = toDefinition(spec);
  return _defineActionSet(spec.id, actions, options, "asset");
}

/** The text each set file was last defined from, by path: an unchanged file isn't defined again. */
const loaded = new Map<string, string>();

/**
 * The set the file at `path` holds, given its parsed `value`: an `*.actions.json` import in a script (the code
 * linker, ADR 0329) and the boot both come here, so whichever runs first defines it and the other gets the same
 * definition. A file whose text changed defines its set again. Throws with the file's problems.
 */
export function actionSetFromData(path: string, value: unknown): ActionSetDef {
  const text = JSON.stringify(value);
  const id = isRecord(value) && typeof value.id === "string" ? value.id : undefined;
  const existing = id !== undefined ? actionSetSource(id) : undefined;
  if (existing?.source === "asset" && loaded.get(path) === text) return existing.def;
  try {
    const def = defineActionsFromData(value as ActionSetFile);
    loaded.set(path, text);
    return def;
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
}

/** The set the asset at `path` holds (see `actionSetFromData`). */
export function actionSetFromAsset(path: string): ActionSetDef {
  return actionSetFromData(path, Assets.json(path));
}

/**
 * Define every set `input.actionSets` lists, in order (ADR 0417), before the bootstrap. Lenient, like the other
 * boot steps: a missing or broken file is reported in the console and skipped.
 */
export function bootActionSets(paths: readonly string[]): void {
  for (const path of paths) {
    if (!Assets.has(path)) {
      console.warn(`[myco] project.json input.actionSets: there's no ${path}.`);
      continue;
    }
    try {
      actionSetFromAsset(path);
    } catch (e) {
      console.warn(`[myco] ${(e as Error).message}`);
    }
  }
}

// A changed set file is defined again (ADR 0417), as a script reload replaces a code set.
Assets.onChanged((path) => {
  if (!loaded.has(path) || !Assets.has(path)) return;
  try {
    actionSetFromAsset(path);
  } catch (e) {
    console.warn(`[myco] ${(e as Error).message}`);
  }
});
