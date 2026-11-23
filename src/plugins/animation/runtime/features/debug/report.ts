// The graph debug report (ADR 0372, 0373; the `debug` wire family, `../../wasm/wire/debug.ts`), decoded: the one reader
// of the core's debug buffer. `Animator.state()` (`../graph/runtime.ts`, D116) reads machines and node phases from it;
// the live debugger (T52) reads all of it: active nodes with weights and phases, state machines, each candidate
// transition with what blocks it, and request lifetimes. A pure library over a byte view.
import { getRecord, recordOpcode, type RecordFields } from "../../core/records";
import { DEBUG_HEADER, DEBUG_MACHINE, DEBUG_NODE, DEBUG_REQUEST, DEBUG_TRANSITION } from "../../wasm/wire/debug";

/** @internal An active node: its index, effective weight, timing clip, playhead and normalised playhead. */
export type DebugNodeRecord = RecordFields<typeof DEBUG_NODE>;
/** @internal A state machine: current and target state, the transition in progress, its fade, times. */
export type DebugMachineRecord = RecordFields<typeof DEBUG_MACHINE>;
/** @internal A candidate transition of a machine's current state and its blocker (`BLOCK_*`). */
export type DebugTransitionRecord = RecordFields<typeof DEBUG_TRANSITION>;
/** @internal A request name (a string id) and its remaining lifetime (0: not live). */
export type DebugRequestRecord = RecordFields<typeof DEBUG_REQUEST>;

/** @internal One instance's debug report, as of its last evaluate. */
export interface DebugReport {
  readonly instance: number;
  /** Nodes the output's weighted walk reaches, in walk order. */
  readonly nodes: readonly DebugNodeRecord[];
  readonly machines: readonly DebugMachineRecord[];
  /** Candidate transitions, per machine in the order the machine tries them. */
  readonly transitions: readonly DebugTransitionRecord[];
  readonly requests: readonly DebugRequestRecord[];
  /** Records that didn't fit the debug buffer. */
  readonly dropped: number;
}

/** The value `NONE` fields hold (no state, no transition). */
export const DEBUG_NONE = 0xffffffff;

const STRIDES = new Map<number, number>([
  [DEBUG_NODE.opcode, DEBUG_NODE.stride],
  [DEBUG_MACHINE.opcode, DEBUG_MACHINE.stride],
  [DEBUG_TRANSITION.opcode, DEBUG_TRANSITION.stride],
  [DEBUG_REQUEST.opcode, DEBUG_REQUEST.stride],
]);

/**
 * @internal Decodes the report at byte `base` of `data` (a header, then its records). An unknown record ends the read
 * (what was read so far is kept); a header with another opcode gives an empty report.
 */
export function readDebugReport(data: DataView, base: number): DebugReport {
  const nodes: DebugNodeRecord[] = [];
  const machines: DebugMachineRecord[] = [];
  const transitions: DebugTransitionRecord[] = [];
  const requests: DebugRequestRecord[] = [];
  if (base + DEBUG_HEADER.stride > data.byteLength || recordOpcode(data, base) !== DEBUG_HEADER.opcode) return { instance: 0, nodes, machines, transitions, requests, dropped: 0 };
  const header = getRecord(data, base, DEBUG_HEADER);
  let at = base + DEBUG_HEADER.stride;
  const end = Math.min(data.byteLength, at + header.recordBytes);
  while (at < end) {
    const op = recordOpcode(data, at);
    const stride = STRIDES.get(op);
    if (!stride || at + stride > end) break;
    if (op === DEBUG_NODE.opcode) nodes.push(getRecord(data, at, DEBUG_NODE));
    else if (op === DEBUG_MACHINE.opcode) machines.push(getRecord(data, at, DEBUG_MACHINE));
    else if (op === DEBUG_TRANSITION.opcode) transitions.push(getRecord(data, at, DEBUG_TRANSITION));
    else requests.push(getRecord(data, at, DEBUG_REQUEST));
    at += stride;
  }
  return { instance: header.instance, nodes, machines, transitions, requests, dropped: header.dropped };
}

/** @internal Machine `machine`'s record in `report`, or undefined when the walk didn't reach it. */
export const reportMachine = (report: DebugReport, machine: number): DebugMachineRecord | undefined => report.machines.find((m) => m.machine === machine);

/** @internal Node `node`'s record in `report`, or undefined when inactive. */
export const reportNode = (report: DebugReport, node: number): DebugNodeRecord | undefined => report.nodes.find((n) => n.node === node);
