import { describe, expect, it } from "vitest";
import { importSites, rewriteImports, typescript } from "./moduleImports";

describe("importSites", () => {
  it("finds imports, export-froms, dynamic imports and requires, with the specifier's own position", async () => {
    const ts = await typescript();
    const code = `import a from "./a.js";\nexport { b } from './b.js';\nexport * from "c";\nconst d = await import("./d.js");\nconst e = require("e");\n`;
    const sites = importSites(ts, code);
    expect(sites.map((s) => s.specifier)).toEqual(["./a.js", "./b.js", "c", "./d.js", "e"]);
    for (const s of sites) expect(code.slice(s.start, s.end)).toBe(s.specifier);
  });

  it("finds every import of minified code, after a regular expression with a quote in it", async () => {
    // A bundle's chunk (King of Pirates' UI runtime): esbuild leaves an external import where its module begins,
    // after code like this, and every one of them must be found to be rewritten.
    const ts = await typescript();
    const code = `var r=/["']/g;import{a as b}from"myco-build:myco-ui-host.js";var t=\`x\${1}\`;import{c}from"myco-build:myco-ui-host.js";`;
    expect(importSites(ts, code).map((s) => s.specifier)).toEqual(["myco-build:myco-ui-host.js", "myco-build:myco-ui-host.js"]);
    const out = rewriteImports(code, importSites(ts, code), () => "../../myco-ui-host.js");
    expect(out).not.toContain("myco-build:");
    expect(out).toContain(`var r=/["']/g;import{a as b}from"../../myco-ui-host.js"`);
  });

  it("doesn't take an import-like string or comment for an import", async () => {
    const ts = await typescript();
    const code = `const s = 'import x from "nope"';\n// import y from "nor";\nimport z from "yes";\n`;
    expect(importSites(ts, code).map((s) => s.specifier)).toEqual(["yes"]);
  });
});
