import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// Every var(--x) used in css/style.css must be defined somewhere — either in
// the CSS token blocks, OR injected by JS (style.setProperty or an inline
// style="--x:..." template). Vars with an inline fallback (var(--x, <default>))
// are safe by construction and don't need a definition. CSS custom properties
// fail silently when undefined (an invalid border collapses to none with no
// error), so this catches cross-repo token drift — e.g. pasting a block that
// uses a token from the sibling game's :root.
test("every var(--x) used in css/ is defined in CSS or injected by JS", () => {
  const css = readFileSync(new URL("../css/style.css", import.meta.url), "utf8");
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

  // JS-injected custom props: setProperty("--x", ...) OR inline style="--x:..."
  const jsFiles = readdirSync(new URL("../js/", import.meta.url)).filter((f) =>
    f.endsWith(".js")
  );
  for (const f of jsFiles) {
    const js = readFileSync(new URL(`../js/${f}`, import.meta.url), "utf8");
    for (const m of js.matchAll(/(?:setProperty\(|style=)['"]?(--[\w-]+)/g))
      defined.add(m[1]);
  }

  // Vars that carry an inline fallback are safe — they need no definition.
  const usedWithFallback = new Set(
    [...css.matchAll(/var\(\s*(--[\w-]+)\s*,\s*[^)]*\)/g)].map((m) => m[1])
  );

  const used = new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
  const missing = [...used].filter(
    (v) => !defined.has(v) && !usedWithFallback.has(v)
  );
  assert.deepEqual(
    missing,
    [],
    `undefined CSS custom properties (no definition, no fallback): ${missing.join(", ")}`
  );
});
