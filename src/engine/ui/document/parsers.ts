/**
 * Everything `UIDocument` loads on demand (ADR 0077): the markup and stylesheet parsers and the
 * cascade, with `htmlparser2` and `css-tree` behind them, so games without UI documents never
 * download them.
 */
export { hasBinding, parseBindings, parseMarkup, resolvePath } from "./markup";
export { attributeField, boundValue, propertyField, cloneValue, convertValue, fieldsOf, matchSelector, parseStylesheet, resolveStyle, usesPseudo } from "./stylesheet";
