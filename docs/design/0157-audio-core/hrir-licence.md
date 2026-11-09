# HRIR data licence decision (task H0)

Status: confirmed by the owner on 2026-11-09 (see "Owner decision" below). Written 2026-11-09 for ADR 0157 (task H0, GitHub issue #51). No letter will be sent; Appendix A is kept for the record only.

## Owner decision (2026-11-09)

- Option (a) stands: the IRCAM Listen IRC_Composite_C data, as shipped in `myco_hrir.bin` (H2).
- **No courtesy letter.** Appendix A is not sent.
- The owner checks IRCAM's terms page before B7, as before (risk 1).
- **Where our copy comes from.** H2's converter fetched the 240 `IRC_Composite_C_R0195_T###_P###.wav` files from Chromium's `third_party/blink/renderer/platform/audio/resources/` at commit `cbba46fd94646232cfd2318ac962138c2a98c1f9` (`tools/hrir/PROVENANCE.json` lists each URL and SHA-256). That directory has no licence file, so the rights come from IRCAM's own statement, not from Chromium (see "Chromium's Composite.flac").
- **Not the source: `Ircam-RnD/m4dp-audio-modules`.** It is ISC-licensed in its `package.json`, which covers its JavaScript. Checked on 2026-11-09, it contains no IRC_Composite data: its `examples/hrtf/` holds SOFA files for other sets (`IRC_1147_C`, `OLPS_2042_C`, `OLPS_2044_C`). Its ISC licence therefore says nothing about our data.

## Decision

Use **option (a): the IRCAM Listen IRC_Composite_C data, as Chromium processed it**, for the HRTF panner in M1. Keep **SADIE II (option b)** as the ready fallback, and `audio.spatial: "equalPower"` (option c) as the user-facing switch that never fetches the data.

Why:

- IRCAM's published terms are about as permissive as data terms get: public, any use, acknowledgement requested. Nothing in them forbids redistribution, modification or commercial use.
- Choosing (a) keeps today's sound. The game ships the same HRIR set the engine's Web Audio `PannerNode` HRTF uses now, so ADR 0157's D4 row stays a non-regression and H4's null test against Chromium stays meaningful.
- The gap is paperwork, not permission. Chromium's copy carries no licence file, so the provenance of our copy rests on IRCAM's own terms, not on Chromium's. That is acceptable if we take the terms from IRCAM and cite IRCAM, not Chromium.
- SADIE II (Apache-2.0, citation required) is a cleaner legal instrument but is a different dataset, so it would change the sound and weaken H4. It is the right fallback, not the first choice.
- Equal-power everywhere is a recorded behaviour regression and drops 11 days of work for no legal gain that (a) doesn't already give.

Confidence: medium-high that (a) is lawful to ship; high that SADIE II is, if (a) is ever challenged. The residual risk is that I could not read IRCAM's own page (see Sources), so the exact IRCAM wording is taken from a redistributor's copy of it.

## What the sources say

Access date for every source below: 2026-11-09.

### IRCAM Listen database

Wording, as reproduced in the Debian packaging copyright file for libmysofa (the entry is named `listen-ircam`, "Copyright: 2002, IRCAM", covering files named `LISTEN_1002_IRC_1002_C_HRIR`):

- "The Listen database is public and available for any use."
- "We would however appreciate an acknowledgment of the database somewhere in the description of your work" (the sentence continues "(e.g. paper) or in your development").

Source: https://metadata.ftp-master.debian.org/changelogs//main/libm/libmysofa/libmysofa_0.6~dfsg0-3+deb10u1_copyright. The same text appears on the Ambisonic Toolkit licensing page, https://doc.sccode.org/Other/ATKLicensing.html (seen in a search summary; I did not fetch it).

Limits of this evidence: I tried IRCAM's own Listen page (http://recherche.ircam.fr/equipes/salles/listen/) and the fetch failed with a TLS protocol error, so I have not seen IRCAM's current wording. The acknowledgement is requested, not made a condition.

### Chromium's Composite.flac

- The file lives with 240 source files named `IRC_Composite_C_R0195_T###_P###.wav` in `third_party/blink/renderer/platform/audio/resources/`. The names match IRCAM's "IRC_Composite_C" set directly. Directory listing: https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/platform/audio/resources/
- The directory holds `Composite.flac`, the 240 WAVs and a `README`. No LICENSE, COPYING or METADATA file is listed.
- The README (https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/platform/audio/resources/README) only explains how `Composite.wav` was made with `sox` from the WAVs and encoded to FLAC with `ffmpeg`. It states no licence, no author and no IRCAM credit, and points to WebKit bug 98294.
- WebKit bug 98294 (https://bugs.webkit.org/show_bug.cgi?id=98294) covers regenerating the file and fixing an elevation-ordering error. It does not mention IRCAM or any licence.
- Provenance is confirmed by Chris Pike (BBC) on the W3C audio list: the IRCAM LISTEN set is what WebKit's HRTF set "is derived from", about 1.5 MB as linear PCM (https://lists.w3.org/Archives/Public/public-audio/2013JanMar/0210.html).
- The Chromium source files carry the BSD-style Google/Apple header (checked on `hrtf_database.h`); it names no data licence and does not mention IRCAM. The BSD header covers the code, so it does not by itself licence the data.

Conclusion on Chromium: confirmed, it ships the IRCAM Composite data with no licence file and no credit. That is Chromium's omission. It does not change IRCAM's terms, and it means we must not cite Chromium as the data's licence.

### SADIE II

From https://www.york.ac.uk/sadie-project/database.html:

- The database is licensed under the "Apache License, Version 2.0."
- "The original dataset must be referenced whenever used in original or modified form."
- Content: 20 subjects (two dummy heads, KU100 and KEMAR, and 18 humans), WAV and AES69 SOFA, at 44.1 kHz/16-bit, 48 kHz/24-bit and 96 kHz/24-bit.

Apache-2.0 allows redistribution and modification with the licence text and notices kept and changes stated. The "must be referenced" line adds a citation duty. Unlike Composite, SADIE II has an explicit, standard licence, but the dataset and its sound are different.

## Risks

1. **Terms read second-hand.** I saw IRCAM's wording only through Debian's copyright file. Before release, a person should open IRCAM's page, confirm the wording and keep a saved copy with the release notes.
2. **"Any use" is informal.** It is not a named licence. A strict lawyer would call it a permission statement, not a grant with defined terms. It is still a clear public statement by the rights holder, and relying on it is normal practice (Debian, libmysofa, Ambisonic Toolkit and Chromium all do).
3. **Derivative work.** Chromium's data is the originals concatenated and FLAC-encoded; ours would be converted to int16 and resampled. "Any use" covers this, but IRCAM was not asked about it.
4. **Chromium's copy is not a source of rights.** Do not treat Chromium's tree as the legal origin. If IRCAM's own download of the Composite subset is available, build the asset from that and compare it with Chromium's WAVs; record any difference.
5. **Acknowledgement is requested, not required.** Omitting it would not breach the quoted text, but we will include it.
6. **Links move.** Keep the quoted terms in this file and in `THIRD_PARTY_NOTICES.md` so they survive.
7. **Fallback cost.** If IRCAM objects, switching to SADIE II costs about the same as H2 and changes H4 as the plan's MS6 text says; no H1 code changes.

## Acknowledgement wording

For `THIRD_PARTY_NOTICES.md` (the data entry, beside the Chromium code ports):

> **HRIR data (HRTF panner).** The head-related impulse responses are the IRC_Composite_C set from the Listen HRTF database, Copyright 2002 IRCAM (Institut de Recherche et Coordination Acoustique/Musique), http://recherche.ircam.fr/equipes/salles/listen/. IRCAM states: "The Listen database is public and available for any use." The data was converted to 16-bit integers and resampled for this engine. We acknowledge the database as IRCAM requests.

For the user guide, in the HRTF/spatial audio section:

> 3D sound over headphones uses the IRCAM Listen HRTF database (IRC_Composite_C, Copyright 2002 IRCAM). We thank IRCAM for making it available.

If the SADIE II fallback is ever used instead, the notice becomes:

> **HRIR data (HRTF panner).** The head-related impulse responses are from the SADIE II database, University of York, https://www.york.ac.uk/sadie-project/database.html, used under the Apache License, Version 2.0 (licence text included). The original dataset is referenced as required; the data was resampled and converted to 16-bit integers for this engine.

(Copy the exact SADIE II citation from the database page when H2 builds the asset.)

## Which MS6 branch applies

In `docs/plans/2026-11-audio-core-m1.md`, MS6: **"If H0 says Composite: run as above."** H1, H2, H3 and H4 go ahead unchanged. H2 builds the blob from the IRC_Composite_C WAVs (ideally checked against IRCAM's own files, risk 4), and the acknowledgement above goes to the coordinator for `THIRD_PARTY_NOTICES.md` and the guide. ADR 0157's D4 row stays as written.

Do not block MS6 on the letter. Block the release (B7, default flipped) on the owner's check of IRCAM's own page (risk 1). If that check or any reply from IRCAM goes badly, take the SADIE II branch of the plan.

## Is a letter advisable?

Yes, as a courtesy and an extra record, not as a gate. The terms are clear enough to ship under, but a short written confirmation from IRCAM that modified redistribution inside a commercial engine is fine would close risks 2 and 3 cheaply. The owner decides whether to send. If no reply arrives, nothing changes.

## Appendix A: draft letter (for the owner to send; not sent)

To: the Listen HRTF database contact at IRCAM (take the current address from IRCAM's Listen page; I have not looked one up)

Subject: Use of the Listen HRTF database (IRC_Composite_C) in the Myco Engine

Dear colleagues,

I am writing for Foxfire Studios, which develops Myco Engine, a game engine for 2D and 3D games. The engine's audio system includes a head-related transfer function (HRTF) panner for headphone listeners. We would like to ship the IRC_Composite_C subset of your Listen database as its impulse-response data.

We have read your statement that "The Listen database is public and available for any use", and that you would appreciate an acknowledgement. We intend to give one. The engine and the games built with it are distributed to the public, free or commercially. We would convert the data to 16-bit integers, resample it to the playback rate, and ship it as a data file beside the engine, with this credit in the engine's third-party notices and user guide:

"HRIR data: the IRC_Composite_C set from the Listen HRTF database, Copyright 2002 IRCAM."

Could you confirm that this use, including the conversion and resampling and distribution inside commercial software, is fine, and that the credit above is acceptable? If you prefer different wording, or want a citation of a particular paper, please tell us and we will use it.

Thank you for making the database available.

Kind regards,
[Name]
Foxfire Studios
[Contact address]

## Sources

All accessed 2026-11-09:

- Debian libmysofa copyright file: https://metadata.ftp-master.debian.org/changelogs//main/libm/libmysofa/libmysofa_0.6~dfsg0-3+deb10u1_copyright
- Ambisonic Toolkit licensing: https://doc.sccode.org/Other/ATKLicensing.html
- IRCAM Listen (fetch failed, not read): http://recherche.ircam.fr/equipes/salles/listen/
- Chromium resources directory and README: https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/platform/audio/resources/
- Chromium `hrtf_database.h`: https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/platform/audio/hrtf_database.h
- WebKit bug 98294: https://bugs.webkit.org/show_bug.cgi?id=98294
- W3C audio list, Chris Pike: https://lists.w3.org/Archives/Public/public-audio/2013JanMar/0210.html
- SADIE II database: https://www.york.ac.uk/sadie-project/database.html
