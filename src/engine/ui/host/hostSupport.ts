// What the UI host loads on demand (ADR 0419): the cascade and the selector reader for queries, neither with a
// CSS parser behind it (components' styles arrive as parsed rule data), so games using only Svelte UI never load
// css-tree, and games without UI load neither.
export * from "../document/cascade";
export { parseSelectorQuery } from "../document/selectorQuery";
export { hasViewportUnits } from "../document/cssMath";
