# Particle kernels: parity and benchmark (ADR 0094)

`npm run bench:particles` (add `-- --parity-only` for just the check) starts Vite, opens two pages in headless
Chromium with WebGPU on SwiftShader, and prints:

- **Parity** (`parity.html`, `parity.ts`): a fountain using every update step, a per-particle operator chain
  and a GPU-event child system, run for 90 frames on the JavaScript, WebGPU and WebGL2 executors with the same
  uniforms. The live particles must match exactly and every value within 1% (relative). Exits non-zero otherwise.
- **Frame time** (`index.html`, `bench.ts`): the effect player (`EffectPlayer`, what the World's particle adapter
  plays each ParticleSystem with) on a Babylon engine, a fountain of N
  particles (lifetime 2 s, gravity, turbulence, colour over life), timed over 30 frames after 150 warm-up frames,
  with a GPU sync every 10 frames. Query: `?engine=webgpu|webgl2&backend=gpu|js|cpu&counts=…&frames=…`,
  `&nodraw=1` (simulation only), `&shot=1` (one run, kept on screen).
  Since ADR 0251 `backend=cpu` is the JavaScript executor too (the CPU simulation is gone), so `run.mjs` no
  longer runs it and the "CPU simulation" rows below are history.

The project's Playwright browser comes from `npm run test:e2e:install`; set `CHROMIUM_PATH` to use another.

## Results (2026-11-20, after ADR 0251)

| Engine | Backend | Particles | ms per frame |
| --- | --- | ---: | ---: |
| WebGL2 | kernel (WebGL2 textures), simulation only | 1 000 | 1.17 |
| WebGL2 | kernel (WebGL2 textures), simulation only | 10 000 | 1.87 |
| WebGL2 | kernel (WebGL2 textures), simulation only | 100 000 | 14.1 |
| WebGL2 | kernel (JavaScript), simulation only | 1 000 | 0.58 |
| WebGL2 | kernel (JavaScript), simulation only | 10 000 | 2.74 |
| WebGL2 | kernel (JavaScript), simulation only | 100 000 | 26.4 |

The WebGPU rows didn't run: in this container's headless Chromium (build 1243) Babylon's `WebGPUEngine` loses its
device as soon as it starts, even for a plain scene with one box, so the page reports the lost device. The parity
check's raw WebGPU device works. The machine was shared with other jobs, so read these as scaling only.
Parity: the executors agree on every kernel and trail (alive counts exact, values within 0.26%), but the four sort
rows (WebGPU and WebGL2, both systems) report MISMATCH: alive counts and the largest error (0.29%) are fine, so some
keys differ from the JavaScript sort's by more than 0.1%. Not investigated yet (the sorts didn't change in ADR 0251).

## Results (2026-11-07, headless Chromium, SwiftShader: the "GPU" runs on CPU threads)

| Engine | Backend | Particles | ms per frame |
| --- | --- | ---: | ---: |
| WebGPU | kernel (WebGPU compute) | 1 000 | 0.83 |
| WebGPU | kernel (WebGPU compute) | 10 000 | 2.15 |
| WebGPU | kernel (WebGPU compute) | 100 000 | 17.6 |
| WebGPU | kernel (WebGPU compute) | 1 000 000 | 167 |
| WebGPU | kernel (JavaScript) | 10 000 | 3.07 |
| WebGPU | kernel (JavaScript) | 100 000 | 19.7 |
| WebGPU | CPU simulation | 10 000 | 4.59 |
| WebGPU | CPU simulation | 50 000 | 31.3 |
| WebGL2 | kernel (WebGL2 textures), simulation only | 10 000 | 1.69 |
| WebGL2 | kernel (WebGL2 textures), simulation only | 100 000 | 10.1 |
| WebGL2 | kernel (JavaScript), simulation only | 100 000 | 18.4 |
| WebGL2 | CPU simulation | 10 000 | 3.40 |
| WebGL2 | CPU simulation | 50 000 | 21.4 |

Parity: WebGPU and WebGL2 match JavaScript exactly on which particles live (1017 and 646 in the two systems)
and to 0.25% on values after 90 frames (f32 against f64 drift through turbulence, noise and orbit).

**Read with care.** SwiftShader emulates the GPU on the CPU, so these numbers show scaling, not what a real GPU
does (expect the kernel executors to be one to two orders of magnitude faster there). Two artefacts of this
setup:
- WebGPU canvases don't present in this headless configuration (even a plain Babylon scene renders nothing),
  so the WebGPU rows may not include drawing; their simulation runs (the parity check reads it back).
- On WebGL2 the instanced draw reads four float textures per vertex, which SwiftShader does slowly (about 20 µs
  per particle: 1 000 particles cost 19 ms with drawing, 1.2 ms without), so WebGL2 kernel rows are
  simulation only. Real GPUs fetch these textures cheaply; this needs checking on hardware.
