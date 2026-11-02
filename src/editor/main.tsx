// Scene editor entry (ADR 0022, 0025, 0026). Renders the Preact layout on the start screen (ADR
// 0031): open a project folder (desktop editor only) or a sample. `?sample=<id>` opens a sample
// straight away.
import { render } from "preact";
import { installCloseGuard } from "./dialogs";
import { installMessageLog } from "./messages";
import { findSample } from "./samples";
import { openSample, openTestProject } from "./session";
import { installShortcuts } from "./shortcuts";
import { App } from "./ui/App";
import "./ui/editor.css";

async function main(): Promise<void> {
  installMessageLog();
  render(<App />, document.getElementById("app")!);
  installShortcuts();
  installCloseGuard();
  Object.assign(window, { openTestProject }); // end-to-end test hook
  const sample = new URLSearchParams(location.search).get("sample");
  if (sample) await openSample(await findSample(sample));
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML("beforeend", `<pre style="color:#f88;padding:16px">${String(err?.stack ?? err)}</pre>`);
});
