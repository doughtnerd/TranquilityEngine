//! The camera of one occlusion view, validated at the boundary (ADR 0447 section 1: NaN and zero-scale matrices are
//! rejected inside the core).

/// Why a view was refused.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Reject {
    /// A matrix entry, the eye or a scalar is NaN or infinite.
    NotFinite,
    /// `near` is not positive, `far` not beyond it, or a projection scale is not positive.
    BadRange,
    /// The matrix is singular (a zero scale along some axis): it cannot be inverted, so no pixel means anything.
    Singular,
}

/// A perspective view. Orthographic views are not supported in v1 (ADR 0447 section 4 turns them off by default); the
/// caller leaves them unculled.
#[derive(Clone, Debug)]
pub struct View {
    /// The view-projection matrix's columns: `cols[j][i]` is row i, column j, so clip = sum over j of `cols[j]` * p_j,
    /// plus `cols[3]`. Clip w must be the positive distance along the view direction.
    pub cols: [[f32; 4]; 4],
    pub eye: [f32; 3],
    pub near: f32,
    pub far: f32,
    /// The projection's x and y scale (cot(fovY/2)/aspect and cot(fovY/2)): turns a world size at w = 1 into half-viewports.
    pub sx: f32,
    pub sy: f32,
}

fn det3(r: &[[f64; 3]; 3]) -> f64 {
    r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1])
        - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0])
        + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0])
}

impl View {
    /// Builds a view from a column-major matrix (16 floats, as `VisibilityView.viewProjection`).
    pub fn perspective(
        matrix: &[f32; 16],
        eye: [f32; 3],
        near: f32,
        far: f32,
        sx: f32,
        sy: f32,
    ) -> Result<View, Reject> {
        let finite = matrix
            .iter()
            .chain(eye.iter())
            .chain([near, far, sx, sy].iter())
            .all(|v| v.is_finite());
        if !finite {
            return Err(Reject::NotFinite);
        }
        if !(near > 0.0 && far > near && sx > 0.0 && sy > 0.0) {
            return Err(Reject::BadRange);
        }
        let mut cols = [[0f32; 4]; 4];
        for (j, col) in cols.iter_mut().enumerate() {
            col.copy_from_slice(&matrix[j * 4..j * 4 + 4]);
        }
        // The linear part (translation ignored, so a far-away eye doesn't hide a collapsed axis): clip x, y, z over world
        // x, y, z. Its determinant relative to the product of its rows' lengths is the (scale-free) rank test; clip w
        // must also depend on position, or no depth exists.
        let mut lin = [[0f64; 3]; 3];
        for (i, row) in lin.iter_mut().enumerate() {
            for (j, v) in row.iter_mut().enumerate() {
                *v = cols[j][i] as f64;
            }
        }
        let norm = |r: &[f64; 3]| libm::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
        let hadamard = norm(&lin[0]) * norm(&lin[1]) * norm(&lin[2]);
        let det = det3(&lin);
        let w_row = [cols[0][3] as f64, cols[1][3] as f64, cols[2][3] as f64];
        if !det.is_finite() || det.abs() <= 1e-9 * hadamard || norm(&w_row) == 0.0 {
            return Err(Reject::Singular);
        }
        Ok(View {
            cols,
            eye,
            near,
            far,
            sx,
            sy,
        })
    }

    /// Buffer pixels per world unit at w = 1 (the larger of the two axes), for projecting an error.
    #[inline]
    pub fn pixel_scale(&self, w: usize, h: usize) -> f32 {
        let a = (w as f32) * 0.5 * self.sx;
        let b = (h as f32) * 0.5 * self.sy;
        if a > b {
            a
        } else {
            b
        }
    }
}
