// The Inspector's Localise control for a UI document element's text field (ADR 0356 §9): shows the key the field is
// bound to with its text in the preview language (Unlink removes the binding), or offers to pick a key (search keys and
// text, each with its preview) or Extract to string table (a suggested key in a chosen table, the field's literal text
// as its reference text). A view: matches and the suggestions come from `localiseModel.ts` through the Inspector.
import { useState } from "preact/hooks";
import type { KeyMatch } from "./localiseModel";
import "./localisation.css";

export interface LocaliseControlProps {
  readonly field: string;
  /** The key the field is bound to, or null. */
  readonly boundKey: string | null;
  /** The bound key's text in the preview language (null: defined in no table). */
  readonly boundPreview: string | null;
  readonly previewLanguage: string;
  /** The field's literal text (what Extract writes as reference text), or null. */
  readonly literal: string | null;
  /** Keys matching a search. */
  findKeys(search: string): readonly KeyMatch[];
  readonly tables: readonly string[];
  readonly suggestedTable: string;
  readonly suggestedKey: string;
  /** Why nothing can be changed now (read-only, playing), or null. */
  readonly disabled: string | null;
  onPick(key: string): void;
  onUnlink(): void;
  onExtract(table: string, key: string): void;
}

export function LocaliseControl(p: LocaliseControlProps) {
  const [mode, setMode] = useState<"closed" | "pick" | "extract">("closed");
  const [search, setSearch] = useState("");
  const [table, setTable] = useState(p.suggestedTable);
  const [key, setKey] = useState(p.suggestedKey);
  const off = p.disabled !== null;

  if (p.boundKey !== null) {
    return (
      <div class="localise-control" role="group" aria-label={`${p.field} localisation`}>
        <div class="localise-row">
          <span class="mono" title="The string key this field shows">
            {p.boundKey}
          </span>
          <button type="button" class="link-button" disabled={off} title={p.disabled ?? "Write the text into the element again instead of the key"} onClick={p.onUnlink}>
            Unlink
          </button>
        </div>
        <span class="localise-preview">
          {p.boundPreview === null ? "No table defines this key: the game shows the key itself." : `${p.previewLanguage}: ${p.boundPreview}`}
        </span>
      </div>
    );
  }

  if (mode === "closed") {
    return (
      <div class="localise-control" role="group" aria-label={`${p.field} localisation`}>
        <div class="localise-row">
          <button type="button" disabled={off} title={p.disabled ?? "Show a string key here instead of literal text"} onClick={() => setMode("pick")}>
            Localise…
          </button>
          <button
            type="button"
            disabled={off || !p.literal}
            title={p.disabled ?? (p.literal ? `Add "${p.literal}" to a string table under a new key and show that key here` : "The field has no literal text to extract")}
            onClick={() => {
              setTable(p.suggestedTable);
              setKey(p.suggestedKey);
              setMode("extract");
            }}
          >
            Extract to string table…
          </button>
        </div>
      </div>
    );
  }

  if (mode === "pick") {
    const matches = p.findKeys(search);
    return (
      <div class="localise-control" role="group" aria-label={`${p.field} localisation`}>
        <div class="localise-row">
          <input type="search" aria-label="Find a key" placeholder="Search keys and text" value={search} ref={(i) => i?.focus()} onInput={(e) => setSearch((e.currentTarget as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Escape" && setMode("closed")} />
          <button type="button" onClick={() => setMode("closed")}>
            Cancel
          </button>
        </div>
        {matches.length === 0 ? (
          <span class="localise-preview">No key matches. Extract the text to a table to make one.</span>
        ) : (
          <ul class="localise-matches" aria-label="Keys">
            {matches.map((m) => (
              <li key={m.key}>
                <button type="button" title={`${m.table}: ${m.preview}`} onClick={() => (setMode("closed"), p.onPick(m.key))}>
                  <span class="mono">{m.key}</span>
                  <span>{m.preview}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div class="localise-control" role="group" aria-label={`${p.field} localisation`}>
      <span class="localise-preview">Reference text: “{p.literal}”</span>
      <div class="localise-row">
        <input type="text" class="mono" aria-label="New key" value={key} onInput={(e) => setKey((e.currentTarget as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && (setMode("closed"), p.onExtract(table, key))} />
      </div>
      <div class="localise-row">
        <input type="text" list="localise-tables" aria-label="String table" value={table} onInput={(e) => setTable((e.currentTarget as HTMLInputElement).value)} />
        <datalist id="localise-tables">
          {p.tables.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </div>
      <div class="localise-row">
        <button type="button" class="primary" disabled={key.trim() === "" || table.trim() === ""} onClick={() => (setMode("closed"), p.onExtract(table.trim(), key.trim()))}>
          Extract
        </button>
        <button type="button" onClick={() => setMode("closed")}>
          Cancel
        </button>
      </div>
    </div>
  );
}
