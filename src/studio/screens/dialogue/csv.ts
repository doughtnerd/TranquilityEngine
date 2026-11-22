// CSV as translators, recording studios and spreadsheets exchange it (RFC 4180; UTF-8 with a byte order mark so Excel
// reads accents; CRLF line ends). Small and generic, for the Dialogue screen's script and report exports until ADR 0342
// T6's shared CSV module lands, which can absorb it unchanged. Reading is lenient: a missing closing quote takes the
// rest of the text, LF or CRLF ends a record, a BOM is dropped, and blank lines are skipped. Pure.

const BOM = "﻿";

/** One field quoted when it must be (a comma, quote, CR or LF, or space at either end). */
export function csvField(value: string | number | boolean | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows as CSV text: a BOM (unless `bom` is false), fields joined by commas, records ended by CRLF. */
export function formatCsv(rows: readonly (readonly (string | number | boolean | null | undefined)[])[], options: { bom?: boolean } = {}): string {
  return `${options.bom === false ? "" : BOM}${rows.map((r) => r.map(csvField).join(",")).join("\r\n")}\r\n`;
}

/** CSV text as rows of fields. */
export function parseCsv(text: string): string[][] {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;
  const endField = () => {
    row.push(field);
    field = "";
    started = false;
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && !started) { quoted = true; started = true; continue; }
    if (c === ",") { endField(); continue; }
    if (c === "\r" && src[i + 1] === "\n") continue;
    if (c === "\n" || c === "\r") { endRow(); continue; }
    field += c;
    started = true;
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/** Rows read against their header: each record as `{ column: value }` (missing fields are ""). */
export function csvRecords(rows: readonly (readonly string[])[]): { header: string[]; records: Record<string, string>[] } {
  const [head, ...body] = rows;
  const header = (head ?? []).map((h) => h.trim());
  return { header, records: body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""]))) };
}
