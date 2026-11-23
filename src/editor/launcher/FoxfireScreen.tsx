// The launcher's first stage (ADR 0380; the "Launcher" artboard): the Foxfire Studios logo, What's new and the
// resources on the brand black, beside one card per application with Open. What's new, the resources and their links
// are placeholders until there is a release feed.
import type { ComponentChildren } from "preact";
import { AUDIO_APP_NAME, launcherArt, PRODUCT_NAME, STUDIO_NAME, VERSION } from "../brand";
import "./foxfire.css";

export type LauncherApp = "myco" | "biosonic";

export interface FoxfireScreenProps {
  onOpen(app: LauncherApp): void;
  readonly chrome?: ComponentChildren;
}

const APPS: readonly { id: LauncherApp; name: string; blurb: string; logo: string; wide: boolean }[] = [
  { id: "myco", name: PRODUCT_NAME, blurb: "2D & 3D game engine.", logo: launcherArt.mycoSplash, wide: true },
  { id: "biosonic", name: AUDIO_APP_NAME, blurb: "Design and mix audio for your games.", logo: launcherArt.biosonicLogo, wide: false },
];

export function FoxfireScreen(props: FoxfireScreenProps) {
  return (
    <div class="ff-root" role="region" aria-label={`${STUDIO_NAME} launcher`}>
      {props.chrome}
      <section class="ff-brand" aria-label={STUDIO_NAME}>
        <img class="ff-logo" src={launcherArt.foxfireSplash} alt={STUDIO_NAME} draggable={false} />
      </section>
      <aside class="ff-info" aria-label="News and resources">
        <div class="ff-news">
          <h2 class="ff-heading">What's new</h2>
          <div class="ff-news-card">
            <p class="ff-news-title">[Latest release headline]</p>
            <p class="ff-news-text">[One line on what changed in this release.]</p>
          </div>
        </div>
        <nav class="ff-resources" aria-label="Resources">
          <h2 class="ff-heading">Resources</h2>
          {["Documentation", "Community", "Report a problem"].map((label) => (
            <span key={label} class="ff-res" aria-disabled="true" title="Coming soon">
              {label}
              <span aria-hidden="true">›</span>
            </span>
          ))}
        </nav>
        <p class="ff-copy">© {STUDIO_NAME}</p>
      </aside>
      <main class="ff-main">
        <header class="ff-head">
          <h1 class="ff-heading">Applications</h1>
          <span class="ff-count">{APPS.length} installed</span>
        </header>
        <div class="ff-grid">
          {APPS.map((app) => (
            <article key={app.id} class="ff-card" aria-labelledby={`ff-${app.id}-name`}>
              <div class="ff-thumb">
                <img src={app.logo} alt="" class={app.wide ? "wide" : ""} draggable={false} />
              </div>
              <div class="ff-card-body">
                <h2 id={`ff-${app.id}-name`} class="ff-card-name">
                  {app.name}
                </h2>
                <p class="ff-card-text">{app.blurb}</p>
                <div class="ff-card-actions">
                  <button type="button" class="ff-open" aria-label={`Open ${app.name}`} onClick={() => props.onOpen(app.id)}>
                    Open
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
        <footer class="ff-footer">
          <span>Launcher {VERSION}</span>
        </footer>
      </main>
    </div>
  );
}
