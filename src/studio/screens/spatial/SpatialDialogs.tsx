// The Spatial screen's dialogs: From open game scene (pick the game scene the test scene plays over), From take (pick a
// take and a moment: listener and emitter positions there) and, for "Edit attenuation…" on a playlist without any,
// Create preset or Inline.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AudioTestScene } from "../../../engine/audio/spatial/testSceneTypes";
import { takeClock } from "./newScene";

function Dialog(props: { title: string; onCancel(): void; children: ComponentChildren; footer: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("select, input, button.primary")?.focus();
  }, []);
  return (
    <div class="sp-dialog-scrim" onPointerDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div ref={ref} class="sp-dialog" role="dialog" aria-modal="true" aria-label={props.title} onKeyDown={(e) => e.key === "Escape" && props.onCancel()}>
        <h2 class="sp-dialog-title">{props.title}</h2>
        {props.children}
        <div class="sp-dialog-footer">{props.footer}</div>
      </div>
    </div>
  );
}

export interface GameSceneDialogProps {
  readonly scenes: readonly string[];
  onPick(path: string): void;
  onCancel(): void;
}

export function GameSceneDialog(props: GameSceneDialogProps) {
  const [pick, setPick] = useState(props.scenes[0] ?? "");
  return (
    <Dialog
      title="New test scene from a game scene"
      onCancel={props.onCancel}
      footer={
        <>
          <button type="button" onClick={props.onCancel}>Cancel</button>
          <button type="button" class="primary" disabled={!pick} onClick={() => props.onPick(pick)}>Create</button>
        </>
      }
    >
      {props.scenes.length === 0 ? (
        <p class="sp-note">The project has no game scenes (*.scene.json).</p>
      ) : (
        <>
          <p class="sp-note">The game scene's emitters, colliders and zones play underneath, read-only; replacing a sound for A/B never changes the game scene.</p>
          <label class="sp-dialog-field">
            Game scene
            <select value={pick} onChange={(e) => setPick((e.currentTarget as HTMLSelectElement).value)}>
              {props.scenes.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        </>
      )}
    </Dialog>
  );
}

export interface TakeDialogProps {
  readonly takes: readonly string[];
  /** Open a take: its length and the scene at a moment. */
  open(path: string): Promise<{ duration: number; at(t: number): AudioTestScene }>;
  onCreate(path: string, scene: AudioTestScene, t: number): void;
  onCancel(): void;
}

export function TakeDialog(props: TakeDialogProps) {
  const [path, setPath] = useState(props.takes[0] ?? "");
  const [take, setTake] = useState<{ path: string; duration: number; at(t: number): AudioTestScene } | { path: string; error: string } | null>(null);
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setTake(null);
    props.open(path).then(
      (r) => live && (setTake({ path, ...r }), setT(Math.min(t, r.duration))),
      (e: unknown) => live && setTake({ path, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [path]);
  const ready = take && "at" in take ? take : null;
  const preview = ready ? ready.at(t) : null;
  return (
    <Dialog
      title="New test scene from a take"
      onCancel={props.onCancel}
      footer={
        <>
          <button type="button" onClick={props.onCancel}>Cancel</button>
          <button type="button" class="primary" disabled={!ready || !preview} onClick={() => ready && preview && props.onCreate(path, preview, t)}>Create</button>
        </>
      }
    >
      {props.takes.length === 0 ? (
        <p class="sp-note">The project has no takes yet: record one while playing the game (Take screen).</p>
      ) : (
        <>
          <p class="sp-note">The listener and every emitter where they were at that moment, each playing what the take last started on it.</p>
          <label class="sp-dialog-field">
            Take
            <select value={path} onChange={(e) => setPath((e.currentTarget as HTMLSelectElement).value)}>
              {props.takes.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          {take && "error" in take && <p class="sp-error" role="alert">Couldn't open the take: {take.error}</p>}
          {!take && <p class="sp-note">Opening…</p>}
          {ready && (
            <label class="sp-dialog-field">
              At {takeClock(t)} of {takeClock(ready.duration)}
              <input type="range" min={0} max={Math.max(0, ready.duration)} step={0.1} value={t} onInput={(e) => setT(Number((e.currentTarget as HTMLInputElement).value))} />
            </label>
          )}
          {preview && <p class="sp-note">{preview.emitters.length === 1 ? "1 emitter" : `${preview.emitters.length} emitters`} and the listener.</p>}
        </>
      )}
    </Dialog>
  );
}

export interface AttenuationChoiceProps {
  readonly playlist: string;
  onChoose(how: "preset" | "inline"): void;
  onCancel(): void;
}

export function AttenuationChoiceDialog(props: AttenuationChoiceProps) {
  const name = props.playlist.slice(props.playlist.lastIndexOf("/") + 1);
  return (
    <Dialog
      title="Give it attenuation"
      onCancel={props.onCancel}
      footer={
        <>
          <button type="button" onClick={props.onCancel}>Cancel</button>
          <button type="button" onClick={() => props.onChoose("inline")}>Inline</button>
          <button type="button" class="primary" onClick={() => props.onChoose("preset")}>Create preset</button>
        </>
      }
    >
      <p class="sp-note">{name} uses the engine's default attenuation. Shape its own curves:</p>
      <ul class="sp-note">
        <li><b>Create preset</b>: a shared attenuation file other playlists can use too.</li>
        <li><b>Inline</b>: curves kept in {name} only.</li>
      </ul>
    </Dialog>
  );
}
