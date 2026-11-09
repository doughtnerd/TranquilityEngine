# Provenance: Chromium Blink audio (reference copies)

These files are unchanged copies of Chromium's Blink audio code, staged as the source for the ports listed in `native/audio/PORTS.md` (ADR 0157, api-and-models §5, task A0.10). Nothing compiles them. The files keep their upstream names; the directory is flat.

- **Upstream repository:** https://chromium.googlesource.com/chromium/src
- **Upstream directory:** `third_party/blink/renderer/platform/audio/`
- **Commit:** `cbba46fd94646232cfd2318ac962138c2a98c1f9` (tip of `main` on 2026-11-09, 19:14 UTC)
- **Fetched:** 2026-11-09, from `https://chromium.googlesource.com/chromium/src/+/<commit>/<path>?format=TEXT` and decoded from base64
- **Not fetched:** the HRIR resource files (`third_party/blink/renderer/platform/audio/resources/`). They are data for task H2; H0 covers their licence (`docs/design/0157-audio-core/hrir-licence.md`).
- **Not present at this commit:** `reverb_input_buffer.cc` and `reverb_input_buffer.h` (both return 404 at the pinned commit). `reverb_convolver` does not need them at this commit.
- **Not staged:** the Blink helper headers these files include (`audio_bus.h`, `vector_math.h`, `fft_frame.h`, `audio_utilities.h`, `panner.h`, `direct_convolver.h`, `denormal_disabler.h`, `delay.h`, `audio_array.h`, `audio_channel.h`, `hrtf_database_loader.h`) and the `wtf`/`base` headers. The ports read them from the same upstream commit when needed.

## Files

| File | Upstream path | SHA-256 |
|---|---|---|
| `biquad.cc` | `third_party/blink/renderer/platform/audio/biquad.cc` | `174c22c8c2ca13d947517bab7486e497010f643c3118b5acb1fb04218ea09a4a` |
| `biquad.h` | `third_party/blink/renderer/platform/audio/biquad.h` | `bf0eaa9f25c2036adeaf9c190896c9a9dd55ba715c3f6862b8fd3039ec52dcc9` |
| `cone_effect.cc` | `third_party/blink/renderer/platform/audio/cone_effect.cc` | `f0bb6c6469574eb817a27b967665b56f81d7b2533600aa6ac2098b00567a00d1` |
| `cone_effect.h` | `third_party/blink/renderer/platform/audio/cone_effect.h` | `309a5d1ac8ca274f3bb453fe745664c618ee86945c1e259177ee31d254dcc149` |
| `distance_effect.cc` | `third_party/blink/renderer/platform/audio/distance_effect.cc` | `ee8041036f59fd44d40825773f43a35b1af0dd095631a92d346fb151722aedb6` |
| `distance_effect.h` | `third_party/blink/renderer/platform/audio/distance_effect.h` | `0cc40696ab97658299733b6d7ab8362f14e1902363cd67da279b951030b9ddea` |
| `dynamics_compressor.cc` | `third_party/blink/renderer/platform/audio/dynamics_compressor.cc` | `be48c17c9d4039cd608269130e87c164cf8ea82f18c7a551fcadd92a37db2a13` |
| `dynamics_compressor.h` | `third_party/blink/renderer/platform/audio/dynamics_compressor.h` | `51e3144759e4e9ad81e733bdbe7e5e8ad94bed1651c93b7c16cea98b4f934ed1` |
| `equal_power_panner.cc` | `third_party/blink/renderer/platform/audio/equal_power_panner.cc` | `c871239ca5ad4757179b1234422798bf1df2f7d150f6ea1e833778bda406c0cd` |
| `equal_power_panner.h` | `third_party/blink/renderer/platform/audio/equal_power_panner.h` | `cff4c7f593c111970cabd19a336dd121d14aa7c08d8642590c7650ba98c8bc80` |
| `fft_convolver.cc` | `third_party/blink/renderer/platform/audio/fft_convolver.cc` | `50c2bf67588600ccba4afb12e92f3d170c84b8cbfe937b2c9b830fd07b81b886` |
| `fft_convolver.h` | `third_party/blink/renderer/platform/audio/fft_convolver.h` | `1e4d4fdad448e989197b4069ae4c5b6f99df2adfa3d5ac4e56996fa488cfb406` |
| `hrtf_database.cc` | `third_party/blink/renderer/platform/audio/hrtf_database.cc` | `d3fedb2c03b43d22334ca01084662ab5ecefcef38d3212dd32a13f0eedd773a5` |
| `hrtf_database.h` | `third_party/blink/renderer/platform/audio/hrtf_database.h` | `d54d176429189b351cb5441f3615fe906aea275795e5aae7e1329e3778a3c126` |
| `hrtf_elevation.cc` | `third_party/blink/renderer/platform/audio/hrtf_elevation.cc` | `e2e6edff1ca3868c600046b41367286f966cb5b72ba99283f257fb10fa63d0a2` |
| `hrtf_elevation.h` | `third_party/blink/renderer/platform/audio/hrtf_elevation.h` | `737fbbfc1dfb02854e57135a3f5a1648b200aaef0bc8c7e401c4b30c2d1068e8` |
| `hrtf_kernel.cc` | `third_party/blink/renderer/platform/audio/hrtf_kernel.cc` | `2b75f99bfbcfb66430fd19d0163896b94c06a54af75cba9365ca1ab6050c4125` |
| `hrtf_kernel.h` | `third_party/blink/renderer/platform/audio/hrtf_kernel.h` | `095a17b557debb89464258645e9d5c351444e1384ede5f186c96c6f44f96e671` |
| `hrtf_panner.cc` | `third_party/blink/renderer/platform/audio/hrtf_panner.cc` | `0c3220a166f4f43eff06f01b236d2c072d662a0ee6dcb2e49f99887e17b6793b` |
| `hrtf_panner.h` | `third_party/blink/renderer/platform/audio/hrtf_panner.h` | `a9455989d877d27b40599820e3c044295ab8267f161748250fc30630d93ce618` |
| `reverb_accumulation_buffer.cc` | `third_party/blink/renderer/platform/audio/reverb_accumulation_buffer.cc` | `3c0cc937a1caaaad7ba2b483b5b16f26e80a48e8c436a9f473ff149b1e309979` |
| `reverb_accumulation_buffer.h` | `third_party/blink/renderer/platform/audio/reverb_accumulation_buffer.h` | `0618182eeddfbeb8474d4d4da93bc02ae150e3df408f6170ba39d222de33f103` |
| `reverb_convolver.cc` | `third_party/blink/renderer/platform/audio/reverb_convolver.cc` | `7185312c93b342d9c1d03888c6e028fc49a4d91d8253cbb2754048bb7567e523` |
| `reverb_convolver.h` | `third_party/blink/renderer/platform/audio/reverb_convolver.h` | `4ad669fd07f531a3e24aec491f890372e2dad62b1c7d0c6925f6b15721fdbc76` |
| `reverb_convolver_stage.cc` | `third_party/blink/renderer/platform/audio/reverb_convolver_stage.cc` | `52fb4526b2e524037000f7e08f66d128fdbb2a26a27981228b1527efef8e8481` |
| `reverb_convolver_stage.h` | `third_party/blink/renderer/platform/audio/reverb_convolver_stage.h` | `90cbee5e702ae52aec188e2b29c56f78f8ab9dedcae435996456d22279a00d54` |
| `CHROMIUM-LICENSE` | `LICENSE` (repository root) | `368cca1106be99d39ecd32a38d8305585d802a475effb66380b91ffc9bcf709b` |

`CHROMIUM-LICENSE` is Chromium's repository LICENSE at the pinned commit, copied as is. The Blink audio files carry their own BSD-3-Clause notices (Google Inc. copyright, with the Apple clause as WebKit has it); see `native/audio/PORTS.md`.
