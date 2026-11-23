// The bone map editor, a card of a model's Import Settings (ADR 0373 "Skeleton and retarget tools"; T54): the profile
// (the built-in Humanoid or a `*.skelprofile.json`), and one row per profile role with the bone it maps to, how well the
// bone's name matches, and the required roles still missing. Auto-guess runs the animation core's `guess_bone_map`;
// Mirror copies one side's bones to the other. Every change edits the Import Settings draft (`boneMapLogic.ts` makes each
// edit and may refuse it); the shell's Apply writes `animation.boneMap` and `animation.profile` to the sidecar, which is how
// a map the importer only guessed (`boneMapSource: "guessed"`, in memory) is kept.
import { useState } from "preact/hooks";
import { AssetPicker, Chip, type ImportSettingsViewProps } from "../../../../editor/sdk";
import { animationOf, applyAnimation, workingBoneMap } from "./animationDraft";
import { applyGuess, boneMapRows, clearBoneMap, guessFor, keepBoneMap, mirrorBoneMap, missingRequired, setBone, setProfile, staleEntries } from "./boneMapLogic";
import { readProfile, useModelAnimation } from "./modelAnimation";
import "./skeleton.css";

const percent = (v: number) => `${Math.round(v * 100)}%`;

/** The bone map card (see the file comment). */
export function BoneMapEditor(props: ImportSettingsViewProps) {
  const { path, draft, readOnly } = props;
  const model = useModelAnimation(path);
  const [busy, setBusy] = useState(false);
  if (model.state === "loading") return <p class="skeleton-note">Loading the model…</p>;
  if (model.state === "failed") return <p class="skeleton-note">Couldn't load the model: {model.error}</p>;
  const skeleton = model.state === "ready" ? model.animation.skeleton : null;
  if (!skeleton) return <p class="skeleton-note">This model has no skeleton, so there is no bone map.</p>;

  const bones = skeleton.bones.map((b) => b.name);
  const anim = animationOf(draft);
  const profile = readProfile(anim.profile);
  // The map shown: the draft's, else the one the importer guessed (kept by the first edit, so Apply writes it).
  const { map: working, showingGuess, guessed: guessedMap, base } = workingBoneMap(anim, model.state === "ready" ? model.animation : null);
  const dirOf = (result: Parameters<typeof applyAnimation>[1], label: string) => applyAnimation(props, result, label, base);

  if (!profile) {
    return (
      <>
        <ProfileRow {...props} />
        <p class="skeleton-note bone-map-problem">The skeleton profile {anim.profile} can't be read; pick another or the built-in Humanoid.</p>
      </>
    );
  }
  const rows = boneMapRows(profile, working, bones);
  const missing = missingRequired(profile, working, bones);
  const stale = staleEntries(profile, working, bones);
  const mapped = rows.filter((r) => r.status === "mapped").length;
  const disabled = !!readOnly;

  const guess = async () => {
    setBusy(true);
    try {
      const guessed = await guessFor(skeleton, anim.profile === null ? null : profile);
      dirOf(applyGuess(base, profile, bones, guessed), "Auto-guess the bone map");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ProfileRow {...props} />
      <div class="import-row">
        <span>Bone map</span>
        <span class="skeleton-actions">
          <Chip tone={mapped === 0 ? "neutral" : missing.length ? "warning" : "success"} title={`${mapped} of ${profile.roles.length} roles mapped`}>
            {mapped} of {profile.roles.length} mapped
          </Chip>
          {showingGuess && (
            <Chip tone="accent" title="The importer guessed this map with the animation core; it isn't in the sidecar until you apply">
              Guessed on import
            </Chip>
          )}
        </span>
      </div>
      <div class="skeleton-actions bone-map-actions">
        <button disabled={disabled || busy} title={readOnly ?? "Fill the roles with no bone using the animation core's guess"} onClick={() => void guess()}>
          Auto-guess
        </button>
        <button disabled={disabled} title={readOnly ?? "Copy the left bones to the right roles (the side swapped in the bone's name)"} onClick={() => dirOf(mirrorBoneMap(base, profile, bones, "left-to-right"), "Mirror the bone map left to right")}>
          Mirror L→R
        </button>
        <button disabled={disabled} title={readOnly ?? "Copy the right bones to the left roles"} onClick={() => dirOf(mirrorBoneMap(base, profile, bones, "right-to-left"), "Mirror the bone map right to left")}>
          Mirror R→L
        </button>
        {showingGuess && (
          <button class="primary" disabled={disabled} title={readOnly ?? "Put the guessed map in the draft, so Apply saves it"} onClick={() => dirOf(keepBoneMap(anim, guessedMap), "Keep the guessed bone map")}>
            Keep guessed map
          </button>
        )}
        <button disabled={disabled || mapped + stale.length === 0} title={readOnly ?? "Unmap every role"} onClick={() => dirOf(clearBoneMap(base), "Clear the bone map")}>
          Clear
        </button>
      </div>
      {missing.length > 0 && mapped > 0 && (
        <p class="skeleton-note bone-map-warning" role="status">
          Required without a bone: {missing.join(", ")}. Retargeting needs them.
        </p>
      )}
      {stale.length > 0 && (
        <p class="skeleton-note bone-map-warning" role="status">
          Names a role or bone that is gone: {stale.join(", ")}.
        </p>
      )}
      <table class="bone-map-table" aria-label="Bone map">
        <thead>
          <tr>
            <th scope="col">Role</th>
            <th scope="col">Bone</th>
            <th scope="col" title="How well the bone's name matches the role's">
              Match
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.role} class={`bone-map-row ${r.status}${r.required ? " required" : ""}`}>
              <th scope="row" title={r.mirror ? `${r.role} (mirror: ${r.mirror})${r.required ? ", required" : ""}` : r.required ? `${r.role} (required)` : r.role}>
                {r.role}
                {r.required && <span class="bone-map-required" aria-label="required"> *</span>}
              </th>
              <td>
                <select
                  aria-label={`Bone for ${r.role}`}
                  disabled={disabled}
                  value={r.bone ?? ""}
                  onChange={(e) => dirOf(setBone(base, profile, bones, r.role, (e.currentTarget as HTMLSelectElement).value || null), `Map ${r.role}`)}
                >
                  <option value="">{r.required ? "(required)" : "(none)"}</option>
                  {r.status === "missing" && r.bone && (
                    <option value={r.bone} disabled>
                      {r.bone} (missing)
                    </option>
                  )}
                  {bones.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </td>
              <td class="bone-map-match" title={r.match === null ? "" : r.match >= 0.6 ? "The bone's name fits the role" : "The bone's name doesn't look like the role: check it"}>
                {r.match === null ? "" : percent(r.match)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** The profile row, above whichever state the card is in. */
function ProfileRow(p: ImportSettingsViewProps) {
  const current = animationOf(p.draft);
  return (
    <div class="import-row" title="The roles the bone map fills: the built-in Humanoid, or a skeleton profile you made (a *.skelprofile.json)">
      <span>Profile</span>
      <AssetPicker
        value={current.profile ?? ""}
        kinds={["skelprofile"]}
        label="Skeleton profile"
        none="Humanoid (built in)"
        disabled={!!p.readOnly}
        onCommit={(value) => {
          const next = value === "" ? null : value;
          const read = readProfile(next);
          if (!read) return void applyAnimation(p, { refused: `the skeleton profile ${value} can't be read.` }, "Set the skeleton profile");
          applyAnimation(p, setProfile(current, next, read), "Set the skeleton profile");
        }}
      />
    </div>
  );
}
