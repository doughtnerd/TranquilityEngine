# HRIR attribution (H2-L2)

Draft text for the coordinator, taken from `hrir-licence.md`, section "Acknowledgement wording". Nothing here has been applied to `THIRD_PARTY_NOTICES.md` or the user guide yet.

## 1. THIRD_PARTY_NOTICES.md entry

Paste as a new section after "## Audio core (`native/audio`; ADR 0157)":

```markdown
## HRIR data (`src/plugins/audio/runtime/wasm/myco_hrir.bin`; ADR 0157)

- **HRIR data (HRTF panner)** - the head-related impulse responses are the IRC_Composite_C set from the Listen HRTF database, Copyright 2002 IRCAM (Institut de Recherche et Coordination Acoustique/Musique), http://recherche.ircam.fr/equipes/salles/listen/. IRCAM states: "The Listen database is public and available for any use." The data is shipped as format 2 (blob `src/plugins/audio/runtime/wasm/myco_hrir.bin`), converted to 16-bit integers and resampled at load. It was taken from Chromium's copy of the set at commit `cbba46fd94646232cfd2318ac962138c2a98c1f9`; the licence is IRCAM's, not Chromium's. We acknowledge the database as IRCAM requests.
```

## 2. User guide paragraph

Place it at the end of the section "## Spatial audio (0074)" in `docs/guide/atmosphere-and-sound.md`, after the paragraph beginning "Only the World that has the view plays sound." (about line 45). That file is the only one under `docs/guide/` with a spatial audio heading. `audio-mixer.md` mentions spatial sound only in its limits, so it is not the place.

> 3D sound over headphones uses the IRCAM Listen HRTF database (IRC_Composite_C, Copyright 2002 IRCAM). We thank IRCAM for making it available.

## 3. SADIE II fallback entry

Use only if the SADIE II branch is ever taken. Copy the exact citation from the database page when H2 builds the asset.

```markdown
- **HRIR data (HRTF panner)** - the head-related impulse responses are from the SADIE II database, University of York, https://www.york.ac.uk/sadie-project/database.html, used under the Apache License, Version 2.0 (licence text included). The original dataset is referenced as required; the data was resampled and converted to 16-bit integers for this engine.
```
