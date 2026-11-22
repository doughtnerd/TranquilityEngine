// The player bar's Hear as control over the page's Hear as service (ADR 0337 §6). Choosing a platform also converts
// what is open on the Samples screen in the background (the screen asks for the rest as it plays), so the chip shows
// progress at once.
import { HearAsControl } from "../components/HearAsControl";
import { studioHearAs } from "../encoding/studioEncoding";

export function HearAsSlot(props: { onChosen?(): void }) {
  const hear = studioHearAs();
  return (
    <HearAsControl
      choice={hear.choice.value}
      busy={hear.busy.value}
      failure={hear.failure.value}
      onChoose={(c) => {
        hear.set(c);
        props.onChosen?.();
      }}
      onToggle={() => {
        hear.toggle();
        props.onChosen?.();
      }}
    />
  );
}
