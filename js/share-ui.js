// share-ui.js — browser glue for the result-share card (the Daily result and
// the party game-over). The card text is built by share.js (pure, tested); this
// file only moves it to the clipboard / Web-Share sheet and emits the aggregate
// share event behind the consent gate. Same ladder everywhere: the Web Share
// sheet where the platform has one, the clipboard otherwise, and — if both are
// blocked — the text lands in the toast so it can be copied by hand.

import { track } from "./consent.js";
import { shareToastText } from "./share.js";

// text: the finished card (link included). opts.event: the analytics event to
// emit ("share_daily" | "share_party"); opts.props: its aggregate properties
// (score/streak/points — never free text); opts.toast: the page's toast fn.
export async function shareText(text, { event, props = {}, toast }) {
  if (navigator.share) {
    try {
      await navigator.share({ text });
      track(event, { ...props, method: "share" });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return; // user closed the sheet
      // Share sheet unavailable/failed: fall through to the clipboard.
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    if (toast) toast(shareToastText());
    track(event, { ...props, method: "copy" });
  } catch {
    if (toast) toast(text); // clipboard blocked: at least show what to send
  }
}
