// In-memory activity log: a ring buffer any module can write to without
// importing app.js. Works the same in the browser and the desktop app.
const MAX = 1000;
let lines = [];
const listeners = new Set();

/** Append one entry; `src` is a short tag like "spansh" or "journal". */
export function log(src, msg, at = Date.now()) {
  lines.push({ at, src, msg });
  if (lines.length > MAX) lines = lines.slice(-MAX);
  for (const fn of listeners) fn();
}
export const getLog = () => lines;
export function clearLog() { lines = []; for (const fn of listeners) fn(); }
export const onLog = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

const pad = (n) => String(n).padStart(2, "0");
export function formatLine(l) {
  const d = new Date(l.at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} [${l.src}] ${l.msg}`;
}
export const formatLog = () => lines.map(formatLine).join("\n");

const PROVIDERS = { "ardent-insight.com": "ardent", "spansh.co.uk": "spansh", "edsm.net": "edsm" };

/** Wrap a fetchJson so every request is logged with status, time and count. */
export function loggedFetch(fetchJson) {
  return async (url, init) => {
    const u = new URL(url);
    const src = PROVIDERS[u.host.replace(/^(www|api)\./, "")] ?? u.host;
    const short = `${init?.method ?? "GET"} ${u.pathname}${u.search.slice(0, 60)}`;
    const t0 = Date.now();
    try {
      const res = await fetchJson(url, init);
      const n = Array.isArray(res) ? res.length : (res?.results?.length ?? res?.commodities?.length);
      log(src, `${short} -> ok ${Date.now() - t0}ms${n === undefined ? "" : `, ${n} results`}`);
      return res;
    } catch (e) {
      log(src, `${short} -> ${e.status ?? "error"} ${Date.now() - t0}ms: ${e.message}`);
      throw e;
    }
  };
}
