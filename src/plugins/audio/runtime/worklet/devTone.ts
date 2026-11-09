// Dev page for checking A0.3 by hand (ADR 0157 MS1): `npm run dev`, then open
// http://localhost:3000/src/plugins/audio/runtime/worklet/devTone.html. It starts the host as the `myco.audio`
// service would (core loaded into a suspended context), and a click unlocks it: a 440 Hz tone plays through the
// worklet shell on top of the core's output, while the page shows STATUS arriving with no rAF loop running.
// Not part of the engine bundle: nothing imports this file.

/** Starts the page. */
export async function main(root: HTMLElement): Promise<void> {
  throw new Error("not implemented: A0.3");
}
