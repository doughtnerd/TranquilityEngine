#[path = "../tests/common/mod.rs"]
mod common;
use anim_format::clip::*;
use common::*;
fn main() {
    let mut rng = Rng::new(60);
    let skel = skeleton(Shape::Humanoid, &mut rng);
    let clip = clip(&skel, 2.0, true, &mut rng);
    let t = std::time::Instant::now();
    let out =
        anim_compress::compress(&clip, Some(&skel), &anim_compress::Settings::default()).unwrap();
    println!("time {:?}", t.elapsed());
    let view = ClipView::parse(&out.bytes).unwrap();
    let c = view.compressed().unwrap();
    let mut hist = std::collections::BTreeMap::new();
    for i in 0..c.channel_count() {
        let ch = c.channel(i).unwrap();
        if ch.mode != ChannelMode::Animated {
            continue;
        }
        let mut v = vec![];
        for s in 0..c.segment_count() {
            v.push(c.bit_rates(s).unwrap()[ch.animated_index as usize]);
        }
        hist.entry(format!("{:?}", ch.kind))
            .or_insert(vec![])
            .push((ch.track, v));
    }
    for (k, v) in hist {
        println!("{k}: {:?}", v);
    }
    println!("data {} segs {}", c.data().len(), c.segment_count());
}
