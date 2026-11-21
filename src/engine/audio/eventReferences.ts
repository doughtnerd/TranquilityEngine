// Where an audio event names a parameter or a bus (ADR 0299): the one list of those references, on the asset as parsed
// or on the file's JSON as written (the music tree under `musicRoot` or `root`), and the one rewrite. The Event editor's
// use count and local rename and the Audio settings' bus and global parameter renames go through here; a new field that
// names a parameter or a bus is added here only. Pure: rewrites copy only the path to what they change.
import { NODE_TYPES, REVERB_SEND_KEY } from "./eventFormat";

/** What a reference names: a parameter (the event's own or a global one) or a bus of the project's mixer. */
export type EventNameKind = "parameter" | "bus";

/** One step from the event to a field: a member key or a list index. */
export type EventReferenceStep = string | number;

/** One place in an event that names a parameter or a bus. */
export interface EventNameReference {
  readonly kind: EventNameKind;
  readonly name: string;
  /** The keys from the event to the field that holds the name. */
  readonly where: readonly EventReferenceStep[];
  /** The name is the last step's key, not its value (an aux send in `sends`). */
  readonly key?: true;
  /**
   * A parameter is `"local"` when the event's own `parameters` define its name: it then hides a global parameter of
   * that name (ADR 0158 §2), for every reference to it. Buses are always `"global"`.
   */
  readonly scope: "local" | "global";
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const EVENT_NODE_TYPES: ReadonlySet<unknown> = new Set(NODE_TYPES);
const SUSTAIN_SLOTS = ["start", "loop", "end"] as const;

/** The names the event's own `parameters` define. */
function localNames(event: Json): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(event.parameters)) for (const p of event.parameters) if (isRecord(p) && typeof p.name === "string") out.add(p.name);
  return out;
}

/**
 * Every reference to a parameter or a bus in `event`, in file order: the event's `bus`, its aux sends (every `sends` key
 * but `reverb`, the event's own send), its `automation`, then its tree. In a 0158 node: `automation`, a `switch`'s or
 * `blend`'s `parameter`, its children and sustain slots. In a music node: a `musicSwitch`'s `parameter`, a stinger's
 * `bus`, a segment's tracks (`bus`, `automation`) and regions (`while`), the children and the `library`. A music node's
 * own `automation` is not read by the format (it belongs on a track), so it names nothing. Empty names are not listed.
 */
export function eventNameReferences(event: unknown): EventNameReference[] {
  const out: EventNameReference[] = [];
  if (!isRecord(event)) return out;
  const locals = localNames(event);
  const add = (kind: EventNameKind, name: unknown, where: EventReferenceStep[], key = false): void => {
    if (typeof name !== "string" || name === "") return;
    const scope = kind === "parameter" && locals.has(name) ? "local" : "global";
    out.push(key ? { kind, name, where, key: true, scope } : { kind, name, where, scope });
  };
  const each = (list: unknown, where: EventReferenceStep[], visit: (item: Json, at: EventReferenceStep[]) => void): void => {
    if (Array.isArray(list)) list.forEach((item, i) => isRecord(item) && visit(item, [...where, i]));
  };
  const automation = (list: unknown, where: EventReferenceStep[]): void => each(list, where, (a, at) => add("parameter", a.parameter, [...at, "parameter"]));

  const node = (n: unknown, where: EventReferenceStep[]): void => {
    if (!isRecord(n)) return;
    if (n.type === "segment") {
      each(n.tracks, [...where, "tracks"], (t, at) => {
        add("bus", t.bus, [...at, "bus"]);
        automation(t.automation, [...at, "automation"]);
      });
      each(n.regions, [...where, "regions"], (r, at) => isRecord(r.while) && add("parameter", r.while.parameter, [...at, "while", "parameter"]));
      return;
    }
    if (n.type === "playlist" || n.type === "musicSwitch") {
      if (n.type === "musicSwitch") add("parameter", n.parameter, [...where, "parameter"]);
      each(n.stingers, [...where, "stingers"], (s, at) => add("bus", s.bus, [...at, "bus"]));
      each(n.children, [...where, "children"], (c, at) => node(c, at));
      each(n.library, [...where, "library"], (c, at) => node(c, at));
      return;
    }
    if (!EVENT_NODE_TYPES.has(n.type)) return;
    automation(n.automation, [...where, "automation"]);
    if (n.type === "switch" || n.type === "blend") add("parameter", n.parameter, [...where, "parameter"]);
    if (n.type === "sustain") for (const slot of SUSTAIN_SLOTS) node(n[slot], [...where, slot]);
    else each(n.children, [...where, "children"], (c, at) => node(c, at));
  };

  add("bus", event.bus, ["bus"]);
  if (isRecord(event.sends)) for (const k of Object.keys(event.sends)) if (k !== REVERB_SEND_KEY) add("bus", k, ["sends", k], true);
  automation(event.automation, ["automation"]);
  node(event.root, ["root"]);
  node(event.musicRoot, ["musicRoot"]);
  return out;
}

/** `value` with `fn` applied at `path`, copying only the containers along it; `value` itself when `fn` changes nothing. */
function updateAt(value: unknown, path: readonly EventReferenceStep[], i: number, fn: (v: unknown) => unknown): unknown {
  if (i === path.length) return fn(value);
  const step = path[i]!;
  if (Array.isArray(value) && typeof step === "number") {
    const next = updateAt(value[step], path, i + 1, fn);
    if (next === value[step]) return value;
    const copy = [...value];
    copy[step] = next;
    return copy;
  }
  if (isRecord(value) && typeof step === "string" && step in value) {
    const next = updateAt(value[step], path, i + 1, fn);
    return next === value[step] ? value : { ...value, [step]: next };
  }
  return value;
}

/**
 * `event` with the one reference `ref` (from `eventNameReferences` of this event) naming `to`. An aux send keeps its place
 * among the `sends` keys; renaming one to `reverb` (the event's own send) or to a key already there is refused. Returns
 * `event` itself when nothing changes (a refused rename, or `ref` no longer naming `ref.name` there).
 */
export function rewriteEventReference<T>(event: T, ref: EventNameReference, to: string): T {
  if (ref.key) {
    const holder = ref.where.slice(0, -1);
    return updateAt(event, holder, 0, (sends) => {
      if (!isRecord(sends) || !(ref.name in sends) || to === REVERB_SEND_KEY || to in sends) return sends;
      return Object.fromEntries(Object.entries(sends).map(([k, v]) => [k === ref.name ? to : k, v]));
    }) as T;
  }
  return updateAt(event, ref.where, 0, (v) => (v === ref.name ? to : v)) as T;
}

/**
 * `event` with every `kind` reference of `scope` naming `from` renamed `to`. A local parameter rename also renames the
 * parameter's definition in `parameters`. A global parameter rename leaves the event alone when its own parameters define
 * `to`: the renamed references would read the local one. Returns `event` itself when nothing changes.
 */
export function renameEventName<T>(event: T, kind: EventNameKind, scope: "local" | "global", from: string, to: string): T {
  if (from === to || !isRecord(event)) return event;
  const locals = localNames(event);
  if (kind === "parameter" && scope === "global" && locals.has(to)) return event;
  let out = event;
  for (const ref of eventNameReferences(event)) {
    if (ref.kind === kind && ref.scope === scope && ref.name === from) out = rewriteEventReference(out, ref, to);
  }
  if (kind === "parameter" && scope === "local" && locals.has(from)) {
    const parameters = (out as Json).parameters as unknown[];
    out = { ...out, parameters: parameters.map((p) => (isRecord(p) && p.name === from ? { ...p, name: to } : p)) };
  }
  return out;
}
