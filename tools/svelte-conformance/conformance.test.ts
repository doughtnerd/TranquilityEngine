// The Svelte conformance harness (ADR 0419: "conformance is measured, not claimed"). Svelte 5.59.2's own runtime
// fixtures (tests/runtime-runes/samples, fetched by fetch.mjs) compiled with the engine's custom renderer and run
// against it in a headless World, the way Svelte's harness runs them against the DOM (its `dom` variant):
//
// - each sample compiles with `experimental.customRenderer` and `css: 'external'` (its CSS registered with the
//   cascade); compile errors the custom renderer causes are failures with the refused feature as the category;
// - it mounts onto a UI host tree, as a UIView does, with its `props` (reactive), and runs its `html` check and its
//   `test(...)` with `target` being the mount node: its Element subset (`innerHTML`, `querySelector`, `click()`,
//   `dispatchEvent`, `value`…) stands in for the DOM, and HTML is compared after the same normalisation as Svelte's;
// - after the test, the hosted UI elements must mirror the rendered tree (tags and text in order), and unmounting
//   must leave nothing behind.
//
// Every sample is its own test that records its result without failing; the last test is the ratchet: every
// sample listed in baseline.json must still pass. `UPDATE_BASELINE=1` rewrites the baseline from this run.
// Results, with each failure's category and message, go to node_modules/.cache/svelte-conformance/results.json.
import { afterAll, assert, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, compileModule } from "svelte/compiler";
import { flushSync } from "svelte";
// Svelte's harness drops every batch left after a sample (a fork never committed or discarded), "to prevent cross-talk
// between tests" (its runtime-legacy/shared.ts): the same module Svelte's `svelte` export uses (one instance).
import { clear as clearBatches } from "../../node_modules/svelte/src/internal/client/reactivity/batch.js";
import { Engine, GameObject } from "../../src/engine/index";
import { World } from "../../src/engine/core/World";
import { loadUIHostSupport, UIHostTree, type UIHostElement } from "../../src/engine/ui/host/UIHost";
import { injectedStylesOf, svelteUIOptions } from "../../src/plugins/ui/svelte/compile.mjs";
import { parseStylesheet } from "../../src/engine/ui/document/stylesheet";
import { SVELTE_UI_RENDERER } from "../../vite.shared";
import { assertHtmlEqual, assertHtmlEqualWithOptions } from "./htmlEqual";
import { ok } from "./testShim";
import { animations, clock, standInAnimate } from "./animationStandIn";
import { setPage } from "./pageGlobals";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const version = JSON.parse(readFileSync(join(root, "node_modules/svelte/package.json"), "utf8")).version as string;
// `SVELTE_CONFORMANCE_CACHE` moves the fixtures and results (a directory holding `<version>/` and `results.json`) so
// concurrent runs don't share the compiled output; its path must contain "svelte-conformance" (the Vitest config's imports).
const cache = process.env.SVELTE_CONFORMANCE_CACHE ?? join(root, "node_modules/.cache/svelte-conformance");
const checkout = join(cache, version);
const SAMPLES = join(checkout, "packages/svelte/tests/runtime-runes/samples");
const RESULTS = join(cache, "results.json");
const BASELINE = join(root, "tools/svelte-conformance/baseline.json");
const FILTER = process.env.FILTER ? new RegExp(process.env.FILTER) : null;
const SAMPLE_TIMEOUT = 5000;

type Status = "pass" | "fail" | "skip";
interface Result {
  status: Status;
  category?: string;
  message?: string;
  /** With `DEBUG=stack`: where a failure was thrown. */
  stack?: string;
}
const results = new Map<string, Result>();

/**
 * The baseline (baseline.json): the samples that must keep passing (the ratchet), and the samples out of scope (ADR
 * 0419's "Out of scope": impossible or meaningless in a canvas game, or an expectation only jsdom can meet), each with
 * its reason. Out-of-scope samples still run, so one that starts passing shows; the in-scope pass rate leaves them out.
 * TRIAGE.md classifies every sample that doesn't pass.
 */
interface Baseline {
  version: string;
  counts: Record<string, number>;
  passing: string[];
  outOfScope: Record<string, string>;
}
const baseline: Baseline | null = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline) : null;
const outOfScope: Record<string, string> = baseline?.outOfScope ?? {};

/** The run's counts: every sample's, and those of the samples in scope (not skipped, not out of scope). */
function tally(): { pass: number; fail: number; skip: number; outOfScope: number; inScopeRun: number; inScopePass: number } {
  const counts = { pass: 0, fail: 0, skip: 0, outOfScope: 0, inScopeRun: 0, inScopePass: 0 };
  for (const [name, r] of results) {
    counts[r.status]++;
    if (r.status === "skip") continue;
    if (name in outOfScope) counts.outOfScope++;
    else {
      counts.inScopeRun++;
      if (r.status === "pass") counts.inScopePass++;
    }
  }
  return counts;
}

interface Config {
  skip?: boolean;
  mode?: string[];
  skip_mode?: string[];
  skip_async?: boolean;
  html?: string;
  props?: Record<string, unknown>;
  compileOptions?: Record<string, unknown>;
  error?: string;
  runtime_error?: string;
  warnings?: string[];
  errors?: string[];
  withoutNormalizeHtml?: boolean | "only-strip-comments";
  skip_initial_flushSync?: boolean;
  before_test?: () => void;
  after_test?: () => void;
  test?: (args: Record<string, unknown>) => unknown;
  transformError?: (error: unknown) => unknown;
}

type Renderer = typeof import("../../src/plugins/ui/svelte/renderer");
let renderer: Renderer;
let engine: Engine;
let raf: { reset(): void; tick(ms: number): void } = { reset() {}, tick() {} };
/** The `window` tests get: the renderer's `<svelte:window>` target (its listeners, sizes and `dispatchEvent`), with the event constructors. */
let testWindow: object = {};
/** The mounted sample's target: the page's content, which the page `document`'s queries search (pageGlobals.ts). */
let currentTarget: object | null = null;
/** The listeners a sample's config added to the page's window, removed after it. */
const pageListeners: unknown[][] = [];
let matchMediaSpy: MockInstance | null = null;

class FakeEvent {
  defaultPrevented = false;
  _stopped = false;
  constructor(readonly type: string, init: Record<string, unknown> = {}) {
    Object.assign(this, init);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this._stopped = true;
  }
  stopImmediatePropagation() {
    this._stopped = true;
  }
}
const fakeWindow = { Event: FakeEvent, InputEvent: FakeEvent, KeyboardEvent: FakeEvent, MouseEvent: FakeEvent, PointerEvent: FakeEvent, FocusEvent: FakeEvent, CustomEvent: FakeEvent };

function walkFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith("_")) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walkFiles(abs, base));
    else out.push(relative(base, abs));
  }
  return out;
}

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** Compile a sample into `_output_myco/` with the engine's renderer. */
function compileSample(dir: string, config: Config): void {
  const out = join(dir, "_output_myco");
  rmSync(out, { recursive: true, force: true });
  const extra = config.compileOptions ?? {};
  for (const file of walkFiles(dir)) {
    const abs = join(dir, file);
    const text = readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
    if (file.endsWith(".svelte.js")) {
      const r = compileModule(text, { filename: abs, rootDir: dir, generate: "client", dev: !!extra.dev, experimental: { async: true } });
      write(join(out, file), r.js.code);
    } else if (file.endsWith(".js")) {
      const source = relative(dirname(join(out, file)), abs).replace(/\\/g, "/");
      write(join(out, file), `export * from './${source}';${text.includes("export default") ? `\nexport { default } from './${source}';` : ""}`);
    } else if (file.endsWith(".svelte") && !file.endsWith(".server.svelte")) {
      const name = file.replace(/\.client\.svelte$/, ".svelte");
      const base = svelteUIOptions(abs, { renderer: SVELTE_UI_RENDERER, dev: !!extra.dev });
      const options = { ...base, ...extra, experimental: { ...(extra.experimental as object), async: true, customRenderer: SVELTE_UI_RENDERER }, runes: "runes" in extra ? (extra.runes as boolean) : true, filename: abs, rootDir: dir, generate: "client" as const };
      if (options.css !== "injected") options.css = "external";
      const r = compile(text, options as never);
      let code = r.js.code;
      if (r.css?.code.trim()) code += `\nimport { addStyles as $$s } from ${JSON.stringify(SVELTE_UI_RENDERER)};\n$$s(${JSON.stringify(abs)}, ${JSON.stringify(parseStylesheet(r.css.code, abs))});\n`;
      const injected = injectedStylesOf(code);
      if (injected) code += `\nimport { injectStyles as $$i } from ${JSON.stringify(SVELTE_UI_RENDERER)};\n$$i(${JSON.stringify(injected.hash)}, ${JSON.stringify(parseStylesheet(injected.code, abs))});\n`;
      write(join(out, `${name}.js`), code);
    }
  }
}

function classify(err: unknown, stage: "compile" | "run"): { category: string; message: string; stack?: string } {
  const e = err as { message?: string; name?: string; code?: string; stack?: string };
  if (process.env.DEBUG === "stack" && e?.stack) return { ...classifyMessage(e, stage), stack: e.stack.split("\n").slice(1, 12).join("\n") };
  return classifyMessage(e, stage);
}

function classifyMessage(err: unknown, stage: "compile" | "run"): { category: string; message: string } {
  const e = err as { message?: string; name?: string; code?: string };
  const message = process.env.DEBUG ? `${String(e?.message ?? err)}${(err as { actual?: unknown })?.actual !== undefined ? `\nactual:   ${JSON.stringify((err as { actual?: unknown }).actual)}\nexpected: ${JSON.stringify((err as { expected?: unknown }).expected)}` : ""}` : String(e?.message ?? err).split("\n")[0].slice(0, 300);
  const refused = /^(`[^`]+`|[^ ]+) is not compatible with `customRenderer`/.exec(message);
  if (refused) return { category: `compile: ${refused[1]} refused under a custom renderer`, message };
  if (stage === "compile") return { category: `compile: ${e?.code ?? "error"}`, message };
  if (/\b(document|window|navigator|getComputedStyle|requestAnimationFrame|HTMLElement|Node|customElements|location) is not defined/.test(message)) return { category: "uses the browser's document/window", message };
  if (message.startsWith("host tree:")) return { category: "UI elements don't mirror the rendered tree", message };
  if (message.startsWith("timeout")) return { category: "timed out", message };
  if (/Expected component to unmount/.test(message)) return { category: "leaves nodes after unmount", message };
  if (/expected '.*' to deeply equal|htmlEqual/.test(message) && e?.name === "AssertionError") return { category: "rendered HTML differs", message };
  if (/is not a function|Cannot read properties of (undefined|null)|Cannot set properties/.test(message)) return { category: "DOM API missing on renderer nodes", message };
  if (/svelte\.dev\/e\//.test(String(e?.message)) || /^[a-z_]+\n/.test(String(e?.message))) return { category: `svelte runtime error: ${message.split(" ")[0]}`, message };
  if (e?.name === "AssertionError") return { category: "assertion failed", message };
  return { category: "other runtime error", message };
}

/** The hosted UI elements must mirror the rendered tree: the same elements (and text labels) in the same order, Text elements holding the text (ADR 0425: in their own text and their inline runs'). */
function checkHostTree(target: InstanceType<Renderer["UIRenderElement"]>, host: UIHostElement): void {
  const label = (h: UIHostElement) => h.tag;
  const expected: string[] = [];
  const textKind = (n: { element?: UIHostElement | null }) => n.element?.uiTag === "Text";
  for (const c of target.childNodes) {
    if (c.nodeType === 1) {
      const el = c as InstanceType<Renderer["UIRenderElement"]>;
      if (!el.element) continue; // inside a leaf: not shown
      expected.push(el.localName);
      if (!textKind(el)) checkHostTree(el, el.element);
      else {
        const collapse = (s: string) => s.replace(/[ \t\n\r\f]+/g, " ").trim();
        const text = collapse((el as unknown as { innerText: string }).innerText);
        const runsOf = (h: UIHostElement): string => ((h.component as { text?: string }).text ?? "") + h.children.map(runsOf).join("");
        const shown = collapse(runsOf(el.element));
        if (shown !== text) throw new Error(`host tree: <${el.localName}> shows ${JSON.stringify(shown)}, not ${JSON.stringify(text)}`);
      }
    } else if (c.nodeType === 3 && (c as { data: string }).data.trim()) expected.push("#text");
  }
  // An `<input type="submit|reset|button">` shows its value as a label the engine makes (no rendered node is it).
  const actual = host.children.filter((h) => !(target.localName === "input" && h.synthetic)).map(label);
  if (actual.join(",") !== expected.join(",")) throw new Error(`host tree: <${host.tag}> has [${actual.join(", ")}], the rendered tree [${expected.join(", ")}]`);
}

async function runSample(name: string): Promise<Result> {
  const dir = join(SAMPLES, name);
  const config = ((await import(join(dir, "_config.js"))) as { default: Config }).default;
  if (config.skip) return { status: "skip", category: "skipped by Svelte" };
  // Svelte runs runtime-runes in async mode by default (`SVELTE_NO_ASYNC` unset), skipping these; the harness compiles in async mode too.
  if (config.skip_async) return { status: "skip", category: "skipped in Svelte's async mode" };
  if (config.skip_mode?.includes("client") || (config.mode && !config.mode.includes("client"))) return { status: "skip", category: "not a client test" };

  try {
    compileSample(dir, config);
  } catch (err) {
    if (config.error && String((err as Error).message).includes(config.error)) return { status: "pass" };
    return { status: "fail", ...classify(err, "compile") };
  }

  const logs: unknown[] = [];
  const warnings: unknown[] = [];
  const errors: unknown[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error, group: console.group, groupCollapsed: console.groupCollapsed, groupEnd: console.groupEnd };
  console.log = (...args: unknown[]) => void logs.push(...args); // returns undefined, as console.log does (`{console.log(x)}` renders "")
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("[myco]")) return; // the engine's own notes, not Svelte's
    if (typeof args[0] === "string" && args[0].startsWith("%c[svelte]")) {
      let message = args[0].slice(args[0].indexOf("%c", 2) + 2);
      const lines = message.split("\n");
      if (lines.at(-1)?.startsWith("https://svelte.dev/e/")) lines.pop();
      message = lines.join("\n");
      warnings.push(message);
    } else warnings.push(...args);
  };
  let rejection: unknown = null;
  const onRejection = (err: unknown) => (rejection ??= err);
  console.error = (...args: unknown[]) => {
    // An event listener that threw: the engine reports it (`[myco] a UI "click" handler on <button> threw:`, error), as
    // the DOM reports a listener's exception rather than throwing it at the dispatcher. jsdom's report is an `error`
    // event on the window and a console error; unless a window listener stops it, Svelte's harness counts it as uncaught.
    if (typeof args[0] === "string" && args[0].startsWith("[myco]") && / (threw|failed):?$/.test(args[0]) && args.length > 1) {
      const err = args[1] as { message?: unknown };
      errors.push(String(err?.message ?? err));
      const report = new FakeEvent("error", { error: err, message: String(err?.message ?? err) });
      (testWindow as { dispatchEvent(e: unknown): unknown }).dispatchEvent(report);
      if (!report._stopped && !report.defaultPrevented) onRejection(err);
      return;
    }
    errors.push(...args);
  };
  // `$inspect` and `$inspect.trace` group their output: the group labels are logs too, as in Svelte's harness.
  console.group = console.groupCollapsed = (...args: unknown[]) => void logs.push(...args);
  console.groupEnd = () => {};

  const world = World.require();
  const node = GameObject.create(`conformance ${name}`);
  const tree = new UIHostTree(world, node, `samples/${name}`);
  let mounted: ReturnType<Renderer["mountView"]> | null = null;
  let unintended = false;
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onRejection);
  try {
    raf.reset();
    // A fresh page per sample, as jsdom is for Svelte: no title left by the previous sample's `<svelte:head>`.
    ((renderer.default as unknown as { globalTarget(kind: string): { title: string } }).globalTarget("document")).title = "";
    matchMediaSpy?.mockClear();
    // ...and `$props.id()` counting from c1 again (Svelte keeps its counter on the global object, jsdom's window per test).
    const svelteGlobal = (globalThis as { __svelte?: { uid?: number } }).__svelte;
    if (svelteGlobal) svelteGlobal.uid = 1;
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = setTimeout;
    const mod = (await import(join(dir, "_output_myco/main.svelte.js"))) as { default: never };
    // As Svelte's harness: what the sample's modules logged or warned while being imported isn't the test's.
    logs.length = warnings.length = 0;
    config.before_test?.();
    mounted = renderer.mountView(tree, mod.default, config.props ?? {}, { transformError: config.transformError });
    const target = mounted.target;
    currentTarget = target;
    if (config.error) {
      unintended = true;
      assert.fail("Expected a runtime error");
    }
    // Svelte's harness mounts without flushing, then flushes before the `html` check and again before the test; a view's
    // mount (`mountView`) flushes once itself, as the first of those (a second drain at mount would start what Svelte's
    // run starts in the test's first `raf.tick`, such as a transition's main animation).
    let flushes = 1;
    const flushOnce = () => {
      if (flushes > 0) flushes--;
      else flushSync();
    };
    if (config.html) {
      flushOnce();
      assertHtmlEqualWithOptions(target.innerHTML, config.html, { preserveComments: config.withoutNormalizeHtml === "only-strip-comments" ? false : undefined, withoutNormalizeHtml: !!config.withoutNormalizeHtml });
    }
    if (config.test) {
      if (!config.skip_initial_flushSync) flushOnce();
      const run = config.test({
        assert: { ...assert, htmlEqual: assertHtmlEqual, htmlEqualWithOptions: assertHtmlEqualWithOptions },
        variant: "dom",
        component: mounted.props,
        instance: mounted.exports,
        mod,
        ok,
        target,
        snapshot: undefined,
        window: testWindow,
        raf,
        compileOptions: config.compileOptions ?? {},
        logs,
        warnings,
        errors,
        hydrate: () => {
          throw new Error("hydration is out of scope");
        },
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([run, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), SAMPLE_TIMEOUT)))]);
      clearTimeout(timer);
      flushSync();
    }
    checkHostTree(target, tree.root);
    if (config.runtime_error && !rejection) {
      unintended = true;
      assert.fail("Expected a runtime error");
    }
    const m = mounted;
    mounted = null;
    m.unmount();
    if (config.warnings) assert.deepEqual(warnings, config.warnings);
    if (config.errors) assert.deepEqual(errors, config.errors);
    assertHtmlEqual(target.innerHTML, "", "Expected component to unmount and leave nothing behind after it was destroyed");
    if (tree.root.children.length) throw new Error(`host tree: ${tree.root.children.length} UI elements left after unmounting`);
    if (rejection) throw rejection;
    return { status: "pass" };
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    if (!unintended && config.runtime_error && message.includes(config.runtime_error)) return { status: "pass" };
    if (!unintended && config.error && message.includes(config.error)) return { status: "pass" };
    return { status: "fail", ...classify(err, "run") };
  } finally {
    currentTarget = null;
    for (const args of pageListeners.splice(0)) (testWindow as { removeEventListener(...a: unknown[]): void }).removeEventListener(...args);
    try {
      mounted?.unmount();
    } catch {
      // already reported
    }
    try {
      config.after_test?.();
    } catch {
      // reported by the test's own result
    }
    await new Promise((r) => setImmediate(r));
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onRejection);
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    console.group = original.group;
    console.groupCollapsed = original.groupCollapsed;
    console.groupEnd = original.groupEnd;
    clearBatches();
    tree.dispose();
    GameObject.destroy(node);
    world.applyDestroys();
  }
}

const names = existsSync(SAMPLES) ? readdirSync(SAMPLES).filter((n) => statSync(join(SAMPLES, n)).isDirectory() && (!FILTER || FILTER.test(n))).sort() : [];

describe(`Svelte ${version} runtime-runes fixtures on the engine's renderer`, () => {
  let saved: { rejection: NodeJS.UnhandledRejectionListener[]; exception: NodeJS.UncaughtExceptionListener[] } | null = null;

  beforeAll(async () => {
    if (!existsSync(SAMPLES)) throw new Error(`No fixtures at ${SAMPLES}: run node tools/svelte-conformance/fetch.mjs (npm run test:svelte-conformance does).`);
    engine = await Engine.create({ headless: true });
    await loadUIHostSupport();
    renderer = await import("../../src/plugins/ui/svelte/renderer");
    // ADR 0425: the inline HTML parser, which compileSvelteUI imports into components that use `{@html}` or `bind:innerHTML`
    // (the samples compile with `compile` itself, so the harness registers it once).
    renderer.useHtmlParser((await import("../../src/plugins/ui/svelte/htmlInline")).parseInlineHtml);
    const win = (renderer.default as unknown as { globalTarget(kind: string): object }).globalTarget("window");
    // A config's own window listeners last only for its sample (jsdom's window is fresh per test); see `pageListeners`.
    const addListener = (win as { addEventListener(...a: unknown[]): void }).addEventListener.bind(win);
    const added = (...args: unknown[]) => {
      pageListeners.push(args);
      addListener(...args);
    };
    testWindow = new Proxy(win, { get: (target, key, receiver) => (key === "addEventListener" ? added : typeof key === "string" && key in fakeWindow ? fakeWindow[key as keyof typeof fakeWindow] : Reflect.get(target, key, receiver)) });
    // Svelte's harness mocks `window.matchMedia` (jsdom has none) and fixtures check its calls: the window target's is spied on, its answers kept.
    matchMediaSpy = vi.spyOn(win as { matchMedia(q: string): unknown }, "matchMedia");
    // The event constructors tests make events with (dispatched to renderer nodes, which read only `type`). The global
    // `window` and `document` stay undefined (engine code takes a defined `window` for a browser); the `window` a test
    // gets as an argument is the renderer's `<svelte:window>` target.
    setPage({ window: testWindow, document: (renderer.default as unknown as { globalTarget(kind: string): object }).globalTarget("document"), target: () => currentTarget, tick: (ms) => raf.tick(ms) });
    for (const [k, v] of Object.entries(fakeWindow)) if (!(k in globalThis)) (globalThis as Record<string, unknown>)[k] = v;
    // The page's `name` (`window.name`, "" on a fresh page), a global in jsdom and browsers that a component can name by accident (`{name}`).
    if (!("name" in globalThis)) (globalThis as Record<string, unknown>).name = "";
    // Svelte's `raf` test helper, with its animation stand-in moved from `element.animate` to the renderer's `animate`
    // hook (animationStandIn.ts): keyframes go to the node's inline style on the test's clock, as in Svelte's DOM runs.
    // The renderer's own `measure` stays (a fixture's stubbed `getBoundingClientRect` on a node is what it reads).
    (renderer.default as unknown as { animate: unknown }).animate = standInAnimate;
    const { raf: svelteRaf } = (await import("svelte/internal/client")) as unknown as { raf: { tick: (f: (n: number) => void) => void; now: () => number; tasks: Set<unknown> } };
    const ticks = new Set<(n: number) => void>();
    raf = {
      reset() {
        clock.time = 0;
        animations.clear();
        ticks.clear();
        svelteRaf.tick = (f) => void ticks.add(f);
        svelteRaf.now = () => clock.time;
        svelteRaf.tasks.clear();
      },
      tick(ms: number) {
        clock.time = ms;
        flushSync();
        for (const a of animations) a._update();
        for (const t of ticks) t(clock.time);
      },
    };
    // Samples that reject or throw asynchronously are recorded as their own failures, not the run's.
    saved = { rejection: process.rawListeners("unhandledRejection") as never, exception: process.rawListeners("uncaughtException") as never };
    process.removeAllListeners("unhandledRejection");
    process.removeAllListeners("uncaughtException");
  });

  afterAll(() => {
    if (saved) {
      for (const l of saved.rejection) process.on("unhandledRejection", l);
      for (const l of saved.exception) process.on("uncaughtException", l);
    }
    engine?.dispose();
    const counts = tally();
    const categories = new Map<string, number>();
    for (const [name, r] of results) if (r.status === "fail" && !(name in outOfScope)) categories.set(r.category!, (categories.get(r.category!) ?? 0) + 1);
    const sorted = [...categories].sort((a, b) => b[1] - a[1]);
    const samples = Object.fromEntries([...results].map(([n, r]) => [n, n in outOfScope ? { ...r, outOfScope: outOfScope[n] } : r]));
    mkdirSync(dirname(RESULTS), { recursive: true });
    writeFileSync(RESULTS, JSON.stringify({ version, counts, categories: Object.fromEntries(sorted), samples }, null, 2));
    const run = counts.pass + counts.fail;
    const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) : "0");
    original.log(`\nSvelte ${version} runtime-runes on the engine's renderer: ${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip (${pct(counts.pass, run)}% of ${run} run)`);
    original.log(`In scope: ${counts.inScopePass} of ${counts.inScopeRun} pass (${pct(counts.inScopePass, counts.inScopeRun)}%); ${counts.outOfScope} run out of scope (baseline.json's outOfScope)`);
    for (const [c, n] of sorted.slice(0, 25)) original.log(`  ${String(n).padStart(4)}  ${c}`);
    const nowPassing = Object.keys(outOfScope).filter((n) => results.get(n)?.status === "pass");
    if (nowPassing.length) original.log(`Out of scope but passing now (take them off the list): ${nowPassing.join(", ")}`);
    original.log(`Results: ${RESULTS}`);
  });

  for (const name of names) {
    it(name, async () => {
      let result: Result;
      try {
        result = await runSample(name);
      } catch (err) {
        result = { status: "fail", ...classify(err, "run") };
      }
      results.set(name, result);
      // `DEBUG=1` with a FILTER: show why each failure failed.
      if (process.env.DEBUG && result.status === "fail") original.log(`${name}: ${result.category}\n${result.message}${result.stack ? `\n${result.stack}` : ""}`);
    });
  }

  it("keeps every sample in the baseline passing (the ratchet)", () => {
    if (FILTER) return;
    const passing = [...results].filter(([, r]) => r.status === "pass").map(([n]) => n).sort();
    // Every out-of-scope sample names one that exists, with a reason.
    expect(Object.entries(outOfScope).filter(([n, why]) => !results.has(n) || !why.trim()).map(([n]) => n), "outOfScope entries without a sample or a reason").toEqual([]);
    if (process.env.UPDATE_BASELINE) {
      const sortedOut = Object.fromEntries(Object.entries(outOfScope).sort(([a], [b]) => (a < b ? -1 : 1)));
      writeFileSync(BASELINE, `${JSON.stringify({ version, counts: tally(), passing, outOfScope: sortedOut }, null, 2)}\n`);
      return;
    }
    if (!baseline) return;
    const lost = baseline.passing.filter((n) => results.get(n)?.status !== "pass");
    expect(lost, "samples that passed in baseline.json and fail now").toEqual([]);
  });
});

const original = { log: (...args: unknown[]) => void process.stderr.write(`${args.join(" ")}\n`) };
