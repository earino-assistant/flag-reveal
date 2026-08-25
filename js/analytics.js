// analytics.js — pure analytics core for Flag Reveal: consent state, the event
// schema (a HARD allowlist), and the PostHog gating logic. No DOM, no network in
// here (same discipline as flag.js) — the browser glue lives in consent.js, and
// everything in this file is unit-tested in tests/analytics.test.js.
//
// Modeled on GeoParty's analytics.js, reduced to what Flag Reveal needs (no
// imagery/replay-map machinery). Privacy invariants (CLAUDE.md, SPEC §12/§13):
//   - Nothing is captured, and PostHog is never even LOADED, before the user
//     explicitly accepts (GDPR opt-in).
//   - Every event goes through a per-event property allowlist: unknown events
//     are dropped, unknown/banned/badly-typed properties stripped. Country
//     names, ISO codes as free strings, team names and room codes can never
//     leave the device — only aggregates and bare slot ids (tN).

/* ================================================================
 * PostHog project config (public embeddable key, EU-resident instance —
 * same trust model as the Firebase keys in config.js). Flag Reveal's OWN
 * project — NOT the shared GeoParty key (see tests/analytics.test.js, which
 * guards against reverting to it).
 * ================================================================ */

export const POSTHOG_PROJECT_KEY =
  "phc_tjYdfjtT6Ve8ywyLe8jrJBpzzxsyCTit6p3KXspbqvEG";

// A minimal, safe URL scrub: drop the query string and collapse long digit runs
// (ids) so nothing route-identifying rides on a captured URL. Pure.
export function scrubUrl(url) {
  if (typeof url !== "string") return url;
  return url.split(/[?#]/)[0].replace(/\d{4,}/g, "…");
}

// before_send hook: scrub URL-shaped properties on every outgoing event. Never
// returns null — dropping stays the schema's job (sanitizeEvent).
const URL_PROPS = Object.freeze([
  "$current_url", "$pathname", "$referrer", "$referring_domain",
  "$initial_current_url", "$initial_pathname", "$initial_referrer",
  "$session_entry_url", "$session_entry_pathname", "$session_entry_referrer",
]);
export function sanitizeBeforeSend(event) {
  if (!event || !event.properties) return event;
  const props = event.properties;
  for (const key of URL_PROPS) {
    if (typeof props[key] === "string") props[key] = scrubUrl(props[key]);
  }
  return event;
}

// Deliberately NOT frozen: posthog.init() mutates the options object it is given
// (writes defaults like `debug`), so a frozen object makes init throw and
// analytics silently stay off. tests/analytics.test.js asserts extensibility.
export const POSTHOG_INIT_OPTIONS = {
  api_host: "https://eu.i.posthog.com",
  defaults: "2026-05-30",
  person_profiles: "identified_only",
  // Autocapture restricted to button/link clicks: their labels are static UI
  // strings. Team names and room codes live in headings/list items, which
  // autocapture must never lift into $el_text.
  autocapture: { element_allowlist: ["button", "a"] },
  session_recording: {
    maskAllInputs: true, // nothing typed, ever (team names, room codes, guesses)
    // Team names + room codes in the UI are tagged data-ph-mask (SPEC §13,
    // docs/replay-mask-checklist.md).
    maskTextSelector: "[data-ph-mask]",
    blockSelector: "[data-ph-block]",
    captureCanvas: false,
    recordHeaders: false,
    recordBody: false,
  },
  before_send: sanitizeBeforeSend,
};

// The posthog-js bundle, loaded directly (no inline snippet — CSP-friendlier,
// and nothing runs before consent). EU assets host per the official snippet.
export const POSTHOG_SCRIPT_URL =
  "https://eu-assets.i.posthog.com/static/array.js";

/* ================================================================
 * Consent flag (the only thing we store before opt-in)
 * ================================================================ */

export const CONSENT_KEY = "flagreveal_analytics_consent";
export const CONSENT_ACCEPTED = "accepted";
export const CONSENT_DECLINED = "declined";

// storage is localStorage-shaped ({getItem,setItem}); anything but the two exact
// legal values (missing, tampered, legacy) reads as "not chosen yet".
export function getConsent(storage) {
  let raw = null;
  try {
    raw = storage.getItem(CONSENT_KEY);
  } catch {
    return null;
  }
  return raw === CONSENT_ACCEPTED || raw === CONSENT_DECLINED ? raw : null;
}

export function setConsent(storage, value) {
  if (value !== CONSENT_ACCEPTED && value !== CONSENT_DECLINED) {
    throw new TypeError(`invalid consent value: ${value}`);
  }
  try {
    storage.setItem(CONSENT_KEY, value);
  } catch {
    /* private mode */
  }
}

/* ================================================================
 * Event schema — the single source of truth for what we may send.
 * Docs: docs/analytics.md. Property types:
 *   "string" — short string (slot ids, mode, difficulty, roundKey), ≤40 chars
 *   "int"    — finite number, rounded to an integer
 *   "float1" — finite number, rounded to one decimal
 *   "bool"   — strictly boolean; anything else is stripped, not coerced
 * ================================================================ */

export const EVENT_SCHEMA = Object.freeze({
  // Landing → routing.
  front_door_join: { mode: "string" },
  front_door_create: { mode: "string" },
  // A team claimed a slot in the lobby.
  team_joined: { mode: "string", team_count: "int" },
  // The TV attached (screen.html). via ∈ "typed" | "link" | "qr".
  screen_joined: { mode: "string", via: "string" },

  // Daily Challenge (solo, single-device). Aggregates only — the day number is
  // a public counter (Daily #N), never a date-of-play identifier, and no flag
  // ISO or country name ever rides here.
  daily_started: { dayNumber: "int" },
  daily_completed: {
    dayNumber: "int",
    score: "int",
    correct: "int", // rounds named out of DAILY_ROUNDS
    streak: "int",
  },

  // A finished result copied/shared. method ∈ "share" | "copy". Never the emoji
  // grid text, never a country name — only the aggregate score/streak.
  share_daily: {
    dayNumber: "int",
    score: "int",
    rounds: "int",
    streak: "int",
    method: "string",
  },
  share_party: { mode: "string", points: "int", method: "string" },

  // flag_ring — one per ring, emitted by the RINGING phone (SPEC §12). Dedup
  // downstream on (roundKey, team, correct) to reconstruct ringCount. team is a
  // bare slot id (tN), which CLAUDE.md explicitly permits. No country names, no
  // ISO codes as free strings, no team names.
  flag_ring: {
    mode: "string",
    team: "string", // tN slot id — distinguishes players (v3.1 dedup key)
    atStep: "int",
    correct: "bool",
    points: "int",
    contested: "bool", // correct ring that lost the race to a rival win
    difficulty: "string",
    inputMode: "string",
    guessMode: "string", // "single" (lockout) | "multi" (multiple guesses)
    roundKey: "string", // truncated hash(gameSeed, number) — not identifying
  },

  // flag_round — one per round at reveal, emitted by the phone whose
  // resolveRound transaction COMMITTED (at-most-once, SPEC §12). outcome ∈
  // "won" | "busted"; winningStep is null on a bust (dropped by the sanitizer).
  flag_round: {
    mode: "string",
    outcome: "string",
    winningStep: "int",
    ringCount: "int", // best-effort local count; canonical count is downstream
    difficulty: "string",
    inputMode: "string",
    guessMode: "string", // "single" (lockout) | "multi" (multiple guesses)
    roundNumber: "int",
    roundKey: "string",
  },

  consent_given: {},
  consent_denied: {},
  next_game: { mode: "string" },
});

// Defense in depth: even if a call site (or a future schema edit) tries to pass
// location-ish or identity-ish data, these key patterns are stripped before the
// allowlist is consulted. Note "iso"/country-name-shaped keys are also refused
// here so no ISO code or country name can ride as a free string.
const BANNED_KEY_RE =
  /lat|lng|lon|coord|name|email|device|user|iso|country|room|code|guess$|answer/i;
const STRING_MAX = 40;

// Sanitize a props bag against an allowlist (an EVENT_SCHEMA entry). Unknown
// keys never survive: we iterate the ALLOWLIST, not the input.
export function sanitizeProps(schema, props) {
  const clean = {};
  const src = props || {};
  for (const key of Object.keys(schema)) {
    if (BANNED_KEY_RE.test(key)) continue;
    const v = src[key];
    const type = schema[key];
    if (type === "string") {
      if (typeof v === "string" && v.length > 0 && v.length <= STRING_MAX) {
        clean[key] = v;
      }
    } else if (type === "bool") {
      if (typeof v === "boolean") clean[key] = v;
    } else if (typeof v === "number" && Number.isFinite(v)) {
      clean[key] = type === "float1" ? Math.round(v * 10) / 10 : Math.round(v);
    }
  }
  return clean;
}

// Validate one (event, props) pair against the schema. Returns { event, props }
// with only clean allowlisted properties, or null when the event itself is
// unknown — callers drop nulls silently.
export function sanitizeEvent(event, props) {
  const schema = EVENT_SCHEMA[event];
  if (!schema) return null;
  return { event, props: sanitizeProps(schema, props) };
}

/* ================================================================
 * The gated tracker. All effects are injected so this is testable:
 *   storage     — localStorage-shaped
 *   loadPosthog — (projectKey, initOptions) => Promise<posthog-like>; the
 *                 browser impl injects the script tag and inits.
 * Nothing calls loadPosthog until consent is CONSENT_ACCEPTED.
 * ================================================================ */

const QUEUE_MAX = 100; // events buffered while the script is in flight

export function createAnalytics({ storage, loadPosthog }) {
  let posthog = null;
  let loadPromise = null;
  let optedOut = false;
  const queue = [];

  const consent = () => getConsent(storage);

  function flushQueue() {
    while (queue.length && posthog) {
      const item = queue.shift();
      posthog.capture(item.event, item.props);
    }
  }

  function ensureLoaded() {
    if (!loadPromise) {
      loadPromise = Promise.resolve()
        .then(() => loadPosthog(POSTHOG_PROJECT_KEY, POSTHOG_INIT_OPTIONS))
        .then((ph) => {
          posthog = ph || null;
          // Consent may have been revoked while the script was in flight: drop
          // the buffer and stop capturing instead of flushing it.
          if (consent() === CONSENT_ACCEPTED) {
            flushQueue();
          } else {
            queue.length = 0;
            if (posthog && posthog.opt_out_capturing) {
              posthog.opt_out_capturing();
              optedOut = true;
            }
          }
          return posthog;
        })
        .catch(() => {
          // Blocked network / ad blocker: analytics silently stays off.
          loadPromise = null;
          queue.length = 0;
          return null;
        });
    }
    return loadPromise;
  }

  return {
    consentState: consent,
    hasConsent: () => consent() === CONSENT_ACCEPTED,

    // Boot hook: resume capturing when a past session already opted in. Never
    // loads anything otherwise.
    init() {
      return consent() === CONSENT_ACCEPTED
        ? ensureLoaded()
        : Promise.resolve(null);
    },

    // Capture one product event. Returns true only when the event was accepted
    // for delivery (consent given AND the event passed the schema).
    track(event, props) {
      if (consent() !== CONSENT_ACCEPTED) return false;
      const clean = sanitizeEvent(event, props);
      if (!clean) return false;
      if (posthog) {
        posthog.capture(clean.event, clean.props);
      } else {
        if (queue.length < QUEUE_MAX) queue.push(clean);
        ensureLoaded();
      }
      return true;
    },

    // Handled failures → PostHog issues, behind the identical consent gate.
    // Flag Reveal has no imagery pipeline, so this is a thin captureException.
    trackError(error, props) {
      if (consent() !== CONSENT_ACCEPTED) return false;
      if (!error) return false;
      if (posthog && typeof posthog.captureException === "function") {
        posthog.captureException(error, props || {});
        return true;
      }
      ensureLoaded();
      return true;
    },

    // User accepted: persist, load PostHog (first time), record the choice.
    accept() {
      setConsent(storage, CONSENT_ACCEPTED);
      return ensureLoaded().then((ph) => {
        if (!ph) return null;
        // Decline always wins a race: re-check the stored flag before acting.
        if (consent() !== CONSENT_ACCEPTED) return null;
        if (optedOut && ph.opt_in_capturing) {
          ph.opt_in_capturing();
          optedOut = false;
        }
        ph.capture("consent_given", {});
        return ph;
      });
    },

    // User declined (or revoked). A first-time decline records nothing —
    // PostHog was never loaded. A revoke after acceptance sends one final
    // consent_denied so the opt-out shows up, then stops all capturing.
    decline() {
      const wasAccepted = consent() === CONSENT_ACCEPTED;
      setConsent(storage, CONSENT_DECLINED);
      if (wasAccepted && posthog) {
        posthog.capture("consent_denied", {});
        if (posthog.opt_out_capturing) {
          posthog.opt_out_capturing();
          optedOut = true;
        }
      }
    },
  };
}
