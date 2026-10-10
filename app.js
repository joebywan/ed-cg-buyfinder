// The page: wires the pure modules in src/ to the DOM, localStorage and the
// journal folder. Everything worth testing lives in src/.
import { buildRows, defaultFetchJson } from "./src/ardent.js";
import { BodyLookup } from "./src/bodies.js";
import { folderTooltip } from "./src/browser.js";
import { FRONTIER_URL, historyFromLines, parseLive, suggestDestination } from "./src/cg.js";
import { DESKTOP, DesktopDir, desktopStore, journalDir, tauriFetchJson } from "./src/desktop.js";
import { initSettings } from "./src/settings.js";
import { MIXED_COLS, DEFAULT_MIXED, moveCol, toggleCol } from "./src/columns.js";
import { Sender } from "./src/eddn.js";
import { JournalState } from "./src/journal.js";
import { clearLog, formatLog, getLog, formatLine, log, onLog } from "./src/log.js";
import { SOURCES, searchSources } from "./src/merge.js";
import { Progress } from "./src/progress.js";
import { buildRows as spanshRows } from "./src/spansh.js";
import { JournalTail, readJournalFiles, readStationFile } from "./src/tail.js";
import { Watcher, keyOf } from "./src/watch.js";
import { VERSION } from "./src/version.js";
import { MAX_AGE_DEFAULT, ageTag, ageText, buildMixed, compareValues, mixedSortValue, padForShip,
  whereItIs } from "./src/model.js";

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n == null || n === "" ? "" : Number(n).toLocaleString("en-US"));

const DEFAULTS = { hold: 64, range: 30, jump_empty: 20, jump_laden: 15, min_supply: 200,
                   pad: "L", carriers: false, odyssey: false,
                   max_age_days: MAX_AGE_DEFAULT, source: "both" };
const FIELDS = Object.keys(DEFAULTS);
const SHIP_FIELDS = ["hold", "jump_empty", "jump_laden", "pad"];
let ui;                           // the SETTINGS tab: ui.prefs, ui.notify
const TOP_STATIONS = 40;
const EXPANDED_BY_DEFAULT = 5;
const POLL_MS = 2000;
const JOURNAL_FILES = 12;
// Chrome and Edge can keep a folder open and tail it. Firefox can only be
// handed a snapshot of one through <input webkitdirectory>.
const CAN_TAIL = DESKTOP || "showDirectoryPicker" in window;   // the app reads the folder live
const CAN_SNAPSHOT = "webkitdirectory" in document.createElement("input");

const store = desktopStore ?? {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window */ }
  },
};

const S = {
  settings: { ...DEFAULTS, ...store.get("cgbuy.settings", {}) },
  manualDest: store.get("cgbuy.dest", null),
  live: [],
  cgLines: [],
  dest: null,
  journal: null,
  tail: null,
  shipKey: null,
  result: store.get("cgbuy.result", null),
  view: "mixed",
  sort: { mixed: null, single: { key: "cr_per_min", desc: true } },
  expanded: null,
  watch: new Watcher({ shown: TOP_STATIONS }),
  watchGen: 0,      // the search whose first results are the baseline
  alert: null,
  gen: 0,           // bumped per search; older ones' background EDSM work goes quiet
  searching: false,
  noticeDismissed: false,
  // Off until asked for. Everything this page shows is built from market
  // readings other commanders uploaded; sharing yours back is the other half
  // of that, but it is public and it is their call, not ours.
  eddn: store.get("cgbuy.eddn", false),
  sender: new Sender(store.get("cgbuy.eddnSeen", [])),
  snapshotFiles: null,
};

// -- tiny DOM helper ---------------------------------------------------------

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// -- status -------------------------------------------------------------------

function setStatus(text, bad = false) {
  $("status").textContent = text;
  $("status").classList.toggle("bad", bad);
}

function ageShort(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function toast(text, ev) {
  const t = $("toast");
  t.textContent = text;
  t.style.left = `${Math.min((ev?.clientX ?? window.innerWidth / 2) + 12, window.innerWidth - 200)}px`;
  t.style.top = `${(ev?.clientY ?? 80) + 12}px`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 1500);
}

// -- ship and controls ----------------------------------------------------------

/** What the journal says about the ship, or null with no ship to go on. */
function shipFigures() {
  const j = S.journal;
  if (!j?.ship) return null;
  const f = { name: j.shipName || j.ship, pad: padForShip(j.ship) };
  if (j.cargoCapacity) f.hold = j.cargoCapacity;
  if (j.maxJumpRange) f.jump_empty = Math.round(j.maxJumpRange * 10) / 10;
  const laden = j.ladenRange();
  if (laden) f.jump_laden = Math.round(laden * 10) / 10;
  return f;
}

function params() {
  const p = { ...S.settings, dest: S.dest, verify_edsm: ui.prefs.verify_edsm, verify_top: ui.prefs.verify_top };
  const f = shipFigures();
  if (f) for (const k of SHIP_FIELDS) if (f[k] != null) p[k] = f[k];
  return p;
}

function renderControls() {
  const f = shipFigures();
  for (const k of FIELDS) {
    const el = $(`f-${k}`);
    const locked = !!f && SHIP_FIELDS.includes(k) && f[k] != null;
    const v = locked ? f[k] : S.settings[k];
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = v;
    el.disabled = locked;
    const label = el.closest("label");
    label.classList.toggle("locked", locked);
    label.title = locked ? `From your journal: ${f.name}` : "";
  }
}

function readControls() {
  for (const k of FIELDS) {
    const el = $(`f-${k}`);
    if (el.disabled) continue;
    if (el.type === "checkbox") S.settings[k] = el.checked;
    else if (el.tagName === "SELECT") S.settings[k] = el.value;
    else {
      const n = Number(el.value);
      if (el.value !== "" && Number.isFinite(n) && n >= 0) S.settings[k] = n;
    }
  }
  store.set("cgbuy.settings", S.settings);
}

// -- destination --------------------------------------------------------------

async function loadLive() {
  try { S.live = parseLive(await defaultFetchJson(FRONTIER_URL)); } catch { S.live = []; }
  const sel = $("d-live");
  sel.replaceChildren(h("option", { value: "" }, S.live.some((g) => g.is_trade) ? "— pick one —" : "none running"));
  S.live.filter((g) => g.is_trade).forEach((g, i) =>
    sel.append(h("option", { value: String(i) }, `${g.title} — ${g.station}, ${g.system}`)));
}

/** Work out where we're selling. Returns true when it changed. */
function resolveDest() {
  const [auto] = suggestDestination(historyFromLines(S.cgLines), S.live);
  const next = S.manualDest ? { ...S.manualDest, source: "set by hand" } : auto;
  const changed = JSON.stringify(next) !== JSON.stringify(S.dest);
  if (changed && !sameDest(next, S.dest)) { S.watch.clearTarget(); showAlert(null); }
  S.dest = next;
  if (changed) {
    S.noticeDismissed = false;
    if (next?.source === "live CG (not joined)") {
      ui.notify("Trading community goal found",
        `Register at ${next.station} in ${next.system} before hauling - deliveries made before you sign up don't count.`);
    }
    if (next) log("journal", `destination: ${next.station}, ${next.system} (${next.source})`);
  }
  renderDest();
  return changed;
}

function renderDest() {
  const d = S.dest;
  const line = $("dest-line");
  if (!d) {
    line.replaceChildren("No destination yet — ", h("a", { href: "#", onclick: (e) => { e.preventDefault(); $("dest-panel").open = true; } }, "set one"));
    document.title = "cgbuy";
  } else {
    const prices = S.result && sameDest(S.result.p.dest, d)
      ? Object.entries(S.result.cg).map(([c, v]) => `${c}: ${fmt(v.sell)} cr/t`).join("\n") : "";
    line.replaceChildren(
      `${d.station}, ${d.system}`,
      h("span", { class: "sub" }, `  ${d.title ? `· ${d.title} ` : ""}· ${d.source}`),
      S.result ? h("span", { class: "sub" }, `  · data ${ageShort(S.result.at)} old`) : "");
    line.title = prices ? `What the destination pays:\n${prices}` : "";
    document.title = `cgbuy — ${d.station}`;
  }
  const notJoined = d?.source === "live CG (not joined)";
  $("notice").hidden = !notJoined || S.noticeDismissed;
  if (notJoined) {
    $("notice-text").textContent = `You haven't joined "${d.title}". Sign up at the goal board at ${d.station} first — deliveries made before you register don't count.`;
  }
  $("d-system").placeholder = d?.system || "Ega";
  $("d-station").placeholder = d?.station || "Metz Enterprise";
}

/** Tell the user when the top target changes: the window usually sits behind the game. */
function checkBest() {
  const top = buildMixed(S.result.rows, S.result.p.hold)[0];
  const key = top && `${top.station}\0${top.system}`;
  const was = S.lastBest;
  if (key) S.lastBest = key;
  if (!was || !key || key === was) return;       // first search of the session stays quiet
  const mix = top.mix.slice(0, 3).map((m) => `${m.tonnes}t ${m.commodity}`).join(" + ");
  ui.notify(`New best: ${top.station}`,
    `${top.system}  -  ${top.ly} ly, ${fmt(top.ls)} Ls\n${mix}\n${fmt(top.total)} cr per ~${Math.round(top.trip_minutes)} min`);
}

// -- changes after the results are up ---------------------------------------------

let audio;
/** Browsers only let sound start after a click; make the context on the first one. */
const wake = () => { try { audio ??= new AudioContext(); audio.resume(); } catch { /* no sound */ } };
document.addEventListener("click", wake, true);
function chime() {
  if (!audio || audio.state !== "running" || ui?.prefs.alert_sound === false) return;
  [[880, 0], [1175, 0.18]].forEach(([hz, at]) => {
    const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime + at;
    o.frequency.value = hz;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + 0.4);
  });
}

const plansNow = () => (S.result ? buildMixed(S.result.rows, S.result.p.hold) : []);

/** Show (or clear) the one banner; sound and notify only when the watcher says so. */
function showAlert(a) {
  S.alert = a;
  $("alert").hidden = !a;
  if (!a) return;
  $("alert-text").textContent = a.text;
  $("alert-copy").hidden = !a.copy;
  $("alert-copy").textContent = a.copy?.label ?? "";
  $("alert-ack").textContent = a.ok;
  if (a.beep) {
    log("alert", a.text);
    chime();
    if (!document.hasFocus()) ui.notify(a.kind === "target" ? "Your target moved" : "Top 5 changed", a.text);
  }
}

/** Results for search `gen` just changed: baseline if it is the first, else compare. */
function watchResult(gen) {
  const plans = plansNow();
  if (S.watchGen !== gen) { S.watchGen = gen; showAlert(S.watch.begin(plans)); }
  else showAlert(S.watch.check(plans));
}

/** The user copied this station: remember it, and where it ranked. */
function setTarget(station, system) {
  const plan = plansNow().find((x) => x.station === station && x.system === system);
  if (!plan) return;
  S.watch.setTarget(plan, plansNow());
  render();
}

// Copying by hand counts too: a selection that is a station or system in the results.
document.addEventListener("copy", () => {
  const text = String(getSelection()).trim();
  const plans = plansNow();
  const hit = text && (plans.find((x) => x.station === text) ?? plans.find((x) => x.system === text));
  if (hit) setTarget(hit.station, hit.system);
});

const sameDest = (a, b) => !!a && !!b && a.system === b.system && a.station === b.station
  && JSON.stringify(a.commodities) === JSON.stringify(b.commodities);

// -- search ---------------------------------------------------------------------

async function search() {
  if (S.searching) {
    // A dock or a ship swap mid-search must not be lost: run again after.
    S.rerun = true;
    return;
  }
  S.rerun = false;
  readControls();
  const p = params();
  if (!p.dest) {
    setStatus("No destination: open DESTINATION and set one.");
    return;
  }
  S.searching = true;
  $("search").disabled = true;
  const gen = ++S.gen;
  const stale = () => gen !== S.gen;
  const prog = new Progress();
  const t0 = Date.now();
  $("prog-panel").hidden = false;
  renderProgress(prog);
  setStatus(`Searching ${p.dest.commodities.length} commodities around ${p.dest.system}…`);
  log("search", `start: ${p.dest.commodities.length} commodities around ${p.dest.system}, ${p.range} ly, source ${p.source}`);
  let keepPanel = false;
  try {
    const source = DESKTOP && p.source in SOURCES ? p.source : "ardent";
    const res = await searchSources(source, p, {
      ardent: buildRows,
      spansh: (q, o) => spanshRows(q, { ...o, fetchJson: tauriFetchJson }),
    }, {
      cal: S.journal?.cal ?? null,
      cancelled: stale,
      onProgress: (ev) => {
        if (stale()) return;
        prog.update(ev);
        renderProgress(prog);
      },
      // EDSM confirmations land after the results are up: swap them in without
      // moving the scroll position (open rows are keyed by station, so they stay).
      onUpdate: (r) => {
        if (stale()) return;
        const main = document.querySelector("main");
        const top = main.scrollTop;
        S.result = { ...r, p, at: S.result?.at ?? Date.now() };
        render();
        main.scrollTop = top;
        watchResult(gen);
      },
      onPartial: (r, waiting) => {
        S.result = { ...r, p, at: Date.now() };
        renderCredit();
        render();
        watchResult(gen);
        setStatus(`Showing ${SOURCES[r.sources[0]]} - still waiting on ${waiting}…`);
      },
    });
    S.result = { ...res, p, at: Date.now() };
    renderCredit();
    S.expanded = null;
    store.set("cgbuy.result", S.result);
    checkBest();
    render();
    watchResult(gen);
    if (res.verifying) {
      keepPanel = true;
      res.verifying.then(() => {
        if (stale()) return;
        $("prog-panel").hidden = true;
        store.set("cgbuy.result", S.result);
      });
    }
    log("search", `finished in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${res.rows.length} sources`
      + `${res.errors.length ? `, ${res.errors.length} errors` : ""}`);
  } catch (err) {
    setStatus(`Search failed: ${err.message}`, true);
    log("search", `failed: ${err.message}`);
  } finally {
    S.searching = false;
    $("search").disabled = false;
    if (!keepPanel) $("prog-panel").hidden = true;
    if (S.rerun) search();
  }
}

/** One labelled bar per provider that has reported, plus the overall bar. */
const WHY = {
  ardent: "Ardent",
  spansh: "Spansh: large pages, typically ~10s each",
  edsm: "EDSM: days fresher than Spansh, one request per station",
};
function renderProgress(prog) {
  $("progress-bar").style.width = `${100 * prog.overall()}%`;
  $("prog-rows").replaceChildren(...Object.entries(prog.p).map(([k, s]) => {
    const label = { ardent: "Ardent", spansh: "Spansh", edsm: "EDSM" }[k];
    const what = s.state === "done" ? `done in ${(s.ms / 1000).toFixed(1)}s`
      : s.state === "failed" ? `failed: ${s.detail}`
      : s.state === "skipped" ? "skipped" : `${s.detail}  (${s.done}/${s.total})`;
    return h("div", { class: `prog-row ${s.state} ${s.stage}`, title: WHY[k] },
      h("span", { class: "name" }, label),
      h("div", { class: "progress" }, h("div", { style: `width:${s.total ? 100 * Math.min(1, s.done / s.total) : 0}%` })),
      h("span", { class: "what" }, what,
        s.state === "run" && k !== "ardent" ? h("span", { class: "why" }, ` - ${WHY[k].split(": ")[1]}`) : null));
  }));
}

// -- logs -----------------------------------------------------------------------

function renderLog() {
  const wrap = $("wrap-log");
  if (wrap.hidden) return;
  const main = document.querySelector("main");
  const atBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 8;
  $("log-view").textContent = getLog().map(formatLine).join("\n");
  if (atBottom) main.scrollTop = main.scrollHeight;
}

// -- tables ---------------------------------------------------------------------

const SINGLE_COLS = [
  ["commodity", "COMMODITY", false, true, "What to buy."], ["system", "SYSTEM", false, true, "Star system the station is in."],
  ["station", "STATION", false, true, "Station name."], ["ly", "DIST\n(LY)", true, true, "Distance in light years from the goal system."],
  ["ls", "ARRIVAL\n(LS)", true, true, "Supercruise distance from the arrival star to the station, in light seconds."],
  ["supply", "SUPPLY\n(t)", true, true, "Stock for sale, in tonnes."],
  ["loads_available", "LOADS", true, true, "How many full holds the stock would fill."],
  ["buy", "BUY\nPRICE", true, true, "Price per tonne you pay at this station."],
  ["profit_per_t", "PROFIT\nPER t", true, true, "Profit per tonne at the goal."],
  ["trip_minutes", "TRIP\n(MIN)", true, true, "Estimated round-trip minutes, goal to station and back."],
  ["cr_per_min", "CR/MIN", true, true, "Profit per minute of round trip for one full hold."],
  ["t_per_min", "T/MIN", true, true, "Tonnes moved per minute of round trip."],
  ["updated", "DATA\nAGE", true, true, "How old the market report is; green is fresh, red is stale."],
  ...(DESKTOP ? [["src", "SRC", false, true, "Which service the row came from: Ardent or Spansh."]] : []),
];

function sorted(items, sort) {
  if (!sort) return items;
  const dir = sort.desc ? -1 : 1;
  return [...items].sort((a, b) =>
    dir * compareValues(mixedSortValue(a, sort.key), mixedSortValue(b, sort.key)));
}

function headRow(view, cols) {
  const cur = S.sort[view];
  return h("thead", {}, h("tr", {}, cols.map(([key, label, num, sortable = true, title]) =>
    h("th", {
      title,
      class: [num && "num", sortable && "sortable"].filter(Boolean).join(" "),
      onclick: sortable ? () => {
        S.sort[view] = cur?.key === key ? { key, desc: !cur.desc } : { key, desc: true };
        render();
      } : null,
    }, ...label.split("\n").flatMap((t, i) => i ? [h("br"), t] : [t]),
    cur?.key === key ? (cur.desc ? " ▼" : " ▲") : ""))));
}

function copySystem(ev) {
  const tr = ev.target.closest("tr[data-system]");
  if (!tr || ev.target.closest("button")) return;
  const station = tr.querySelector("td.station[data-station]")?.dataset.station;
  navigator.clipboard?.writeText(tr.dataset.system).then(
    () => { toast(`Copied ${tr.dataset.system}`, ev); if (station) setTarget(station, tr.dataset.system); },
    () => toast("Clipboard blocked", ev));
}

// The browser already knows how to show a tooltip: it waits for the pointer
// to settle, follows it, and never flickers. Nothing here needs to be built.
//
// What it will not do is refresh a tooltip that is already up, so the EDSM
// answer for an orbital station is asked for on mouseover - before the dwell
// that makes the tooltip appear - and written back into the title. One
// request answers a system, so the first hover pays for the rest of it.
const bodies = new BodyLookup({ onResolved: retitle });

function stationTitle(x) {
  return whereItIs(x, { body: bodies.known(x.system, x.station),
                        waiting: bodies.waiting(x.system) });
}

const stationCell = (x, ...extra) =>
  h("td", { class: "station", title: stationTitle(x),
            "data-station": x.station, "data-stype": x.stype || "",
            "data-body": x.body || null,
            // A carrier orbits nothing, so there is nothing to look up and
            // nothing to rewrite.
            "data-carrier": x.carrier || null },
    ...extra, x.station, x.carrier ? h("span", { class: "fc" }, " FC") : null,
    keyOf(x) === S.watch.target?.key ? h("span", { class: "copied-tag", title: "the station you last copied" }, " ◂ copied") : null);

/** Rewrite the titles for one system in place, without a re-render.

 Rebuilt through stationTitle rather than patched as a string, so the wording
 has exactly one source and cannot drift between first paint and refill. */
function retitle(system) {
  for (const td of document.querySelectorAll("td.station[data-station]")) {
    if (td.dataset.body || td.dataset.carrier) continue;
    const row = td.closest("tr[data-system]");
    if (!row || (system && row.dataset.system !== system)) continue;
    td.title = stationTitle({ station: td.dataset.station, system: row.dataset.system,
                              stype: td.dataset.stype, body: "", carrier: false,
                              planetary: false });
  }
}

/** A pointer resting anywhere near a station without a body asks for one. */
function wantBody(ev) {
  const td = ev.target.closest?.("td.station[data-station]");
  if (!td || td.dataset.body || td.dataset.carrier) return;
  const row = td.closest("tr[data-system]");
  if (row) bodies.want(row.dataset.system);
}
const SRC_NAME = { A: "Ardent", S: "Spansh" };
const srcCell = (x) => h("td", { class: "src", title: x.other
  ? `${SRC_NAME[x.other.src === "A" ? "S" : "A"]} read ${ageText(x.updated)}; ${SRC_NAME[x.other.src]} read ${ageText(x.other.updated)}` : null }, x.src || "");
// A small mark after the age: confirmed by EDSM, or Spansh data still waiting for its check.
const ageCell = (x) => h("td", { class: `num ${ageTag(x.updated)}`,
  title: x.edsm ? `confirmed by EDSM, market read ${ageText(x.updated)}`
    : x.pending ? "unconfirmed - Spansh data, EDSM check pending" : null },
  ageText(x.updated), x.edsm ? h("span", { class: "ok" }, " ✓") : x.pending ? h("span", { class: "dim" }, " ?") : null);

/** One cell of a mixed-loads row: station row when `m` is null, else the commodity sub-row. */
function mixedCell(c, plan, m, open, k) {
  if (c.id === "station" && !m) return stationCell(plan,
    h("button", { class: "toggle", type: "button", "aria-expanded": String(open),
      onclick: () => { open ? S.expanded.delete(k) : S.expanded.add(k); render(); } }, open ? "▾" : "▸"));
  if (c.id === "station") return h("td", { class: "station", title: whereItIs(plan) }, m.commodity);
  if (c.id === "updated" && !m) return ageCell(plan);
  const v = m ? c.ch?.(m, plan) : c.st?.(plan);
  const text = typeof v === "number" && c.id !== "ly" && c.id !== "trip_minutes" ? fmt(v) : v;
  const short = c.id === "tonnes" && !m && plan.short > 0;
  return h("td", { class: c.num ? `num${short ? " short" : ""}` : null,
    title: short ? `${fmt(plan.short)} t short of your hold` : null }, text ?? "");
}

function renderMixed(r) {
  const hold = r.p.hold;
  const plans = buildMixed(r.rows, hold).slice(0, TOP_STATIONS);
  const key = (x) => `${x.station}\0${x.system}`;
  const best = plans[0] && key(plans[0]);
  if (!S.expanded) S.expanded = new Set(plans.slice(0, EXPANDED_BY_DEFAULT).map(key));
  const body = h("tbody", { onclick: copySystem, onmouseover: wantBody });
  const cols = ui.prefs.cols_mixed.map((id) => MIXED_COLS.find((c) => c.id === id));
  for (const plan of sorted(plans, S.sort.mixed)) {
    const k = key(plan);
    const open = S.expanded.has(k);
    body.append(h("tr", { class: `row head${k === best ? " top" : ""}${S.alert?.keys.has(k) ? " moved" : ""}`, "data-system": plan.system },
      ...cols.map((c) => mixedCell(c, plan, null, open, k))));
    if (!open) continue;
    for (const m of plan.mix) {
      body.append(h("tr", { class: "child", "data-system": plan.system },
        ...cols.map((c) => mixedCell(c, plan, m))));
    }
  }
  $("t-mixed").replaceChildren(headRow("mixed", cols.map((c) =>
    [c.key ?? c.id, c.label, c.num, c.sortable !== false, c.title])), body);
  return plans.length;
}

function renderSingle(r) {
  const body = h("tbody", { onclick: copySystem, onmouseover: wantBody });
  for (const x of sorted(r.rows, S.sort.single)) {
    body.append(h("tr", { class: "row", "data-system": x.system },
      h("td", {}, x.commodity), h("td", {}, x.system), stationCell(x),
      h("td", { class: "num" }, x.ly), h("td", { class: "num" }, fmt(x.ls)),
      h("td", { class: "num" }, fmt(x.supply)), h("td", { class: "num" }, x.loads_available),
      h("td", { class: "num" }, fmt(x.buy)), h("td", { class: "num" }, fmt(x.profit_per_t)),
      h("td", { class: "num" }, x.trip_minutes), h("td", { class: "num" }, fmt(x.cr_per_min)),
      h("td", { class: "num" }, x.t_per_min), ageCell(x), DESKTOP ? srcCell(x) : null));
  }
  $("t-single").replaceChildren(headRow("single", SINGLE_COLS), body);
}

// -- BEST MIXED LOADS column chooser -----------------------------------------------

function setCols(list) {
  ui.prefs.cols_mixed = list;
  ui.save();
  render();
}

function renderCols() {
  const mixed = S.view === "mixed";
  $("cols-btn").hidden = !mixed;
  const panel = $("cols-panel");
  panel.hidden = !mixed || $("cols-btn").getAttribute("aria-expanded") !== "true";
  if (panel.hidden) return;
  const on = ui.prefs.cols_mixed;
  const ids = [...on, ...MIXED_COLS.map((c) => c.id).filter((id) => !on.includes(id))];
  const btn = (txt, label, d, id) => h("button", { type: "button", "aria-label": label,
    disabled: d ? on.indexOf(id) < 0 || on.indexOf(id) + d < 0 || on.indexOf(id) + d >= on.length : null,
    onclick: () => setCols(moveCol(on, id, d)) }, txt);
  panel.replaceChildren(
    ...ids.map((id) => {
      const c = MIXED_COLS.find((x) => x.id === id);
      return h("div", { class: `row${on.includes(id) ? "" : " off"}`, title: c.title },
        h("label", {}, h("input", { type: "checkbox", checked: on.includes(id), disabled: id === "station" ? true : null,
          onchange: () => setCols(toggleCol(on, id)) }), " ", c.label.replace("\n", " ")),
        btn("▲", `Move ${id} up`, -1, id), btn("▼", `Move ${id} down`, 1, id));
    }),
    h("button", { type: "button", onclick: () => setCols([...DEFAULT_MIXED]) }, "RESET TO DEFAULT"));
}

function render() {
  $("wrap-mixed").hidden = S.view !== "mixed";
  $("wrap-single").hidden = S.view !== "single";
  $("wrap-log").hidden = S.view !== "log";
  document.querySelector("main").dataset.view = S.view;
  $("tab-log").setAttribute("aria-selected", String(S.view === "log"));
  renderLog();
  $("tab-mixed").setAttribute("aria-selected", String(S.view === "mixed"));
  $("tab-single").setAttribute("aria-selected", String(S.view === "single"));
  $("wrap-settings").hidden = S.view !== "settings";
  $("tab-settings").setAttribute("aria-selected", String(S.view === "settings"));
  renderCols();
  if (S.view === "settings") ui.refresh();
  renderDest();
  renderCalibration();
  const r = S.result;
  const stale = r && S.dest && !sameDest(r.p.dest, S.dest);
  if (!r) {
    $("empty").hidden = false;
    $("empty").textContent = S.dest ? "No results yet — press SEARCH." : "Set a destination to search.";
    $("t-mixed").replaceChildren();
    $("t-single").replaceChildren();
    $("age-line").textContent = "";
    return;
  }
  const stations = renderMixed(r);
  renderSingle(r);
  $("empty").hidden = r.rows.length > 0;
  $("empty").textContent = "Nothing within range makes a profit. Try a wider radius, a lower minimum supply, or carriers.";
  const maxAge = r.p.max_age_days;
  $("age-line").textContent = !maxAge ? "Age filter off: showing sources of any age."
    : r.allStale ? `Every source is older than ${maxAge} days — showing them anyway.`
    : r.hiddenStale ? `Hid ${fmt(r.hiddenStale)} of ${fmt(r.hiddenStale + r.rows.length)} sources older than ${maxAge} days.`
    : `Nothing hidden: every source is within ${maxAge} days.`;
  const errs = r.errors?.length ? `  ·  failed: ${r.errors.join("; ")}` : "";
  setStatus(`${stations} stations, ${fmt(r.rows.length)} sources for ${r.p.dest.station}${stale ? " (for a previous destination — search again)" : ""}${errs}`, !!errs);
}

/** "Markets come from" names the source(s) the last search actually used. */
function renderCredit() {
  const used = DESKTOP ? S.result?.sources ?? (S.settings.source === "both" ? ["ardent", "spansh"] : [S.settings.source]) : ["ardent"];
  const link = { ardent: ["https://ardent-insight.com", "Ardent Insight"],
                 spansh: ["https://spansh.co.uk", "Spansh"] };
  const parts = used.filter((u) => link[u]).map((u) => h("a", { href: link[u][0], target: "_blank", rel: "noopener" }, link[u][1]));
  if (used.includes("spansh")) parts.push(h("a", { href: "https://www.edsm.net", target: "_blank", rel: "noopener" }, "EDSM"));
  $("credit-src").replaceChildren(...parts.flatMap((a, i) => (i ? [", ", a] : [a])));
}

function renderCalibration() {
  $("calibration").textContent = S.journal
    ? `Trip timings: ${S.journal.cal.summary()}`
    : "Trip timings: estimates. Add your journal folder to calibrate them to your flying.";
}

// -- journal --------------------------------------------------------------------

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("cgbuy", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function kv(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", value === undefined ? "readonly" : "readwrite");
    const req = value === undefined ? tx.objectStore("kv").get(key) : tx.objectStore("kv").put(value, key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const shipKey = () => (S.journal ? `${S.journal.ship}|${S.journal.shipId}|${S.journal.cargoCapacity}` : "");

function renderJournal() {
  const j = S.journal;
  const when = S.snapshotAt
    ? ` · read at ${new Date(S.snapshotAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, load again after docking to refresh`
    : "";
  $("journal-status").textContent = j
    ? `CMDR ${j.commander || "?"} · ${j.shipName || j.ship || "no ship seen"}${j.ship && !j.cargoCapacity ? " (waiting for loadout)" : ""}${j.system ? ` · ${j.system}` : ""}${when}`
    : "";
  $("journal-btn").textContent = CAN_TAIL
    ? (j ? "Change folder" : "Connect journal folder")
    : (j ? "Load journal folder again" : "Load journal folder");
}

// Each means "I have just rewritten the matching .json file". Market is the
// only one this page reads back; the other two are given.
const EDDN_KINDS = ["Market", "Outfitting", "Shipyard"];

/** Send one of the station files the game last wrote, if sharing is on.

 Everything that could make this a bad idea - a repeat, a stale reading, a
 file left behind by another station, a malformed list - is the Sender's to
 refuse rather than this function's to guess at. */
async function shareStation(kind, marketId = null) {
  if (!S.eddn || !S.journal) return;
  let data = null;
  try {
    data = S.tail ? await S.tail.stationFile(kind)
      : S.snapshotFiles ? await readStationFile(S.snapshotFiles, kind) : null;
  } catch { /* never used that service, or the game is mid-write */ }
  if (!data) return;
  const j = S.journal;
  const common = {
    commander: j.commander, odyssey: j.odyssey, gameversion: j.gameversion,
    gamebuild: j.gamebuild, softwareVersion: VERSION,
  };
  if (kind === "Market") {
    await S.sender.maybeSend(data, { ...common, horizons: j.horizons });
  } else {
    await S.sender.maybeSendStation(kind, data, { ...common, marketId });
  }
  log("eddn", `${kind}: ${S.sender.last}`);
  store.set("cgbuy.eddnSeen", S.sender.toList());
  renderEddn();
}

/** The toggle, who it uploads as, and what it has done this session. */
function renderEddn() {
  const label = $("eddn-label");
  const box = $("f-eddn");
  label.hidden = !S.journal;
  box.checked = S.eddn;
  label.title = S.journal
    ? `Send the market, outfitting and shipyard lists the game writes when you dock `
      + `back to EDDN, which is where Ardent - the source of every price on this `
      + `page - gets its data from.\n\n`
      + `Public and pseudonymous: it uploads as commander ${S.journal.commander || "?"}, `
      + `exactly as E:D Market Connector does. Only what the station sells is sent `
      + `- no position, no route, no cargo.`
    : "";
  const bits = [];
  if (S.eddn && S.journal) {
    bits.push(`sharing as CMDR ${S.journal.commander || "?"}`);
    if (!CAN_TAIL) bits.push("only what the last folder load saw");
  }
  const done = S.sender.summary();
  if (done) bits.push(done);
  if (S.sender.last && S.sender.last !== done) bits.push(S.sender.last);
  $("eddn-status").textContent = bits.length ? `· ${bits.join(" · ")}` : "";
}

/** A fresh journal reader: the state, the goal lines it saw, and its sink. */
function newJournal() {
  const state = new JournalState();
  state.calAfter = ui.prefs.calAfter;
  const lines = [];
  const sink = (line, live) => {
    state.handle(line, live);
    if (line.includes('"CommunityGoal"')) lines.push(line);
  };
  return { state, lines, sink };
}

/** Seed the ODYSSEY box from the game, once.

 LoadGame says which game this commander is running, which is the question
 the box asks. Only ever a seed: after that the choice is theirs, and a
 deliberate "off" has to survive a journal that says they own it. */
function adoptOdyssey(state) {
  const saved = store.get("cgbuy.settings", {});
  if ("odyssey" in saved || state?.odyssey == null) return;
  S.settings.odyssey = !!state.odyssey;
  store.set("cgbuy.settings", S.settings);
}

/** Make a freshly read journal the one the page uses. */
function adoptJournal({ state, lines }) {
  S.journal = state;
  S.cgLines = lines;
  S.shipKey = shipKey();
  adoptOdyssey(state);
  log("journal", `loaded: commander ${state.commander || "?"}, ${lines.length} lines`);
  state.onDocked = (station, system) => {
    log("journal", `docked at ${station}, ${system}`);
    if (S.dest && station === S.dest.station && system === S.dest.system) {
      S.noticeDismissed = false;       // docking unregistered is when the reminder matters
      if (S.dest.source === "live CG (not joined)") {
        ui.notify(`You're at ${station} - register for the CG`,
          "The goal board is here. Sign up now so your deliveries count.");
      }
      search();
    }
  };
  // The game writes Market.json and then logs this, so the file is there by
  // the time we are told about it.
  state.onEvent = (e) => {
    if (EDDN_KINDS.includes(e.event)) shareStation(e.event, e.MarketID ?? null);
  };
  renderControls();
  renderJournal();
  renderCalibration();
  renderEddn();
  // A snapshot has no live events, so the files it holds get their only
  // chance here. The Sender refuses anything too old to be worth sending,
  // which these usually are - hence no market ID to check them against.
  if (!CAN_TAIL) for (const k of EDDN_KINDS) shareStation(k);
  if (resolveDest() || S.result) search();
}

/** Firefox: read a one-off snapshot of the folder. Nothing updates after. */
async function loadSnapshot(files) {
  clearTimeout(S.pollTimer);
  S.tail = null;
  const j = newJournal();
  $("journal-status").textContent = "Reading journals…";
  let n;
  try {
    n = await readJournalFiles(files, j.sink, JOURNAL_FILES);
  } catch (err) {
    $("journal-status").textContent = `Couldn't read that folder (${err.name}). Load it again.`;
    return;
  }
  if (!n) {
    $("journal-status").textContent = "No Journal.*.log files in that folder.";
    return;
  }
  S.snapshotAt = Date.now();
  S.snapshotFiles = files;
  adoptJournal(j);
}

async function connectJournal(dir) {
  clearTimeout(S.pollTimer);
  const j = newJournal();
  const tail = new JournalTail(dir, j.sink);
  $("journal-status").textContent = "Reading journals…";
  let n;
  try {
    n = await tail.prime(JOURNAL_FILES);
  } catch (err) {
    // A remembered folder that was moved or deleted: forget it rather than
    // failing the same way on every visit.
    if (err.name === "NotFoundError") {
      try { await kv("journalDir", null); } catch { /* nothing remembered */ }
    }
    $("journal-status").textContent = `Couldn't read that folder (${err.name}). Connect it again.`;
    return;
  }
  if (!n) {
    $("journal-status").textContent = "No Journal.*.log files in that folder.";
    return;
  }
  S.tail = tail;
  S.snapshotAt = null;
  S.snapshotFiles = null;
  adoptJournal(j);
  const loop = async () => {
    try {
      if (await S.tail.poll()) {
        renderControls();
        renderJournal();
        renderCalibration();
        const k = shipKey();
        const shipChanged = k !== S.shipKey && !!S.journal.cargoCapacity;
        if (k !== S.shipKey && S.journal.cargoCapacity) S.shipKey = k;
        if (resolveDest() || shipChanged) search();
      }
    } catch (err) {
      $("journal-status").textContent = `Journal read failed: ${err.message}`;
    }
    S.pollTimer = setTimeout(loop, POLL_MS);
  };
  S.pollTimer = setTimeout(loop, POLL_MS);
}

async function pickJournal() {
  try {
    const dir = await window.showDirectoryPicker({ id: "elite-journal", mode: "read" });
    try { await kv("journalDir", dir); } catch { /* remembered next time, or not */ }
    await connectJournal(dir);
  } catch (err) {
    if (err.name !== "AbortError") $("journal-status").textContent = `Could not open folder: ${err.message}`;
  }
}

/** Decided before anything loads, so a quick click never finds a dead button. */
function setupJournalButton() {
  const btn = $("journal-btn");
  if (DESKTOP) {                      // the app finds the folder; nothing to pick
    btn.hidden = true;
    renderJournal();
    return;
  }
  btn.title = "Usually C:\\Users\\<you>\\Saved Games\\Frontier Developments\\Elite Dangerous";
  if (CAN_TAIL) {
    btn.onclick = pickJournal;
  } else if (CAN_SNAPSHOT) {
    btn.title = folderTooltip(navigator);
    const input = $("journal-files");
    btn.onclick = () => input.click();
    input.onchange = () => {
      const files = [...input.files];
      input.value = "";                 // so picking the same folder again still fires
      if (files.length) loadSnapshot(files);
    };
  } else {
    btn.hidden = true;
    $("journal-status").textContent = "This browser can't read the journal folder: enter your ship's figures by hand.";
  }
  renderJournal();
}

async function restoreJournal() {
  if (DESKTOP) {
    if (journalDir) { log("journal", `folder found: ${journalDir}`); await connectJournal(new DesktopDir()); }
    else $("journal-status").textContent = "Couldn't find the Elite Dangerous journal folder: enter your ship's figures by hand.";
    return;
  }
  if (!CAN_TAIL) return;
  const btn = $("journal-btn");
  let dir;
  try { dir = await kv("journalDir"); } catch { return; }
  if (!dir) return;
  if (await dir.queryPermission({ mode: "read" }) === "granted") {
    await connectJournal(dir);
    return;
  }
  // The browser needs a click before it will hand the folder back.
  btn.textContent = "Reconnect journal folder";
  btn.onclick = async () => {
    btn.onclick = pickJournal;
    if (await dir.requestPermission({ mode: "read" }) === "granted") await connectJournal(dir);
  };
}

// -- wiring ---------------------------------------------------------------------

function bind() {
  $("controls").addEventListener("submit", (e) => { e.preventDefault(); search(); });
  $("controls").addEventListener("change", (e) => {
    readControls();
    if (e.target.id === "f-max_age_days") search();   // hidden rows aren't kept anywhere
  });
  $("f-eddn").onchange = () => {
    S.eddn = $("f-eddn").checked;
    store.set("cgbuy.eddn", S.eddn);
    renderEddn();
    // Turning it on mid-session should not wait for the next dock to mean
    // anything: what is already on disk is the station you just left.
    if (S.eddn) for (const k of EDDN_KINDS) shareStation(k);
  };
  $("tab-mixed").onclick = () => { S.view = "mixed"; render(); };
  $("cols-btn").onclick = () => {
    const b = $("cols-btn");
    b.setAttribute("aria-expanded", String(b.getAttribute("aria-expanded") !== "true"));
    render();
  };
  $("s-cols-reset").onclick = () => setCols([...DEFAULT_MIXED]);
  $("tab-single").onclick = () => { S.view = "single"; render(); };
  $("tab-settings").onclick = () => { S.view = "settings"; render(); };
  $("tab-log").onclick = () => { S.view = "log"; render(); };
  $("log-clear").onclick = clearLog;
  $("log-copy").onclick = (ev) => navigator.clipboard.writeText(formatLog()).then(
    () => toast("Copied log", ev), () => toast("Clipboard blocked", ev));
  onLog(renderLog);
  $("alert-ack").onclick = () => { S.watch.acknowledge(plansNow()); showAlert(null); render(); };
  $("alert-copy").onclick = () => {
    const plan = S.alert?.copy?.plan;
    if (!plan) return;
    navigator.clipboard?.writeText(plan.system).then(() => toast(`Copied ${plan.system}`), () => toast("Clipboard blocked"));
    S.watch.setTarget(plan, plansNow());
    S.watch.acknowledge(plansNow());
    showAlert(null);
    render();
  };
  $("notice-close").onclick = () => { S.noticeDismissed = true; renderDest(); };
  $("d-live").onchange = () => {
    const g = S.live.filter((x) => x.is_trade)[Number($("d-live").value)];
    if (!g) return;
    $("d-system").value = g.system;
    $("d-station").value = g.station;
    $("d-commodities").value = g.commodities.join(", ");
  };
  $("d-use").onclick = () => {
    const system = $("d-system").value.trim();
    const station = $("d-station").value.trim();
    const commodities = $("d-commodities").value.split(",").map((c) => c.trim()).filter(Boolean);
    if (!system || !station || !commodities.length) {
      setStatus("A destination needs a system, a station and at least one commodity.", true);
      return;
    }
    const g = S.live.find((x) => x.system === system && x.station === station);
    S.manualDest = { system, station, commodities, title: g?.title || "", expiry: g?.expiry || null };
    store.set("cgbuy.dest", S.manualDest);
    $("dest-panel").open = false;
    resolveDest();
    search();
  };
  $("d-auto").onclick = () => {
    S.manualDest = null;
    store.set("cgbuy.dest", null);
    $("dest-panel").open = false;
    resolveDest();
    search();
  };
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("dest-panel").open = false;
  });
  setInterval(() => renderDest(), 30000);
}

async function main() {
  ui = initSettings({
    store,
    journal: () => S.journal,
    reconnectJournal: () => connectJournal(new DesktopDir()),
  });
  bind();
  setupJournalButton();
  $("source-label").hidden = !DESKTOP;
  renderControls();
  renderCredit();
  render();
  await loadLive();
  resolveDest();
  render();
  try {
    await restoreJournal();
  } catch (err) {
    $("journal-status").textContent = `Couldn't reopen the journal folder (${err.name}). Connect it again.`;
  }
  const r = S.result;
  const fresh = r && sameDest(r.p.dest, S.dest) && (Date.now() - r.at) / 60000 < ui.prefs.cache_fresh_minutes;
  if (S.dest && !fresh && !S.searching) search();
}

main();
