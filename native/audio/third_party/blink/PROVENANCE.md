# Provenance: Chromium Blink audio (reference copies)

These files are unchanged copies of Chromium's Blink audio code, staged as the source for the ports listed in `native/audio/PORTS.md` (ADR 0157, api-and-models §5, task A0.10). Nothing compiles them. The files keep their upstream names; the directory is flat.

- **Upstream repository:** https://chromium.googlesource.com/chromium/src
- **Upstream directory:** `third_party/blink/renderer/platform/audio/`
- **Commit:** `cbba46fd94646232cfd2318ac962138c2a98c1f9` (tip of `main` on 2026-11-09, 19:14 UTC)
- **Fetched:** 2026-11-09, from `https://chromium.googlesource.com/chromium/src/+/<commit>/<path>?format=TEXT` and decoded from base64
- **Not fetched:** the HRIR resource files (`third_party/blink/renderer/platform/audio/resources/`). They are data for task H2; H0 covers their licence (`docs/design/0157-audio-core/hrir-licence.md`).
- **Not present at this commit:** `reverb_input_buffer.cc` and `reverb_input_buffer.h` (both return 404 at the pinned commit). `reverb_convolver` does not need them at this commit.
- **Helpers staged for H1** (fetched 2026-11-09 from the same commit, same method): `fft_frame.cc`, `fft_frame.h` (kernel interpolation, average group delay, the packed spectrum layout), `delay.cc`, `delay.h` (the interaural delay line), `audio_utilities.cc`, `audio_utilities.h` (`TimeToSampleFrame`, for the delay buffer length) and `rustfft_ffi.rs` (the FFT scaling and packing `FFTFrame` uses at this commit; read for its conventions, not ported).
- **Staged for H5** (fetched 2026-11-10 from the same commit, from Chromium's GitHub mirror `https://raw.githubusercontent.com/chromium/chromium/<commit>/<path>`, as is; googlesource was not reachable from that session): `audio_bus.cc` (`TryCreateBySampleRateConverting`: each HRIR resampled on its own, `floor(length / ratio)` frames, a `SincResampler` with 64-frame requests), and, from outside the Blink audio directory (upstream paths in the table), `media/base/sinc_resampler.cc` and `.h` (the 32-tap kernel, its 0.90 cutoff and the region bookkeeping), `third_party/blink/renderer/modules/webaudio/panner_handler.cc` (`CalculateAzimuthElevation`), `ui/gfx/geometry/vector3d_f.cc` and `.h` (the f32 vector operations it uses) and `base/numerics/angle_conversions.h` (`RadToDeg`). These six carry the Chromium Authors' notice, whose licence is `CHROMIUM-LICENSE`.
- **Not staged:** the Blink helper headers these files include (`audio_bus.h`, `vector_math.h`, `panner.h`, `direct_convolver.h`, `denormal_disabler.h`, `audio_array.h`, `audio_channel.h`, `hrtf_database_loader.h`) and the `wtf`/`base` headers. The ports read them from the same upstream commit when needed.

## Files

| File | Upstream path | SHA-256 |
|---|---|---|
| `angle_conversions.h` | `base/numerics/angle_conversions.h` | `9110b3f9b5b2f7f050626d5f2e6f21b917ebd5c29bfad3234de1951a763ba3ae` |
| `audio_bus.cc` | `third_party/blink/renderer/platform/audio/audio_bus.cc` | `17fc6c0a60c1b1ef4115942b05bd7c37838f74784d0d128e66a0e660cc2a05c6` |
| `audio_utilities.cc` | `third_party/blink/renderer/platform/audio/audio_utilities.cc` | `d3ed345360190487ee482eebda6141580994db924bd0fd36f342a61b33a09db0` |
| `audio_utilities.h` | `third_party/blink/renderer/platform/audio/audio_utilities.h` | `04c36054b0c043f9f4cf061875734e7b0631df7f53c8a25d7ad3e7bb0ca271cc` |
| `biquad.cc` | `third_party/blink/renderer/platform/audio/biquad.cc` | `174c22c8c2ca13d947517bab7486e497010f643c3118b5acb1fb04218ea09a4a` |
| `biquad.h` | `third_party/blink/renderer/platform/audio/biquad.h` | `bf0eaa9f25c2036adeaf9c190896c9a9dd55ba715c3f6862b8fd3039ec52dcc9` |
| `cone_effect.cc` | `third_party/blink/renderer/platform/audio/cone_effect.cc` | `f0bb6c6469574eb817a27b967665b56f81d7b2533600aa6ac2098b00567a00d1` |
| `cone_effect.h` | `third_party/blink/renderer/platform/audio/cone_effect.h` | `309a5d1ac8ca274f3bb453fe745664c618ee86945c1e259177ee31d254dcc149` |
| `delay.cc` | `third_party/blink/renderer/platform/audio/delay.cc` | `d8a1b966dc49fb24b0c4fc83c3296a138c2e35bfd19b39666b3baa8d8f4deb0a` |
| `delay.h` | `third_party/blink/renderer/platform/audio/delay.h` | `4373092a3a6225ea1450796e007086cb680acd1a5448ad614d87fbe572829908` |
| `distance_effect.cc` | `third_party/blink/renderer/platform/audio/distance_effect.cc` | `ee8041036f59fd44d40825773f43a35b1af0dd095631a92d346fb151722aedb6` |
| `distance_effect.h` | `third_party/blink/renderer/platform/audio/distance_effect.h` | `0cc40696ab97658299733b6d7ab8362f14e1902363cd67da279b951030b9ddea` |
| `dynamics_compressor.cc` | `third_party/blink/renderer/platform/audio/dynamics_compressor.cc` | `be48c17c9d4039cd608269130e87c164cf8ea82f18c7a551fcadd92a37db2a13` |
| `dynamics_compressor.h` | `third_party/blink/renderer/platform/audio/dynamics_compressor.h` | `51e3144759e4e9ad81e733bdbe7e5e8ad94bed1651c93b7c16cea98b4f934ed1` |
| `equal_power_panner.cc` | `third_party/blink/renderer/platform/audio/equal_power_panner.cc` | `c871239ca5ad4757179b1234422798bf1df2f7d150f6ea1e833778bda406c0cd` |
| `equal_power_panner.h` | `third_party/blink/renderer/platform/audio/equal_power_panner.h` | `cff4c7f593c111970cabd19a336dd121d14aa7c08d8642590c7650ba98c8bc80` |
| `fft_convolver.cc` | `third_party/blink/renderer/platform/audio/fft_convolver.cc` | `50c2bf67588600ccba4afb12e92f3d170c84b8cbfe937b2c9b830fd07b81b886` |
| `fft_convolver.h` | `third_party/blink/renderer/platform/audio/fft_convolver.h` | `1e4d4fdad448e989197b4069ae4c5b6f99df2adfa3d5ac4e56996fa488cfb406` |
| `fft_frame.cc` | `third_party/blink/renderer/platform/audio/fft_frame.cc` | `6ecc33a8508263f9e329084e691703caabd009090cb72f31c4a386c4782718fd` |
| `fft_frame.h` | `third_party/blink/renderer/platform/audio/fft_frame.h` | `49294818e9e0ff12b8884bab3faacbdb1ba7b6017a77a5d4db5ee86fc9f1d087` |
| `hrtf_database.cc` | `third_party/blink/renderer/platform/audio/hrtf_database.cc` | `d3fedb2c03b43d22334ca01084662ab5ecefcef38d3212dd32a13f0eedd773a5` |
| `hrtf_database.h` | `third_party/blink/renderer/platform/audio/hrtf_database.h` | `d54d176429189b351cb5441f3615fe906aea275795e5aae7e1329e3778a3c126` |
| `hrtf_elevation.cc` | `third_party/blink/renderer/platform/audio/hrtf_elevation.cc` | `e2e6edff1ca3868c600046b41367286f966cb5b72ba99283f257fb10fa63d0a2` |
| `hrtf_elevation.h` | `third_party/blink/renderer/platform/audio/hrtf_elevation.h` | `737fbbfc1dfb02854e57135a3f5a1648b200aaef0bc8c7e401c4b30c2d1068e8` |
| `hrtf_kernel.cc` | `third_party/blink/renderer/platform/audio/hrtf_kernel.cc` | `2b75f99bfbcfb66430fd19d0163896b94c06a54af75cba9365ca1ab6050c4125` |
| `hrtf_kernel.h` | `third_party/blink/renderer/platform/audio/hrtf_kernel.h` | `095a17b557debb89464258645e9d5c351444e1384ede5f186c96c6f44f96e671` |
| `hrtf_panner.cc` | `third_party/blink/renderer/platform/audio/hrtf_panner.cc` | `0c3220a166f4f43eff06f01b236d2c072d662a0ee6dcb2e49f99887e17b6793b` |
| `hrtf_panner.h` | `third_party/blink/renderer/platform/audio/hrtf_panner.h` | `a9455989d877d27b40599820e3c044295ab8267f161748250fc30630d93ce618` |
| `panner_handler.cc` | `third_party/blink/renderer/modules/webaudio/panner_handler.cc` | `e8fc38c80d53338de399a108a37cc5080a60b3feeac528674f8262c79fc78adb` |
| `reverb_accumulation_buffer.cc` | `third_party/blink/renderer/platform/audio/reverb_accumulation_buffer.cc` | `3c0cc937a1caaaad7ba2b483b5b16f26e80a48e8c436a9f473ff149b1e309979` |
| `reverb_accumulation_buffer.h` | `third_party/blink/renderer/platform/audio/reverb_accumulation_buffer.h` | `0618182eeddfbeb8474d4d4da93bc02ae150e3df408f6170ba39d222de33f103` |
| `reverb.cc` | `third_party/blink/renderer/platform/audio/reverb.cc` | `6d17eb6c2022da61d1ecad19954004f807b1b00728fcf552a3827c3336ac6a72` |
| `reverb_convolver.cc` | `third_party/blink/renderer/platform/audio/reverb_convolver.cc` | `7185312c93b342d9c1d03888c6e028fc49a4d91d8253cbb2754048bb7567e523` |
| `reverb_convolver.h` | `third_party/blink/renderer/platform/audio/reverb_convolver.h` | `4ad669fd07f531a3e24aec491f890372e2dad62b1c7d0c6925f6b15721fdbc76` |
| `reverb_convolver_stage.cc` | `third_party/blink/renderer/platform/audio/reverb_convolver_stage.cc` | `52fb4526b2e524037000f7e08f66d128fdbb2a26a27981228b1527efef8e8481` |
| `reverb_convolver_stage.h` | `third_party/blink/renderer/platform/audio/reverb_convolver_stage.h` | `90cbee5e702ae52aec188e2b29c56f78f8ab9dedcae435996456d22279a00d54` |
| `rustfft_ffi.rs` | `third_party/blink/renderer/platform/audio/rustfft_ffi.rs` | `52a5317f5074fcfa50dedb7aac8b88cdfd007c75e01f4438a27e144cd613400d` |
| `sinc_resampler.cc` | `media/base/sinc_resampler.cc` | `a17b9ad025111bdb8bb0a0f479da69ffa88034bdc0615587f55b7dcee07947a3` |
| `sinc_resampler.h` | `media/base/sinc_resampler.h` | `0cc12c1b94d52a92a3802345339e61f0dd0dfcdc7c86845a05826c95235923ee` |
| `vector3d_f.cc` | `ui/gfx/geometry/vector3d_f.cc` | `bd7b07e0059d42011db159e6b4d9f386cdbd0005000de8fa21f0bca835cb9a67` |
| `vector3d_f.h` | `ui/gfx/geometry/vector3d_f.h` | `e00ff0184b768564b3277b5a4d5bb0b616389eb3c1a301050e4ad08e81189a0e` |
| `CHROMIUM-LICENSE` | `LICENSE` (repository root) | `368cca1106be99d39ecd32a38d8305585d802a475effb66380b91ffc9bcf709b` |

`CHROMIUM-LICENSE` is Chromium's repository LICENSE at the pinned commit, copied as is. The Blink audio files carry their own BSD-3-Clause notices (Google Inc. copyright, with the Apple clause as WebKit has it); see `native/audio/PORTS.md`.
