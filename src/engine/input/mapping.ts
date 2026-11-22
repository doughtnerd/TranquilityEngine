/**
 * Internal (ADR 0335): the gamepad mapping module (`native/input`, built into ./wasm by
 * `npm run build:input`): device families, web gamepad ids, and the SDL controller database for
 * pads the browser doesn't map. Loaded the first time a gamepad connects; Node reads it from disk.
 */
import type * as InputModule from "./wasm/myco_input.js";

export interface InputMapping {
  /** 0 generic, 1 xbox, 2 playstation, 3 switch (`GAMEPAD_FAMILIES`). */
  familyOf(vendor: number, product: number, name: string): number;
  parseWebGamepadId(id: string): { vendor: number; product: number } | null;
  /** Per control in wire order (23 buttons, then 4 axes): `[kind, index]`; undefined when the database has no entry. */
  webMapping(vendor: number, product: number, platform: number): Int16Array | undefined;
  /** The wire-order control names the module was built with. */
  controlNames(): string[];
}

let loading: Promise<InputMapping> | null = null;

/** @internal The mapping module, loaded and instantiated once. */
export function loadInputMapping(): Promise<InputMapping> {
  loading ??= instantiate().catch((err: unknown) => {
    loading = null; // a failed fetch or compile is tried again next time
    throw err;
  });
  return loading;
}

async function instantiate(): Promise<InputMapping> {
  const mod: typeof InputModule = await import("./wasm/myco_input.js");
  const url = new URL("./wasm/myco_input_bg.wasm", import.meta.url);
  let source: URL | Uint8Array = url;
  if (url.protocol === "file:") {
    // Node has no fetch for file URLs. A variable specifier keeps bundlers from pulling node:fs into web builds.
    const fsModule = "node:fs/promises";
    const { readFile } = (await import(/* @vite-ignore */ fsModule)) as { readFile(path: URL): Promise<Uint8Array> };
    source = await readFile(url);
  }
  await mod.default({ module_or_path: source });
  return {
    familyOf: (vendor, product, name) => mod.family_of(vendor, product, name),
    parseWebGamepadId(id) {
      const packed = mod.parse_web_gamepad_id(id);
      return packed < 0 ? null : { vendor: (packed >>> 16) & 0xffff, product: packed & 0xffff };
    },
    webMapping: (vendor, product, platform) => mod.web_mapping(vendor, product, platform) ?? undefined,
    controlNames: () => mod.control_names().split(","),
  };
}
