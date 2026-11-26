/**
 * The built-in subtitle document and stylesheet (ADR 0357 §5), served to UI documents from an asset source the plugin
 * adds under `__myco/subtitles/` (never listed, so the editor and string-table discovery don't see it).
 *
 * **The contract for replacement documents and themes:** a `<Canvas>` root (game UI comes only from documents, ADR 0417;
 * a document without one shows only when the display's node is under a canvas another document built), and an element
 * `#subtitles` whose `<Template>` holds an element
 * with a `.speaker` and a `.line` Text (and optionally a `.box` Panel, the background, whose opacity the player's
 * `background` setting drives). The display writes `#subtitles`' placement (position, margin, max width), each row's
 * opacity (fades) and `speech`/`caption` class, the `.speaker` and `.line` texts, font size and the speaker's colour,
 * and the `.box` opacity. Themes override the variables below in a stylesheet (`SubtitleDisplay.stylesheet`).
 *
 * A display with a `stylesheet` gets a small generated wrapper document: its document `<Use>`d as the root, then the
 * stylesheet, so the theme comes after the document's own styles.
 */
import { Assets, type AssetSource } from "../../../engine/scene/Assets";
import { SUBTITLE_LOOK } from "./look";

export const BUILTIN_FOLDER = "__myco/subtitles";
export const BUILTIN_DOCUMENT = `${BUILTIN_FOLDER}/subtitles.ui.xml`;
export const BUILTIN_STYLESHEET = `${BUILTIN_FOLDER}/subtitles.ui.css`;

// Its own screen canvas above the game's UI (ADR 0357 §5, 0417).
const DOCUMENT = `<Canvas id="subtitle-root" mode="screen" sort-order="1000">
  <Style src="subtitles.ui.css"/>
  <Panel id="subtitles">
    <Template>
      <Panel class="row">
        <Panel class="box"/>
        <Text class="speaker"/>
        <Text class="line"/>
      </Panel>
    </Template>
  </Panel>
</Canvas>
`;

const STYLESHEET = `/* The built-in subtitle look (ADR 0357 §5). Themes override these variables in their own stylesheet. */
:root {
  --subtitle-font: "";
  --subtitle-color: ${SUBTITLE_LOOK.color};
  --subtitle-background: ${SUBTITLE_LOOK.background};
  --subtitle-speaker-color: ${SUBTITLE_LOOK.speakerColor};
  --subtitle-caption-color: ${SUBTITLE_LOOK.captionColor};
  --subtitle-padding: ${SUBTITLE_LOOK.padding}px;
  --subtitle-radius: ${SUBTITLE_LOOK.radius}px;
}

#subtitles { position: absolute; flex-direction: column; align-items: center; gap: ${SUBTITLE_LOOK.gap}px; }
.row { flex-direction: row; align-items: flex-start; gap: ${SUBTITLE_LOOK.nameGap}px; padding: var(--subtitle-padding); }
.box {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background-color: var(--subtitle-background);
  border-radius: var(--subtitle-radius);
}
.speaker, .line { font: var(--subtitle-font); }
.speaker { color: var(--subtitle-speaker-color); font-weight: bold; }
.line { color: var(--subtitle-color); text-align: center; }
.caption .line { color: var(--subtitle-caption-color); }
`;

const files = new Map<string, string>([
  [BUILTIN_DOCUMENT, DOCUMENT],
  [BUILTIN_STYLESHEET, STYLESHEET],
]);

const source: AssetSource = {
  has: (path) => files.has(path),
  get: (path) => files.get(path),
};

/** Keeps the built-in files reachable: a host that cleared the asset sources (a project opening) gets them again. */
export function ensureBuiltinSource(): void {
  if (Assets.has(BUILTIN_STYLESHEET)) return;
  Assets.removeSource(source);
  Assets.addSource(source);
}

let wrappers = 0;
const wrapperOf = new Map<string, string>();

/**
 * The document path a display builds: the built-in document, the replacement `document`, or (with a `stylesheet`) a
 * generated wrapper that uses the document and then the stylesheet.
 */
export function displayDocument(document: string, stylesheet: string): string {
  const doc = normalize(document) || BUILTIN_DOCUMENT;
  const css = normalize(stylesheet);
  if (!css) return doc;
  const id = `${doc}\n${css}`;
  let path = wrapperOf.get(id);
  if (!path) {
    path = `${BUILTIN_FOLDER}/display-${++wrappers}.ui.xml`;
    wrapperOf.set(id, path);
    files.set(path, `<Use src="/${doc}"/>\n<Style src="/${css}"/>\n`);
  }
  return path;
}

const normalize = (p: string): string => p.trim().replace(/^asset:/, "").replace(/^\.?\//, "");
