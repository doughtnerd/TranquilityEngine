// The `strings` asset kind (ADR 0356 §1, §9): string tables (`<stem>.strings.json`, `myco.strings@1`) and their
// translations (`<stem>.<code>.strings.json`, `myco.translation@1`) as asset documents, so the Localisation panel's
// edits are undo steps in each file's own history (ADR 0027, 0233) and project-wide changes reach them through their
// owner (ADR 0302). Opening one opens the Localisation panel. The path says which of the two a file is; a translation
// that doesn't exist yet reads as an empty one in its language, so the first translated key creates it.
import { emptyStringTable, formatStringTable, parseStringTable, stringsPathKind, type StringTable } from "../../../engine/localisation/strings/format";
import { emptyTranslation, formatTranslation, parseTranslation, type TranslationFile } from "../../../engine/localisation/strings/translation";
import type { AssetFormat, AssetKindContribution } from "../../sdk/contributions";

/** A strings file's value: a table or a translation. */
export type StringsFile = { readonly kind: "table"; readonly table: StringTable } | { readonly kind: "translation"; readonly translation: TranslationFile };

export const STRINGS_KIND = "strings";

export const stringsFormat: AssetFormat<StringsFile> = {
  parse(raw, path) {
    const kind = stringsPathKind(path);
    if (kind?.kind === "translation") {
      if (raw === undefined) return { value: { kind: "translation", translation: emptyTranslation(kind.code) }, problems: [] };
      const { translation, problems } = parseTranslation(raw, path);
      return { value: { kind: "translation", translation }, problems: problems.map((message) => ({ message })) };
    }
    if (raw === undefined) return { value: { kind: "table", table: emptyStringTable() }, problems: [] };
    const { table, problems } = parseStringTable(raw, path);
    return { value: { kind: "table", table }, problems: problems.map((message) => ({ message })) };
  },
  format: (v) => (v.kind === "table" ? formatStringTable(v.table) : formatTranslation(v.translation)),
  empty: () => ({ kind: "table", table: emptyStringTable() }),
};

/** The kind's registration: the core asset kinds list it (`assetKinds.builtin.ts`). */
export const STRINGS_ASSET_KIND: AssetKindContribution<StringsFile> = {
  id: STRINGS_KIND,
  extensions: [".strings.json"],
  label: "Strings",
  icon: "M4 6h16M4 12h10M4 18h7M17 14l3 6M17 14l-3 6M15 18h4",
  panel: "localisation",
  format: stringsFormat,
  folder: "strings",
  create: { label: "New String Table", name: "new-table", what: "string tables" }, // a stem without spaces or dots (0356 §1)
};
