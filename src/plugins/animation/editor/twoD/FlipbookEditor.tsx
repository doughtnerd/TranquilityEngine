// The flipbook editor (ADR 0371 "Sprites and 2D", 0373 "2D tools"; T56), over an image's flipbooks (the sidecar's
// `flipbooks`): make a flipbook from checked slices (frames ordered by name and number), then edit it: its name, rate and
// loop, the frames in order (reorder, hold each for longer, remove, add) and a preview that plays in the panel as the runtime
// plays it. The format has one rate and no events, so a frame's duration is its hold over the rate and no event rows are
// offered. Every change is one refused-or-next edit (`flipbookLogic.ts`) applied through `applyEdit`; the host (the Import
// Settings card, the Sprite Editor's Flipbooks tab) decides where it goes.
import { useEffect, useRef, useState } from "preact/hooks";
import { useImageSize } from "./imageSize";
import { applyEdit, NumberField, TextField, type EditResult } from "../../../../editor/sdk";
import type { SpriteSlice } from "../../../../engine/scene/importSettings";
import type { SpriteFlipbook } from "../../../../engine/animation/sprites/sidecar";
import {
  addFrame,
  createFlipbook,
  editFlipbook,
  flipbookDuration,
  frameCrop,
  frameSeconds,
  framesOf,
  moveFrame,
  removeFlipbook,
  removeFrame,
  renameFlipbook,
  setFps,
  setHold,
  setLoop,
  sliceAt,
  suggestFlipbookName,
  type Flipbooks,
} from "./flipbookLogic";
import "./twoD.css";

/** What the editor needs of its host. */
export interface FlipbookEditorProps {
  /** The image's URL. */
  readonly url: string;
  readonly slices: readonly SpriteSlice[];
  readonly flipbooks: Flipbooks;
  /** The flipbooks after an accepted edit, with its label (one undo step of the host). */
  onChange(next: Flipbooks, label: string): void;
  /** Why nothing can be changed, or null. */
  readonly readOnly: string | null;
}

/** One slice drawn from the image (a CSS crop), `box` pixels across. */
export function SliceThumb(props: { url: string; slice: SpriteSlice | undefined; image: readonly [number, number] | null; box: number; label?: string }) {
  const { slice, image, box } = props;
  if (!slice || !image) return <span class="flip-thumb flip-thumb-empty" style={{ width: `${box}px`, height: `${box}px` }} aria-label={props.label} />;
  const crop = frameCrop(slice.rect, image, box);
  return <span class="flip-thumb" role="img" aria-label={props.label ?? slice.name} style={{ width: `${crop.width}px`, height: `${crop.height}px`, backgroundImage: `url("${props.url}")`, backgroundSize: crop.backgroundSize, backgroundPosition: crop.backgroundPosition }} />;
}

/** The preview: plays the flipbook from the start at its rate, looping as it says, with play, pause and a scrubber. */
export function FlipbookPreview(props: { url: string; slices: readonly SpriteSlice[]; flipbook: SpriteFlipbook }) {
  const { flipbook } = props;
  const image = useImageSize(props.url);
  const duration = flipbookDuration(flipbook);
  const [playing, setPlaying] = useState(true);
  const [time, setTime] = useState(0);
  const latest = useRef({ flipbook, duration });
  latest.current = { flipbook, duration };
  useEffect(() => {
    if (!playing) return;
    let last: number | null = null;
    let frame = 0;
    const tick = (now: number) => {
      const dt = last === null ? 0 : (now - last) / 1000;
      last = now;
      const { flipbook: f, duration: d } = latest.current;
      setTime((t) => {
        const next = t + dt;
        if (f.loop) return d > 0 ? next % d : 0;
        if (next >= d) {
          setPlaying(false);
          return Math.max(0, d - 1 / f.fps / 2);
        }
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  const shown = sliceAt(flipbook, time);
  const slice = props.slices.find((s) => s.name === shown);
  return (
    <div class="flip-preview" aria-label="Flipbook preview">
      <div class="flip-preview-stage">
        <SliceThumb url={props.url} slice={slice} image={image} box={96} label={`Showing ${shown ?? "nothing"}`} />
      </div>
      <div class="flip-preview-controls">
        <button
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => {
            if (!playing && !flipbook.loop && time >= duration - 1 / flipbook.fps) setTime(0);
            setPlaying(!playing);
          }}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <input type="range" aria-label="Preview time" min={0} max={duration} step={1 / flipbook.fps} value={Math.min(time, duration)} onInput={(e) => (setPlaying(false), setTime(Number((e.currentTarget as HTMLInputElement).value)))} />
        <span class="flip-preview-time">
          {shown ?? "-"} · {time.toFixed(2)} / {duration.toFixed(2)} s
        </span>
      </div>
    </div>
  );
}

/** The flipbook editor (see the file comment). */
export function FlipbookEditor(props: FlipbookEditorProps) {
  const { url, slices, flipbooks, readOnly } = props;
  const names = Object.keys(flipbooks);
  const sliceNames = slices.map((s) => s.name);
  const image = useImageSize(url);
  const [selected, setSelected] = useState<string | null>(names[0] ?? null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [newName, setNewName] = useState("");
  const [add, setAdd] = useState("");
  const current = selected !== null && selected in flipbooks ? selected : (names[0] ?? null);
  const flipbook = current === null ? null : flipbooks[current]!;
  const disabled = readOnly !== null;

  const commit = (next: Flipbooks, label: string) => props.onChange(next, label);
  const apply = (result: EditResult<Flipbooks>, label: string): boolean => applyEdit(result, label, commit, flipbooks);
  const edit = (label: string, f: (flipbook: SpriteFlipbook) => EditResult<SpriteFlipbook>) => current !== null && apply(editFlipbook(flipbooks, current, f), label);

  const create = () => {
    const picked = sliceNames.filter((n) => checked.has(n));
    const result = createFlipbook(flipbooks, sliceNames, picked, newName.trim() === "" ? {} : { name: newName.trim() });
    if (applyEdit(result, "create flipbook", (made) => commit(made.flipbooks, `Create flipbook ${made.name}`))) {
      if ("next" in result) setSelected(result.next.name);
      setChecked(new Set());
      setNewName("");
    }
  };

  const toggle = (name: string) =>
    setChecked((c) => {
      const next = new Set(c);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div class="flip-editor">
      <section class="flip-section" aria-label="Create flipbook">
        <h4>Create from slices</h4>
        {slices.length === 0 ? (
          <p class="flip-note">This image has no slices yet. Slice it in the Sprite Editor, then make a flipbook from its slices.</p>
        ) : (
          <>
            <ul class="flip-slices" aria-label="Slices">
              {slices.map((s) => (
                <li key={s.name}>
                  <label title={s.name}>
                    <input type="checkbox" aria-label={`Use slice ${s.name}`} checked={checked.has(s.name)} onChange={() => toggle(s.name)} />
                    <SliceThumb url={url} slice={s} image={image} box={28} />
                    <span class="flip-slice-name">{s.name}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div class="flip-row">
              <button onClick={() => setChecked(new Set(sliceNames))} disabled={checked.size === sliceNames.length}>
                Select all
              </button>
              <button onClick={() => setChecked(new Set())} disabled={checked.size === 0}>
                Clear
              </button>
              <input
                type="text"
                aria-label="New flipbook name"
                placeholder={suggestFlipbookName(sliceNames.filter((n) => checked.has(n)), flipbooks)}
                value={newName}
                onInput={(e) => setNewName((e.currentTarget as HTMLInputElement).value)}
              />
              <button class="primary" disabled={disabled} title={readOnly ?? "Frames are ordered by slice name and number"} onClick={create}>
                Create Flipbook{checked.size > 0 ? ` (${checked.size})` : ""}
              </button>
            </div>
          </>
        )}
      </section>

      <section class="flip-section" aria-label="Flipbooks">
        <h4>Flipbooks ({names.length})</h4>
        {names.length === 0 ? (
          <p class="flip-note">No flipbooks yet. Check slices above and choose Create Flipbook.</p>
        ) : (
          <div class="flip-row">
            <select aria-label="Flipbook" value={current ?? ""} onChange={(e) => setSelected((e.currentTarget as HTMLSelectElement).value)}>
              {names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <button
              class="danger"
              disabled={disabled || current === null}
              title={readOnly ?? undefined}
              onClick={() => current !== null && apply(removeFlipbook(flipbooks, current), `delete flipbook ${current}`)}
            >
              Delete Flipbook
            </button>
          </div>
        )}
        {flipbook && current !== null && (
          <>
            <div class="flip-grid">
              <span>Name</span>
              <TextField
                label="Flipbook name"
                value={current}
                onCommit={(to) => {
                  if (applyEdit(renameFlipbook(flipbooks, current, to), `rename flipbook ${current}`, commit, flipbooks)) setSelected(to);
                }}
              />
              <span>Frame rate</span>
              <NumberField id="flip-fps" label="Frame rate" placeholder="12" suffix="frames per second" value={flipbook.fps} onCommit={(v) => v !== undefined && edit(`set the frame rate of ${current}`, (f) => setFps(f, v))} />
              <span>Loop</span>
              <label class="flip-check">
                <input type="checkbox" aria-label="Loop" checked={flipbook.loop} disabled={disabled} onChange={(e) => edit(`set loop of ${current}`, (f) => setLoop(f, (e.currentTarget as HTMLInputElement).checked))} />
                Repeat when it ends
              </label>
            </div>
            <FlipbookPreview url={url} slices={slices} flipbook={flipbook} />
            <h4>Frames</h4>
            <ol class="flip-frames" aria-label="Frames">
              {framesOf(flipbook).map((frame, i, all) => (
                <li key={`${i}-${frame.slice}`} class="flip-frame">
                  <SliceThumb url={url} slice={slices.find((s) => s.name === frame.slice)} image={image} box={28} />
                  <span class="flip-frame-name" title={frame.slice}>
                    {i + 1}. {frame.slice}
                  </span>
                  <NumberField id={`flip-hold-${i}`} label={`Hold of frame ${i + 1}`} placeholder="1" suffix="×" value={frame.hold} onCommit={(v) => v !== undefined && edit(`hold frame ${i + 1} of ${current}`, (f) => setHold(f, i, v))} />
                  <span class="flip-frame-seconds">{frameSeconds(flipbook, frame.hold).toFixed(3)} s</span>
                  <button aria-label={`Move frame ${i + 1} earlier`} disabled={disabled || i === 0} onClick={() => edit(`move frame ${i + 1} of ${current}`, (f) => moveFrame(f, i, i - 1))}>
                    ↑
                  </button>
                  <button aria-label={`Move frame ${i + 1} later`} disabled={disabled || i === all.length - 1} onClick={() => edit(`move frame ${i + 1} of ${current}`, (f) => moveFrame(f, i, i + 1))}>
                    ↓
                  </button>
                  <button aria-label={`Remove frame ${i + 1}`} disabled={disabled} onClick={() => edit(`remove frame ${i + 1} of ${current}`, (f) => removeFrame(f, i))}>
                    ✕
                  </button>
                </li>
              ))}
            </ol>
            <div class="flip-row">
              <select aria-label="Slice to add" value={add} onChange={(e) => setAdd((e.currentTarget as HTMLSelectElement).value)}>
                <option value="">Add a frame…</option>
                {sliceNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <button disabled={disabled || add === ""} title={readOnly ?? undefined} onClick={() => edit(`add frame to ${current}`, (f) => addFrame(f, add, sliceNames))}>
                Add Frame
              </button>
            </div>
            <p class="flip-note">
              Plays as the image's <code>{`#Flip/${current}`}</code>: one rate for every frame, so a frame lasts longer by being held. {flipbookDuration(flipbook).toFixed(2)} s in all.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
