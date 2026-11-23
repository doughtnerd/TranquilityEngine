// The Studio router (ADR 0349 "Navigation between screens"): `open({ screen, asset, select })` shows a screen, on an
// asset, with something in it selected, and the URL hash says so (`#/mixer?asset=audio.json&select=Music`), so the
// editor's hand-off (ADR 0341), a second window or a reload opens the same place. Back and Forward follow the hash.
// It replaces the prototype's `myco.nav` hand-off.
import { signal, type ReadonlySignal } from "@preact/signals";
import { parseStudioHash } from "../../editor/studioAssets";
import { DEFAULT_SCREEN, isScreenId, type ScreenId } from "./screens";

export interface Route {
  readonly screen: ScreenId;
  /** A project-relative asset path the screen opens. */
  readonly asset?: string;
  /** Something in the screen to select (a bus, a marker, an instance), in the screen's own words. */
  readonly select?: string;
}

/** Where to go: a screen (default: the current one), and what to open in it. */
export interface RouteRequest {
  readonly screen?: ScreenId;
  readonly asset?: string;
  readonly select?: string;
}

/** The hash, read and written (the window's `location.hash`, or a test's). */
export interface HashLocation {
  get(): string;
  /** `replace`: without a history entry (the first, normalised route). */
  set(hash: string, replace: boolean): void;
  /** Call `fn` when the hash changes from outside (Back, Forward, a typed URL). Returns the stop. */
  listen(fn: () => void): () => void;
}

const decoded = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text; // a malformed escape: as written
  }
};

/**
 * A hash as a route; anything unreadable is the default screen. Also reads the editor's form (`#/<screen>/<asset path>`,
 * `studioHash` in studioAssets.ts, what Open in Audio Studio puts in a browser tab's URL): the path after the screen is
 * the asset, unless `?asset=` names one.
 */
export function parseRoute(hash: string): Route {
  const text = hash.replace(/^#/, "").replace(/^\//, "");
  const q = text.indexOf("?");
  const path = q < 0 ? text : text.slice(0, q);
  const slash = path.indexOf("/");
  const name = decoded(slash < 0 ? path : path.slice(0, slash)).toLowerCase();
  const screen = isScreenId(name) ? name : DEFAULT_SCREEN;
  const params = new URLSearchParams(q < 0 ? "" : text.slice(q + 1));
  const inPath = slash >= 0 && isScreenId(name) ? parseStudioHash(`#/${name}${path.slice(slash)}`).asset : null;
  const asset = params.get("asset") || inPath || undefined;
  const select = params.get("select") || undefined;
  return { screen, ...(asset ? { asset } : {}), ...(select ? { select } : {}) };
}

/** A route as a hash: `#/<screen>` plus `asset` and `select` when set. */
export function formatRoute(route: Route): string {
  const params = new URLSearchParams();
  if (route.asset) params.set("asset", route.asset);
  if (route.select) params.set("select", route.select);
  const query = params.toString();
  return `#/${route.screen}${query ? `?${query}` : ""}`;
}

/**
 * Where `request` leads from `from`. Another screen starts from what the request gives. On the same screen, a new
 * asset drops the old selection; without one the asset stays, and the selection unless a new one is given.
 */
export function resolveRoute(from: Route, request: RouteRequest): Route {
  const screen = request.screen ?? from.screen;
  let asset = request.asset;
  let select = request.select;
  if (screen === from.screen && asset === undefined) {
    asset = from.asset;
    select ??= from.select;
  }
  return { screen, ...(asset ? { asset } : {}), ...(select ? { select } : {}) };
}

export interface StudioRouter {
  readonly route: ReadonlySignal<Route>;
  open(request: RouteRequest): void;
  dispose(): void;
}

export function createRouter(location: HashLocation): StudioRouter {
  const route = signal(parseRoute(location.get()));
  const normal = formatRoute(route.peek());
  if (location.get() !== normal) location.set(normal, true);
  const stop = location.listen(() => {
    const next = parseRoute(location.get());
    if (formatRoute(next) !== formatRoute(route.peek())) route.value = next;
  });
  return {
    route,
    open(request) {
      const next = resolveRoute(route.peek(), request);
      const hash = formatRoute(next);
      if (hash === formatRoute(route.peek())) return;
      route.value = next;
      location.set(hash, false);
    },
    dispose: stop,
  };
}

/** The window's hash as a `HashLocation`. */
export function windowHash(win: Window = window): HashLocation {
  return {
    get: () => win.location.hash,
    set: (hash, replace) => {
      if (replace) win.history.replaceState(win.history.state, "", hash);
      else win.location.hash = hash;
    },
    listen(fn) {
      win.addEventListener("hashchange", fn);
      return () => win.removeEventListener("hashchange", fn);
    },
  };
}
