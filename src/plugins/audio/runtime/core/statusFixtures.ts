// Test support: STATUS blocks built the way the link decodes them, for tests that feed a `StatusMirror` or a backend.
import { newStatusBlock, type StatusBlock } from "../wire.generated";

/** A STATUS block with every header field 0, every section empty, then `fields` laid over it. */
export function makeStatusBlock(fields: Partial<StatusBlock> = {}): StatusBlock {
  return Object.assign(newStatusBlock(), fields);
}
