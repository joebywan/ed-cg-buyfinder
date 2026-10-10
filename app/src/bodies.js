// Which body an orbital station is parked above.
//
// Ardent records a body for every station on a surface and almost none of the
// ones in orbit - measured around Ega: 107 of 107 surface stations, but 16 of
// 391 Outposts and 18 of 88 Coriolis. That is the same asymmetry the desktop
// app hits with Spansh, and the same answer: EDSM has both, and unlike Spansh
// it lets a web page read it.
//
// So this is only ever asked for a row someone actually pointed at. One
// request answers a whole system, so the first hover pays for every other row
// in the same place.

import { edsmGate } from "./edsm.js";

export const EDSM_STATIONS = "https://www.edsm.net/api-system-v1/stations";

async function defaultFetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`),
    { status: res.status, retryAfter: res.headers.get("retry-after") });
  return res.json();
}

/**
 * A per-system cache of station -> body, filled on demand.
 *
 * `onResolved(system)` fires when a system's answer lands, so whatever is on
 * screen can be told. Lookups are serialised: EDSM throttles hard, and a
 * pointer run down forty rows must not become forty requests.
 */
export class BodyLookup {
  constructor({ fetchJson = defaultFetchJson, onResolved = null, gate = edsmGate } = {}) {
    this.gate = gate;
    this.fetchJson = fetchJson;
    this.onResolved = onResolved;
    this.cache = new Map();      // system -> Map(station -> body)
    this.pending = new Set();    // systems asked for and not yet answered
    this.queue = [];
    this.running = false;
  }

  /** The body, "" when EDSM has none, or undefined when nobody has asked. */
  known(system, station) {
    const found = this.cache.get(system);
    if (!found) return undefined;
    return found.get(station) ?? "";
  }

  /** Is an answer for this system on its way? */
  waiting(system) {
    return this.pending.has(system);
  }

  /** Ask for a system, at most once. Safe to call on every pointer move. */
  want(system) {
    if (!system || this.cache.has(system) || this.pending.has(system)) return;
    this.pending.add(system);
    this.queue.push(system);
    this.#drain();
  }

  async #drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const system = this.queue.shift();
        let found = new Map();
        try {
          // Shares EDSM's pacing and pauses with searches, behind their requests.
          const d = await this.gate.request(this.fetchJson,
            `${EDSM_STATIONS}?systemName=${encodeURIComponent(system)}`, { low: true });
          for (const st of d?.stations ?? []) {
            const body = st?.body?.name;
            if (body) found.set(st.name, body);
          }
        } catch {
          // Cached as "asked, nothing there" rather than retried. A tooltip
          // is not worth hammering a throttled API over.
          found = new Map();
        }
        this.cache.set(system, found);
        this.pending.delete(system);
        this.onResolved?.(system);
      }
    } finally {
      this.running = false;
    }
  }
}
