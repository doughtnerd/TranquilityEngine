// Stories (ADR 0219) for the LODGroup's LOD bar: automatic heights, explicit ones that a drag edits, a forced level and a
// model without levels.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { LodBar } from "./LodBar";

const meta: Meta = { title: "Editor/LodBar", component: LodBar };
export default meta;

const TRIANGLES = [12840, 6420, 3210, 1605];

function Demo(props: { levels: number[]; automatic: number[]; forceLevel?: number; editable?: boolean; readOnly?: string | null }) {
  const [levels, setLevels] = useState(props.levels);
  const heights = levels.length ? levels : props.automatic;
  return (
    <div style={{ width: "360px" }}>
      <LodBar
        heights={heights}
        automatic={levels.length === 0}
        triangles={heights.map((_, i) => TRIANGLES[Math.min(i, TRIANGLES.length - 1)])}
        forceLevel={props.forceLevel ?? -1}
        readOnly={props.readOnly ?? null}
        editable={props.editable ?? true}
        onCommit={setLevels}
        onReset={() => setLevels([])}
      />
    </div>
  );
}

export const Automatic: StoryObj = { render: () => <Demo levels={[]} automatic={[0.149, 0.093, 0.056, 0.01]} /> };
export const Explicit: StoryObj = { render: () => <Demo levels={[0.5, 0.25, 0.1, 0]} automatic={[0.149, 0.093, 0.056, 0.01]} /> };
export const Forced: StoryObj = { render: () => <Demo levels={[0.4, 0.2, 0.05]} automatic={[]} forceLevel={1} /> };
export const NoLevels: StoryObj = { render: () => <Demo levels={[]} automatic={[0]} editable={false} /> };
export const ReadOnly: StoryObj = { render: () => <Demo levels={[0.4, 0.2, 0.05]} automatic={[]} readOnly="Stop the game to edit the scene" /> };
