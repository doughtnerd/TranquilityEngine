// Dev page for checking A0.3 by hand (ADR 0157 MS1): `npm run dev`, then open
// http://localhost:3000/src/plugins/audio/runtime/worklet/devTone.html. It starts the host as the `myco.audio`
// service would (core loaded into a suspended context), and a click unlocks it: a 440 Hz tone plays through the
// worklet shell on top of the core's output, while the page shows STATUS arriving with no rAF loop running.
// Not part of the engine bundle: nothing imports this file.
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import { startAudioHost } from "../core/context";

/** Starts the page. */
export async function main(root: HTMLElement): Promise<void> {
  root.innerHTML = `<h1>Audio core: first tone (A0.3)</h1>
<p>Click anywhere (or press a key) to unlock. A 440 Hz tone should play. STATUS keeps arriving with no animation frames.</p>
<p><button id="tone">Tone off</button> <button id="ping">Ping</button></p>
<pre id="out">loading…</pre>`;
  const out = root.querySelector<HTMLPreElement>("#out")!;
  let host: Awaited<ReturnType<typeof startAudioHost>>;
  try {
    host = await startAudioHost(defaultAudioSettings(), document);
  } catch (error) {
    out.textContent = `failed to start: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  const link = host.link;
  let toneOn = true;
  link.debugTone(440, 0.1);
  let lastPing = 0;
  let errors = "";
  link.onShellEvent((e) => (errors += `${e.type}: ${e.message}\n`));
  const toneButton = root.querySelector<HTMLButtonElement>("#tone")!;
  toneButton.onclick = () => {
    toneOn = !toneOn;
    link.debugTone(toneOn ? 440 : 0, 0.1);
    toneButton.textContent = toneOn ? "Tone off" : "Tone on";
  };
  root.querySelector<HTMLButtonElement>("#ping")!.onclick = () => (lastPing = link.ping());
  // A timer, not rAF: the page shows that STATUS flows without frames.
  setInterval(() => {
    const s = link.lastStatus;
    out.textContent = [
      `host status:   ${host.status} (context ${host.context.state}, ${host.context.sampleRate} Hz)`,
      `STATUS blocks: ${link.statusCount}`,
      s ? `currentFrame:  ${s.currentFrame}` : "currentFrame:  (none yet)",
      s ? `ready flag:    ${(s.flags & 0x10) !== 0}` : "",
      `ping sent:     ${lastPing}, echoed: ${s?.pingSeq ?? 0} at frame ${s?.pingFrameLo ?? 0}`,
      `underruns:     ${s?.underruns ?? 0} (${s?.underrunFrames ?? 0} frames), traps ${s?.traps ?? 0}`,
      errors,
    ].join("\n");
  }, 100);
}
