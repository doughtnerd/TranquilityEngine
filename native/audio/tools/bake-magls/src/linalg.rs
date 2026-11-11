//! A 16 x 16 solve in `f64` (Gauss-Jordan with partial pivoting), in a fixed order so the bake is
//! deterministic.

use crate::sh::CHANNELS;

pub type Mat16 = [[f64; CHANNELS]; CHANNELS];

/// The inverse of `g` (symmetric positive definite in every use here). Panics on a singular matrix.
pub fn invert(mut g: Mat16) -> Mat16 {
    let n = CHANNELS;
    let mut inv = [[0.0f64; CHANNELS]; CHANNELS];
    for (i, row) in inv.iter_mut().enumerate() {
        row[i] = 1.0;
    }
    for c in 0..n {
        let mut piv = c;
        for r in c + 1..n {
            if g[r][c].abs() > g[piv][c].abs() {
                piv = r;
            }
        }
        g.swap(c, piv);
        inv.swap(c, piv);
        let d = g[c][c];
        assert!(d.abs() > 1e-300, "singular normal matrix");
        for q in 0..n {
            g[c][q] /= d;
            inv[c][q] /= d;
        }
        for r in 0..n {
            if r != c {
                let f = g[r][c];
                if f != 0.0 {
                    for q in 0..n {
                        g[r][q] -= f * g[c][q];
                        inv[r][q] -= f * inv[c][q];
                    }
                }
            }
        }
    }
    inv
}

/// The weighted least-squares projector `P = (Yᵀ V Y + λ I)⁻¹ Yᵀ V` of the rows `y` (one harmonic
/// row per direction) with weights `v`, stored per direction as `p[i][c]`: the fitted channel `c`
/// of data `t` is `Σᵢ p[i][c] t[i]`. `ridge` is λ as a fraction of the mean diagonal of `Yᵀ V Y`.
pub fn projector(y: &[[f64; CHANNELS]], v: &[f64], ridge: f64) -> Vec<[f64; CHANNELS]> {
    let mut g = [[0.0f64; CHANNELS]; CHANNELS];
    for (yi, &vi) in y.iter().zip(v) {
        for a in 0..CHANNELS {
            for b in 0..CHANNELS {
                g[a][b] += yi[a] * vi * yi[b];
            }
        }
    }
    let lam = ridge * (0..CHANNELS).map(|i| g[i][i]).sum::<f64>() / CHANNELS as f64;
    for (i, row) in g.iter_mut().enumerate() {
        row[i] += lam;
    }
    let inv = invert(g);
    // Stored per direction (`p[i][c]`) so a fit walks the data once.
    y.iter()
        .zip(v)
        .map(|(yi, &vi)| {
            let mut col = [0.0f64; CHANNELS];
            for (c, out) in col.iter_mut().enumerate() {
                let mut s = 0.0;
                for b in 0..CHANNELS {
                    s += inv[c][b] * yi[b];
                }
                *out = s * vi;
            }
            col
        })
        .collect()
}
