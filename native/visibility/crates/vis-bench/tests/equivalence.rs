//! The 4-wide path against the scalar reference on the spike's workloads (ADR 0460 section 1: "SIMD and scalar outputs
//! equal"): the same depth buffer bit for bit, the same visibility, at both tier resolutions, along a camera path.
use vis_bench::Workload;
use vis_raster::{Config, Occlusion};

fn same(workload: &Workload, w: usize, h: usize, frames: &[u32]) {
    let mut fast = Occlusion::new(w, h, Config { simd: true });
    let mut slow = Occlusion::new(w, h, Config { simd: false });
    let n = workload.boxes.len() / 6;
    for &f in frames {
        let view = workload.view(f);
        let frame = workload.frame(&view);
        let (mut hf, mut hs) = (vec![0u8; n], vec![0u8; n]);
        let sf = fast
            .occlude(&view, &frame.occluders(), &workload.boxes, &mut hf)
            .unwrap();
        let ss = slow
            .occlude(&view, &frame.occluders(), &workload.boxes, &mut hs)
            .unwrap();
        assert!(
            sf.rasterised > 100 && sf.culled > 100,
            "{} frame {f}: {sf:?}",
            workload.name
        );
        assert_eq!(sf, ss, "{} {w}x{h} frame {f}: stats", workload.name);
        assert_eq!(hf, hs, "{} {w}x{h} frame {f}: visibility", workload.name);
        let (a, b) = (fast.buffer(), slow.buffer());
        assert!(
            a.fine
                .iter()
                .zip(&b.fine)
                .all(|(x, y)| x.to_bits() == y.to_bits()),
            "{} {w}x{h} frame {f}: depth",
            workload.name
        );
        assert!(
            a.coarse
                .iter()
                .zip(&b.coarse)
                .all(|(x, y)| x.to_bits() == y.to_bits()),
            "{} {w}x{h} frame {f}: coarse level",
            workload.name
        );
    }
}

#[test]
fn city_boxes() {
    let w = Workload::city(false);
    same(&w, 256, 128, &[0, 60, 120, 180]);
    same(&w, 320, 180, &[30, 150]);
}

#[test]
fn city_coarse() {
    same(&Workload::city(true), 256, 128, &[0, 90, 200]);
}

#[test]
fn forest() {
    let w = Workload::forest();
    same(&w, 256, 128, &[0, 100, 200]);
    same(&w, 320, 180, &[50]);
}
