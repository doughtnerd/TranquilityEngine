#!/usr/bin/env node
// `npm run conformance:layout` (ADR 0434): lays out every case in src/engine/tests/layoutConformance/cases.json in
// Chromium (Playwright) and writes each node's border box, relative to its parent's border box, to chromium.json beside
// it. taffyConformance.test.ts compares the UI core's layout engine with those boxes. Rerun it after adding a case.
//
// A case node is a div with the UI core's initial values (display: flex, position: relative, border-box sizing) and
// its `style` (camelCase CSS; numbers are pixels, `{ calc: [px, percent] }` a calc(); `padding`, `margin`, `border` set all four sides). A node with
// `words: [count, width, lineHeight]` is a measured leaf: `count` inline boxes of `width` x `lineHeight`, which wrap
// like words of text (the test's measure function models the same).
import { chromium } from "playwright";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../src/engine/tests/layoutConformance/", import.meta.url));
const cases = JSON.parse(readFileSync(`${dir}cases.json`, "utf8"));

// The Chromium playwright.config.ts picks: E2E_CHROMIUM, else Playwright's own, else a preinstalled /opt/pw-browsers one.
const chromiumPath = process.env.E2E_CHROMIUM ?? (!existsSync(chromium.executablePath()) && existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const browser = await chromium.launch(chromiumPath ? { executablePath: chromiumPath } : {});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
const results = await page.evaluate((cases) => {
  // A number is pixels; `{ calc: [px, percent] }` is `calc(percent% + px)`.
  const px = (v) => (typeof v === "number" ? `${v}px` : v && typeof v === "object" ? `calc(${v.calc[1]}% + ${v.calc[0]}px)` : v);
  function build(spec) {
    const el = document.createElement("div");
    const s = el.style;
    s.display = "flex";
    s.position = "relative";
    s.boxSizing = "border-box";
    s.borderStyle = "solid";
    s.borderWidth = "0";
    for (const [k, v] of Object.entries(spec.style ?? {})) {
      if (v === null || v === undefined) continue;
      if (k === "padding" || k === "margin") s[k] = px(v);
      else if (k === "border") s.borderWidth = px(v);
      else if (k === "overflow") s.overflow = v;
      else if (k === "aspectRatio" || k === "flexGrow" || k === "flexShrink") s[k] = String(v);
      else s[k] = px(v);
    }
    if (spec.words) {
      const [count, width, lineHeight] = spec.words;
      s.display = spec.style?.display === "none" ? "none" : "block";
      s.fontSize = "0";
      s.lineHeight = "0";
      for (let i = 0; i < count; i++) {
        if (i > 0) el.append(document.createTextNode(" "));
        const w = document.createElement("span");
        w.style.cssText = `display:inline-block;width:${width}px;height:${lineHeight}px`;
        el.append(w);
      }
    }
    for (const child of spec.children ?? []) el.append(build(child));
    return el;
  }
  return cases.map((c) => {
    const host = document.createElement("div");
    host.style.cssText = `position:absolute;left:0;top:0;width:${c.width}px;height:${c.height}px`;
    const root = build(c.root);
    host.append(root);
    document.body.append(host);
    const boxes = [];
    const walk = (spec, el) => {
      const r = el.getBoundingClientRect();
      const p = el === root ? host.getBoundingClientRect() : el.parentElement.getBoundingClientRect();
      boxes.push([r.left - p.left, r.top - p.top, r.width, r.height]);
      const kids = [...el.children].filter((k) => k.tagName === "DIV");
      (spec.children ?? []).forEach((child, i) => walk(child, kids[i]));
    };
    walk(c.root, root);
    host.remove();
    return { name: c.name, boxes };
  });
}, cases);
await browser.close();
// One box per line.
const json = JSON.stringify({ browser: browser.version(), cases: results }, null, 1).replace(/\[\s+([-\d.e]+),\s+([-\d.e]+),\s+([-\d.e]+),\s+([-\d.e]+)\s+\]/g, "[$1, $2, $3, $4]");
writeFileSync(`${dir}chromium.json`, json + "\n");
console.log(`[conformance:layout] ${results.length} cases from Chromium ${browser.version()} -> ${dir}chromium.json`);
