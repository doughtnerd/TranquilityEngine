// What the fixtures' `_config.js` files import as `../../test` (Svelte's runtime-runes `test.ts`): the config
// itself, and `ok`. The conformance harness runs the configs; this only hands them over.
export function test<T>(config: T): T {
  return config;
}

export function ok(value: unknown): asserts value {
  if (!value) throw new Error(`Expected truthy value, got ${value}`);
}
