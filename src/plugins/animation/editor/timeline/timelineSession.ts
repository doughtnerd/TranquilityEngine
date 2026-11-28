// The Timeline window's session (ADR 0373): what the window is bound to, its playhead, selection, nesting and preview,
// shared by the window's views. One per page: the window is a single panel.
//
// - **Binding:** the TimelineDirector on the selected node or its nearest ancestor (its `timeline` file), else the
//   `*.timeline.json` opened in the window (double-click in the Assets panel). Edits go to the timeline's asset document,
//   each one labelled undo step (`applyToDocument`). Bindings are paths relative to the director's node.
// - **Nesting:** double-clicking a clip that is a timeline opens it in the window (`openInner`); the breadcrumb leads back
//   (`goTo`). The stack belongs to the file the window was bound to: binding another file starts again at its top.
// - **Preview** plays the timeline shown on the bound director in the Editor World through the runtime
//   (`timelinePreviewLogic.ts`); turning it off stops it and puts the animated fields back as the scene holds them. A
//   timeline opened from a file (no director) has nothing to preview on.
import { computed, signal } from "@preact/signals";
import { parseAnimSource } from "../../../../engine/animation/animSource";
import { snapToFrame } from "../../../../engine/animation/compile/frames";
import { parseTimeline, type Timeline } from "../../../../engine/animation/timeline";
import type { Binding } from "../../../../engine/animation/tracks";
import { Assets } from "../../../../engine/scene/Assets";
import type { GameObject } from "../../../../engine/scene/GameObject";
import { applyEdit, applyToDocument, editor, openAssetDocument, type AssetDocument, type EditResult, type NodePath, type OpenScene } from "../../../../editor/sdk";
import { TimelineDirector } from "../../runtime/components/TimelineDirector";
import { restoreBindings } from "../animationWindow/animationSession";
import { ClipPlayhead } from "../scene/clipPreviewLogic";
import { TIMELINE_WINDOW_PANEL } from "./panelId";
import { animatedBindings, breadcrumbs, isTimelineRef, openNested, refPath, type Crumb, type NestedStack } from "./timelineModelLogic";
import { TimelinePreviewPlayer } from "./timelinePreviewLogic";

export { TIMELINE_WINDOW_PANEL };

/** What the window edits. */
export type TimelineTarget =
  | { readonly kind: "none"; readonly why: string }
  | { readonly kind: "file"; readonly file: string }
  | { readonly kind: "director"; readonly scene: OpenScene; readonly path: NodePath; readonly node: GameObject; readonly director: TimelineDirector; readonly file: string | null };

/** The fields a timeline's nested clips and timelines drive (to restore after a preview), read from the project's files, at most `depth` levels. */
function nestedBindings(tl: Timeline, depth: number, seen: Set<string>): Binding[] {
  const out: Binding[] = [];
  if (depth <= 0) return out;
  for (const t of tl.tracks) {
    if (t.kind !== "subclip") continue;
    for (const k of t.keys) {
      const path = refPath(k.clip);
      if (seen.has(path) || !Assets.has(path)) continue;
      seen.add(path);
      try {
        const raw = Assets.json(path);
        if (isTimelineRef(path)) {
          const inner = parseTimeline(raw).value;
          out.push(...animatedBindings(inner), ...nestedBindings(inner, depth - 1, seen));
        } else out.push(...animatedBindings(parseAnimSource(raw).value));
      } catch {
        // a file that doesn't parse drives nothing
      }
    }
  }
  return out;
}

class TimelineSession {
  /** Seconds into the timeline; play, pause. */
  readonly playhead = new ClipPlayhead();
  /** Whether playback loops at the end (the preview only; the timeline's own flag is `Timeline.loop`). */
  readonly loop = signal(false);
  readonly previewing = signal(false);
  /** Selected items (`timelineModelLogic.ts` ids). */
  readonly selection = signal<readonly string[]>([]);
  /** The picked row (where "add item at playhead" puts one). */
  readonly activeRow = signal<string | null>(null);
  /** Whether the window is showing. */
  readonly open = signal(false);
  /** The nested timelines opened inside `root`, outermost first, or null at the top. */
  private readonly nested = signal<{ readonly root: string; readonly stack: NestedStack } | null>(null);
  readonly player = new TimelinePreviewPlayer();

  /** The binding (see the file header). Tracks the selection, the open scene and the window's file. */
  readonly target = computed<TimelineTarget>(() => {
    const scene = editor.scene.open;
    let node = editor.scene.selection.node();
    while (node && !node.getComponent(TimelineDirector)) node = node.parent;
    const director = node?.getComponent(TimelineDirector);
    if (scene && node && director) {
      const path = scene.sync.pathOf(node);
      if (path) return { kind: "director", scene, path, node, director, file: director.timeline ? refPath(director.timeline) : null };
    }
    const file = editor.assets.openIn(TIMELINE_WINDOW_PANEL);
    if (file) return { kind: "file", file };
    return { kind: "none", why: "Select a node with a TimelineDirector, or double-click a timeline (*.timeline.json) in the Assets panel." };
  });

  /** The file the window was bound to, before any nesting. */
  readonly baseFile = computed<string | null>(() => {
    const t = this.target.value;
    return t.kind === "file" ? t.file : t.kind === "director" ? t.file : null;
  });

  /** The files from the bound one to the one shown. */
  readonly stack = computed<NestedStack>(() => {
    const base = this.baseFile.value;
    const n = this.nested.value;
    return n && n.root === base ? n.stack : base ? [base] : [];
  });

  /** The breadcrumb of nested timelines. */
  readonly crumbs = computed<Crumb[]>(() => breadcrumbs(this.stack.value));

  /** The timeline file shown, or null. */
  readonly file = computed<string | null>(() => this.stack.value.at(-1) ?? null);

  /** The timeline's asset document, or null (no project, no timeline, or a file that isn't one). */
  readonly document = computed<AssetDocument<Timeline> | null>(() => {
    const project = editor.project.current;
    const file = this.file.value;
    if (!project || !file || !file.toLowerCase().endsWith(".timeline.json") || !project.files.includes(file)) return null;
    return openAssetDocument<Timeline>(project, file, "timeline");
  });

  /** Apply a timeline edit as one labelled undo step on the document. */
  apply(result: EditResult<Timeline>, label: string): boolean {
    const doc = this.document.peek();
    if (!doc) {
      editor.messages.error(`Can't ${label.charAt(0).toLowerCase()}${label.slice(1)}: no timeline is open`);
      return false;
    }
    return applyToDocument(doc, result, label);
  }

  /** Open the timeline a clip names inside the one shown (refused with the reason when it can't be). */
  openInner(ref: string): boolean {
    const base = this.baseFile.peek();
    if (!base) return false;
    return applyEdit(openNested(this.stack.peek(), ref, editor.project.current?.files ?? []), "Open nested timeline", (stack) => {
      this.nested.value = { root: base, stack };
      this.selection.value = [];
      this.activeRow.value = null;
    });
  }

  /** Show the timeline a crumb stands for. */
  goTo(stack: NestedStack): void {
    const base = this.baseFile.peek();
    if (!base) return;
    this.nested.value = stack.length > 1 ? { root: base, stack } : null;
    this.selection.value = [];
    this.activeRow.value = null;
  }

  /** The playhead clamped into the timeline, snapped to its frames. */
  seek(t: number): void {
    const tl = this.document.peek()?.value.peek();
    const rate = tl?.rate ?? 30;
    if (tl) this.playhead.setTiming({ duration: tl.duration, looping: this.loop.peek(), known: true });
    this.playhead.seek(snapToFrame(t, rate, tl?.duration));
  }

  /** Show the timeline at the playhead on the bound director (preview on). */
  show(): void {
    const t = this.target.peek();
    const tl = this.document.peek()?.value.peek();
    if (t.kind !== "director" || !tl || !this.previewing.peek()) return;
    this.player.show(t.director, tl, this.playhead.time.peek(), this.file.peek() ?? undefined);
  }

  /** Turn the preview on or off; off stops it and puts the animated fields back as the scene holds them. */
  setPreview(on: boolean): void {
    if (this.previewing.peek() === on) return;
    this.previewing.value = on;
    if (on) return this.show();
    this.playhead.pause();
    const t = this.target.peek();
    if (t.kind !== "director") return;
    this.player.stop(t.director);
    const tl = this.document.peek()?.value.peek();
    if (tl) restoreBindings(t.scene, t.node, [...animatedBindings(tl), ...nestedBindings(tl, 3, new Set())]);
  }
}

/** The page's one session. */
export const timelineSession = new TimelineSession();
