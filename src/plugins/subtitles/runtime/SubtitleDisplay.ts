/**
 * `SubtitleDisplay` (ADR 0357 §5): the optional built-in subtitle and caption display. Add it to any node (a persistent
 * scene or a HUD prefab); it mounts its view on a child node: a `UIView` of the built-in Svelte component
 * (`@myco/ui/Subtitles.svelte`, ADR 0419 wave B) on its own screen canvas (`sortOrder` 1000), or of a replacement
 * component (`component`), which gets the same props. It shows what `Audio.onLine` and `Audio.onCaption` report, timed
 * on the heard clock (`Audio.time`), obeying the player's `Subtitles` settings.
 *
 * **The props a replacement component gets:** `rows` (the rows on screen, oldest first: `{ id, kind: "speech" |
 * "caption", speaker, text, opacity, color }`, where `speaker` is the formatted name or "" when names aren't shown,
 * `opacity` the fade and `color` the speaker's CSS colour or null), `position` (`"bottom"` or `"top"`), `margin` (% of
 * the canvas height from that edge), `maxWidth` (% of the canvas width), `fontSize` (UI pixels) and `background` (the
 * player's background opacity). Themes for the built-in component set its `--subtitle-*` variables in a global rule
 * (`:global(:root) { --subtitle-color: #ffee00; }`) of any of the game's components.
 *
 * Built only on public API — `Audio.onLine`, `Audio.onCaption`, `Audio.time`, `Audio.subtitleLanguage`, `Locale`,
 * `Subtitles` and a `UIView` — so a game can leave it out and build its own display on the same events.
 *
 * Paging measures text with a character estimate at the display's width and font size (`characterFit`): the UI core's
 * text measuring isn't public API.
 */
import { GameBehavior } from "../../../engine/core/Component";
import { AssetRef, component, field } from "../../../engine/core/registry";
import { Locale } from "../../../engine/localisation/Locale";
import { readingRule } from "../../../engine/localisation/subtitles";
import { GameObject } from "../../../engine/scene/GameObject";
import { Audio, type AudioCaptionEvent, type AudioLineEvent } from "../../audio/runtime";
import { UIView } from "../../ui/runtime/UIView";
import { characterFit, fontSizeFor, showSpeakerNames, SubtitleBoard, type BoardRow, type SpeakerNameMode } from "./board";
import { Subtitles } from "./Subtitles";

/** The built-in component (ADR 0419 wave B). */
export const SUBTITLES_COMPONENT = "@myco/ui/Subtitles.svelte";

/** One row as the view gets it. */
interface RowProps {
  id: number;
  kind: "speech" | "caption";
  /** The shown speaker name (formatted), or "" when names aren't shown. */
  speaker: string;
  text: string;
  /** The fade, 0 to 1. */
  opacity: number;
  /** The speaker's colour (CSS), or null. */
  color: string | null;
}

@component("engine.SubtitleDisplay")
export class SubtitleDisplay extends GameBehavior {
  /** A Svelte component replacing the built-in one; it gets the rows and their placement as props (see the class's notes). */
  @field(AssetRef, { kind: "svelte" }) component = "";
  @field(String, { choices: ["bottom", "top"] }) position: "bottom" | "top" = "bottom";
  /** % of the canvas height from the edge (title-safe). */
  @field(Number) margin = 8;
  /** % of the canvas width. */
  @field(Number) maxWidth = 70;
  /** Lines per page before paging. */
  @field(Number) maxLines = 2;
  /** Rows on screen at once. */
  @field(Number) maxStack = 3;
  /** Multiplies the size presets. */
  @field(Number) sizeScale = 1;
  /** `always`, `whenSeveral` (only while two or more speakers are shown) or `never`. */
  @field(String, { choices: ["always", "whenSeveral", "never"] }) speakerNames: SpeakerNameMode = "always";
  /** Seconds. */
  @field(Number) fadeIn = 0.12;
  /** Seconds. */
  @field(Number) fadeOut = 0.2;
  /** Shows captions when the player's setting allows. */
  @field(Boolean) captions = true;

  /** @internal The editor's Play overlay (ADR 0357 §6): stands aside while the game has a display of its own. */
  _overlay = false;

  private board: SubtitleBoard | null = null;
  private offs: (() => void)[] = [];
  private host: GameObject | null = null;
  private view: UIView | null = null;
  /** The props last passed to the view, as JSON. */
  private shown = "";
  private epoch = -1;
  private fitKey = "";
  private fit = characterFit(896, 28.8, 2, "en");

  onEnable(): void {
    this.board ??= new SubtitleBoard(
      {
        resolve: (key) => {
          // Subtitles follow the text language unless the game set another subtitle language (then the event's text stays).
          const sub = Audio.subtitleLanguage;
          if (sub !== null && sub.toLowerCase() !== Locale.language.toLowerCase()) return null;
          return Locale.has(key) ? Locale.t(key) : null;
        },
        rule: () => readingRule(this.language(), this._world.settings.languages, this._world.settings.subtitles),
        fits: () => this.fit,
      },
      this.boardOptions(),
    );
    this.epoch = Locale.epoch;
    this.offs.push(
      Audio.onLine((e: AudioLineEvent) => this.board?.line(e)),
      Audio.onCaption((e: AudioCaptionEvent) => this.board?.caption(e)),
    );
    this.mount();
    this.host?.setActive(true);
  }

  onDisable(): void {
    for (const off of this.offs.splice(0)) off();
    this.board?.clear();
    if (this.host?.isValid) this.host.setActive(false);
  }

  onDestroy(): void {
    if (this.host?.isValid) GameObject.destroy(this.host);
    this.host = null;
    this.view = null;
  }

  update(): void {
    const board = this.board;
    const view = this.view;
    if (!board || !view) return;
    const path = this.componentPath();
    if (view.component !== path) view.component = path;

    const settings = Subtitles.settings;
    board.options = this.boardOptions();
    const refW = view.referenceResolution.x;
    const refH = view.referenceResolution.y;
    const fontSize = fontSizeFor(settings.size, refH, this.sizeScale);
    const width = (refW * clamp(this.maxWidth, 10, 100)) / 100;
    const fitKey = `${width}|${fontSize}|${this.maxLines}|${this.language()}`;
    if (fitKey !== this.fitKey) {
      this.fitKey = fitKey;
      this.fit = characterFit(width, fontSize, this.maxLines, this.language());
      board.repage();
    }
    if (Locale.epoch !== this.epoch) {
      this.epoch = Locale.epoch;
      board.refreshText();
    }

    const aside = this._overlay && this._world._componentsOfType(SubtitleDisplay).some((d) => d !== this && d.isActiveAndEnabled && !d._overlay);
    const rows = aside ? [] : board.rows(Audio.time);
    this.show(rows, fontSize, settings.background, showSpeakerNames(rows, this.speakerNames, settings.speakerNames));
  }

  // --- the view ------------------------------------------------------------------------------------------------------

  /** The child its view mounts on: a screen canvas of its own, above the game's UI. */
  private mount(): void {
    if (this.host?.isValid) return;
    const host = GameObject.create("Subtitles", { parent: this.node, transform: false });
    this.view = host.addBehavior(UIView, { component: this.componentPath(), mode: "screen", sortOrder: 1000, props: { rows: [] } });
    this.host = host;
    this.shown = "";
  }

  /** The component the view mounts: the replacement, else the built-in one. */
  private componentPath(): string {
    const own = this.component.trim();
    return own || `asset:${SUBTITLES_COMPONENT}`;
  }

  private language(): string {
    return Audio.subtitleLanguage ?? Locale.language;
  }

  private boardOptions() {
    const s = Subtitles.settings;
    return { maxStack: this.maxStack, fadeIn: this.fadeIn, fadeOut: this.fadeOut, speech: s.enabled, captions: s.captions && this.captions };
  }

  /** Passes this frame's rows and their placement to the view, when they changed. */
  private show(rows: readonly BoardRow[], fontSize: number, background: number, names: boolean): void {
    const out: RowProps[] = rows.map((r) => {
      const look = r.kind === "speech" && r.speaker !== null ? Subtitles.speaker(r.speaker) : null;
      const speaker = names && look ? formatName(look.name) : "";
      const c = speaker ? look!.color : null;
      return { id: r.id, kind: r.kind, speaker, text: r.text, opacity: r.opacity, color: c ? `rgba(${c.r * 100}%, ${c.g * 100}%, ${c.b * 100}%, ${c.a})` : null };
    });
    const props = { rows: out, position: this.position, margin: clamp(this.margin, 0, 50), maxWidth: clamp(this.maxWidth, 10, 100), fontSize, background };
    const json = JSON.stringify(props);
    if (json === this.shown) return;
    this.shown = json;
    this.view!.props = props;
  }
}

/** `{name}:` through the project's `subtitles.speaker` string when it has one (French writes `{name} :`). */
function formatName(name: string): string {
  return Locale.has("subtitles.speaker") ? Locale.t("subtitles.speaker", { name }) : `${name}:`;
}

const clamp = (v: number, lo: number, hi: number): number => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
