// The Connect dialog's model of network discovery (ADR 0403 "Discovery"): browsing starts when the dialog opens and stops
// when it closes, the list is what `browseBuilds` last reported (sorted by name), and `available` says whether this tool
// can browse at all (a page can't: `browseBuilds` resolves to null, and the dialog then shows no discovery section).
import { signal, type ReadonlySignal } from "@preact/signals";
import { browseBuilds, type DiscoveredBuild } from "../../engine/debugLink/tauriDiscovery";

export type { DiscoveredBuild };

/** What the dialog reads. `available` is null until the first answer, then true (browsing) or false (can't browse). */
export interface DiscoveryModel {
  readonly builds: ReadonlySignal<readonly DiscoveredBuild[]>;
  readonly available: ReadonlySignal<boolean | null>;
  /** Starts browsing (no-op when started). */
  start(): void;
  /** Stops browsing and forgets the list (no-op when stopped). */
  stop(): void;
}

/** A list row: the name, the platform as the build reports it, and the host ("Racer — desktop, 192.168.1.20"). */
export function buildLabel(build: DiscoveredBuild): string {
  return `${build.name} — ${build.platform}, ${hostOf(build.address)}`;
}

/** The host part of `ws://192.168.1.20:7790/myco-debug` (the address as is when it isn't a URL). */
export function hostOf(address: string): string {
  try {
    return new URL(address).hostname || address;
  } catch {
    return address;
  }
}

/** The list by name (then platform, then address), without changing the input. */
export function sortBuilds(builds: readonly DiscoveredBuild[]): DiscoveredBuild[] {
  return [...builds].sort((a, b) => a.name.localeCompare(b.name) || a.platform.localeCompare(b.platform) || a.address.localeCompare(b.address));
}

/** What choosing a build fills in: the address the flow connects to (the code is still typed). */
export function chosenAddress(build: DiscoveredBuild): string {
  return build.address;
}

/** A discovery model over `browse` (`browseBuilds` by default; tests give their own). */
export function createDiscovery(browse: typeof browseBuilds = browseBuilds): DiscoveryModel {
  const builds = signal<readonly DiscoveredBuild[]>([]);
  const available = signal<boolean | null>(null);
  let generation = 0;
  let stopBrowse: (() => void) | null = null;
  let running = false;
  return {
    builds,
    available,
    start() {
      if (running) return;
      running = true;
      const mine = ++generation;
      browse((list) => {
        if (mine === generation) builds.value = sortBuilds(list);
      }).then(
        (stop) => {
          if (mine !== generation) {
            stop?.(); // closed before browsing began
            return;
          }
          stopBrowse = stop;
          available.value = stop !== null;
        },
        () => {
          if (mine === generation) available.value = false;
        },
      );
    },
    stop() {
      if (!running) return;
      running = false;
      generation++;
      stopBrowse?.();
      stopBrowse = null;
      builds.value = [];
      available.value = null;
    },
  };
}
