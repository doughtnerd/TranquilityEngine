// Creating UI documents (ADR 0077; the UI plugin's since ADR 0149): a `.ui.xml` markup file with its
// `.ui.css` stylesheet beside it. The `uidocument` kind's `create` (the Assets panel's New… menu) and the
// Hierarchy's Create > UI Document (through that `create`) make them, so they go when the plugin does.
import { editor } from "../../../editor/sdk";

/** The markup and stylesheet of a new UI document whose stylesheet is `css` (a file name beside it). */
export function newUIDocumentTexts(css: string): { markup: string; stylesheet: string } {
  return {
    markup: `<Canvas>\n  <Style src="${css}"/>\n  <Panel id="panel">\n    <Text id="title">New UI Document</Text>\n  </Panel>\n</Canvas>\n`,
    stylesheet: `/* The look of the document beside it (ADR 0077). */\n#panel {\n  width: 100%;\n  height: 100%;\n  justify-content: center;\n  align-items: center;\n}\n\n#title {\n  font-size: 32px;\n}\n`,
  };
}

/**
 * Create `New UI.ui.xml` with a matching `New UI.ui.css` (or `New UI 2`…) in `folder`: a Canvas
 * root with a panel and a title. Returns the markup's path, or null (read-only project, or a write
 * failed: the status says why).
 */
export async function createUIDocument(folder: string, base = "New UI"): Promise<string | null> {
  const project = editor.project.peek();
  if (!project || editor.project.refuseReadOnly(project, "UI documents")) return null;
  const join = (name: string) => (folder ? `${folder}/${name}` : name);
  const taken = (name: string) => project.files.includes(join(name));
  let stem = base;
  for (let n = 2; taken(`${stem}.ui.xml`) || taken(`${stem}.ui.css`); n++) stem = `${base} ${n}`;
  const { markup, stylesheet } = newUIDocumentTexts(`${stem}.ui.css`);
  try {
    await project.writeFile(join(`${stem}.ui.css`), stylesheet);
    await project.writeFile(join(`${stem}.ui.xml`), markup);
  } catch (err) {
    editor.messages.failed(`Couldn't create ${stem}.ui.xml`, err);
    return null;
  }
  editor.project.changed(); // the Assets panel lists them
  editor.messages.info(`Created ${stem}.ui.xml and ${stem}.ui.css.`);
  return join(`${stem}.ui.xml`);
}
