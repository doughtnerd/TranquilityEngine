// One top-level member of a JSON object's text, set or removed with the rest of the text kept exactly: how a project
// section (ADR 0038, 0151) writes its keys into `project.json` without reformatting the file. Pure and generic.

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

interface Member {
  key: string;
  keyStart: number;
  keyEnd: number;
  valueStart: number;
  valueEnd: number;
}

const skipSpace = (text: string, i: number) => {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
};

function stringEnd(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
  return j + 1;
}

function valueEnd(text: string, i: number): number {
  if (text[i] === '"') return stringEnd(text, i);
  if (text[i] === "{" || text[i] === "[") {
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i = stringEnd(text, i);
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if ((c === "}" || c === "]") && --depth === 0) return i + 1;
      i++;
    }
    return i;
  }
  while (i < text.length && !/[\s,}\]]/.test(text[i])) i++;
  return i;
}

/** The root object's members with their text positions, or null for text it doesn't understand. */
function topLevelMembers(text: string): Member[] | null {
  let i = skipSpace(text, 0);
  if (text[i] !== "{") return null;
  i++;
  const out: Member[] = [];
  for (;;) {
    i = skipSpace(text, i);
    if (text[i] === "}" && out.length === 0) return out;
    if (text[i] !== '"') return null;
    const keyStart = i;
    const keyEnd = stringEnd(text, i);
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    i = skipSpace(text, keyEnd);
    if (text[i] !== ":") return null;
    const start = skipSpace(text, i + 1);
    const end = valueEnd(text, start);
    out.push({ key, keyStart, keyEnd, valueStart: start, valueEnd: end });
    i = skipSpace(text, end);
    if (text[i] === ",") i++;
    else if (text[i] === "}") return out;
    else return null;
  }
}

/**
 * A value as project.json lays values out: objects one key per line, lists of plain values on one
 * line (`["server", "local"]`), lists of objects one per line.
 */
function formatJsonValue(value: unknown, indent = "", unit = "  ", nl = "\n"): string {
  const inner = indent + unit;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((v) => v === null || typeof v !== "object")) return `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
    return `[${nl}${value.map((v) => inner + formatJsonValue(v, inner, unit, nl)).join(`,${nl}`)}${nl}${indent}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return "{}";
    return `{${nl}${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${formatJsonValue(v, inner, unit, nl)}`).join(`,${nl}`)}${nl}${indent}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** A value on one line: compact (`{"a":[1,2]}`) or spaced (`{ "a": [1, 2] }`). */
function formatJsonInline(value: unknown, spaced: boolean): string {
  if (!spaced) return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => formatJsonInline(v, true)).join(", ")}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return entries.length === 0 ? "{}" : `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${formatJsonInline(v, true)}`).join(", ")} }`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * A JSON object's text with its top-level `key` set to `setting` (or removed, for undefined), the
 * way a project section writes its keys into `project.json`: every other key keeps its text exactly. A file laid out one
 * key per line gets the value in that layout, at the keys' indent; a file on one line stays on one
 * line, with its own spacing after `:` and between keys.
 */
export function withMember(text: string, key: string, setting: unknown): string {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const members = topLevelMembers(text);
  if (!members) {
    const json = JSON.parse(text) as Record<string, unknown>;
    return `${formatJsonValue({ ...json, [key]: setting })}\n`;
  }
  // The keys' indent: what precedes the first key that starts its own line (never the `{` before a key on the brace's line).
  const leads = members.map((m) => text.slice(text.lastIndexOf("\n", m.keyStart) + 1, m.keyStart));
  const lineLead = leads.find((lead) => /^[ \t]*$/.test(lead));
  const inline = members.length > 0 && lineLead === undefined;
  const unit = lineLead || "  ";
  const first = members[0];
  const colon = inline ? text.slice(first.keyEnd, first.valueStart) : ": ";
  const spaced = colon.endsWith(" ");
  const value = setting === undefined ? undefined : inline ? formatJsonInline(setting, spaced) : formatJsonValue(setting, unit, unit, nl);
  const at = members.findIndex((m) => m.key === key);
  if (at >= 0) {
    const m = members[at];
    if (value !== undefined) return text.slice(0, m.valueStart) + value + text.slice(m.valueEnd);
    if (at > 0) return text.slice(0, members[at - 1].valueEnd) + text.slice(m.valueEnd);
    const next = members[at + 1];
    return next ? text.slice(0, m.keyStart) + text.slice(next.keyStart) : text.slice(0, text.indexOf("{") + 1) + text.slice(text.lastIndexOf("}"));
  }
  if (value === undefined) return text;
  const entry = `${JSON.stringify(key)}${colon}${value}`;
  const last = members.at(-1);
  if (last && inline) {
    const between = members.length > 1 ? text.slice(members[0].valueEnd, members[1].keyStart) : spaced ? ", " : ",";
    return `${text.slice(0, last.valueEnd)}${between}${entry}${text.slice(last.valueEnd)}`;
  }
  if (last) return `${text.slice(0, last.valueEnd)},${nl}${unit}${entry}${text.slice(last.valueEnd)}`;
  const close = text.lastIndexOf("}");
  return `${text.slice(0, close).trimEnd()}${nl}${unit}${entry}${nl}${text.slice(close)}`;
}
