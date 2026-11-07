/**
 * Shader keywords (ADR 0106): switches a shader graph or shader asset declares and a material sets,
 * each combination compiling to its own shader variant. Pure data and maths: no Babylon.js.
 *
 * - A boolean keyword `{ "name": "RIM" }` is the define `KW_RIM` when on (off by default).
 * - An enum keyword `{ "name": "QUALITY", "values": ["LOW", "HIGH"] }` defines exactly one of
 *   `KW_QUALITY_LOW`, `KW_QUALITY_HIGH` (the first by default).
 * - `"variants": "all"` (Unity's `multi_compile`) marks a keyword scripts switch at run time: warm-up
 *   compiles every combination. `"used"` (the default, Unity's `shader_feature`) compiles what materials use.
 */

export interface ShaderKeyword {
  /** Upper-case identifier (`KEYWORD_NAME`). */
  name: string;
  /** Enum keywords: their values, upper-case identifiers, the first the default. Absent for booleans. */
  values?: string[];
  /** "all": warm-up compiles every combination (switched at run time). Default "used". */
  variants?: "used" | "all";
}

/** A keyword's value: on/off for a boolean, one of its values for an enum. */
export type KeywordValue = boolean | string;

export const KEYWORD_NAME = /^[A-Z][A-Z0-9_]*$/;
/** The prefix every keyword define has, keeping them apart from Babylon's own defines. */
export const KEYWORD_PREFIX = "KW_";
/** The most variants warm-up compiles for one material's `all` keywords. */
export const MAX_WARM_VARIANTS = 16;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A boolean keyword's define, or an enum value's. */
export const keywordDefine = (name: string, value?: string): string => (value === undefined ? `${KEYWORD_PREFIX}${name}` : `${KEYWORD_PREFIX}${name}_${value}`);

/** The WGSL constant a graph's Keyword node reads (a `bool`, or a `u32` index for an enum). */
export const keywordConstant = (name: string): string => `mycoKw_${name}`;

/** A file's `keywords` list, leniently: bad entries are skipped and listed in `problems`. */
export function parseKeywords(raw: unknown, where: string, problems: string[]): ShaderKeyword[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push(`${where}: "keywords" should be a list; ignored.`);
    return [];
  }
  const out: ShaderKeyword[] = [];
  for (const k of raw) {
    if (!isObject(k) || typeof k.name !== "string" || !KEYWORD_NAME.test(k.name)) {
      problems.push(`${where}: a keyword needs a "name" in upper case (letters, digits, _), such as "RIM"; skipped.`);
      continue;
    }
    if (out.some((o) => o.name === k.name)) {
      problems.push(`${where}: keyword "${k.name}" is declared twice; the first is used.`);
      continue;
    }
    const kw: ShaderKeyword = { name: k.name };
    if (k.values !== undefined) {
      const values = Array.isArray(k.values) ? k.values.filter((v): v is string => typeof v === "string" && KEYWORD_NAME.test(v)) : [];
      const unique = [...new Set(values)];
      if (unique.length < 2 || unique.length !== (k.values as unknown[]).length) problems.push(`${where}: keyword "${k.name}" "values" should be two or more distinct upper-case names${unique.length >= 2 ? "; bad ones skipped" : "; read as on/off"}.`);
      if (unique.length >= 2) kw.values = unique;
    }
    if (k.variants !== undefined) {
      if (k.variants === "all" || k.variants === "used") {
        if (k.variants === "all") kw.variants = "all";
      } else problems.push(`${where}: keyword "${k.name}" "variants" should be "used" or "all"; using "used".`);
    }
    out.push(kw);
  }
  return out;
}

/** A keywords list as file JSON (the inverse of `parseKeywords`). */
export function keywordsJSON(list: readonly ShaderKeyword[]): Record<string, unknown>[] {
  return list.map((k) => ({ name: k.name, ...(k.values ? { values: [...k.values] } : {}), ...(k.variants === "all" ? { variants: "all" } : {}) }));
}

/** A material's `keywords` object (`{ "RIM": true, "QUALITY": "HIGH" }`), leniently. Checked against a shader by `resolveKeywords`. */
export function parseKeywordValues(raw: unknown, where: string, problems: string[]): Record<string, KeywordValue> {
  const out: Record<string, KeywordValue> = {};
  if (raw === undefined) return out;
  if (!isObject(raw)) {
    problems.push(`${where}: "keywords" should be an object such as { "RIM": true }; ignored.`);
    return out;
  }
  for (const [name, v] of Object.entries(raw)) {
    if (typeof v === "boolean" || typeof v === "string") out[name] = v;
    else problems.push(`${where}: keyword "${name}" should be true, false or one of its values; ignored.`);
  }
  return out;
}

/** Every keyword's effective value: `values`' when it suits the keyword, else its default. Unknown names are reported through `problem`. */
export function resolveKeywords(keywords: readonly ShaderKeyword[], values: Readonly<Record<string, KeywordValue>>, problem?: (message: string) => void): Record<string, KeywordValue> {
  const out: Record<string, KeywordValue> = {};
  for (const k of keywords) {
    const v = values[k.name];
    if (k.values) {
      if (typeof v === "string" && k.values.includes(v)) out[k.name] = v;
      else {
        if (v !== undefined) problem?.(`keyword "${k.name}" has no value ${JSON.stringify(v)} (it has ${k.values.join(", ")}); using ${k.values[0]}.`);
        out[k.name] = k.values[0];
      }
    } else {
      if (v !== undefined && typeof v !== "boolean") problem?.(`keyword "${k.name}" is on/off; ${JSON.stringify(v)} reads as off.`);
      out[k.name] = v === true;
    }
  }
  for (const name of Object.keys(values)) if (!keywords.some((k) => k.name === name)) problem?.(`the shader has no keyword "${name}"; ignored.`);
  return out;
}

/** Every define the keywords can set (what a material plugin registers up front). */
export function allKeywordDefines(keywords: readonly ShaderKeyword[]): string[] {
  return keywords.flatMap((k) => (k.values ? k.values.map((v) => keywordDefine(k.name, v)) : [keywordDefine(k.name)]));
}

/** The defines that are on for these values (as `resolveKeywords` reads them). */
export function keywordDefines(keywords: readonly ShaderKeyword[], values: Readonly<Record<string, KeywordValue>>): string[] {
  const resolved = resolveKeywords(keywords, values);
  return keywords.flatMap((k) => {
    const v = resolved[k.name];
    if (k.values) return [keywordDefine(k.name, v as string)];
    return v === true ? [keywordDefine(k.name)] : [];
  });
}

/**
 * The keyword combinations warm-up compiles for a material (ADR 0106): its own values, then every
 * combination of its `"variants": "all"` keywords with the rest as the material sets them. At most
 * `cap` (with `capped` set when there were more).
 */
export function warmKeywordVariants(keywords: readonly ShaderKeyword[], values: Readonly<Record<string, KeywordValue>>, cap = MAX_WARM_VARIANTS): { variants: Record<string, KeywordValue>[]; capped: boolean } {
  const base = resolveKeywords(keywords, values);
  let combos: Record<string, KeywordValue>[] = [base];
  for (const k of keywords) {
    if (k.variants !== "all") continue;
    const options: KeywordValue[] = k.values ? k.values : [false, true];
    combos = combos.flatMap((c) => options.map((o) => ({ ...c, [k.name]: o })));
  }
  // The material's own combination first, then the rest without repeats.
  const key = (c: Record<string, KeywordValue>) => keywords.map((k) => String(c[k.name])).join("|");
  const seen = new Set<string>([key(base)]);
  const out = [base];
  for (const c of combos) {
    const k = key(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return { variants: out.slice(0, cap), capped: out.length > cap };
}

/**
 * WGSL declarations of the constants a graph's Keyword nodes read: a `bool` per boolean keyword and a
 * `u32` value index per enum keyword, chosen by the defines (`#ifdef`), so the shader compiler drops
 * the branches a variant doesn't take.
 */
export function keywordConstantsWgsl(keywords: readonly ShaderKeyword[]): string {
  const lines: string[] = [];
  for (const k of keywords) {
    const c = keywordConstant(k.name);
    if (!k.values) {
      lines.push(`#ifdef ${keywordDefine(k.name)}`, `const ${c}: bool = true;`, "#else", `const ${c}: bool = false;`, "#endif");
      continue;
    }
    k.values.slice(1).forEach((v, i) => lines.push(`${i === 0 ? "#if" : "#elif"} defined(${keywordDefine(k.name, v)})`, `const ${c}: u32 = ${i + 1}u;`));
    lines.push("#else", `const ${c}: u32 = 0u;`, "#endif");
  }
  return lines.join("\n");
}
