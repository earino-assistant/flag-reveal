// roomcode.js — room-code generation + validation (reused verbatim from the
// GeoParty kernel, spec §1.1). Six uppercase letters, no I or O (they read
// ambiguously on a TV). Pure/glue-light: `makeRoomCode` uses Math.random (a
// fresh code is not a determinism-sensitive value), `isValidRoomCode` is pure.

// No I, no O.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";

export function makeRoomCode() {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

export function isValidRoomCode(code) {
  return /^[A-HJ-NP-Z]{6}$/.test(String(code || "").toUpperCase());
}

// A stable per-browser device id, minted once and persisted. Identifies a
// player's phone across refreshes so `claimTeamSlot`/resume can recognise the
// same device (spec §1.1/§5). Never sent to analytics (it matches BANNED_KEY_RE).
const DEVICE_KEY = "flagreveal_device";
export function deviceId() {
  let id = null;
  try {
    id = window.localStorage.getItem(DEVICE_KEY);
  } catch {
    /* private mode */
  }
  if (!id) {
    id = "d-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try {
      window.localStorage.setItem(DEVICE_KEY, id);
    } catch {
      /* private mode: a per-load id is still usable within the session */
    }
  }
  return id;
}
