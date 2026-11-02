// Scene editor entry (ADR 0022, 0025, 0026). Renders the Preact layout, then opens the bundled
// demo project; Open Project switches to a folder on disk (desktop editor only).
import { render } from "preact";
import { installCloseGuard } from "./dialogs";
import { installMessageLog } from "./messages";
import { bundledDemoProject } from "./projects";
import { loadProject } from "./session";
import { installShortcuts } from "./shortcuts";
import { App } from "./ui/App";
import "./ui/editor.css";

async function main(): Promise<void> {
  installMessageLog();
  render(<App />, document.getElementById("app")!);
  installShortcuts();
  installCloseGuard();
  await loadProject(bundledDemoProject());
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML("beforeend", `<pre style="color:#f88;padding:16px">${String(err?.stack ?? err)}</pre>`);
});
