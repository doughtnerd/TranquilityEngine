// An application's projects screen frame (ADR 0380; the "Myco Engine · Projects" and "Biosonic · Projects" artboards):
// the brand column (the app's logo and tagline on the brand black, with the way back to the Foxfire launcher and the
// studio credit under it) beside the main column, which ends in the status line (`status`: what opening a project
// said) and the app's version. Only the tab panel scrolls; the brand column, the tabs and the footer stay put. Fluid: the brand column stacks over the main one on narrow windows (appProjects.css).
import type { ComponentChildren } from "preact";
import { STUDIO_NAME } from "../../brand";
import { status } from "../../state";
import "./appProjects.css";

export interface AppProjectsLayoutProps {
  /** The app's name, the brand column's accessible name and the logo's alt text ("Myco Engine"). */
  readonly app: string;
  readonly logo: string;
  readonly tagline: string;
  /** Back to the Foxfire launcher; absent where the screen is the app's own start (the standalone Studio). */
  readonly back?: () => void;
  /** The version line at the bottom of the main column ("Myco Engine 0.1.0"). */
  readonly footer: string;
  /** Shown in the footer's status line while there is no status message ("Starting the editor…"). */
  readonly note?: string;
  /** Laid over the top right (the borderless window's controls); the main column then starts with an empty title-bar row under them. */
  readonly chrome?: ComponentChildren;
  readonly children: ComponentChildren;
}

export function AppProjectsLayout(props: AppProjectsLayoutProps) {
  const s = status.value;
  return (
    <div class={`ap-root${props.chrome ? " has-chrome" : ""}`} role="region" aria-label={`${props.app} projects`}>
      {props.chrome}
      <section class="ap-brand" aria-label={props.app}>
        <img class="ap-logo" src={props.logo} alt={props.app} draggable={false} />
        <p class="ap-tagline">{props.tagline}</p>
      </section>
      <aside class="ap-info" aria-label="Navigation">
        {props.back ? (
          <button type="button" class="ap-back" onClick={props.back}>
            <span aria-hidden="true">‹</span>Foxfire launcher
          </button>
        ) : (
          <span />
        )}
        <span class="ap-credit">© {STUDIO_NAME}</span>
      </aside>
      <main class="ap-main">
        {props.chrome && <div class="ap-titlebar" aria-hidden="true" />}
        {props.children}
        <footer class="ap-footer">
          <span class={`ap-status${s?.kind === "error" ? " error" : ""}`} role="status">
            {s?.text ?? props.note ?? ""}
          </span>
          <span>{props.footer}</span>
        </footer>
      </main>
    </div>
  );
}
