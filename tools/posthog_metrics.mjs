// posthog_metrics.mjs — the one repeatable source of truth for Flag Reveal's
// product metrics. Pulls every KPI the "State of Flag Reveal" report reads from
// PostHog, on stable date windows, and writes a single JSON file.
//
// Mirrors GeoParty's tools/posthog_metrics.mjs exactly (structure, exit
// contract, stable-window logic) — only the PROJECT id and the KPI queries
// differ, because Flag Reveal's mechanics (rings, round outcomes, the party
// funnel) are its own. Read that file before changing this one.
//
// The queries here are deliberately FIXED: the weekly report is only
// apples-to-apples if the same questions run every time. Change a query
// deliberately (and document why) — never silently.
//
// Windows are anchored to an `--asof` date (default: today UTC) and rendered
// into the SQL as literal `toDate('…')` bounds, NOT `now()`. A re-run after a
// failed Monday therefore reproduces Monday's numbers exactly.
//
// Usage:
//   POSTHOG_FLAGREVEAL_API_KEY=... node tools/posthog_metrics.mjs [--asof YYYY-MM-DD] [--out FILE]
//   node tools/posthog_metrics.mjs --asof 2026-08-24 --out /opt/data/flag-reveal-metrics/flag-metrics-2026-08-24.json
//
// The API key is read from the environment ONLY — never committed, never
// printed. This script has no dependencies beyond Node's built-ins.
//
// EXIT CONTRACT (read by the weekly cron; the cron is not in this repo):
//   - Exit 0 only when EVERY query succeeded (bag.ok === true).
//   - Any query error → exit 1, bag.ok=false, bag.errors=[failed keys]. The
//     cron MUST then deliver "metrics pull FAILED: <errors>" and never render
//     a digest from a partial bag.
//   - The baseline (last-week file) is rotated only AFTER a fully-ok run, so a
//     failed pull never poisons next week's week-over-week deltas.
//
// BASELINE STORAGE (also a cron concern, stated here so it isn't lost):
//   Metrics JSON is written to a dated history on the persistent volume —
//   /opt/data/flag-reveal-metrics/flag-metrics-YYYY-MM-DD.json — and the
//   report's `prev` file is the newest earlier dated file. Metrics JSON is
//   NEVER committed to the repo: this is a public Pages repo, so the bag lives
//   under /opt/data/ only.

import { writeFileSync } from "node:fs";

const HOST = "https://eu.i.posthog.com";
const PROJECT = "256584"; // Flag Reveal EU project (NOT GeoParty's 252836)

const REQUEST_TIMEOUT_MS = 30000; // per-query abort budget
const RETRY_BACKOFF_MS = 1000;    // one retry on 5xx / timeout

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A PostHog HogQL query helper. Same transport GeoParty's field-debug sessions
// use. One retry on 5xx or timeout/network error, mirroring the AbortController
// pattern; 4xx (a real query/auth fault) is not retried.
async function query(sql) {
  const key = process.env.POSTHOG_FLAGREVEAL_API_KEY;
  if (!key) {
    console.error("posthog_metrics: POSTHOG_FLAGREVEAL_API_KEY is not set (Flag Reveal project 256584)");
    return { error: "no key" };
  }
  const url = `${HOST}/api/projects/${PROJECT}/query/`;
  const body = JSON.stringify({ query: { kind: "HogQLQuery", query: sql } });

  for (let attempt = 0; attempt <= 1; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body,
        signal: ac.signal,
      });
      if (res.status >= 500) {
        console.error(`posthog_metrics: query failed ${res.status} (attempt ${attempt + 1})`);
        if (attempt === 0) { await sleep(RETRY_BACKOFF_MS); continue; }
        return { error: `http ${res.status}` };
      }
      if (!res.ok) {
        const text = await res.text();
        console.error(`posthog_metrics: query failed ${res.status}: ${text.slice(0, 300)}`);
        return { error: `http ${res.status}` };
      }
      const data = await res.json();
      return data.results || [];
    } catch (e) {
      const reason = ac.signal.aborted ? "timeout" : (e && e.message) || "network error";
      console.error(`posthog_metrics: query error (${reason}, attempt ${attempt + 1})`);
      if (attempt === 0) { await sleep(RETRY_BACKOFF_MS); continue; }
      return { error: reason };
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ---------------- stable-window contract ---------------- */

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function formatDateUTC(d) {
  return d.toISOString().slice(0, 10);
}

// Shift a YYYY-MM-DD string by whole UTC days, returning YYYY-MM-DD.
function addDaysUTC(ymd, delta) {
  const [y, m, dd] = ymd.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, dd));
  d.setUTCDate(d.getUTCDate() + delta);
  return formatDateUTC(d);
}

// Resolve the --asof anchor: a real YYYY-MM-DD, or today UTC when omitted.
// Throws on a malformed or impossible date so a typo can't silently shift the
// whole report's window.
export function resolveAsof(value) {
  if (value === null || value === undefined || value === "") {
    return formatDateUTC(new Date());
  }
  if (!YMD.test(value)) {
    throw new Error(`invalid --asof '${value}', expected YYYY-MM-DD`);
  }
  const [y, m, dd] = value.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, dd));
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== m - 1 || d.getUTCDate() !== dd) {
    throw new Error(`invalid --asof '${value}', not a real date`);
  }
  return value;
}

// Build the fixed 14d / 30d windows as literal date bounds anchored to `asof`.
// Each window is [start, end) in whole UTC days; `end` is exclusive and equals
// `asof`, so the report always covers complete days and is reproducible from
// the anchor alone (no `now()`).
export function buildWindows(asof) {
  const end = asof;
  const start14 = addDaysUTC(asof, -14);
  const start30 = addDaysUTC(asof, -30);
  const w14 = `timestamp >= toDate('${start14}') and timestamp < toDate('${end}')`;
  const w30 = `timestamp >= toDate('${start30}') and timestamp < toDate('${end}')`;
  return { asof, end, start14, start30, w14, w30 };
}

// The metrics bag definitions, parameterized by the resolved windows. Each
// entry is a { label, sql } pair; results are stored under a stable key so the
// report builder never re-derives the query. The KPIs mirror GeoParty's but
// speak Flag Reveal's mechanics: rooms are created via front_door_create,
// engagement is teams/rings/rounds, and the core experiment signal is ring
// health (are correct buzzes colliding?) + round outcome (win vs bust).
export function buildMetrics(windows) {
  const W14 = windows.w14;
  const W30 = windows.w30;
  return {
    core_30d: {
      label: "Core volumes (30d)",
      sql: `select
        countIf(event='front_door_create') created,
        countIf(event='team_joined') teams,
        countIf(event='flag_round') rounds,
        countIf(event='flag_ring') rings,
        count(distinct distinct_id) players
        from events where ${W30}`,
    },
    mode_mix_30d: {
      label: "Mode mix (30d)",
      sql: `select properties.mode,
        countIf(event='front_door_create'),
        countIf(event='flag_round'),
        countIf(event='flag_ring')
        from events where ${W30}
        and event in ('front_door_create','flag_round','flag_ring')
        group by properties.mode order by properties.mode`,
    },
    funnel_14d: {
      label: "Party funnel (14d)",
      sql: `select event, count() from events where ${W14} and event in
        ('front_door_join','team_joined','flag_round','next_game')
        group by event order by count() desc`,
    },
    ring_health_14d: {
      label: "Ring health (14d)",
      sql: `select
        countIf(properties.correct=true) correct,
        countIf(properties.correct=false) wrong,
        round(avg(toFloat64OrNull(properties.atStep)),1) avg_step,
        round(median(toFloat64OrNull(properties.atStep)),1) median_step,
        countIf(properties.contested=true) contested,
        count() total
        from events where ${W14} and event='flag_ring'`,
    },
    round_outcome_14d: {
      label: "Round outcome (14d)",
      sql: `select
        countIf(properties.outcome='won') won,
        countIf(properties.outcome='busted') busted,
        round(avg(toFloat64OrNull(properties.winningStep)),1) avg_winning_step,
        count() total
        from events where ${W14} and event='flag_round'`,
    },
    daily_30d: {
      label: "Daily challenge funnel (30d)",
      sql: `select
        countIf(event='daily_started'),
        countIf(event='daily_completed'),
        countIf(event='share_daily')
        from events where ${W30}`,
    },
    share_party_30d: {
      label: "Party share (30d)",
      sql: `select count() from events where ${W30}
        and event='share_party'`,
    },
    tv_attach_14d: {
      label: "TV attach by via (14d)",
      sql: `select properties.via, count() from events where ${W14}
        and event='screen_joined' group by properties.via order by count() desc`,
    },
    exceptions_14d: {
      label: "Exception signatures (14d)",
      sql: `select properties.$exception_functions, properties.$exception_handled,
        count(), count(distinct properties.$current_url)
        from events where ${W14} and event='$exception'
        group by properties.$exception_functions, properties.$exception_handled
        order by count() desc`,
    },
    consent_30d: {
      label: "Consent (30d)",
      sql: `select
        countIf(event='consent_given'),
        countIf(event='consent_denied')
        from events where ${W30}`,
    },
  };
}

async function main(argv) {
  const outIdx = argv.indexOf("--out");
  let outFile = null;
  if (outIdx >= 0) {
    outFile = argv[outIdx + 1];
    if (!outFile || outFile.startsWith("--")) {
      console.error("posthog_metrics: --out requires a file path");
      return 1;
    }
  }

  const asofIdx = argv.indexOf("--asof");
  let asof;
  try {
    asof = resolveAsof(asofIdx >= 0 ? argv[asofIdx + 1] : null);
  } catch (e) {
    console.error(`posthog_metrics: ${e.message}`);
    return 1;
  }

  const windows = buildWindows(asof);
  const METRICS = buildMetrics(windows);

  const bag = {
    generated_at: new Date().toISOString(),
    asof,
    project: PROJECT,
    window: {
      asof,
      end: windows.end,
      start14: windows.start14,
      start30: windows.start30,
    },
    ok: true,
    errors: [],
    metrics: {},
  };

  for (const [key, def] of Object.entries(METRICS)) {
    const rows = await query(def.sql);
    if (rows && !rows.error) {
      bag.metrics[key] = { label: def.label, rows };
    } else {
      bag.metrics[key] = { label: def.label, error: true };
      bag.errors.push(key);
    }
  }
  bag.ok = bag.errors.length === 0;

  const output = JSON.stringify(bag, null, 2);
  if (outFile) {
    writeFileSync(outFile, output);
    const suffix = bag.ok ? "" : ` (with ${bag.errors.length} failed quer${bag.errors.length === 1 ? "y" : "ies"})`;
    console.log(`posthog_metrics: wrote ${outFile}${suffix}`);
  } else {
    process.stdout.write(output + "\n");
  }

  if (!bag.ok) {
    console.error(`posthog_metrics: FAILED queries: ${bag.errors.join(", ")}`);
  }
  return bag.ok ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith("posthog_metrics.mjs")) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

export { main };
