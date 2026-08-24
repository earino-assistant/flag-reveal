// Tests for the offline metrics tooling — the pure digest builder
// (tools/posthog_report.mjs) and the stable-window contract
// (tools/posthog_metrics.mjs). No network is touched: the digest is built from
// hand-authored bags, and the window builder is pure date math. These mirror
// GeoParty's posthog-report.test.js and cover the same P0s — a failed query
// must never render as a healthy zero, and a null exception stack must not
// crash — plus the reproducibility contract and Flag Reveal's own KPIs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDigest, fmtStack } from "../tools/posthog_report.mjs";
import { buildWindows, resolveAsof } from "../tools/posthog_metrics.mjs";

// A fully-populated, all-ok bag we can selectively break in each test.
function fullBag() {
  return {
    generated_at: "2026-08-24T00:00:00.000Z",
    asof: "2026-08-24",
    project: "256584",
    window: { asof: "2026-08-24", end: "2026-08-24", start14: "2026-08-10", start30: "2026-07-25" },
    ok: true,
    errors: [],
    metrics: {
      core_30d: { label: "Core", rows: [[10, 24, 40, 88, 33]] },
      mode_mix_30d: { label: "Mode", rows: [["phone", 8, 30, 70], ["tv", 2, 10, 18]] },
      funnel_14d: { label: "Funnel", rows: [["front_door_join", 50], ["team_joined", 24], ["flag_round", 40], ["next_game", 6]] },
      ring_health_14d: { label: "Ring", rows: [[52, 36, 4.2, 4.0, 7, 88]] },
      round_outcome_14d: { label: "Outcome", rows: [[30, 10, 5.1, 40]] },
      daily_30d: { label: "Daily", rows: [[12, 7, 3]] },
      tv_attach_14d: { label: "TV", rows: [["qr", 5], ["link", 3], ["typed", 1]] },
      exceptions_14d: { label: "Exc", rows: [['["a","b","boom"]', false, 3, 1]] },
      consent_30d: { label: "Consent", rows: [[40, 5]] },
    },
  };
}

test("all-error bag renders NO DATA markers, never zeros", () => {
  const bag = fullBag();
  for (const k of Object.keys(bag.metrics)) bag.metrics[k] = { label: k, error: true };
  bag.ok = false;
  bag.errors = Object.keys(bag.metrics);
  const out = buildDigest(bag, null);

  // Every section prints the failure marker (9 sections)...
  const markers = out.split("\n").filter((l) => l.includes("NO DATA")).length;
  assert.ok(markers >= 9, `expected a marker per failed section, got ${markers}`);
  // ...and the incomplete-pull banner is loud.
  assert.match(out, /metrics pull incomplete/);
  // A failed core must NOT masquerade as a real zero.
  assert.doesNotMatch(out, /Rooms created: \*\*0\*\*/);
  // A failed ring-health section must NOT render a fabricated correctness rate.
  assert.doesNotMatch(out, /correct \*\*0\*\*/);
});

test("zero-row tv_attach renders explicitly, not a missing line", () => {
  const bag = fullBag();
  bag.metrics.tv_attach_14d = { label: "TV", rows: [] };
  const out = buildDigest(bag, null);
  assert.match(out, /TV attach by via \(14d\):/);
  assert.match(out, /none in window \(no TVs attached\)/);
});

test("ring health KPI: correctness rate and contested count", () => {
  const out = buildDigest(fullBag(), null);
  // 52 correct of 88 total → 59%.
  assert.match(out, /correct \*\*52\*\* · wrong \*\*36\*\* \(59% correct\) · n=88/);
  assert.match(out, /atStep avg \*\*4\.2\*\* · median \*\*4\*\* · contested rings \*\*7\*\*/);
});

test("round outcome KPI: bust rate and avg winning step", () => {
  const out = buildDigest(fullBag(), null);
  // 10 busted of 40 → 25% bust rate.
  assert.match(out, /won \*\*30\*\* · busted \*\*10\*\* \(25% bust rate\) · n=40/);
  assert.match(out, /avg winning step \*\*5\.1\*\*/);
});

test("tv attach mix and total render", () => {
  const out = buildDigest(fullBag(), null);
  assert.match(out, /qr=5, link=3, typed=1 · total \*\*9\*\*/);
});

test("zero-row mode mix and exceptions render 'none in window'", () => {
  const bag = fullBag();
  bag.metrics.mode_mix_30d = { label: "Mode", rows: [] };
  bag.metrics.exceptions_14d = { label: "Exc", rows: [] };
  const out = buildDigest(bag, null);
  const modeSection = out.slice(out.indexOf("Mode mix"));
  assert.match(modeSection, /none in window/);
  const excSection = out.slice(out.indexOf("Errors (14d)"));
  assert.match(excSection, /none in window/);
});

test("null / garbage $exception_functions does not crash", () => {
  assert.equal(fmtStack(null), "(no stack)");
  assert.equal(fmtStack(undefined), "(no stack)");
  assert.equal(fmtStack(""), "(no stack)");
  assert.equal(fmtStack("not json at all"), "not json at all");
  assert.equal(fmtStack('["x","y","z"]'), "y › z");
  assert.equal(fmtStack(["x", "y", "z"]), "y › z");
  assert.equal(fmtStack(42), "(no stack)");

  const bag = fullBag();
  bag.metrics.exceptions_14d = { label: "Exc", rows: [[null, false, 5, 1], ["{garbage", true, 2, 1]] };
  let out;
  assert.doesNotThrow(() => { out = buildDigest(bag, null); });
  assert.match(out, /\(no stack\)/);
  assert.match(out, /⚠ UNHANDLED/);
});

test("boolean handled classification splits UNHANDLED vs handled", () => {
  const bag = fullBag();
  bag.metrics.exceptions_14d = {
    label: "Exc",
    rows: [['["boom"]', false, 3, 1], ['["ok"]', true, 9, 2]],
  };
  const out = buildDigest(bag, null);
  assert.match(out, /⚠ UNHANDLED boom: \*\*3\*\*/);
  assert.match(out, /· handled ok: \*\*9\*\*/);
  assert.match(out, /> Unhandled: boom \(3\)/);
});

test("delta math: core volumes and funnel step deltas", () => {
  const cur = fullBag();
  const prev = fullBag();
  prev.metrics.core_30d = { label: "Core", rows: [[8, 20, 30, 70, 25]] };
  prev.metrics.funnel_14d = { label: "Funnel", rows: [["front_door_join", 40], ["team_joined", 18]] };
  const out = buildDigest(cur, prev);
  assert.match(out, /Rooms created: \*\*10\*\* \(\+2 vs last week\)/);
  assert.match(out, /active devices: \*\*33\*\* \(\+8 vs last week\)/);
  assert.match(out, /Teams joined: \*\*24\*\* \(\+4 vs last week\)/);
  assert.match(out, /rounds played: \*\*40\*\* \(\+10 vs last week\)/);
  assert.match(out, /front_door_join: \*\*50\*\* \(\+10 vs last week\)/);
  assert.match(out, /team_joined: \*\*24\*\* \(\+6 vs last week\)/);
});

test("missing baseline (no prev) suppresses deltas cleanly", () => {
  const out = buildDigest(fullBag(), null);
  assert.doesNotMatch(out, /vs last week/);
  assert.doesNotMatch(out, /baseline unreliable/);
});

test("unreliable baseline (prev.ok=false) suppresses deltas with a warning", () => {
  const prev = fullBag();
  prev.ok = false;
  prev.errors = ["core_30d"];
  const out = buildDigest(fullBag(), prev);
  assert.match(out, /⚠ baseline unreliable/);
  assert.doesNotMatch(out, /vs last week/);
});

test("header prints asof and the resolved window bounds", () => {
  const out = buildDigest(fullBag(), null);
  assert.match(out, /State of Flag Party/);
  assert.match(out, /as of 2026-08-24/);
  assert.match(out, /30d 2026-07-25→2026-08-24/);
  assert.match(out, /14d 2026-08-10→2026-08-24/);
});

/* ---------------- window-builder (reproducibility) ---------------- */

test("buildWindows: 14d/30d literal bounds anchored to asof", () => {
  const w = buildWindows("2026-08-24");
  assert.equal(w.end, "2026-08-24");
  assert.equal(w.start14, "2026-08-10");
  assert.equal(w.start30, "2026-07-25");
  assert.match(w.w14, /timestamp >= toDate\('2026-08-10'\) and timestamp < toDate\('2026-08-24'\)/);
  assert.match(w.w30, /timestamp >= toDate\('2026-07-25'\) and timestamp < toDate\('2026-08-24'\)/);
  // No now() — the whole point of the stable-window contract.
  assert.doesNotMatch(w.w14, /now\(\)/);
  assert.doesNotMatch(w.w30, /now\(\)/);
});

test("buildWindows: re-run reproduces the same bounds (month boundary)", () => {
  assert.deepEqual(buildWindows("2026-03-05"), buildWindows("2026-03-05"));
  // Crossing into February / January exercises the UTC date math.
  const w = buildWindows("2026-03-05");
  assert.equal(w.start14, "2026-02-19");
  assert.equal(w.start30, "2026-02-03");
});

test("resolveAsof: accepts real dates, rejects malformed and impossible ones", () => {
  assert.equal(resolveAsof("2026-08-24"), "2026-08-24");
  assert.throws(() => resolveAsof("2026-8-2"), /YYYY-MM-DD/);
  assert.throws(() => resolveAsof("2026-13-01"), /not a real date/);
  assert.throws(() => resolveAsof("2026-02-30"), /not a real date/);
  assert.throws(() => resolveAsof("garbage"), /YYYY-MM-DD/);
  // Omitted → today UTC, a valid YYYY-MM-DD.
  assert.match(resolveAsof(null), /^\d{4}-\d{2}-\d{2}$/);
});
