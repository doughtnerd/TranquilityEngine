# Sound Lab tools

`makeTones.mjs` writes the clips in `../audio/` (mono, 16-bit PCM, 48 kHz; about 260 KB in all). It is deterministic, so rerunning it rewrites identical files:

```
node samples/sound-lab/tools/makeTones.mjs
```
