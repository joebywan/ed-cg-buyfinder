// "There is a newer version" - and nothing more than that. A port of the old
// app's update.py.
//
// Deliberately not an updater: this asks GitHub for the latest release tag,
// compares it with the running version, and hands the answer back. Fetching
// the new build is the user's click, in their own browser.
//
// It is also deliberately quiet: one request at startup, no poller and no
// nag, and any failure at all is silence, not a message.

export const OWNER_REPO = "joebywan/ed-cg-buyfinder";

// /releases/latest skips drafts and pre-releases, so the rolling `snapshot`
// release that every push to main refreshes is invisible here - which is what
// we want. A snapshot user is told about stable releases, not about snapshots.
export const RELEASES_API = `https://api.github.com/repos/${OWNER_REPO}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${OWNER_REPO}/releases/latest`;

/** 'v1.10' -> [1, 10]. null if it is not a plain dotted number.
 *
 *  Strict on purpose: this decides whether to interrupt someone, and an
 *  unparseable tag should say nothing rather than guess. */
export function parseVersion(text) {
  if (typeof text !== "string") return null;
  const parts = text.trim().replace(/^[vV]/, "").split(".");
  if (parts.length > 4) return null;
  if (!parts.every((p) => /^\d+$/.test(p))) return null;   // rejects "", "1a", "-1" and "1 "
  return parts.map(Number);
}

/** Is `latest` a higher version than `current`?
 *
 *  String comparison gets this wrong at 1.10 vs 1.9, which is the whole
 *  reason this is not `latest > current`. Unparseable either side is false:
 *  never nag on something we do not understand. */
export function isNewer(latest, current) {
  const a = parseVersion(latest), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {   // 1.5.1 beats 1.5, and 1.5 ties 1.5.0
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/** The newer version as a bare string ('1.6'), or null to say nothing.
 *
 *  Never throws. Offline, rate-limited, GitHub down, a tag in a shape we do
 *  not parse - all of it is null, because a background courtesy check has no
 *  business surfacing an error. `fetchJson` is injected so the tests never
 *  open a socket. */
export async function checkForUpdate(current, fetchJson) {
  try {
    const tag = (await fetchJson(RELEASES_API))?.tag_name;
    return parseVersion(tag) && isNewer(tag, current) ? tag.replace(/^[vV]/, "") : null;
  } catch {
    return null;
  }
}
