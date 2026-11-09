// Whether this run's Chromium renders on the machine's GPU (playwright.config.ts): locally on
// Windows only, where it's measured (ANGLE on Direct3D 11, WebGPU through Dawn on Direct3D 12).
// CI, other platforms and E2E_SOFTWARE_GL=1 render in software (SwiftShader), on the CPU.
export const gpuAngle: "d3d11" | null = process.env.CI || process.env.E2E_SOFTWARE_GL || process.platform !== "win32" ? null : "d3d11";
