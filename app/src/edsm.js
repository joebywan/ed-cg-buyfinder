// One gate for every EDSM request in the app: searches and station-body
// hovers share EDSM's limit (429 after roughly ten rapid requests), so they
// share the pacing and the pause too. Nothing is ever skipped: a 429 pauses
// the whole queue, then the same request is sent again.
import { log } from "./log.js";

const INTERVAL = 800;            // ms between sends
const PAUSE_FIRST = 5_000;       // pause after a 429, doubling per consecutive one
const PAUSE_MAX = 300_000;
const TICK = 1000;               // countdown granularity for onWait

const hhmmss = (ms) => new Date(ms).toTimeString().slice(0, 8);

/** Retry-After as ms: delta-seconds or an HTTP date; null when absent/unparseable. */
export function retryAfterMs(v, now) {
  if (v == null || v === "") return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export class EdsmGate {
  constructor({ now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.now = now;
    this.sleep = sleep;
    this.until = 0;              // no sends before this
    this.pause = PAUSE_FIRST;    // length of the next pause
    this.last = -Infinity;       // when the last request went out
    this.queue = [];
    this.running = false;
    this.paused = false;         // a pause is open and not yet logged as over
  }

  /** ms timestamp the pause ends, or 0 when EDSM may be asked. */
  coolingUntil() { return this.until > this.now() ? this.until : 0; }

  /**
   * fetchJson(url) through the queue, one at a time, 800ms apart. `low`
   * requests (hover lookups) go after everything else waiting. While paused
   * the request waits, calling onWait(msLeft) about once a second.
   * `cancelled()` true drops it with an error carrying `.cancelled`.
   */
  request(fetchJson, url, { low = false, onWait = null, cancelled = null } = {}) {
    return new Promise((resolve, reject) => {
      const item = { fetchJson, url, low, onWait, cancelled, resolve, reject };
      const at = low ? this.queue.length : this.queue.findIndex((q) => q.low);
      this.queue.splice(at < 0 ? this.queue.length : at, 0, item);
      this.#pump();
    });
  }

  async #pump() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const it = this.queue.shift();
      try { it.resolve(await this.#send(it)); } catch (e) { it.reject(e); }
    }
    this.running = false;
  }

  async #send(it) {
    const stop = () => { if (it.cancelled?.()) throw Object.assign(new Error("superseded"), { cancelled: true }); };
    for (;;) {
      stop();
      for (let c; (c = this.coolingUntil());) {
        it.onWait?.(c - this.now());
        await this.sleep(Math.min(TICK, c - this.now()));
        stop();
      }
      if (this.paused) { this.paused = false; log("edsm", "pause over, resuming queue"); }
      const gap = INTERVAL - (this.now() - this.last);
      if (gap > 0) await this.sleep(gap);
      this.last = this.now();
      try {
        const res = await it.fetchJson(it.url);
        this.pause = PAUSE_FIRST;
        return res;
      } catch (e) {
        if (e.status !== 429) throw e;
        const ms = retryAfterMs(e.retryAfter, this.now()) ?? this.pause;
        this.pause = Math.min(this.pause * 2, PAUSE_MAX);
        this.until = this.now() + ms;
        this.paused = true;
        log("edsm", `rate limited (429): pausing EDSM requests until ${hhmmss(this.until)}`
          + `${e.retryAfter != null ? " (Retry-After)" : ""}`);
      }
    }
  }
}

export const edsmGate = new EdsmGate();
