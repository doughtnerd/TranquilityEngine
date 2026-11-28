//! The rule sets that are measured. `FULL b+c+d2x+e` is ADR 0460 §3 as written: depth pushed back by the error, coverage shrink
//! max(0.25 px, projected error) on the stand-in's triangle edges, skip occluders within 2 x near of the camera, and the
//! projected-width test. The rest isolate each rule and add candidate fixes.
use crate::setup::{Near, Rule, Shrink, RULE_NONE};

const R: Rule = RULE_NONE;
const C: Shrink = Shrink::ErrAll(0.25);
const CS: Shrink = Shrink::ErrSil(0.25);
const CS5: Shrink = Shrink::ErrSil(0.5);

pub fn rules() -> Vec<Rule> {
    vec![
        // each rule alone
        R,
        Rule { name: "b push", push: true, ..R },
        Rule { name: "c shrink max(.25,E), all edges", shrink: C, ..R },
        Rule { name: "c' shrink .25 const, all edges", shrink: Shrink::Floor(0.25), ..R },
        Rule { name: "c'' shrink max(.25,E), silhouette edges only", shrink: CS, ..R },
        Rule { name: "d near 1x (bounds)", near: Near::Mult(1.0), ..R },
        Rule { name: "d near 2x (bounds)", near: Near::Mult(2.0), ..R },
        Rule { name: "d radius 1 m (bounds)", near: Near::Radius(1.0), ..R },
        Rule { name: "d radius 3 m (bounds)", near: Near::Radius(3.0), ..R },
        Rule { name: "d' per-triangle near + 1x err", near: Near::TriErr(1.0), ..R },
        Rule { name: "e width>=2px", width: true, ..R },
        // together, as the ADR writes them
        Rule { name: "FULL b+c+d2x+e", push: true, shrink: C, near: Near::Mult(2.0), width: true, ..R },
        Rule { name: "FULL, d=1 m", push: true, shrink: C, near: Near::Radius(1.0), width: true, ..R },
        Rule { name: "FULL, d=3 m", push: true, shrink: C, near: Near::Radius(3.0), width: true, ..R },
        // candidate fixes
        Rule { name: "FULL, c silhouette only", push: true, shrink: CS, near: Near::Mult(2.0), width: true, ..R },
        Rule { name: "FULL + grazing-aware push", push: true, graze: true, shrink: C, near: Near::Mult(2.0), width: true, ..R },
        Rule { name: "trim 0.5% only", trim: 0.005, ..R },
        Rule { name: "FULL + trim 0.5%", push: true, shrink: C, near: Near::Mult(2.0), width: true, trim: 0.005, ..R },
        Rule { name: "FULL + trim 1%", push: true, shrink: C, near: Near::Mult(2.0), width: true, trim: 0.01, ..R },
        Rule { name: "FULL sil + trim 0.5%", push: true, shrink: CS, near: Near::Mult(2.0), width: true, trim: 0.005, ..R },
        Rule { name: "FULL sil + trim 0.5% + dilate 2", push: true, shrink: CS, near: Near::Mult(2.0), width: true, trim: 0.005, dilate: 2, ..R },
        Rule { name: "FULL sil + trim 0.5% + dilate 2 + d' tri-near", push: true, shrink: CS, near: Near::TriErr(1.0), width: true, trim: 0.005, dilate: 2, ..R },
        Rule { name: "c'' + dilate 2 (no push, no trim)", shrink: CS, dilate: 2, ..R },
        // silhouette shrink of a whole pixel (inner-conservative at silhouettes), per-triangle near test
        Rule { name: "c-sil5 sil shrink max(.5,E)", shrink: CS5, ..R },
        Rule { name: "c-all5 all-edge shrink max(.5,E)", shrink: Shrink::ErrAll(0.5), ..R },
        Rule { name: "FULL sil.5 + trim 0.5%", push: true, shrink: CS5, near: Near::Mult(2.0), width: true, trim: 0.005, ..R },
        Rule { name: "FULL sil.5 + trim 0.5% + d' tri-near 1x", push: true, shrink: CS5, near: Near::TriErr(1.0), width: true, trim: 0.005, ..R },
        Rule { name: "FULL sil.5 + trim 0.5% + d' tri-near 2x", push: true, shrink: CS5, near: Near::TriErr(2.0), width: true, trim: 0.005, ..R },
        Rule { name: "PROPOSED sil.5 + trim 0.5% + graze + d' tri-near 2x", push: true, graze: true, shrink: CS5, near: Near::TriErr(2.0), width: true, trim: 0.005, ..R },
        Rule { name: "PROPOSED + dilate 2", push: true, graze: true, shrink: CS5, near: Near::TriErr(2.0), width: true, trim: 0.005, dilate: 2, ..R },
        Rule { name: "PROPOSED, trim 1%", push: true, graze: true, shrink: CS5, near: Near::TriErr(2.0), width: true, trim: 0.01, ..R },
        Rule { name: "PROPOSED, errors x2", push: true, graze: true, shrink: CS5, near: Near::TriErr(2.0), width: true, trim: 0.005, emul: 2.0, ..R },
        Rule { name: "PROPOSED, errors x4", push: true, graze: true, shrink: CS5, near: Near::TriErr(2.0), width: true, trim: 0.005, emul: 4.0, ..R },
        Rule { name: "FULL (ADR) errors x2", push: true, shrink: C, near: Near::Mult(2.0), width: true, emul: 2.0, ..R },
    ]
}
