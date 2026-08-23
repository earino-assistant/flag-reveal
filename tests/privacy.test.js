// tests/privacy.test.js — the render-discipline contract (SPEC §5.2). No
// renderer reads round/private/*. The wrong-ring lockout is private DURING the
// round; it is disclosed only at reveal (from results/*, written by the
// resolveRound transaction). We assert the two rendering modules — the shared
// reveal renderer and the passive TV — never reference `private` at all.
//
// (js/flag-ui.js legitimately reads the owning phone's OWN private lockout on
// resume, which §5.1 explicitly permits, so it is not covered by this grep.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const JS = join(HERE, "..", "js");

for (const file of ["reveal-render.js", "screen-flag.js"]) {
  test(`${file} never references round/private (render-discipline, §5.2)`, () => {
    const src = readFileSync(join(JS, file), "utf8");
    // Strip line comments so the word "private" in prose doesn't trip the guard.
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    assert.ok(
      !/private/.test(code),
      `${file} must not read round/private (privacy render-discipline)`
    );
  });
}
