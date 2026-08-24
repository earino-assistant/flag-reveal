// share.js — pure share-artifact logic for Flag Reveal. The post-game result
// card is a clipboard string, no backend. Two shapes: the party brag
// ("we hit 4,200 pts") and the Wordle-style daily grid (one square per flag,
// graded by how fast it was named). Every link the card carries is UTM-tagged
// so PostHog can attribute new-room arrivals back to a shared card — the tag
// names a source and a campaign, never a person. No DOM in here; the clipboard
// / Web-Share glue lives in share-ui.js.
//
// Privacy (CLAUDE.md): the daily grid encodes only a felt-quality bucket per
// round (fast / slow / missed) — it never carries an answer ISO or a country
// name. The party brag carries the user's own points and, at their choice, the
// winning team's name (user-entered, never a country) — analytics stays
// aggregate-only regardless (share_party / share_daily emit no free text).

/* ================================================================
 * UTM tagging. utm_source=share marks "arrived via a result card";
 * utm_campaign says which card ("daily" | "party"). PostHog reads
 * utm_* off the landing URL automatically — no code here reads them.
 * ================================================================ */

export const UTM_SOURCE = "share";

export function withUtm(href, campaign) {
  const url = new URL(href);
  url.searchParams.set("utm_source", UTM_SOURCE);
  url.searchParams.set("utm_campaign", campaign);
  return url.href;
}

/* ================================================================
 * The party card. The brag is the room's winning score; the winner's
 * (user-entered) team name is optional flair, deliberately never a
 * country name. `url` should already be UTM-tagged by the caller.
 * ================================================================ */

// "Flag Party 🚩 The Cartographers hit 4,200 pts — beat us: <url>"
// winner omitted → "we hit …". points defaults to 0 (an all-bust game still
// gets a shareable card).
export function partyShareText({ winner, points = 0, url }) {
  const who = winner ? `${winner} hit` : "we hit";
  const pts = Number(points) || 0;
  return `Flag Party 🚩 ${who} ${pts.toLocaleString()} pts — beat us: ${url}`;
}

/* ================================================================
 * The daily card: puzzle number, streak + score, and the emoji row —
 * one square per round, graded by the reveal step it was named at.
 * The row is the Wordle grid: legible at a glance in any chat, and it
 * spoils nothing (no flag, no country, just a felt-quality tier).
 * ================================================================ */

// Felt-quality tiers, NOT score math: 🟩 named it fast (early in the reveal),
// 🟨 named it slower, 🟥 never named it (wrong or timed out). The green cutoff
// is a fraction of the reveal depth so the buckets track "how much flag did you
// need", independent of the exact step count.
export const GREEN_MAX_FRACTION = 0.375; // ≤ step 3 of 8 → 🟩
export const EMOJI_FAST = "🟩";
export const EMOJI_SLOW = "🟨";
export const EMOJI_MISS = "🟥";

// One round's square. round is { correct, atStep }; steps is the reveal depth.
export function roundEmoji(round, steps = 8) {
  if (!round || !round.correct || typeof round.atStep !== "number") return EMOJI_MISS;
  return round.atStep <= steps * GREEN_MAX_FRACTION ? EMOJI_FAST : EMOJI_SLOW;
}

// rounds is a daily run's rounds array ({correct, atStep}).
export function emojiRow(rounds, steps = 8) {
  return (rounds || []).map((r) => roundEmoji(r, steps)).join("");
}

// The daily card:
//   line 1  header — "Flag Party Daily #N", 🔥streak (a 🔥1 is noise), score
//   line 2  the emoji grid
//   line 3  the link (UTM-tagged by the caller)
export function dailyShareText({ dayNumber, score = 0, rounds, url, streak = 0, steps = 8 }) {
  const flair = streak >= 2 ? `🔥${streak}` : "🚩";
  const pts = (Number(score) || 0).toLocaleString();
  const first = `Flag Party Daily #${dayNumber} ${flair} · ${pts} pts`;
  return `${first}\n${emojiRow(rounds, steps)}\nBeat me: ${url}`;
}

// The clipboard-fallback toast text (share-ui.js).
export function shareToastText() {
  return "Result copied 📋";
}
