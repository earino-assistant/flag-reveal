// consent.js — GDPR opt-in gate + PostHog bootstrap, shared by every page
// (index, player, screen, howto). All logic lives in analytics.js (pure,
// tested); this module is only the browser glue, modeled on GeoParty's:
//   - renders the consent banner for first-time visitors,
//   - injects the PostHog script ONLY after an explicit accept,
//   - exports openBanner() so a footer "Privacy" link can reopen it later,
//   - exports track()/trackError() for the UI modules to instrument with.
// Docs: docs/analytics.md. Consent gating is inviolable (CLAUDE.md, SPEC §13):
// never reference PostHog outside this file, never capture pre-opt-in.

import {
  createAnalytics,
  getConsent,
  CONSENT_ACCEPTED,
  POSTHOG_SCRIPT_URL,
} from "./analytics.js";

// Inject posthog-js directly (no inline snippet). Called at most once per page,
// and never before an explicit accept. Injecting the bundle captures nothing on
// its own: only init() starts anything.
let scriptPromise = null;
function injectPosthogScript() {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    if (window.posthog) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = POSTHOG_SCRIPT_URL;
    s.async = true;
    s.crossOrigin = "anonymous";
    s.onload = () => resolve();
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error("PostHog script failed to load"));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

function loadPosthogScript(projectKey, initOptions) {
  return injectPosthogScript().then(() => {
    if (!window.posthog.__loaded) {
      window.posthog.init(projectKey, initOptions);
    }
    return window.posthog;
  });
}

const analytics = createAnalytics({
  storage: window.localStorage,
  loadPosthog: loadPosthogScript,
});

// The functions feature code calls. Safe anywhere: without consent (or with a
// bad event/props shape) they are validated no-ops.
export const track = (event, props) => analytics.track(event, props);
export const trackError = (error, props) => analytics.trackError(error, props);
export const hasAnalyticsConsent = () => analytics.hasConsent();

/* ================================================================
 * Banner (injected — page HTML untouched)
 * ================================================================ */

let banner = null;

function ensureBanner() {
  if (banner) return banner;
  banner = document.createElement("div");
  banner.id = "consentBanner";
  banner.className = "consent-banner";
  banner.setAttribute("role", "dialog");
  banner.setAttribute("aria-label", "Share anonymous play stats?");

  const text = document.createElement("p");
  const lead = document.createElement("strong");
  lead.textContent = "\u{1F3F3}️ Share anonymous play stats?";
  text.append(
    lead,
    " When rounds are rung, busted or won, plus the difficulty and mode — so we ",
    "can see whether players actually race each other. Never your guesses, the ",
    "countries, your team names, or the room code. EU-hosted, change anytime.",
  );
  const status = document.createElement("span");
  status.className = "consent-status";
  text.appendChild(status);

  const actions = document.createElement("div");
  actions.className = "consent-actions";
  const decline = document.createElement("button");
  decline.id = "consentDecline";
  decline.textContent = "No thanks";
  const accept = document.createElement("button");
  accept.id = "consentAccept";
  accept.className = "btn-primary";
  accept.textContent = "Sounds good";
  actions.append(decline, accept);

  banner.append(text, actions);

  accept.addEventListener("click", () => {
    analytics.accept();
    closeBanner();
  });
  decline.addEventListener("click", () => {
    analytics.decline();
    closeBanner();
  });

  document.body.appendChild(banner);
  return banner;
}

export function openBanner() {
  const el = ensureBanner();
  const status = el.querySelector(".consent-status");
  const consent = getConsent(window.localStorage);
  status.textContent = consent
    ? ` Sharing is ${consent === CONSENT_ACCEPTED ? "on" : "off"}.`
    : "";
  el.classList.remove("hidden");
}

function closeBanner() {
  if (banner) banner.classList.add("hidden");
}

/* Boot.
 * Returning visitors get their prior choice honored immediately (init() only
 * loads PostHog if they had accepted). First-timers get the banner; nothing
 * loads or fires before an explicit accept. A player who never chooses is
 * simply never captured — the privacy-safe outcome by construction. */
if (getConsent(window.localStorage) === null) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", openBanner, { once: true });
  } else {
    openBanner();
  }
} else {
  analytics.init();
}
