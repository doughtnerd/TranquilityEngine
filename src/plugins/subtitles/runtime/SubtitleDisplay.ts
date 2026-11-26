/**
 * `SubtitleDisplay` (ADR 0357 §5): the optional built-in subtitle and caption display. Add it to any node (a persistent
 * scene or a HUD prefab); it builds its UI document on a child node. The built-in document's root is a `<Canvas>` (screen
 * mode, `sortOrder` 1000, ADR 0417); a replacement document has its own `<Canvas>` root, or shows under a canvas another
 * document built above the node. It shows what `Audio.onLine` and `Audio.onCaption` report, timed
 * on the heard clock (`Audio.time`), obeying the player's `Subtitles` settings.
 *
 * Built only on public API — `Audio.onLine`, `Audio.onCaption`, `Audio.time`, `Audio.subtitleLanguage`, `Locale`,
 * `Subtitles` and a `UIDocument` — so a game can leave it out and build its own display on the same events.
 *
 * Paging measures text with a character estimate at the display's width and font size (`characterFit`): the UI core's
 * text measuring isn't public API.
 */
import { GameBehavior } from "../../../engine/core/Component";
import { AssetRef, component, field } from "../../../engine/core/registry";
import { Locale } from "../../../engine/localisation/Locale";
import { readingRule } from "../../../engine/localisation/subtitles";
import { GameObject } from "../../../engine/scene/GameObject";
import { UICanvas, type UIPanel, UIText } from "../../../engine/ui/components";
import { UIDocument, type UIDocumentElement } from "../../../engine/ui/UIDocument";
import { Audio, type AudioCaptionEvent, type AudioLineEvent } from "../../audio/runtime";
import { characterFit, fontSizeFor, showSpeakerNames, SubtitleBoard, type BoardRow, type SpeakerNameMode } from "./board";
import { displayDocument, ensureBuiltinSource } from "./builtin";
import { Subtitles } from "./Subtitles";

/** One row's data, also readable by `{name}` bindings in a replacement document's template. */
interface RowItem {
  id: number;
  kind: "speech" | "caption";
  /** The shown speaker name (formatted), or "" when names aren't shown. */
  speaker: string;
  text: string;
}

@component("engine.SubtitleDisplay")
export class SubtitleDisplay extends GameBehavior {
  /** A `*.ui.xml` replacing the built-in one: it needs `#subtitles` with a `<Template>` holding `.speaker` and `.line` texts. */
  @field(AssetRef, { kind: "uidocument" }) document = "";
  /** A `*.ui.css` applied after the built-in one (themes override its variables). */
  @field(AssetRef, { kind: "stylesheet" }) stylesheet = "";
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
  private ui: UIDocument | null = null;
  private items = new Map<number, RowItem>();
  private listed = "";
  private epoch = -1;
  private fitKey = "";
  private fit = characterFit(896, 28.8, 2, "en");

  onEnable(): void {
    ensureBuiltinSource();
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
    this.ui = null;
  }

  update(): void {
    const board = this.board;
    if (!board || !this.ui) return;
    ensureBuiltinSource();
    const doc = displayDocument(this.document, this.stylesheet);
    if (this.ui.document !== doc) this.ui.document = doc;

    const settings = Subtitles.settings;
    board.options = this.boardOptions();
    const canvas = this.canvas();
    const refW = canvas?.referenceResolution.x ?? 1280;
    const refH = canvas?.referenceResolution.y ?? 720;
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

  // --- building ------------------------------------------------------------------------------------------------------

  /** The child its document builds on; the document brings its own canvas (ADR 0417). */
  private mount(): void {
    if (this.host?.isValid) return;
    const host = GameObject.create("Subtitles", { parent: this.node, transform: false });
    this.ui = host.addBehavior(UIDocument, { document: displayDocument(this.document, this.stylesheet) });
    this.host = host;
    this.items.clear();
    this.listed = "";
  }

  /** The canvas its rows are laid out on: the document's root canvas, else the nearest one above the node. */
  private canvas(): UICanvas | null {
    const root = this.ui?.root?.component;
    if (root instanceof UICanvas) return root;
    for (let n: GameObject | null = this.node; n; n = n.parent) {
      const c = n.getComponent(UICanvas);
      if (c) return c;
    }
    return null;
  }

  private language(): string {
    return Audio.subtitleLanguage ?? Locale.language;
  }

  private boardOptions() {
    const s = Subtitles.settings;
    return { maxStack: this.maxStack, fadeIn: this.fadeIn, fadeOut: this.fadeOut, speech: s.enabled, captions: s.captions && this.captions };
  }

  /** Writes this frame's rows into the document: the list (when rows came or went), then each row's look. */
  private show(rows: readonly BoardRow[], fontSize: number, background: number, names: boolean): void {
    const ui = this.ui!;
    const next = new Map<number, RowItem>();
    for (const r of rows) {
      const item = this.items.get(r.id) ?? { id: r.id, kind: r.kind, speaker: "", text: "" };
      item.text = r.text;
      item.speaker = names && r.kind === "speech" && r.speaker !== null ? formatName(Subtitles.speaker(r.speaker).name) : "";
      next.set(r.id, item);
    }
    this.items = next;
    // Bottom: the newest row nearest the bottom edge; top: nearest the top edge.
    const ordered = [...next.values()];
    const ids = ordered.map((i) => i.id).join(",");
    if (ids !== this.listed) {
      this.listed = ids;
      ui.list("#subtitles", ordered, undefined, { key: "id" });
    }
    const container = ui.query("#subtitles");
    if (!container) return;
    const panel = container.component as UIPanel;
    const margin = `${clamp(this.margin, 0, 50)}%`;
    const width = clamp(this.maxWidth, 10, 100);
    set(panel, "positionType", "absolute");
    set(panel, "flexDirection", this.position === "top" ? "column-reverse" : "column");
    set(panel, "top", this.position === "top" ? margin : "auto");
    set(panel, "bottom", this.position === "top" ? "auto" : margin);
    set(panel, "left", `${(100 - width) / 2}%`);
    set(panel, "width", `${width}%`);
    const opacityOf = new Map(rows.map((r) => [r.id, r.opacity]));
    for (const el of container.children) {
      const item = el.item as RowItem | undefined;
      if (!item || !next.has(item.id)) continue;
      set(el.component as UIPanel, "opacity", opacityOf.get(item.id) ?? 1);
      el.classList.toggle("speech", item.kind === "speech");
      el.classList.toggle("caption", item.kind === "caption");
      for (const box of el.queryAll(".box")) set(box.component as UIPanel, "opacity", background);
      const line = text(el, ".line");
      if (line) {
        set(line, "text", item.text);
        set(line, "fontSize", fontSize);
      }
      const speaker = text(el, ".speaker");
      if (speaker) {
        set(speaker, "text", item.speaker);
        set(speaker, "fontSize", fontSize);
        set(speaker, "display", item.speaker === "" ? "none" : "flex");
        const id = rows.find((r) => r.id === item.id)?.speaker;
        const color = id ? Subtitles.speaker(id).color : null;
        if (color && (speaker.color.r !== color.r || speaker.color.g !== color.g || speaker.color.b !== color.b || speaker.color.a !== color.a)) speaker.color = color;
      }
    }
  }
}

/** `{name}:` through the project's `subtitles.speaker` string when it has one (French writes `{name} :`). */
function formatName(name: string): string {
  return Locale.has("subtitles.speaker") ? Locale.t("subtitles.speaker", { name }) : `${name}:`;
}

function text(row: UIDocumentElement, selector: string): UIText | null {
  const el = row.query(selector);
  return el && el.component instanceof UIText ? el.component : null;
}

/** Writes a field only when it differs (so the UI isn't marked changed every frame). */
function set<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): void {
  if (target[key] !== value) target[key] = value;
}

const clamp = (v: number, lo: number, hi: number): number => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
