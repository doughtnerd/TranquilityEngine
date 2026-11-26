// A small project for the Localisation panel's stories: two tables (one a line table's, the Studio's), English text,
// a French translation with a needs-review entry and a broken message, and a Svelte component using the keys.
import { parseLanguages } from "../../../engine/localisation/languages";
import { textHash } from "../../../engine/localisation/textHash";
import { exchangeProjectOf } from "./localisationData";

export const FIXTURE_LANGUAGES = parseLanguages({ list: [{ code: "en", name: "English" }, { code: "fr", name: "Français" }, { code: "ar", name: "العربية" }], reference: "en" }).languages;

export const FIXTURE_FILES: [string, unknown][] = [
  ["strings/menu.strings.json", {
    format: "myco.strings@1", language: "en",
    strings: [
      { key: "menu.start", text: "Start", notes: "Main menu button. Verb.", maxLength: 12 },
      { key: "menu.quit", text: "Quit game" },
      { key: "hud.coins", text: "{count, plural, one {# coin} other {# coins}}", examples: { count: 3 } },
      { key: "old.unused", text: "Nobody uses me" },
    ],
  }],
  ["strings/menu.fr.strings.json", {
    format: "myco.translation@1", language: "fr",
    strings: { "menu.start": { text: "Commencer", source: textHash("Start") }, "menu.quit": { text: "Quitter", source: textHash("Quit") }, "hud.coins": { text: "{n} pièces" } },
  }],
  ["audio/vo/ch1.lines.json", { format: "myco.lines@1", lines: [{ key: "intro_01", speaker: "Ava" }] }],
  ["audio/vo/ch1.strings.json", { format: "myco.strings@1", language: "en", strings: [{ key: "intro_01", text: "Hello there." }] }],
  ["ui/Menu.svelte", '<script lang="ts">\n  import { t } from "myco";\n</script>\n\n<p id="start">{t("menu.start")}</p>\n<p>{t("menu.missing")}</p>\n'],
];

export const fixtureProject = () => exchangeProjectOf(FIXTURE_LANGUAGES, FIXTURE_FILES);
