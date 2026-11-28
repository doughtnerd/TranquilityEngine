// The pose database tool (ADR 0373 "Pose database tool"; T55): a `*.posedb.json` selected in the Assets panel shows its
// clips with their tagged ranges on a timeline strip (add and remove clips and ranges, drag edges, type times and tags),
// the feature schema (bone features, trajectory sample times and weights, custom features, the rate, the skeleton and the
// normalisation) and the Bake card (the bake in a worker with progress, the baked file's summary, the viewport debug view).
// Every edit is a refused-or-next result of `poseDbLogic.ts` applied to the source's asset document: one labelled undo
// step each, with Undo and Redo in the frame's head (ADR 0265).
import { useState } from "preact/hooks";
import { AssetDocumentFrame, AssetPicker, applyToDocument, editor, openAssetDocument, refuse, type AssetDocument, type EditorProject, type EditResult, EmptyState, assetRefTarget } from "../../../../editor/sdk";
import { NORMALISATIONS, type PoseDatabaseSource, type PoseRange } from "../../../../engine/animation/poseDatabase";
import { BakeCard } from "./BakeCard";
import { RangeStrip } from "./RangeStrip";
import {
  addBoneFeature, addClip, addCustomFeature, addRange, featureDimensions, missingBones, parseTagList, removeBoneFeature, removeClip, removeCustomFeature, removeRange, setBoneFeature, setCustomFeature, setMirror, setNormalisation, setRange, setRangeTags, setRate, setSkeleton,
  setTrajectoryTimes, setTrajectoryWeights, tagStats,
} from "./poseDbLogic";
import { useClipDuration, useClipSkeleton, useSkeletonBones } from "./poseDbHooks";
import { tagOrder, timeText } from "./timelineStripLogic";
import "./poseDatabase.css";

type Db = PoseDatabaseSource;
type Apply = (result: EditResult<Db>, label: string) => boolean;

const input = (e: Event) => e.currentTarget as HTMLInputElement;
const select = (e: Event) => e.currentTarget as HTMLSelectElement;

/** The selected pose database source (see the file comment). */
export function PoseDatabaseEditor(props: { path: string }) {
  editor.project.version; // files change under it
  const project = editor.project.current;
  if (!project) return <EmptyState compact title="Nothing selected" />;
  return <PoseDatabaseDocument path={props.path} project={project} />;
}

function PoseDatabaseDocument({ path, project }: { path: string; project: EditorProject }) {
  const doc = openAssetDocument<Db>(project, path, "posedb");
  const db = doc.value.value;
  const apply: Apply = (result, label) => applyToDocument(doc, result, label);
  const version = `${editor.project.version}`;
  const own = useClipSkeleton(db.skeleton ? null : (db.sources[0]?.clip ?? null), version);
  const skeletonRef = db.skeleton ?? own;
  const bones = useSkeletonBones(skeletonRef, version);
  return (
    <AssetDocumentFrame doc={doc} kind="Pose Database" class="inspector-body asset-inspector posedb">
      <SourceCard db={db} doc={doc} apply={apply} inherited={db.skeleton ? null : skeletonRef} />
      <ClipsCard db={db} doc={doc} apply={apply} version={version} />
      <FeaturesCard db={db} doc={doc} apply={apply} bones={bones} />
      <BakeCard path={path} db={db} project={project} disabled={doc.readOnly} />
    </AssetDocumentFrame>
  );
}

interface CardProps {
  readonly db: Db;
  readonly doc: AssetDocument<Db>;
  readonly apply: Apply;
}

function SourceCard({ db, doc, apply, inherited }: CardProps & { inherited: string | null }) {
  const readOnly = doc.readOnly;
  return (
    <div class="component asset-import-card">
      <h3>Database</h3>
      <div class="import-row" title="The skeleton the features are measured on. Empty: the skeleton of the first clip's model.">
        <span>Skeleton</span>
        <AssetPicker value={db.skeleton ?? ""} kinds={["skeleton"]} label="Skeleton" none={inherited ? `(the clips': ${editor.assets.fileName(assetRefTarget(inherited))})` : "(the clips')"} disabled={!!readOnly} onCommit={(v) => apply(setSkeleton(db, v || null), "Set the skeleton")} />
      </div>
      <label class="import-row" title="Frames baked per second of clip">
        <span>Rate (Hz)</span>
        <input type="number" aria-label="Rate" min={1} max={240} step={1} disabled={!!readOnly} value={db.rate} onChange={(e) => apply(setRate(db, input(e).valueAsNumber), "Set the rate")} />
      </label>
      <label class="import-row" title="How feature dimensions are scaled so they weigh alike: by one deviation per feature, per dimension, or not at all">
        <span>Normalisation</span>
        <select aria-label="Normalisation" disabled={!!readOnly} value={db.normalisation} onChange={(e) => apply(setNormalisation(db, select(e).value as Db["normalisation"]), "Set the normalisation")}>
          {NORMALISATIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function ClipsCard({ db, doc, apply, version }: CardProps & { version: string }) {
  const readOnly = !!doc.readOnly;
  const order = tagOrder(db.sources);
  const stats = tagStats(db);
  return (
    <div class="component asset-import-card">
      <h3>Clips and tags</h3>
      {db.sources.length === 0 && <p class="posedb-note">No clips: add the clips to search. A clip with no ranges is baked whole, untagged.</p>}
      {db.sources.map((s, i) => (
        <ClipRow key={s.clip} index={i} db={db} apply={apply} readOnly={readOnly} order={order} version={version} />
      ))}
      <div class="import-row">
        <span>Add clip</span>
        <AssetPicker value="" kinds={["animclip"]} label="Add clip" none="Choose a clip…" disabled={readOnly} onCommit={(v) => v && apply(addClip(db, v), `Add ${editor.assets.fileName(assetRefTarget(v))}`)} />
      </div>
      {stats.length > 0 && (
        <p class="posedb-tags" aria-label="Tags">
          {stats.map((t) => (
            <span key={t.tag} class={`posedb-tag slot-${(order.indexOf(t.tag) % 7) + 1}`} title={`${t.ranges} range${t.ranges === 1 ? "" : "s"}`}>
              {t.tag} {t.seconds.toFixed(1)} s
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

function ClipRow(props: { index: number; db: Db; apply: Apply; readOnly: boolean; order: readonly string[]; version: string }) {
  const { index: i, db, apply, readOnly } = props;
  const s = db.sources[i]!;
  const name = editor.assets.fileName(assetRefTarget(s.clip));
  const duration = useClipDuration(s.clip, props.version);
  const [selected, setSelected] = useState<number | null>(null);
  const addAt = (from: number, to: number) => apply(addRange(db, i, { from, to, tags: [] }), `Add a range to ${name}`);
  return (
    <div class="posedb-clip" aria-label={`Clip ${name}`}>
      <div class="posedb-clip-head">
        <span class="posedb-clip-name" title={s.clip}>
          {name}
        </span>
        <span class="posedb-note">{duration > 0 ? `${duration.toFixed(2)} s` : "length unknown"}</span>
        <label class="posedb-inline" title="Bake a mirrored copy too (the editor's bake doesn't make mirrored copies yet)">
          <input type="checkbox" aria-label={`Mirror ${name}`} disabled={readOnly} checked={s.mirror} onChange={(e) => apply(setMirror(db, i, input(e).checked), `Set ${name} ${input(e).checked ? "mirrored" : "not mirrored"}`)} />
          Mirror
        </label>
        <button aria-label={`Remove ${name}`} title={`Remove ${name} from the database`} disabled={readOnly} onClick={() => apply(removeClip(db, i), `Remove ${name}`)}>
          ✕
        </button>
      </div>
      <RangeStrip
        clip={name}
        duration={duration}
        ranges={s.ranges}
        tagOrder={props.order}
        selected={selected}
        disabled={readOnly}
        onSelect={setSelected}
        onChange={(k, from, to) => apply(setRange(db, i, k, from, to), `Change a range of ${name}`)}
        onAdd={(from, to) => addAt(from, to) && setSelected(s.ranges.length)}
      />
      {s.ranges.length > 0 && (
        <table class="posedb-table" aria-label={`Ranges of ${name}`}>
          <thead>
            <tr>
              <th scope="col">From</th>
              <th scope="col">To</th>
              <th scope="col">Tags</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {s.ranges.map((g, k) => (
              <RangeRow key={k} g={g} k={k} i={i} name={name} db={db} apply={apply} readOnly={readOnly} selected={selected === k} onSelect={() => setSelected(k)} />
            ))}
          </tbody>
        </table>
      )}
      <div class="posedb-actions">
        <button disabled={readOnly} onClick={() => addAt(0, duration > 0 ? duration : 1)}>
          Add Range
        </button>
      </div>
    </div>
  );
}

function RangeRow(props: { g: PoseRange; k: number; i: number; name: string; db: Db; apply: Apply; readOnly: boolean; selected: boolean; onSelect(): void }) {
  const { g, k, i, name, db, apply, readOnly } = props;
  const label = `range ${k + 1} of ${name}`;
  return (
    <tr class={props.selected ? "selected" : undefined} onFocusCapture={props.onSelect}>
      <td>
        <input type="number" aria-label={`From of ${label}`} step={0.01} min={0} disabled={readOnly} value={timeText(g.from)} onChange={(e) => apply(setRange(db, i, k, input(e).valueAsNumber, g.to), `Change ${label}`)} />
      </td>
      <td>
        <input type="number" aria-label={`To of ${label}`} step={0.01} min={0} disabled={readOnly} value={timeText(g.to)} onChange={(e) => apply(setRange(db, i, k, g.from, input(e).valueAsNumber), `Change ${label}`)} />
      </td>
      <td>
        <input
          type="text"
          aria-label={`Tags of ${label}`}
          placeholder="tags"
          disabled={readOnly}
          value={g.tags.join(" ")}
          onChange={(e) => {
            const { tags, bad } = parseTagList(input(e).value);
            apply(bad.length ? refuse(`"${bad[0]}" isn't a tag name: use letters, digits, _ . -`) : setRangeTags(db, i, k, tags), `Set the tags of ${label}`);
          }}
        />
      </td>
      <td>
        <button aria-label={`Remove ${label}`} title="Remove this range" disabled={readOnly} onClick={() => apply(removeRange(db, i, k), `Remove ${label}`)}>
          ✕
        </button>
      </td>
    </tr>
  );
}

function FeaturesCard({ db, doc, apply, bones }: CardProps & { bones: readonly string[] | null }) {
  const readOnly = !!doc.readOnly;
  const [bone, setBone] = useState("");
  const [custom, setCustom] = useState("");
  const [times, setTimes] = useState<string | null>(null);
  const t = db.schema.trajectory;
  const lacking = bones ? missingBones(db, bones) : [];
  const free = bones ? bones.filter((b) => !db.schema.bones.some((f) => f.bone === b)) : [];
  const commitTimes = (text: string) => {
    const parsed = text.split(/[,\s]+/).filter((w) => w !== "").map(Number);
    const result = parsed.some((n) => Number.isNaN(n)) ? refuse("sample times are numbers of seconds.") : setTrajectoryTimes(db, parsed);
    if (apply(result, "Set the trajectory times")) setTimes(null);
  };
  return (
    <div class="component asset-import-card">
      <h3>Features</h3>
      <p class="posedb-note" aria-label="Dimensions">
        {featureDimensions(db)} dimensions per frame.
      </p>
      <h4 class="posedb-heading">Bones</h4>
      <table class="posedb-table" aria-label="Bone features">
        <thead>
          <tr>
            <th scope="col">Bone</th>
            <th scope="col">Position</th>
            <th scope="col">Velocity</th>
            <th scope="col">Weight</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {db.schema.bones.map((f) => (
            <tr key={f.bone} class={lacking.includes(f.bone) ? "missing" : undefined} title={lacking.includes(f.bone) ? `The skeleton has no bone ${f.bone}` : undefined}>
              <th scope="row">{f.bone}</th>
              <td>
                <input type="checkbox" aria-label={`Position of ${f.bone}`} disabled={readOnly} checked={f.position} onChange={(e) => apply(setBoneFeature(db, f.bone, { position: input(e).checked }), `Set the position of ${f.bone}`)} />
              </td>
              <td>
                <input type="checkbox" aria-label={`Velocity of ${f.bone}`} disabled={readOnly} checked={f.velocity} onChange={(e) => apply(setBoneFeature(db, f.bone, { velocity: input(e).checked }), `Set the velocity of ${f.bone}`)} />
              </td>
              <td>
                <input type="number" aria-label={`Weight of ${f.bone}`} min={0} step={0.1} disabled={readOnly} value={f.weight} onChange={(e) => apply(setBoneFeature(db, f.bone, { weight: input(e).valueAsNumber }), `Set the weight of ${f.bone}`)} />
              </td>
              <td>
                <button aria-label={`Remove ${f.bone}`} title="Remove this feature" disabled={readOnly} onClick={() => apply(removeBoneFeature(db, f.bone), `Remove ${f.bone}`)}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="posedb-actions">
        {bones ? (
          <select aria-label="New bone feature" disabled={readOnly || free.length === 0} value={bone} onChange={(e) => setBone(select(e).value)}>
            <option value="">{free.length === 0 ? "(every bone is a feature)" : "Choose a bone…"}</option>
            {free.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        ) : (
          <input type="text" aria-label="New bone feature" placeholder="Bone name" disabled={readOnly} value={bone} onInput={(e) => setBone(input(e).value)} />
        )}
        <button
          disabled={readOnly || bone.trim() === ""}
          onClick={() => {
            if (apply(addBoneFeature(db, bone), `Add the bone feature ${bone.trim()}`)) setBone("");
          }}
        >
          Add Bone
        </button>
      </div>
      <h4 class="posedb-heading">Trajectory</h4>
      <label class="import-row" title="Seconds from now the query looks at: negative is the past. Non-zero, distinct, within ±10 s.">
        <span>Sample times (s)</span>
        <input type="text" aria-label="Trajectory sample times" disabled={readOnly} value={times ?? t.times.map(timeText).join(", ")} onInput={(e) => setTimes(input(e).value)} onChange={(e) => commitTimes(input(e).value)} onBlur={() => setTimes(null)} />
      </label>
      <label class="import-row">
        <span>Position weight</span>
        <input type="number" aria-label="Trajectory position weight" min={0} step={0.1} disabled={readOnly} value={t.position} onChange={(e) => apply(setTrajectoryWeights(db, { position: input(e).valueAsNumber }), "Set the trajectory position weight")} />
      </label>
      <label class="import-row">
        <span>Direction weight</span>
        <input type="number" aria-label="Trajectory direction weight" min={0} step={0.1} disabled={readOnly} value={t.direction} onChange={(e) => apply(setTrajectoryWeights(db, { direction: input(e).valueAsNumber }), "Set the trajectory direction weight")} />
      </label>
      <h4 class="posedb-heading">Custom</h4>
      {db.schema.custom.length > 0 && (
        <table class="posedb-table" aria-label="Custom features">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Dims</th>
              <th scope="col">Weight</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {db.schema.custom.map((c) => (
              <tr key={c.name}>
                <th scope="row">{c.name}</th>
                <td>
                  <input type="number" aria-label={`Dimensions of ${c.name}`} min={1} max={16} step={1} disabled={readOnly} value={c.dims} onChange={(e) => apply(setCustomFeature(db, c.name, { dims: input(e).valueAsNumber }), `Set the dimensions of ${c.name}`)} />
                </td>
                <td>
                  <input type="number" aria-label={`Weight of ${c.name}`} min={0} step={0.1} disabled={readOnly} value={c.weight} onChange={(e) => apply(setCustomFeature(db, c.name, { weight: input(e).valueAsNumber }), `Set the weight of ${c.name}`)} />
                </td>
                <td>
                  <button aria-label={`Remove ${c.name}`} title="Remove this feature" disabled={readOnly} onClick={() => apply(removeCustomFeature(db, c.name), `Remove ${c.name}`)}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p class="posedb-note">Custom features are filled by a bake hook; the editor's bake leaves them out.</p>
      <div class="posedb-actions">
        <input type="text" aria-label="New custom feature" placeholder="Feature name" disabled={readOnly} value={custom} onInput={(e) => setCustom(input(e).value)} />
        <button
          disabled={readOnly || custom.trim() === ""}
          onClick={() => {
            if (apply(addCustomFeature(db, custom), `Add the custom feature ${custom.trim()}`)) setCustom("");
          }}
        >
          Add Custom
        </button>
      </div>
    </div>
  );
}
