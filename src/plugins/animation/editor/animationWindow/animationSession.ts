// The Animation window's session (ADR 0373): what the window is bound to, its playhead, selection, record mode,
// preview and onion skin, shared by the window's views, the Inspector's key buttons and the record-mode interceptor.
// One per page: the window is a single panel.
//
// - **Binding:** the Animator on the selected node or its nearest ancestor (its `defaultClip`, or a clip chosen in the
//   window), else the `*.anim.json` opened in the window (double-click in the Assets panel). Edits go to the clip's
//   asset document, each one labelled undo step (`applyToDocument`).
// - **Preview** plays the clip on the bound Animator in the Editor World through the runtime (`previewLogic.ts`);
//   turning it off stops the play and puts the animated fields back as the scene holds them.
// - **Record mode** (`recordLogic.ts`): the field write interceptor takes writes to animatable fields of nodes under
//   the bound Animator, shows them on the live node and keys them at the playhead; every write inside one undo step
//   of the scene (a gizmo drag, an Inspector scrub) becomes one undo step on the clip when the step closes.
import { computed, signal } from "@preact/signals";
import type { AnimSource } from "../../../../engine/animation/animSource";
import { nodePathOf, parseFieldPath, resolveNodePath, trackBinding } from "../../../../engine/animation/bindingPath";
import type { Binding } from "../../../../engine/animation/tracks";
import type { GameObject } from "../../../../engine/scene/GameObject";
import {
  applyToDocument,
  editor,
  openAssetDocument,
  type AssetDocument,
  type EditResult,
  type FieldWriteInterceptorContribution,
  type InterceptedFieldWrite,
  type NodePath,
  type OpenScene,
} from "../../../../editor/sdk";
import { storedFieldValue } from "../../../../editor/sdk";
import { Animator } from "../../runtime/components/Animator";
import { ClipPlayhead } from "../scene/clipPreviewLogic";
import type { KeyClipboard } from "./clipEditLogic";
import type { OnionSettings } from "./onionSkinLogic";
import { ANIMATION_WINDOW_PANEL } from "./panelId";
import { ClipPreviewPlayer } from "./previewLogic";
import { recordWrite } from "./recordLogic";

export { ANIMATION_WINDOW_PANEL };

/** What the window edits. */
export type WindowTarget =
  | { readonly kind: "none"; readonly why: string }
  | { readonly kind: "file"; readonly clip: string }
  | { readonly kind: "animator"; readonly scene: OpenScene; readonly path: NodePath; readonly node: GameObject; readonly animator: Animator; readonly clip: string | null };

const clipPath = (ref: string) => ref.replace(/^asset:/, "");

class AnimationSession {
  /** Seconds into the clip; play, pause and the loop flag. */
  readonly playhead = new ClipPlayhead();
  readonly loop = signal(true);
  readonly recording = signal(false);
  readonly previewing = signal(false);
  /** Selected keys (leaf key ids, `trackRowsLogic.ts`). */
  readonly selection = signal<readonly string[]>([]);
  /** The picked row (paste target, curve view). */
  readonly activeRow = signal<string | null>(null);
  /** Onion skin settings, or null when it is off. */
  readonly onion = signal<OnionSettings | null>(null);
  /** A clip chosen for the bound Animator instead of its default clip, by Animator node key. */
  readonly chosen = signal<ReadonlyMap<string, string>>(new Map());
  /** Whether the window is showing (key buttons appear only then). */
  readonly open = signal(false);
  /** Keys copied in the window. */
  copied: KeyClipboard | null = null;
  readonly player = new ClipPreviewPlayer();

  /** The binding (see the file header). Tracks the selection, the open scene and the window's file. */
  readonly target = computed<WindowTarget>(() => {
    const scene = editor.scene.open;
    let node = editor.scene.selection.node();
    while (node && !node.getComponent(Animator)) node = node.parent;
    const animator = node?.getComponent(Animator);
    if (scene && node && animator) {
      const path = scene.sync.pathOf(node);
      if (path) {
        const chosen = this.chosen.value.get(path.join("/"));
        const clip = chosen ?? (animator.defaultClip ? clipPath(animator.defaultClip) : null);
        return { kind: "animator", scene, path, node, animator, clip };
      }
    }
    const file = editor.assets.openIn(ANIMATION_WINDOW_PANEL);
    if (file) return { kind: "file", clip: file };
    return { kind: "none", why: "Select a node with an Animator, or double-click an animation clip (*.anim.json) in the Assets panel." };
  });

  /** The clip file the window edits, or null. */
  readonly clipFile = computed<string | null>(() => {
    const t = this.target.value;
    return t.kind === "file" ? t.clip : t.kind === "animator" ? t.clip : null;
  });

  /** The clip's asset document, or null (no project, no clip, or a file that isn't an authored clip). */
  readonly document = computed<AssetDocument<AnimSource> | null>(() => {
    const project = editor.project.current;
    const file = this.clipFile.value;
    if (!project || !file || !file.toLowerCase().endsWith(".anim.json") || !project.files.includes(file)) return null;
    return openAssetDocument<AnimSource>(project, file, "animclip");
  });

  /** Apply a clip edit as one labelled undo step on the clip's document. */
  apply(result: EditResult<AnimSource>, label: string): boolean {
    const doc = this.document.peek();
    if (!doc) {
      editor.messages.error(`Can't ${label.charAt(0).toLowerCase()}${label.slice(1)}: no clip is open`);
      return false;
    }
    return applyToDocument(doc, result, label);
  }

  /** The bound field's binding for a document field of a node under the bound Animator, or null. */
  bindingOf(scene: OpenScene, path: NodePath, type: string, field: string): Binding | null {
    const t = this.target.value;
    if (t.kind !== "animator" || t.scene !== scene) return null;
    const node = scene.sync.nodeFor(path);
    const nodePath = node ? nodePathOf(t.node, node) : null;
    return nodePath === null ? null : { nodePath, component: type, field };
  }

  /** The playhead snapped to the clip's frames and clamped into it. */
  seek(t: number): void {
    const clip = this.document.peek()?.value.peek();
    const rate = clip?.rate ?? 30;
    if (clip) this.playhead.setTiming({ duration: clip.duration, looping: this.loop.peek(), known: true });
    this.playhead.seek(Math.round(t * rate) / rate);
  }

  /** Show the clip at the playhead on the bound Animator (preview on). */
  show(): void {
    const t = this.target.peek();
    const clip = this.document.peek()?.value.peek();
    if (t.kind !== "animator" || !clip || !this.previewing.peek()) return;
    this.player.show(t.animator, clip, this.playhead.time.peek(), t.clip ?? undefined);
  }

  /** Turn the preview on or off; off stops the play and puts the animated fields back as the scene holds them. */
  setPreview(on: boolean): void {
    if (this.previewing.peek() === on) return;
    this.previewing.value = on;
    if (on) return this.show();
    this.recording.value = false;
    this.playhead.pause();
    const t = this.target.peek();
    if (t.kind !== "animator") return;
    this.player.stop(t.animator);
    restoreFields(t, this.document.peek()?.value.peek() ?? null);
  }

  /** Record mode on (preview with it) or off. */
  setRecording(on: boolean): void {
    if (on) this.setPreview(true);
    this.recording.value = on;
  }
}

/** Put the fields `clip` animates under the Animator back to what the scene holds (after a preview). */
function restoreFields(t: Extract<WindowTarget, { kind: "animator" }>, clip: AnimSource | null): void {
  if (!clip) return;
  restoreBindings(t.scene, t.node, clip.tracks.flatMap((track) => trackBinding(track) ?? []));
}

/**
 * Put the fields `bindings` name (nodes relative to `root`) back to what the open scene holds, after a preview wrote
 * them. Shared with the Timeline window (T53), whose director previews the same way.
 */
export function restoreBindings(scene: OpenScene, root: GameObject, bindings: readonly Binding[]): void {
  for (const b of bindings) {
    if (!b.component) continue;
    const node = resolveNodePath(root, b.nodePath);
    const path = node && scene.sync.pathOf(node);
    if (!node || !path) continue;
    const field = parseFieldPath(b.field).head;
    const [id, ...inner] = path;
    const stored = inner.length ? scene.doc.overrideValue(id!, inner, b.component, field) : scene.doc.fieldValue(id!, b.component, field);
    if (stored !== undefined) editor.scene.writeField({ node, type: b.component }, field, stored);
  }
}

/** The page's one session. */
export const animationSession = new AnimationSession();

/** A drag's recorded keys, waiting for its undo step to close: the clip so far, the label, and the live values to put back. */
interface PendingRecord {
  doc: AssetDocument<AnimSource>;
  clip: AnimSource;
  label: string;
  readonly restore: Map<string, () => void>;
  refused: boolean;
}

const pending = new Map<number, PendingRecord>();

/**
 * Record mode's field write interceptor (ADR 0373): takes writes to animatable fields of nodes under the bound Animator
 * while recording (see the file header).
 */
export const recordInterceptor: FieldWriteInterceptorContribution = {
  id: "myco.animation.record",
  take(w: InterceptedFieldWrite): boolean {
    const s = animationSession;
    if (!s.recording.peek()) return false;
    const binding = s.bindingOf(w.scene, w.path, w.type, w.field);
    const doc = s.document.peek();
    if (!binding || !doc) return false;
    const p = w.gesture === null ? null : pending.get(w.gesture);
    const rec = recordWrite(p?.clip ?? doc.value.peek(), { nodePath: binding.nodePath, type: w.type, field: w.field, value: w.value, stored: w.stored }, s.playhead.time.peek());
    if (!rec) return false;
    const node = w.scene.sync.nodeFor(w.path);
    if ("refused" in rec.result) {
      // Shown once per drag; the scene stays as it is (record mode doesn't fall back to editing the scene).
      if (!p?.refused) editor.messages.error(`Can't ${rec.label.toLowerCase()}: ${rec.result.refused}`);
      if (p) p.refused = true;
      else if (w.gesture !== null) pending.set(w.gesture, { doc, clip: doc.value.peek(), label: rec.label, restore: new Map(), refused: true });
      return true;
    }
    const place = node ? { node, type: w.type, index: w.index } : null;
    if (w.gesture === null) {
      applyToDocument(doc, rec.result, rec.label);
      if (place) editor.scene.writeField(place, w.field, w.value);
      return true;
    }
    const entry = p ?? { doc, clip: doc.value.peek(), label: rec.label, restore: new Map<string, () => void>(), refused: false };
    entry.clip = rec.result.next;
    entry.label = rec.label;
    if (place) {
      const key = `${w.path.join("/")}|${w.type}|${w.index}|${w.field}`;
      if (!entry.restore.has(key)) {
        const shown = storedFieldValue(place, w.field) ?? w.stored; // what the viewport shows before the drag
        entry.restore.set(key, () => void (shown !== undefined && editor.scene.writeField(place, w.field, shown)));
      }
      editor.scene.writeField(place, w.field, w.value); // the viewport follows the drag
    }
    pending.set(w.gesture, entry);
    return true;
  },
  gestureEnded(gesture: number, cancelled: boolean) {
    const p = pending.get(gesture);
    pending.delete(gesture);
    if (!p) return;
    if (cancelled || p.refused) {
      for (const put of p.restore.values()) put();
      animationSession.show();
      return;
    }
    p.doc.edit(p.clip, { label: p.label });
  },
};
