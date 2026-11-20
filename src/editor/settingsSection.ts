// A settings section handle (ADR 0253): one top-level `project.json` key as the Project panel's draft holds it,
// with the key's lenient parser and its defaults behind one interface: read it, write it back, set one value by path,
// reset it to the defaults, and say what keeps it from saving. The models of the sections plugins add (ADR 0151:
// navigation, physics; audio edits a core key) build their edits on it, so each key is parsed, written and defaulted
// in one place. Pure: the project section (`projectSection.ts`) does the undo, saving and reconciling.
import type { SettingsDraft, SettingsProblem } from "./projectSettingsModel";

/** What a settings section handle is made from. */
export interface SettingsSectionSpec<S> {
  /** The top-level `project.json` key (`"navigation"`). */
  readonly key: string;
  /**
   * The key's value as the engine reads it: `written` is what the draft holds (undefined when the key is absent), the
   * result's `settings` has the defaults where values are missing or rejected, and `problems` says what was rejected.
   */
  parse(written: unknown): { readonly settings: S; readonly problems?: readonly string[] };
  /**
   * How `set` edits (default `"parsed"`): `"parsed"` sets the value in the parsed section and writes the whole section
   * back, so the file then holds every value; `"written"` changes only that value in what's written (undefined removes
   * it, and a section left empty is removed), so values never set keep following the engine's defaults.
   */
  readonly edits?: "parsed" | "written";
  /** The draft with `settings` as the key's value (default: as given). The audio section prunes built-in rows here. */
  write?(draft: SettingsDraft, settings: S): SettingsDraft;
  /** What's wrong with the key in `draft`, by field. Default: each of the parse's problems, under the key. */
  problems?(draft: SettingsDraft): SettingsProblem[];
}

/** One `project.json` key of the settings draft. Its members are plain functions, so they can be passed on as callbacks. */
export interface SettingsSection<S> {
  readonly key: string;
  /** The key's parsed value in `values` (a draft, or a project's settings): the defaults when it's absent. */
  read(values: object | undefined): S;
  /** `draft` with `settings` written as the key's value. */
  write(draft: SettingsDraft, settings: S): SettingsDraft;
  /** `draft` with one value set by dotted path (`"tileSize"`, `"build.vertsPerPoly"`, `"walk.radius"`), as given. */
  set(draft: SettingsDraft, path: string, value: unknown): SettingsDraft;
  /** `draft` with the key removed, so the engine's defaults apply. */
  reset(draft: SettingsDraft): SettingsDraft;
  /** What keeps the draft from being saved, by field (`"navigation"`, `"physics.layers.2"`). */
  problems(draft: SettingsDraft): SettingsProblem[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A copy of `obj` with the value at `path` set; undefined removes it, and with `prune`, objects it leaves empty too. */
function setPath(obj: unknown, path: readonly string[], value: unknown, prune: boolean): unknown {
  const [head, ...rest] = path;
  const copy: Record<string, unknown> = Array.isArray(obj) ? ([...obj] as unknown as Record<string, unknown>) : { ...(isRecord(obj) ? obj : {}) };
  const next = rest.length === 0 ? value : setPath(copy[head], rest, value, prune);
  if (next === undefined || (prune && isRecord(next) && Object.keys(next).length === 0)) delete copy[head];
  else copy[head] = next;
  return copy;
}

/** A handle on `spec.key` of the settings draft. */
export function settingsSection<S>(spec: SettingsSectionSpec<S>): SettingsSection<S> {
  const { key } = spec;
  const parse = (draft: object | undefined) => spec.parse((draft as Record<string, unknown> | undefined)?.[key]);
  const read = (values: object | undefined): S => parse(values).settings;
  const write = (draft: SettingsDraft, settings: S): SettingsDraft => (spec.write ? spec.write(draft, settings) : { ...draft, [key]: settings });
  return {
    key,
    read,
    write,
    set(draft, path, value) {
      const at = path.split(".");
      if (spec.edits === "written") {
        const next = setPath(draft[key], at, value, true);
        return { ...draft, [key]: isRecord(next) && Object.keys(next).length === 0 ? undefined : next };
      }
      return write(draft, setPath(read(draft), at, value, false) as S);
    },
    reset: (draft) => ({ ...draft, [key]: undefined }),
    problems: (draft) => (spec.problems ? spec.problems(draft) : (parse(draft).problems ?? []).map((message) => ({ field: key, message }))),
  };
}
