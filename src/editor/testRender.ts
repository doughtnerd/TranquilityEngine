// Test helper (not part of the editor build): renders a Preact component tree, hooks and all, without a DOM. The unit
// tests run under Node with no DOM library, so a component that uses hooks can't go through Preact's own `render`.
// This module stands in for `preact/hooks` and expands the tree itself:
//
//   vi.mock("preact/hooks", () => import("<path>/editor/testRender"));
//   const r = render(() => h(MixerPanel, {}));
//   click(find(r.tree(), byLabel("Reset"))[0]);
//
// `tree()` renders the element (the factory is called each time, so it can read the test's current props), calling every
// function component in place with its own hook state, kept per position in the tree as Preact keeps it, and returns the
// host elements (`div`, `button`…) with their props, handlers included. Effects and layout effects run after each
// render when their dependencies change, and their cleanups run when the component leaves the tree or on `unmount()`. A
// state update inside an effect renders again before `tree()` returns; an update from a handler or a resolved promise
// shows on the next `tree()`. Refs are never attached (there is no DOM), so a ref's `current` stays what the component
// set. Context providers are honoured. That is all the editor's components use.
import type { ComponentChild, VNode } from "preact";

/** A host element of a rendered tree: its tag and its props, children rendered. */
export type HostNode = VNode<Record<string, unknown>> & { type: string };

type Deps = readonly unknown[] | undefined;
interface EffectSlot { kind: "effect"; deps: Deps; cleanup?: (() => void) | void; run?: () => (() => void) | void; layout: boolean }
interface Instance { slots: unknown[]; index: number; obj?: ClassInstance }
interface ClassInstance { props: unknown; state: Record<string, unknown>; context?: unknown; render(props: unknown, state: unknown, context: unknown): ComponentChild; setState(u: unknown): void; forceUpdate(): void; componentDidMount?(): void; componentWillUnmount?(): void }
interface Root { instances: Map<string, Instance>; dirty: boolean; pending: EffectSlot[] }

let root: Root | null = null;
let current: Instance | null = null;
let contexts: Array<{ ctx: unknown; value: unknown }> = [];

function slot<T>(init: () => T): T {
  if (!current) throw new Error("testRender: a hook was called outside a component render");
  const i = current.index++;
  if (current.slots.length <= i) current.slots.push(init());
  return current.slots[i] as T;
}

const changed = (a: Deps, b: Deps): boolean => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));

function markDirty(r: Root | null): void {
  if (r) r.dirty = true;
}

export function useReducer<S, A>(reducer: (s: S, a: A) => S, initial: S, init?: (i: S) => S): [S, (a: A) => void] {
  const r = root;
  const s = slot(() => {
    const box = { value: init ? init(initial) : initial, dispatch: (a: A): void => {} };
    box.dispatch = (a: A) => {
      const next = reducer(box.value, a);
      if (Object.is(next, box.value)) return;
      box.value = next;
      markDirty(r);
    };
    return box;
  });
  return [s.value, s.dispatch];
}

export function useState<S>(initial?: S | (() => S)): [S, (u: S | ((s: S) => S)) => void] {
  return useReducer<S, S | ((s: S) => S)>(
    (s, u) => (typeof u === "function" ? (u as (s: S) => S)(s) : u),
    undefined as S,
    () => (typeof initial === "function" ? (initial as () => S)() : (initial as S)),
  );
}

export function useRef<T>(initial?: T): { current: T } {
  return slot(() => ({ current: initial as T }));
}

export function useMemo<T>(fn: () => T, deps: Deps): T {
  const s = slot(() => ({ deps: undefined as Deps, value: undefined as T, set: false }));
  if (!s.set || changed(s.deps, deps)) {
    s.value = fn();
    s.deps = deps;
    s.set = true;
  }
  return s.value;
}

export function useCallback<T>(fn: T, deps: Deps): T {
  return useMemo(() => fn, deps);
}

function effect(fn: () => (() => void) | void, deps: Deps, layout: boolean): void {
  const s = slot((): EffectSlot => ({ kind: "effect", deps: undefined, layout }));
  if (s.run === undefined && (s.deps === undefined || changed(s.deps, deps))) {
    s.run = fn;
    s.deps = deps;
    root?.pending.push(s);
  } else if (s.run !== undefined) {
    s.run = fn; // queued this render already (a re-render inside the same pass): the newest closure runs
  }
}

export function useEffect(fn: () => (() => void) | void, deps?: Deps): void {
  effect(fn, deps, false);
}

export function useLayoutEffect(fn: () => (() => void) | void, deps?: Deps): void {
  effect(fn, deps, true);
}

export function useImperativeHandle<T>(ref: { current: T | null } | ((v: T | null) => void) | null | undefined, create: () => T, deps?: Deps): void {
  useLayoutEffect(() => {
    if (typeof ref === "function") {
      ref(create());
      return () => ref(null);
    }
    if (ref) {
      ref.current = create();
      return () => void (ref.current = null);
    }
  }, deps);
}

export function useContext<T>(ctx: unknown): T {
  for (let i = contexts.length - 1; i >= 0; i--) if (contexts[i]!.ctx === ctx) return contexts[i]!.value as T;
  return (ctx as { __?: T }).__ as T; // preact's packed name for the context's default value
}

let ids = 0;
export function useId(): string {
  return slot(() => `t${ids++}`);
}

export function useDebugValue(): void {}

export function useErrorBoundary(): [unknown, () => void] {
  return [undefined, () => {}];
}

// ---- rendering ----

interface ElementLike { type: unknown; props: Record<string, unknown>; key?: unknown }

function isContext(type: unknown): boolean {
  return typeof type === "function" && (type as { Provider?: unknown }).Provider === type;
}

function expand(node: unknown, path: string, r: Root, seen: Set<string>): unknown {
  if (node === null || node === undefined || typeof node === "boolean") return null;
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") return node;
  if (Array.isArray(node)) {
    return node.map((child, i) => {
      const key = child && typeof child === "object" && "key" in child && (child as ElementLike).key != null ? `k${String((child as ElementLike).key)}` : `${i}`;
      return expand(child, `${path}.${key}`, r, seen);
    });
  }
  if (typeof node !== "object" || !("type" in node) || !("props" in node)) return null;
  const v = node as ElementLike;
  if (typeof v.type === "string") {
    return { type: v.type, key: v.key, props: { ...v.props, children: expand(v.props.children, `${path}>`, r, seen) } };
  }
  if (typeof v.type !== "function") return null;
  const type = v.type as ((props: unknown, context?: unknown) => ComponentChild) & { name?: string; prototype?: { render?: unknown } };
  const id = `${path}/${type.name || "anon"}`;
  if (isContext(type)) {
    contexts.push({ ctx: type, value: v.props.value });
    try {
      return expand(v.props.children, id, r, seen);
    } finally {
      contexts.pop();
    }
  }
  seen.add(id);
  let inst = r.instances.get(id);
  if (!inst) r.instances.set(id, (inst = { slots: [], index: 0 }));
  const prev = current;
  current = inst;
  inst.index = 0;
  let out: ComponentChild;
  try {
    if (typeof type.prototype?.render === "function") {
      const Ctor = type as unknown as new (props: unknown) => ClassInstance;
      if (!inst.obj) {
        const obj = new Ctor(v.props);
        obj.state ??= {};
        obj.setState = (u) => {
          const patch = typeof u === "function" ? (u as (s: unknown, p: unknown) => object)(obj.state, obj.props) : u;
          obj.state = { ...obj.state, ...(patch as object) };
          markDirty(r);
        };
        obj.forceUpdate = () => markDirty(r);
        inst.obj = obj;
        if (obj.componentDidMount) r.pending.push({ kind: "effect", deps: [], layout: true, run: () => obj.componentDidMount!() });
      }
      inst.obj.props = v.props;
      out = inst.obj.render(inst.obj.props, inst.obj.state, undefined);
    } else {
      out = type(v.props);
    }
  } finally {
    current = prev;
  }
  return expand(out, id, r, seen);
}

function runPending(r: Root): void {
  const pending = r.pending.splice(0);
  for (const layout of [true, false]) {
    for (const s of pending) {
      if (s.layout !== layout || !s.run) continue;
      const run = s.run;
      s.run = undefined;
      if (typeof s.cleanup === "function") s.cleanup();
      s.cleanup = run();
    }
  }
}

function dispose(inst: Instance): void {
  for (const s of inst.slots) {
    const e = s as Partial<EffectSlot> | null;
    if (e && typeof e === "object" && e.kind === "effect" && typeof e.cleanup === "function") {
      e.cleanup();
      e.cleanup = undefined;
    }
  }
  inst.obj?.componentWillUnmount?.();
}

export interface Rendered {
  /** Render now and return the host tree (an element, an array of them, a string or null). */
  tree(): unknown;
  /** Run every cleanup, as Preact does when the tree is removed. */
  unmount(): void;
}

/** Render `element()` with hooks; call `tree()` to (re-)render and read it. */
export function render(element: () => ComponentChild): Rendered {
  const r: Root = { instances: new Map(), dirty: false, pending: [] };
  let alive = true;
  let last: unknown = null;
  return {
    tree() {
      if (!alive) throw new Error("testRender: tree() after unmount()");
      for (let pass = 0; pass < 50; pass++) {
        const seen = new Set<string>();
        const outer = root;
        const outerContexts = contexts;
        root = r;
        contexts = [];
        r.dirty = false;
        try {
          last = expand(element(), "", r, seen);
        } finally {
          root = outer;
          contexts = outerContexts;
        }
        for (const [id, inst] of r.instances) {
          if (!seen.has(id)) {
            dispose(inst);
            r.instances.delete(id);
          }
        }
        runPending(r);
        if (!r.dirty) return last;
      }
      throw new Error("testRender: the tree kept updating itself (50 renders)");
    },
    unmount() {
      if (!alive) return;
      alive = false;
      for (const inst of r.instances.values()) dispose(inst);
      r.instances.clear();
    },
  };
}

// ---- reading a rendered tree ----

/** Every host element in `node` (depth first) that `pred` accepts. */
export function find(node: unknown, pred: (n: HostNode) => boolean, out: HostNode[] = []): HostNode[] {
  if (Array.isArray(node)) {
    for (const c of node) find(c, pred, out);
    return out;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return out;
  const v = node as HostNode;
  if (pred(v)) out.push(v);
  return find(v.props.children, pred, out);
}

/** The text content of a rendered tree. */
export function text(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return text((node as HostNode).props.children);
}

export const byLabel = (label: string) => (n: HostNode): boolean => n.props["aria-label"] === label;
export const byClass = (cls: string) => (n: HostNode): boolean => typeof n.props.class === "string" && n.props.class.split(" ").includes(cls);
