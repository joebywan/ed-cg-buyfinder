// Market discovery through Spansh, re-checked against EDSM. A port of
// fetch_sources / verify.py / build_rows from cgbuy; produces exactly the
// rows and result shape ardent.js's buildRows does, so the two can be swapped.
//
// Spansh sends no CORS headers, so a plain browser cannot call it: pass
// Tauri's http fetch as `fetchJson` (url, init) => parsed JSON, throwing an
// Error with a numeric `.status` on HTTP failure (defaultFetchJson does).
import { MAX_AGE_DEFAULT, tripMinutes } from "./model.js";
import { ageFilter } from "./ardent.js";
import { log, loggedFetch } from "./log.js";
import { edsmGate } from "./edsm.js";

export const SPANSH_SEARCH = "https://spansh.co.uk/api/stations/search";
export const EDSM_STATIONS = "https://www.edsm.net/api-system-v1/stations?systemName=";
export const EDSM_MARKET = "https://www.edsm.net/api-system-v1/stations/market";

const PARALLEL = 6;
const VERIFY_TOP_DEFAULT = 18;   // stations re-checked against EDSM per search
const EDSM_BUDGET = 40;          // requests per search, so one cannot exhaust the limit
const PAGES_GUESS = 2;           // pages per commodity assumed before it finishes

// Spansh sheds load rather than queueing: six concurrent searches against it
// will draw 502s from its proxy on a busy evening. The same call a moment
// later works, so a failed page is worth asking for again before a whole
// commodity is written off.
const RETRY_CODES = [429, 500, 502, 503, 504];
const RETRY_ATTEMPTS = 3;
const RETRY_PAUSE = 1500;        // ms before the first retry, doubling after

const round1 = (x) => Math.round(x * 10) / 10;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function defaultFetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} from ${new URL(url).host}`),
    { status: res.status, retryAfter: res.headers?.get?.("retry-after") });
  return res.json();
}

/** A busy server or a dropped connection, not a bad question. A 400 means
 the payload is wrong - asking again cannot fix that and only costs the other
 commodities their share of the server. */
export function worthRetrying(err) {
  return err.status ? RETRY_CODES.includes(err.status) : true;
}

/**
 * Every market within maxLy that stocks `commodity`.
 *
 * Spansh caps results per request, so page through until we run past the
 * radius. A single fixed page silently drops most candidates.
 *
 * `onPage(page, got, retryInMs)` reports each request: got is null while it
 * is out or backing off (retryInMs set), else the number of results.
 *
 * `onFail(commodity, page, error)` is called when a page is given up on.
 * Page 0 failing means this commodity contributed nothing at all, which the
 * caller must not discover by finding no rows - an empty answer and an
 * unanswered question have to look different, or a ranking quietly drops a
 * quarter of the goal and says it covered all of it.
 */
export async function fetchSources(commodity, maxLy, minSupply, referenceSystem,
    { fetchJson = defaultFetchJson, pageSize = 500, maxPages = 10, onFail = null,
      onPage = null, attempts = RETRY_ATTEMPTS, pause = RETRY_PAUSE, sleep = sleepMs } = {}) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const body = JSON.stringify({
      filters: {
        distance: { comparison: "<=>", value: [0, maxLy] },
        market: [{ name: commodity, supply: { comparison: "<=>", value: [minSupply, 100000000] } }],
      },
      sort: [{ distance: { direction: "asc" } }],
      size: pageSize, page, reference_system: referenceSystem,
    });
    let res = null;
    let err = null;
    onPage?.(page, null);
    for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
      try {
        res = (await fetchJson(SPANSH_SEARCH, { method: "POST", body,
          headers: { "Content-Type": "application/json" } }))?.results ?? [];
        break;
      } catch (e) {
        err = e;
        if (attempt + 1 < attempts && worthRetrying(e)) {
          onPage?.(page, null, pause * 2 ** attempt);
          await sleep(pause * 2 ** attempt);
        } else break;
      }
    }
    // A dropped connection must not abort every other commodity.
    if (res === null) { onFail?.(commodity, page, err); break; }
    out.push(...res);
    onPage?.(page, res.length);
    if (res.length < pageSize || (res.at(-1).distance ?? 0) > maxLy) break;
  }
  return out;
}

/** Largest pad a station has, "L"|"M"|"S", or "" when Spansh gave no counts. */
export function stationPad(st) {
  return st.large_pads || st.has_large_pad ? "L" : st.medium_pads ? "M" : st.small_pads ? "S" : "";
}

/** Can a ship needing `pad` ("S"|"M"|"L") land here? Spansh reports per-size
 pad counts, and a large pad accepts any ship, so it counts toward every size. */
export function stationFits(st, pad) {
  const large = st.large_pads || (st.has_large_pad ? 1 : 0);
  if (pad === "L") return !!large;
  if (pad === "M") return !!(large || st.medium_pads);
  return !!(large || st.medium_pads || st.small_pads);
}

/** EDSM client: paced and paused by the shared gate, cached for the life of
 one search. `opts` ({onWait, cancelled}) is read at call time. */
function edsmClient(fetchJson, gate, opts) {
  const cache = new Map();
  const get = (url) => gate.request(fetchJson, url, opts);
  const cached = async (key, url) => {
    if (!cache.has(key)) cache.set(key, await get(url));
    return cache.get(key);
  };
  return {
    system: (s) => cached(`s/${s}`, EDSM_STATIONS + encodeURIComponent(s)),
    market: (s, n) => cached(`m/${s}/${n}`,
      `${EDSM_MARKET}?systemName=${encodeURIComponent(s)}&stationName=${encodeURIComponent(n)}`),
  };
}

/** Recompute the derived figures after EDSM corrects supply or price. */
function rescore(r, hold, cgLs, p, cal) {
  r.profit_per_t = r.sell - r.buy;
  r.load = Math.min(r.supply, hold);
  r.loads_available = round1(r.supply / hold);
  const mins = tripMinutes(r.ly, r.ls, cgLs, p.jump_empty, p.jump_laden, cal);
  r.trip_minutes = round1(mins);
  r.trip_profit = r.load * r.profit_per_t;
  r.cr_per_min = Math.round(r.load * r.profit_per_t / mins);
  r.t_per_min = round1(r.load / mins);
}

/**
 * Correct the best few rows in place using EDSM, which follows EDDN live
 * while Spansh's station index lags by days (it once reported 530t of Gold
 * where the real figure was 18t). Deliberately narrow: only the stations you
 * might fly to are re-checked, capped by `budget` requests. Rows EDSM
 * confirmed get edsm=true; rows still waiting their turn have pending=true.
 * Each station is applied as soon as it is answered, then `onApply()` runs, so
 * a caller can show progress. `cancelled()` stops the loop. Returns
 * { checked, corrected }.
 */
export async function refresh(rows, edsm, { top = VERIFY_TOP_DEFAULT, budget = EDSM_BUDGET,
    onStation = null, onApply = null, cancelled = null } = {}) {
  const ranked = [...rows].sort((a, b) => b.cr_per_min - a.cr_per_min);
  const stations = [];
  const seen = new Set();
  for (const r of ranked) {
    const key = `${r.system}\n${r.station}`;
    if (!seen.has(key)) { seen.add(key); stations.push([r.system, r.station]); }
    if (stations.length >= top) break;
  }
  const spanshDates = new Map();
  for (const r of rows) {
    const k = `${r.system}\n${r.station}`;
    r.edsm = false;
    r.pending = seen.has(k);
    if (!spanshDates.has(k)) spanshDates.set(k, r.updated || "");
  }

  const times = {};     // system -> {station: market timestamp}
  const bodies = {};    // system -> {station: body name}
  let checked = 0;
  let corrected = 0;
  let spent = 0;
  let k = 0;
  for (const [sys, stn] of stations) {
    if (cancelled?.() || spent >= budget) break;
    onStation?.(k++, stations.length, stn);
    try {
      if (!times[sys]) {
        const d = await edsm.system(sys);
        spent++;
        times[sys] = {};
        bodies[sys] = {};
        for (const s of d?.stations ?? []) {
          if (s.updateTime?.market) times[sys][s.name] = s.updateTime.market;
          // Spansh names a body only for surface stations; EDSM has the
          // parent of an orbital one too, in this same payload.
          if (s.body?.name) bodies[sys][s.name] = s.body.name;
        }
      }
      const edsmTime = times[sys][stn];
      if (!edsmTime) continue;           // EDSM has no market record for this station
      // Only spend a request when EDSM is actually fresher than what Spansh
      // already told us. Saves most of the rate-limit budget.
      const spanshTime = spanshDates.get(`${sys}\n${stn}`);
      if (spanshTime && edsmTime.slice(0, 10) < spanshTime.slice(0, 10)) continue;
      const d = await edsm.market(sys, stn);
      spent++;
      checked++;
      const goods = Object.fromEntries((d?.commodities ?? []).map((c) =>
        [c.name, { buy: c.buyPrice ?? 0, supply: c.stock ?? 0 }]));
      for (const r of rows) {
        const m = r.system === sys && r.station === stn && goods[r.commodity];
        if (!m) continue;
        r.edsm = true;
        r.updated = edsmTime.slice(0, 10);
        if (!r.body && bodies[sys]?.[stn]) r.body = bodies[sys][stn];
        if (m.supply !== r.supply || m.buy !== r.buy) corrected++;
        r.supply = m.supply;
        r.buy = m.buy;
      }
    } catch (e) {
      if (e.cancelled) break;
      // one bad station must not stop the rest
    } finally {
      for (const r of rows) if (r.system === sys && r.station === stn) r.pending = false;
      onApply?.();
    }
  }
  for (const r of rows) r.pending = false;
  onStation?.(stations.length, stations.length);
  return { checked, corrected };
}

/**
 * Same contract as ardent.js's buildRows. `p` additionally honours
 * verify_edsm (default true) and verify_top (default 18). Destination prices
 * and arrival distance come from EDSM, as in cgbuy; `errors` also carries
 * commodities Spansh could not answer for, and EDSM trouble.
 *
 * Returns as soon as Spansh discovery is done, rows unconfirmed. Verification
 * carries on in the background (result.verifying resolves when it ends),
 * handing a fresh result to `onUpdate` after each station. `cancelled()` true
 * means a newer search took over: verification stops and stays silent.
 */
export async function buildRows(p, { fetchJson = defaultFetchJson, cal = null, now = new Date(),
                                      onProgress = null, sleep = sleepMs, gate = edsmGate,
                                      onUpdate = null, cancelled = null } = {}) {
  const dest = p.dest;
  const empty = { rows: [], cg: {}, cgLs: 0, hiddenStale: 0, allStale: false, errors: [] };
  if (!dest?.system || !dest?.station || !dest?.commodities?.length) return empty;

  fetchJson = loggedFetch(fetchJson);
  const verify = p.verify_edsm !== false;
  const top = p.verify_top ?? VERIFY_TOP_DEFAULT;
  const ncom = dest.commodities.length;
  // Spansh steps are pages: assume PAGES_GUESS per commodity until a commodity
  // finishes and its real count replaces the guess. EDSM steps: the two
  // destination lookups, then one per verified station.
  const pages = Object.fromEntries(dest.commodities.map((c) => [c, { n: 0, fin: false }]));
  let comDone = 0;
  let edsmDone = 0;
  let edsmTotal = verify ? 2 + top : 2;
  const emitS = (stage, detail) => {
    const v = Object.values(pages);
    onProgress?.({ provider: "spansh", stage, detail,
      done: v.reduce((a, x) => a + x.n, 0),
      total: v.reduce((a, x) => a + (x.fin ? x.n : Math.max(PAGES_GUESS, x.n + 1)), 0) });
  };
  const emitE = (stage, detail) => onProgress?.({ provider: "edsm", stage, detail,
    done: edsmDone, total: edsmTotal });
  emitS("discovery", "starting");
  emitE("destination", `reading ${dest.station} prices`);
  let discovering = true;
  const edsm = edsmClient(fetchJson, gate, { cancelled, onWait: (ms) => {
    const t = `rate limited - resuming in ${Math.ceil(ms / 1000)}s`;
    emitE("ratelimit", t);
    if (discovering) emitS("discovery", `waiting on EDSM (${t})`);
  } });
  // Any community-goal multiplier is already baked into what the station
  // reports, so it is never applied here.
  const mkt = await edsm.market(dest.system, dest.station);
  edsmDone++;
  const cg = {};
  for (const c of mkt?.commodities ?? []) {
    if (dest.commodities.includes(c.name)) cg[c.name] = { sell: c.sellPrice, demand: c.demand };
  }
  if (!Object.keys(cg).length) {
    throw new Error(`EDSM returned no market for ${dest.station} - station renamed?`);
  }
  let cgLs = 0;
  try {
    cgLs = ((await edsm.system(dest.system)).stations ?? [])
      .find((s) => s.name === dest.station)?.distanceToArrival || 0;
  } catch { /* arrival distance is only a trip-time input */ }
  edsmDone++;
  discovering = false;
  emitE(verify ? "waiting" : "done", verify ? "waiting for Spansh candidates" : "");

  const errors = [];
  let rows = [];
  await mapLimit(dest.commodities, PARALLEL, async (name) => {
    const sell = cg[name]?.sell;
    if (sell > 0) {
      const lost = [];
      const found = await fetchSources(name, p.range, p.min_supply, dest.system,
        { fetchJson, sleep, onFail: (c, page, err) => lost.push([page, err]),
          onPage: (page, got, retry) => {
            if (got !== null) pages[name].n = page + 1;
            emitS("discovery", got !== null ? `${name}, page ${page + 1} done (${comDone}/${ncom} commodities)`
              : retry ? `${name}, page ${page + 1} failed, retrying in ${retry / 1000}s`
              : `${name}, page ${page + 1} (${comDone}/${ncom} commodities)`);
          } });
      for (const [page, err] of lost) {
        errors.push(`${name}: Spansh failed${page ? ` on page ${page}` : ""}: ${err.message}`);
      }
      for (const st of found) {
        if (!stationFits(st, p.pad ?? "L")) continue;
        const carrier = String(st.type ?? "").includes("Carrier");
        if (carrier && !p.carriers) continue;
        // Landing on a surface is a different trip from docking at a
        // starport - a glide, a pad on a rock, and a client that has to own
        // the expansion. Off unless the journal says otherwise.
        if (st.is_planetary && !p.odyssey) continue;
        const e = (st.market ?? []).find((c) => c.commodity === name);
        if (!e || e.supply <= 0 || e.buy_price <= 0) continue;
        const dist = st.distance ?? 0;
        if (dist > p.range) continue;
        const profit = sell - e.buy_price;
        if (profit <= 0) continue;
        const ls = st.distance_to_arrival || 0;
        const mins = tripMinutes(dist, ls, cgLs, p.jump_empty, p.jump_laden, cal);
        const load = Math.min(e.supply, p.hold);
        rows.push({
          commodity: name, station: st.name ?? "?", system: st.system_name ?? "?", carrier,
          planetary: !!st.is_planetary, stype: st.type || "", body: st.body_name || "", pad: stationPad(st),
          ly: round1(dist), ls: Math.round(ls), supply: e.supply, buy: e.buy_price, sell,
          profit_per_t: profit, load, loads_available: round1(e.supply / p.hold),
          trip_minutes: round1(mins), trip_profit: load * profit,
          cr_per_min: Math.round(load * profit / mins), t_per_min: round1(load / mins),
          updated: String(st.market_updated_at || "").slice(0, 10),
        });
      }
    }
    pages[name].fin = true;
    comDone++;
    emitS("discovery", `${name} finished (${comDone}/${ncom} commodities)`);
  });
  emitS("done", `${rows.length} candidate stations`);
  log("spansh", `discovery finished: ${rows.length} candidate rows`);

  const snapshot = () => {
    // A station EDSM says is empty must drop out, not sit at the top on a
    // supply figure that no longer exists.
    const live = rows.filter((r) => r.profit_per_t > 0 && r.supply > 0)
      .sort((a, b) => b.cr_per_min - a.cr_per_min);
    const aged = ageFilter(live, p.max_age_days ?? MAX_AGE_DEFAULT, now);
    // Why EDSM-checked stations left the list, for the watcher's wording.
    const dropped = {};
    for (const r of rows) {
      if (r.edsm && !(r.profit_per_t > 0 && r.supply > 0)) dropped[`${r.station}\0${r.system}`] = r.supply > 0 ? "no longer profitable" : "sold out";
    }
    return { rows: aged.rows, cg, cgLs, hiddenStale: aged.hidden, allStale: aged.allStale, errors, dropped };
  };
  const first = snapshot();
  if (!verify) return first;
  first.verifying = (async () => {
    const apply = () => {
      for (const r of rows) if (r.edsm) rescore(r, p.hold, cgLs, p, cal);
      if (!cancelled?.()) onUpdate?.(snapshot());
    };
    try {
      const v = await refresh(rows, edsm, { top, cancelled, onApply: apply, onStation: (k, n, stn) => {
        edsmDone = 2 + k;
        edsmTotal = 2 + n;
        emitE("verify", stn ? `confirming ${k + 1}/${n} stations (${stn}) against fresher data`
          : `confirmed ${n} stations`);
      } });
      log("edsm", `verified ${v.checked} stations, corrected ${v.corrected}`);
    } catch (err) {
      errors.push(`EDSM verify failed: ${err.message}`);
      emitE("failed", err.message);
    }
    emitE("done", "");
    apply();
  })();
  return first;
}
