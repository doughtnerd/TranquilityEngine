// The retarget card of a model's Import Settings (ADR 0373 "A side-by-side retarget preview", "Bake retargeted clip"; T54):
// pick a source model and one of its clips; the source and this model show side by side in the live preview; "Bake
// retargeted clip" retargets the clip onto this model with the draft's profile and bone map (so a map set above is used
// before it is applied) and writes it beside the model as a compiled clip (`retargetLogic.ts`).
//
// Not yet: posing the previews. The live preview renders models in the thumbnail renderer's own scene, which has no World,
// so nothing evaluates a clip there (T18 found the same for the clip preview): both rigs show at rest, and the bake is the
// way to see the result (play the written clip on an Animator).
import { useState } from "preact/hooks";
import { LargePreview, editor, AssetPicker, type ImportSettingsViewProps } from "../../../../editor/sdk";
import { describeReport } from "../clipImport/clipImportLogic";
import { animationOf, workingBoneMap } from "./animationDraft";
import { readProfile, useModelAnimation } from "./modelAnimation";
import { bakeRetargetedClip, sideProblem, type BakeOutcome } from "./retargetLogic";
import { projectRetargetEnv } from "./retargetEnv";
import "./skeleton.css";

/** The source model and clip last chosen for a model, this session. */
const chosen = new Map<string, { source: string; clip: string }>();

/** The retarget card (see the file comment). */
export function RetargetPanel(props: ImportSettingsViewProps) {
  const { path, draft, project, readOnly } = props;
  const mine = useModelAnimation(path);
  const [pick, setPick] = useState(() => chosen.get(path) ?? { source: "", clip: "" });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<BakeOutcome | null>(null);
  const source = useModelAnimation(pick.source || path);
  const choose = (next: { source: string; clip: string }) => {
    chosen.set(path, next);
    setPick(next);
    setOutcome(null);
  };

  if (mine.state !== "ready" || !mine.animation.skeleton) return <p class="skeleton-note">Retargeting needs a model with a skeleton.</p>;
  const target = mine.animation.skeleton;
  const anim = animationOf(draft);
  const { map } = workingBoneMap(anim, mine.animation);
  const targetProfile = readProfile(anim.profile);
  const src = pick.source && source.state === "ready" ? source.animation : null;
  const sourceClips = src?.clips.map((c) => c.name) ?? [];
  const clip = sourceClips.includes(pick.clip) ? pick.clip : (sourceClips[0] ?? "");
  const sourceProfile = src?.skeleton ? readProfile(src.skeleton.profile) : null;

  // Why the bake can't run yet, shown on the button.
  let why: string | null = null;
  if (readOnly) why = readOnly;
  else if (!pick.source) why = "Choose the model whose clip to retarget.";
  else if (source.state === "loading") why = "Loading the source model…";
  else if (!src?.skeleton) why = `${editor.assets.fileName(pick.source)} has no skeleton.`;
  else if (clip === "") why = `${editor.assets.fileName(pick.source)} has no clips.`;
  else if (!targetProfile) why = `The skeleton profile ${anim.profile} can't be read.`;
  else if (!sourceProfile) why = `The source's skeleton profile ${src.skeleton.profile} can't be read.`;
  else why = sideProblem("source", sourceProfile, src.boneMap, src.skeleton.bones.map((b) => b.name)) ?? sideProblem("target", targetProfile, map, target.bones.map((b) => b.name));

  const bake = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      const result = await bakeRetargetedClip(projectRetargetEnv(project), { source: pick.source, clip, target: { model: path, profile: anim.profile, boneMap: map } });
      setOutcome(result);
      if (result.ok) {
        editor.project.changed();
        editor.messages.info(`Baked ${clip} onto ${editor.assets.fileName(path)} as ${editor.assets.fileName(result.path)}.`);
      } else editor.messages.error(`Can't bake the retargeted clip: ${result.error}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div class="import-row" title="The model whose clip to retarget onto this one: its skeleton, bone map and profile are the source's">
        <span>Source model</span>
        <AssetPicker value={pick.source} kinds={["model"]} label="Source model" stored="path" none="Choose a model…" accepts={(p) => p !== path} onCommit={(value) => choose({ source: value, clip: "" })} />
      </div>
      <label class="import-row">
        <span>Source clip</span>
        <select aria-label="Source clip" disabled={sourceClips.length === 0} value={clip} onChange={(e) => choose({ source: pick.source, clip: (e.currentTarget as HTMLSelectElement).value })}>
          {sourceClips.length === 0 && <option value="">{pick.source ? "(no clips)" : "(choose a model)"}</option>}
          {sourceClips.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <div class="retarget-previews" aria-label="Retarget preview">
        <div class="retarget-side">
          <span class="retarget-side-title">Source{pick.source ? `: ${editor.assets.fileName(pick.source)}` : ""}</span>
          {pick.source ? <LargePreview path={pick.source} /> : <div class="retarget-empty">Choose a source model</div>}
        </div>
        <div class="retarget-side">
          <span class="retarget-side-title">Target: {editor.assets.fileName(path)}</span>
          <LargePreview path={path} />
        </div>
      </div>
      <p class="skeleton-note">Both rigs show at rest: the preview doesn't pose a model with a clip yet. Bake the clip and play it on an Animator to see it.</p>
      <div class="skeleton-actions">
        <button class="primary" disabled={busy || why !== null} title={why ?? "Retarget the clip onto this model and write it beside it as a compiled clip"} onClick={() => void bake()}>
          Bake retargeted clip
        </button>
        {why && !readOnly && pick.source && <span class="skeleton-note">{why}</span>}
      </div>
      {outcome?.ok && (
        <p class="retarget-result" role="status">
          Wrote {outcome.path} ({describeReport(outcome.report).size}, largest error {describeReport(outcome.report).maxError}).
        </p>
      )}
      {outcome && !outcome.ok && (
        <p class="retarget-problem" role="alert">
          {outcome.error}
        </p>
      )}
    </>
  );
}
