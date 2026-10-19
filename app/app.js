// The page: wires the pure modules in src/ to the DOM, localStorage and the
// journal folder. Everything worth testing lives in src/.
import { buildRows, defaultFetchJson } from "./src/ardent.js";
import { BodyLookup } from "./src/bodies.js";
import { folderTooltip } from "./src/browser.js";
import { FRONTIER_URL, bandOutlook, finishEstimate, hoursLeft, totalPoints, historyFromLines, parseLive, standing, standingChanges, standingText, suggestDestination } from "./src/cg.js";
import { DESKTOP, DesktopDir, desktopStore, journalDir, tauriFetchJson } from "./src/desktop.js";
import { initSettings } from "./src/settings.js";
import { VIEWS, colWidths, fitWidth, moveCol, placeCol, toggleCol } from "./src/columns.js";
import { wireHeaders } from "./src/headers.js";
import { Sender } from "./src/eddn.js";
import { JournalState, runMinutes, timingReport } from "./src/journal.js";
import { clearLog, formatLog, getLog, formatLine, log, onLog } from "./src/log.js";
import { SOURCES, searchSources } from "./src/merge.js";
import { Progress } from "./src/progress.js";
import { buildRows as spanshRows } from "./src/spansh.js";
import { JournalTail, readJournalFiles, readStationFile } from "./src/tail.js";
import { Watcher, keyOf, stallAlert } from "./src/watch.js";
import { edsmGate } from "./src/edsm.js";
import { WANT, widen } from "./src/widen.js";
import { copySummary } from "./src/summary.js";
import { VERSION } from "./src/version.js";
import { checkForUpdate } from "./src/update.js";
import { MAX_AGE_DEFAULT, tripParts, ageTag, ageText, buildMixed, compareValues, hiddenBy, mixedSortValue, padForShip,
  viewRows, whereItIs } from "./src/model.js";

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n == null || n === "" ? "" : Number(n).toLocaleString("en-US"));

const DEFAULTS = { hold: 64, range: 120, jump_empty: 20, jump_laden: 15, min_supply: 200,
                   pad: "L", carriers: false, odyssey: false,
                   max_age_days: MAX_AGE_DEFAULT, source: "both" };
const FIELDS = Object.keys(DEFAULTS);
const SHIP_FIELDS = ["hold", "jump_empty", "jump_laden", "pad"];
let ui;                           // the SETTINGS tab: ui.prefs, ui.notify
const TOP_STATIONS = 40;
const HINT = "Click a row to copy its system.";
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
  lines: {},                                   // per table: row key -> its summary line
  sel: new Set(),                              // selected row keys
  snaps: store.get("cgbuy.cgSnaps", {}),      // {goal id: [[ms, qty], ...]} feed snapshots
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
  const p = { ...S.settings, dest: S.dest, verify_edsm: ui.prefs.verify_edsm, verify_top: ui.prefs.verify_top,
              rank: rankRow };      // EDSM checks the rows the view shows, best first
  const f = shipFigures();
  if (f) for (const k of SHIP_FIELDS) if (f[k] != null) p[k] = f[k];
  return p;
}

/** The view filters and surface penalty as they stand now. Searches keep every
 *  station; these only decide what is shown, so changing them needs no network. */
function viewOpts() {
  const { carriers, odyssey, pad } = S.settings;
  return { carriers, odyssey, pad: shipFigures()?.pad ?? pad, penalty: ui.prefs.surface_penalty };
}
const viewed = (r = S.result) => (r ? viewRows(r.rows, viewOpts()) : []);
const rankRow = (r) => viewRows([r], viewOpts())[0]?.cr_per_min ?? null;

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

const SOURCE_NAME = { ardent: "Ardent", spansh: "Spansh", both: "Both" };

/** Controls fold to one line once there are results to look at; EDIT unfolds them until the next search. */
function renderCollapse() {
  const folded = !!(S.result && S.dest) && !ui.prefs.controls_open;
  $("controls").classList.toggle("collapsed", folded);
  $("dest-panel").hidden = folded;
  $("ctl-summary").hidden = $("ctl-edit").hidden = !folded;
  if (!folded) return;
  const p = { ...S.settings, ...shipFigures() };
  $("ctl-summary").textContent = [`${fmt(p.hold)} t`, `${p.range} ly`, `jump ${p.jump_empty}/${p.jump_laden}`, `min ${fmt(p.min_supply)}`,
    `${p.pad} pad`, `max ${p.max_age_days} d`, DESKTOP && SOURCE_NAME[p.source], p.carriers && "carriers",
    `Odyssey ${p.odyssey ? "on" : "off"}`].filter(Boolean).join(" · ");
}

function setControlsOpen(open) {
  ui.prefs.controls_open = open;
  ui.save();
  render();
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
  try { S.live = parseLive(await defaultFetchJson(FRONTIER_URL)); } catch { /* keep the last feed */ }
  snapshotFeed();
  const sel = $("d-live"), keep = sel.value;
  sel.replaceChildren(h("option", { value: "" }, S.live.some((g) => g.is_trade) ? "— pick one —" : "none running"));
  S.live.filter((g) => g.is_trade).forEach((g, i) =>
    sel.append(h("option", { value: String(i) }, `${g.title} — ${g.station}, ${g.system}`)));
  sel.value = keep;
}

/** Remember each running goal's total across restarts (500 readings a goal; ended goals dropped). */
function snapshotFeed() {
  const now = Date.now(), next = {};
  for (const g of S.live) {
    if (g.id == null || !g.qty) continue;
    next[g.id] = [...(S.snaps[g.id] || []), [now, g.qty]].slice(-500);
  }
  S.snaps = next;
  store.set("cgbuy.cgSnaps", next);
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

/** Minutes per run and where that came from: what you have flown beats the route model. */
function runFigures() {
  const hold = S.result?.p.hold ?? S.journal?.cargoCapacity ?? 1;
  const [real, n] = S.journal && S.dest ? runMinutes(S.journal.dockLog, S.dest.station) : [null, 0];
  if (real) return { hold, mins: real, mins_best: plansNow()[0]?.trip_minutes ?? real, basis: `the median of your last ${n}, flying time plus a two-minute turnaround at each end` };
  const top = plansNow()[0];
  return { hold, mins: top?.trip_minutes ?? null, mins_best: top?.trip_minutes ?? null, basis: "the route plus a two-minute turnaround at each end" };
}

/** INFO tab, YOUR FLYING: measured timings in plain words plus the current plan's breakdown. */
function renderInfo() {
  const box = $("info-flying");
  const j = S.journal;
  if (!j) { box.innerHTML = '<dd class="dim">Needs a journal: pick your journal folder (desktop app) to measure your own timings.</dd>'; return; }
  const rows = timingReport(j.cal);
  const top = plansNow()[0], r = S.result;
  if (top && r) {
    const f = shipFigures() ?? r.p;
    const t = tripParts(top.ly, top.ls, r.cgLs ?? 0, f.jump_empty, f.jump_laden, j.cal);
    const sum = Object.values(t).reduce((a, b) => a + b, 0);
    const pct = (m) => `${m.toFixed(1)} min (${Math.round(m / sum * 100)}%)`;
    rows.push({ label: "Where a round trip goes", value: `${sum.toFixed(1)} min to ${top.station}`,
      detail: `jumps ${pct(t.jumps)}, departures ${pct(t.depart)}, arrival legs ${pct(t.arrive)}, docking ${pct(t.dock)}`
        + (top.penalty ? `; ranked with +${top.penalty} min surface penalty` : "") });
  }
  const run = runFigures();
  if (run.mins && run.basis.startsWith("the median")) {
    rows.push({ label: "Measured round trip", value: `${run.mins.toFixed(1)} min`, detail: run.basis });
  }
  const sf = shipFigures();
  if (sf?.jump_empty) {
    rows.push({ label: "Jump range", value: `${sf.jump_empty} ly empty${sf.jump_laden ? `, ${sf.jump_laden} ly laden` : ""}`, detail: "" });
  }
  box.replaceChildren(...rows.flatMap((x) => {
    const dt = document.createElement("dt"), dd = document.createElement("dd");
    dt.textContent = x.label;
    dd.textContent = x.value;
    if (x.detail) { const d = document.createElement("span"); d.className = "dim small"; d.textContent = x.detail; dd.append(d); }
    return [dt, dd];
  }));
}

/** Where you stand in the goal you joined; updates on journal events and Frontier feed refreshes. */
function renderStanding() {
  const line = $("standing");
  const hist = historyFromLines(S.cgLines);
  const cur = hist.at(-1);
  const live = S.live.find((g) => cur && String(g.id) === String(cur.cgid));
  const st = standing(hist, live);
  const run = runFigures();
  let fx = {};
  if (st) {
    const pts = totalPoints(hist, st.cgid, S.snaps[st.cgid]);
    const exp = live?.expiry || cur.expiry, now = Date.now();
    const finish = finishEstimate(pts, st.target, exp ? hoursLeft(exp, now) : null, now);
    fx = { finish, now, outlook: bandOutlook(st, pts, finish, run, now) };
  }
  const [text, tip, mark, kind] = standingText(st, run, fx);
  line.replaceChildren(...(mark
    ? [text.slice(0, text.indexOf(mark)), h("span", { class: { safe: "ok", tight: "warn", haul: "bad" }[kind] }, mark), text.slice(text.indexOf(mark) + mark.length)]
    : [text || ""]));
  line.title = text ? `${text}\n\n${tip}` : "";
  const vs = line.querySelector("span");
  if (vs && fx.outlook) {
    vs.classList.add("why"); vs.title = "Why?";
    vs.onclick = () => showWhy(fx.outlook);
  }
  if (!st) return;
  const { next, notes } = standingChanges(S.lastStanding, st);
  S.lastStanding = next;
  if (!notes.length) return;
  const text2 = notes.map((n) => `${n.title}. ${n.text}`).join(" ");
  showAlert({ kind: "standing", title: notes[0].title, text: text2, keys: new Set(), copy: null, ok: "OK", beep: true });
}

/** The verdict's reasoning in a dialog: the overtake argument, then the model's tip. */
function showWhy(o) {
  const d = $("why-dialog");
  $("why-title").textContent = { safe: "Why it's safe to stop", tight: "Why it's tight", haul: "Why keep hauling" }[o.kind] ?? "Why";
  $("why-body").replaceChildren(...(o.overtake?.lines ?? []).map((l) => h("p", {}, l)), h("p", { class: "dim" }, o.tip));
  d.showModal();
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
  renderStanding();
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
  const top = plansNow()[0];
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

/** EDSM rate-limited 5+ min with stations still waiting on it: say so once, clear it on recovery. */
function checkStall() {
  const a = stallAlert(edsmGate.stalledMs(), plansNow().filter((x) => x.pending).length);
  if (!edsmGate.stalledMs()) S.stallShown = false;
  if (S.alert?.kind === "edsm" && !a) showAlert(null);
  else if (a && !S.stallShown && !S.alert) { S.stallShown = true; showAlert(a); }
}

const plansNow = () => (S.result ? buildMixed(viewed(), S.result.p.hold) : []);

/** Show (or clear) the one banner; sound and notify only when the watcher says so. */
function showAlert(a) {
  S.alert = a;
  $("alert").hidden = !a;
  if (!a) return;
  $("alert-text").textContent = a.text;
  $("alert-text").title = a.detail ?? a.text;
  $("alert-copy").hidden = !a.copy;
  $("alert-copy").textContent = a.copy?.label ?? "";
  $("alert-ack").textContent = a.ok;
  if (a.beep) {
    log("alert", a.detail ?? a.text);
    chime();
    if (!document.hasFocus()) ui.notify(a.title ?? "Your target moved", a.text);
  }
}

/** Results for search `gen` just changed: baseline if it is the first, else compare. */
function watchResult(gen) {
  const plans = plansNow();
  const keep = ["standing", "edsm"].includes(S.alert?.kind);   // these stay until acknowledged (or EDSM recovers)
  let a;
  if (S.watchGen !== gen) { S.watchGen = gen; a = S.watch.begin(plans, S.result?.dropped); }
  else a = S.watch.check(plans, S.result?.dropped);
  if (a || !keep) showAlert(a);
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

// -- view filters ------------------------------------------------------------------

const FILTER_NAME = { odyssey: "ODYSSEY filter (surface station)", carriers: "CARRIERS filter (fleet carrier)" };

/** ODYSSEY, CARRIERS, PAD or the surface penalty changed: re-show the cached rows.
 *
 *  The user did this, so the new ranking is the baseline.
 *  The one thing worth saying is a copied target the filters now hide. Rows
 *  that came into sight may make the verified top N: confirm just those. */
function viewChanged() {
  if (!S.result) return;
  const t = S.watch.target;
  const raw = t && S.result.rows.find((r) => r.station === t.station && r.system === t.system);
  const why = raw && hiddenBy(raw, viewOpts());
  const a = S.watch.rebase(plansNow(), why && (FILTER_NAME[why] ?? `PAD filter (largest pad is ${raw.pad || "unknown"})`), S.result.dropped);
  if (a || !["standing", "edsm"].includes(S.alert?.kind)) showAlert(a);
  render();
  maybeWiden();
  const more = S.verifyMore;
  if (!more || S.searching) return;
  const gen = S.gen, prog = new Progress();
  more(rankRow, (ev) => {
    if (gen !== S.gen) return;
    prog.update(ev);
    $("prog-panel").hidden = false;
    renderProgress(prog);
  }).then(() => {
    if (gen !== S.gen || S.searching) return;
    $("prog-panel").hidden = true;
    store.set("cgbuy.result", S.result);
  });
}

/** Stations in the BEST MIXED LOADS list that pass the view filters. */
const stationsIn = (rows, hold) => buildMixed(viewRows(rows, viewOpts()), hold).length;

/** A filter change left fewer than 5 stations: widen from where the last search stopped. */
function maybeWiden() {
  const r = S.result;
  if (!r || S.searching || !ui.prefs.widen || !sameDest(r.p.dest, S.dest)) return;
  if (!S.held && r.sources?.includes("spansh")) return;     // nothing to build the next ring on
  if ((r.eff ?? r.p.range) >= Math.max(ui.prefs.widen_max, r.p.range) || plansNow().length >= WANT) return;
  search({ more: true });
}

// -- search ---------------------------------------------------------------------

async function search({ more = false } = {}) {
  if (S.searching) {
    if (more) return;
    // A dock or a ship swap mid-search must not be lost: run again after.
    S.rerun = true;
    return;
  }
  S.rerun = false;
  readControls();
  if (ui.prefs.controls_open) setControlsOpen(false);
  const p = params();
  if (!p.dest) {
    setStatus("No destination: open DESTINATION and set one.");
    return;
  }
  S.searching = true;
  S.verifyMore = null;
  $("search").disabled = true;
  const gen = ++S.gen;
  const stale = () => gen !== S.gen;
  let prog = new Progress();
  const user = p.range;
  const cap = ui.prefs.widen ? Math.max(ui.prefs.widen_max, user) : user;
  const cont = more && S.result ? { range: S.result.eff ?? user, n: plansNow().length, baseRows: S.result.rows.length } : null;
  let step = 0, first = true;
  const t0 = Date.now();
  $("prog-panel").hidden = false;
  renderProgress(prog);
  setStatus(`Searching ${p.dest.commodities.length} commodities around ${p.dest.system}…`);
  log("search", `start: ${p.dest.commodities.length} commodities around ${p.dest.system}, ${p.range} ly, source ${p.source}`);
  let keepPanel = false;
  try {
    const source = DESKTOP && p.source in SOURCES ? p.source : "ardent";
    const run = (range, prev) => {
      const my = ++step, mine = () => !stale() && my === step;
      const ring = prev ? `${prev}-${range} ly` : `${range} ly`;
      // Spansh is asked for the new ring only (minLy) and given the rows it already
      // found; Ardent takes a max distance only, so it is simply asked again.
      const q = { ...p, range, minLy: prev || 0, defer_verify: cap > user && source !== "ardent",
                  held: prev ? S.held : undefined };
      return searchSources(source, q, {
        ardent: buildRows,
        spansh: (qq, o) => spanshRows(qq, { ...o, fetchJson: tauriFetchJson }),
      }, {
        cal: S.journal?.cal ?? null,
        cancelled: () => !mine(),
        onProgress: (ev) => {
          if (!mine()) return;
          const own = ev.provider === "ardent" ? `0-${range} ly` : ev.provider === "spansh" ? ring : "";
          prog.update(own && ev.detail ? { ...ev, detail: `${own}: ${ev.detail}` } : ev);
          renderProgress(prog);
        },
        // EDSM confirmations land after the results are up: swap them in without
        // moving the scroll position (open rows are keyed by station, so they stay).
        onUpdate: (r) => {
          if (!mine()) return;
          const main = document.querySelector("main");
          const top = main.scrollTop;
          S.result = { ...r, p, eff: S.result?.eff ?? range, note: S.result?.note, at: S.result?.at ?? Date.now() };
          render();
          main.scrollTop = top;
          watchResult(gen);
        },
        onPartial: !first || cont ? undefined : (r, waiting) => {
          S.result = { ...r, p, eff: range, at: Date.now() };
          renderCredit();
          render();
          watchResult(gen);
          setStatus(`Showing ${SOURCES[r.sources[0]]} - still waiting on ${waiting}…`);
        },
      });
    };
    let last = null;
    const out = await widen({
      user, cap, run, ...cont,
      label: source === "both" ? "Ardent + Spansh" : SOURCES[source],
      count: (r) => stationsIn(r.rows, p.hold),
      rows: (r) => r.rows.length,
      say: (t) => setStatus(t),
      cancelled: stale,
      onStep: (ev) => {
        if (ev.end) { prog.update({ provider: "radius", stage: "done", done: ev.done, total: ev.total }); renderProgress(prog); return; }
        // Each step gets fresh bars; the Radius row is "step k of at most n".
        prog = new Progress();
        prog.update({ provider: "radius", stage: "step", done: ev.done, total: ev.total,
                      detail: `step ${ev.done + 1} of ${ev.total}: ${ev.prev ? `${ev.prev}-` : "0-"}${ev.range} ly` });
        renderProgress(prog);
      },
      onResult: (r, range) => {
        first = false;
        last = r;
        if (stale()) return;
        S.held = r.held;
        S.result = { ...r, p, at: Date.now(), eff: range };      // the table grows with each step
        renderCredit();
        render();
      },
    });
    const res = out.res ?? last;
    if (!res || stale()) return;
    S.result = { ...res, p, at: Date.now(), eff: out.range, note: out.note };
    if (res.startVerify) res.verifying = res.startVerify();
    S.verifyMore = res.verifyMore;
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
  radius: "Radius: each step asks every source again, a little further out",
};
function renderProgress(prog) {
  $("progress-bar").style.width = `${100 * prog.overall()}%`;
  $("prog-rows").replaceChildren(...Object.entries(prog.p).map(([k, s]) => {
    const label = { ardent: "Ardent", spansh: "Spansh", edsm: "EDSM", radius: "Radius" }[k];
    const what = s.state === "done" ? `done in ${(s.ms / 1000).toFixed(1)}s`
      : s.state === "failed" ? `failed: ${s.detail}`
      : s.state === "skipped" ? "skipped" : `${s.detail}  (${s.done}/${s.total})`;
    return h("div", { class: `prog-row ${s.state} ${s.stage}`, title: WHY[k] },
      h("span", { class: "name" }, label),
      h("div", { class: "progress" }, h("div", { style: `width:${s.total ? 100 * Math.min(1, s.done / s.total) : 0}%` })),
      h("span", { class: "what", title: `${what}${s.state === "run" && k !== "ardent" ? ` - ${WHY[k].split(": ")[1]}` : ""}` }, what,
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

function sorted(items, sort) {
  if (!sort) return items;
  const dir = sort.desc ? -1 : 1;
  return [...items].sort((a, b) =>
    dir * compareValues(mixedSortValue(a, sort.key), mixedSortValue(b, sort.key)));
}

function headRow(view, cols) {
  const cur = S.sort[view];
  return h("thead", {}, h("tr", {}, cols.map((c) =>
    h("th", {
      title: c.title,
      class: [c.num && "num", c.sortable !== false && "sortable"].filter(Boolean).join(" "),
      onclick: c.sortable !== false ? () => {
        S.sort[view] = cur?.key === c.key ? { key: c.key, desc: !cur.desc } : { key: c.key, desc: true };
        render();
      } : null,
    }, ...c.label.split("\n").flatMap((t, i) => i ? [h("br"), t] : [t]),
    c.key && cur?.key === c.key ? (cur.desc ? " ▼" : " ▲") : ""))));
}

/** The active column set for a tab: registry entries in the saved order (desktop-only ones hidden on the web). */
const colsFor = (view) => ui.prefs[`cols_${view}`]
  .map((id) => VIEWS[view].cols.find((c) => c.id === id)).filter((c) => DESKTOP || !c.desktop);

/** Render a table: header, body, then fixed-layout widths and drag handles. */
function putTable(view, cols, head, body) {
  const table = $(`t-${view}`);
  table.title = HINT;
  table.replaceChildren(head, body);
  const em = parseFloat(getComputedStyle(table).fontSize) || 14;
  const saved = ui.prefs[`colw_${view}`];
  const widths = colWidths(cols.map((c) => c.id), saved, view, em);
  wireHeaders(table, cols.map((c) => c.id), widths, {
    // No dragged width yet: fit the content, so numbers never clip.
    auto: cols.map((c) => (c.id in saved ? null : (need) => fitWidth(need, c, em))),
    onWidth: (id, w) => { ui.prefs[`colw_${view}`][id] = w; ui.save(); },
    onMove: (id, target, after) => setCols(view, placeCol(ui.prefs[`cols_${view}`], id, target, after)),
  });
}

function copySystem(ev) {
  const tr = ev.target.closest("tr[data-system]");
  if (!tr || ev.target.closest("button")) return;
  if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return select(tr.dataset.key, ev.shiftKey && !ev.ctrlKey && !ev.metaKey);
  if (S.sel.size) { S.sel.clear(); paintSel(); }
  const station = tr.querySelector("td.station[data-station]")?.dataset.station;
  navigator.clipboard?.writeText(tr.dataset.system).then(
    () => { toast(`Copied ${tr.dataset.system}`, ev); if (station) setTarget(station, tr.dataset.system); },
    () => toast("Clipboard blocked", ev));
}

// -- selecting rows and copying them as a summary -------------------------------------
// S.lines[view] holds what is on screen, in order: row key -> the line it adds to the
// summary. Expanded child rows carry their parent's key, so they select the station.

/** Ctrl-click toggles one row; Shift-click selects from the last one clicked. */
function select(key, range) {
  const keys = [...S.lines[S.view].keys()];
  if (range && keys.includes(S.anchor)) {
    const [a, b] = [keys.indexOf(S.anchor), keys.indexOf(key)].sort((x, y) => x - y);
    keys.slice(a, b + 1).forEach((k) => S.sel.add(k));
  } else {
    S.sel.has(key) ? S.sel.delete(key) : S.sel.add(key);
    S.anchor = key;
  }
  paintSel();
}

function paintSel() {
  for (const tr of document.querySelectorAll("tbody tr[data-key]")) tr.classList.toggle("sel", S.sel.has(tr.dataset.key));
}

function copySelected(ev) {
  const lines = [...S.lines[S.view].values()].filter((l) => S.sel.has(l.key));
  const text = copySummary({ dest: S.result.p.dest.station, hold: S.result.p.hold, lines });
  const n = text.split("\n").length - 1;
  navigator.clipboard?.writeText(text).then(
    () => toast(`copied ${n} station${n === 1 ? "" : "s"}`, ev), () => toast("Clipboard blocked", ev));
}

// The row menu is a list of { label, run(ev) }; add an item here to add a command.
const rowMenuItems = (n) => [
  { label: `Copy ${n} station${n === 1 ? "" : "s"}`, run: copySelected },
];

document.addEventListener("click", () => closeMenu());
function closeMenu() { $("row-menu")?.remove(); }

function rowMenu(ev) {
  const tr = ev.target.closest("tr[data-key]");
  if (!tr || !S.result) return;
  ev.preventDefault();
  closeMenu();
  if (!S.sel.has(tr.dataset.key)) { S.sel = new Set([tr.dataset.key]); S.anchor = tr.dataset.key; paintSel(); }
  const stations = new Set([...S.lines[S.view].values()].filter((l) => S.sel.has(l.key)).map((l) => `${l.station}\0${l.system}`));
  const menu = h("div", { id: "row-menu", class: "menu" },
    ...rowMenuItems(stations.size).map((it) => h("button", { type: "button", onclick: () => { closeMenu(); it.run(ev); } }, it.label)));
  menu.style.left = `${Math.min(ev.clientX, window.innerWidth - 180)}px`;
  menu.style.top = `${ev.clientY}px`;
  document.body.append(menu);
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
  return `${x.station}\n${whereItIs(x, { body: bodies.known(x.system, x.station),
                                         waiting: bodies.waiting(x.system) })}`;
}

const beyond = (x) => S.result && x.ly > S.result.p.range;
const beyondTip = () => `beyond your ${S.result.p.range} ly radius - added because fewer than ${WANT} stations were in range`;

const stationCell = (x, extra = [], commodity = null) =>
  h("td", { class: "station", title: stationTitle(x),
            "data-station": x.station, "data-stype": x.stype || "",
            "data-body": x.body || null,
            // A carrier orbits nothing, so there is nothing to look up and
            // nothing to rewrite.
            "data-carrier": x.carrier || null },
    ...extra, x.station, commodity ? h("span", { class: "sub" }, ` · ${commodity}`) : null, x.planetary ? h("span", { class: "surface", title: `Surface station${x.body ? ` on ${x.body}` : ""}` }, " ⏚") : null,
    x.carrier ? h("span", { class: "fc" }, " FC") : null,
    beyond(x) ? h("span", { class: "beyond", title: beyondTip() }, " ⤢") : null,
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
/** The pointer left a row: a lookup that has not gone out yet is not wanted. */
function dropBody(ev) {
  const row = ev.target.closest?.("tr[data-system]");
  if (row && !row.contains(ev.relatedTarget)) bodies.unwant(row.dataset.system);
}
const SRC_NAME = { A: "Ardent", S: "Spansh" };
const srcCell = (x) => h("td", { class: "src", title: x.other
  ? `${SRC_NAME[x.other.src === "A" ? "S" : "A"]} read ${ageText(x.updated)}; ${SRC_NAME[x.other.src]} read ${ageText(x.other.updated)}` : null }, x.src || "");
// A small mark after the age: confirmed by EDSM, or Spansh data still waiting for its check.
const ageCell = (x) => h("td", { class: `num ${ageTag(x.updated)}`,
  title: x.edsm ? `confirmed by EDSM, market read ${ageText(x.updated)}`
    : x.pending ? "unconfirmed - Spansh data, EDSM check pending" : null },
  ageText(x.updated), x.edsm ? h("span", { class: "ok" }, " ✓") : x.pending ? h("span", { class: "dim" }, " ?") : null);

const penaltyTip = (c, x, m) => (c.id === "trip_minutes" && !m && x.penalty ? `+${x.penalty} min surface penalty` : null);

/** One cell of a mixed-loads row: station row when `m` is null, else the commodity sub-row. */
function mixedCell(c, plan, m, open, k) {
  // One commodity: one line, its figures on the station row. Only a mix expands.
  const one = !m && plan.mix.length === 1 ? plan.mix[0] : null;
  if (c.id === "station" && one) return stationCell(plan, [h("span", { class: "toggle" })], one.commodity);
  if (c.id === "station" && !m) return stationCell(plan, [
    h("button", { class: "toggle", type: "button", "aria-expanded": String(open),
      onclick: () => { open ? S.expanded.delete(k) : S.expanded.add(k); render(); } }, open ? "▾" : "▸")]);
  if (c.id === "station") return h("td", { class: "station", title: whereItIs(plan) }, m.commodity);
  if (c.id === "updated" && !m) return ageCell({ ...plan, edsm: plan.confirmed });
  const v = m ? c.ch?.(m, plan) : c.st ? c.st(plan) : one && c.ch?.(one, plan);
  const text = typeof v === "number" && !c.raw ? fmt(v) : v;
  const short = c.id === "tonnes" && !m && plan.short > 0;
  return h("td", { class: c.num ? `num${short ? " short" : ""}` : null,
    title: short ? `${fmt(plan.short)} t short of your hold` : penaltyTip(c, plan, m) ?? (c.num ? null : text || null) }, text ?? "");
}

/** One footer line explaining the row markers, only the ones on screen. */
function renderLegend(plans, key) {
  const mark = (cls, t) => h("span", { class: cls }, t);
  const items = [
    plans.length && [mark("lg-top", "▌"), "best cr/min"],
    plans.some((x) => S.alert?.keys.has(key(x))) && [mark("lg-moved", "▌"), "moved (see alert)"],
    plans.some((x) => key(x) === S.watch.target?.key) && [mark("copied-tag", "◂"), "copied"],
    plans.some((x) => x.confirmed) && [mark("ok", "✓"), "EDSM-confirmed"],
    plans.some((x) => x.pending) && [mark("dim", "?"), "awaiting EDSM"],
    plans.some((x) => x.planetary) && [mark("surface", "⏚"), "surface station"],
    plans.some(beyond) && [mark("beyond", "⤢"), "beyond your radius (added to find 5 stations)"],
  ].filter(Boolean);
  $("legend").replaceChildren(...items.flatMap(([m, t], i) => [i ? "   " : "", m, ` ${t}`]));
  $("legend").hidden = !items.length;
}

function renderMixed(r) {
  const hold = r.p.hold;
  const plans = buildMixed(viewed(r), hold).slice(0, TOP_STATIONS);
  const lines = S.lines.mixed = new Map();
  const key = (x) => `${x.station}\0${x.system}`;
  const best = plans[0] && key(plans[0]);
  S.expanded ??= new Set();
  const body = h("tbody", { onclick: copySystem, oncontextmenu: rowMenu, onmousedown: (e) => { if (e.shiftKey) e.preventDefault(); }, onmouseover: wantBody, onmouseout: dropBody });
  const cols = colsFor("mixed");
  for (const plan of sorted(plans, S.sort.mixed)) {
    const k = key(plan);
    const open = plan.mix.length > 1 && S.expanded.has(k);
    const moved = S.alert?.keys.has(k);
    lines.set(k, { key: k, station: plan.station, system: plan.system, ls: plan.ls, ly: plan.ly, updated: plan.updated,
      cr_per_min: plan.cr_per_min, parts: plan.mix.map((m) => ({ commodity: m.commodity, tonnes: m.tonnes })) });
    body.append(h("tr", { class: `row head${k === best ? " top" : ""}${moved ? " moved" : ""}`, "data-system": plan.system, "data-key": k,
      title: [k === best && "Best credits per minute", moved && "Moved since you last pressed GOT IT - see the banner above"].filter(Boolean).join(". ") || null },
      ...cols.map((c) => mixedCell(c, plan, null, open, k))));
    if (!open) continue;
    for (const m of plan.mix) {
      body.append(h("tr", { class: "child", "data-system": plan.system, "data-key": k },
        ...cols.map((c) => mixedCell(c, plan, m))));
    }
  }
  putTable("mixed", cols, headRow("mixed", cols), body);
  renderLegend(plans, key);
  return plans.length;
}

function singleCell(c, x) {
  if (c.id === "station") return stationCell(x);
  if (c.id === "updated") return ageCell(x);
  if (c.id === "src") return srcCell(x);
  const v = c.st(x);
  return h("td", { class: c.num ? "num" : null, title: penaltyTip(c, x) ?? (c.num ? null : v || null) }, typeof v === "number" && !c.raw ? fmt(v) : v ?? "");
}

function renderSingle(r) {
  const body = h("tbody", { onclick: copySystem, oncontextmenu: rowMenu, onmousedown: (e) => { if (e.shiftKey) e.preventDefault(); }, onmouseover: wantBody, onmouseout: dropBody });
  const cols = colsFor("single");
  const lines = S.lines.single = new Map();
  for (const x of sorted(viewed(r), S.sort.single)) {
    const k = `${x.station}\0${x.system}\0${x.commodity}`;
    lines.set(k, { key: k, station: x.station, system: x.system, ls: x.ls, ly: x.ly, updated: x.updated,
      cr_per_min: x.cr_per_min, parts: [{ commodity: x.commodity, tonnes: x.load }] });
    body.append(h("tr", { class: "row", "data-system": x.system, "data-key": k }, ...cols.map((c) => singleCell(c, x))));
  }
  putTable("single", cols, headRow("single", cols), body);
}

// -- column chooser (shared by both tables, edits the active tab's set) --------------

function setCols(view, list) {
  ui.prefs[`cols_${view}`] = list;
  ui.save();
  render();
}

/** Back to the default columns, at their default widths. */
function resetCols(view) {
  ui.prefs[`colw_${view}`] = {};
  setCols(view, [...VIEWS[view].def]);
}

function renderCols() {
  const view = S.view;
  const shown = view === "mixed" || view === "single";
  $("cols-btn").hidden = !shown;
  const panel = $("cols-panel");
  panel.hidden = !shown || $("cols-btn").getAttribute("aria-expanded") !== "true";
  if (panel.hidden) return;
  const reg = VIEWS[view].cols.filter((c) => DESKTOP || !c.desktop);
  const on = ui.prefs[`cols_${view}`];
  const ids = [...on, ...reg.map((c) => c.id).filter((id) => !on.includes(id))];
  const btn = (txt, label, d, id) => h("button", { type: "button", "aria-label": label,
    disabled: d ? on.indexOf(id) < 0 || on.indexOf(id) + d < 0 || on.indexOf(id) + d >= on.length : null,
    onclick: () => setCols(view, moveCol(on, id, d)) }, txt);
  panel.replaceChildren(
    ...ids.map((id) => {
      const c = reg.find((x) => x.id === id);
      return h("div", { class: `row${on.includes(id) ? "" : " off"}`, title: c.title },
        h("label", {}, h("input", { type: "checkbox", checked: on.includes(id), disabled: id === "station" ? true : null,
          onchange: () => setCols(view, toggleCol(on, id, view)) }), " ", c.label.replace("\n", " ")),
        btn("▲", `Move ${id} up`, -1, id), btn("▼", `Move ${id} down`, 1, id));
    }),
    h("button", { type: "button", onclick: () => resetCols(view) }, "RESET TO DEFAULT"));
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
  $("wrap-info").hidden = S.view !== "info";
  $("tab-info").setAttribute("aria-selected", String(S.view === "info"));
  renderCollapse();
  renderCols();
  $("legend").hidden = true;                 // renderMixed brings it back
  if (S.view === "settings") ui.refresh();
  if (S.view === "info") renderInfo();
  renderDest();
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
  if (S.view !== "mixed") $("legend").hidden = true;   // the markers are the table's
  renderSingle(r);
  const shown = viewed(r).length;
  $("empty").hidden = shown > 0;
  $("empty").textContent = "Nothing within range makes a profit. Try a wider radius, a lower minimum supply, or carriers.";
  const maxAge = r.p.max_age_days;
  $("age-line").textContent = !maxAge ? "Age filter off: showing sources of any age."
    : r.allStale ? `Every source is older than ${maxAge} days — showing them anyway.`
    : r.hiddenStale ? `Hid ${fmt(r.hiddenStale)} of ${fmt(r.hiddenStale + shown)} sources older than ${maxAge} days.`
    : `Nothing hidden: every source is within ${maxAge} days.`;
  const errs = r.errors?.length ? `  ·  failed: ${r.errors.join("; ")}` : "";
  setStatus(`${r.note ? `${r.note}  ·  ` : ""}${stations} stations, ${fmt(shown)} sources for ${r.p.dest.station}${stale ? " (for a previous destination — search again)" : ""}${errs}`, !!errs);
  paintSel();
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
  state.onCalibration = () => { if (S.view === "info") renderInfo(); };
  state.onEvent = (e) => {
    if (EDDN_KINDS.includes(e.event)) shareStation(e.event, e.MarketID ?? null);
  };
  renderControls();
  renderJournal();
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
    else if (["f-odyssey", "f-carriers", "f-pad"].includes(e.target.id)) viewChanged();
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
  $("s-cols-reset").onclick = () => { resetCols("single"); resetCols("mixed"); };
  $("tab-single").onclick = () => { S.view = "single"; render(); };
  $("tab-settings").onclick = () => { S.view = "settings"; render(); };
  $("tab-info").onclick = () => { S.view = "info"; render(); };
  $("ctl-edit").onclick = () => setControlsOpen(true);
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
    if (e.key === "Escape") { $("dest-panel").open = false; S.sel.clear(); paintSel(); closeMenu(); }
  });
  setInterval(() => renderDest(), 30000);
  setInterval(checkStall, 5000);
  setInterval(renderStanding, 60000);          // ticks the countdown
}

async function main() {
  ui = initSettings({
    store,
    journal: () => S.journal,
    reconnectJournal: () => connectJournal(new DesktopDir()),
    onPenalty: viewChanged,
  });
  bind();
  window.addEventListener("cgbuy-font", () => render());   // unsaved column widths follow the font
  setupJournalButton();
  $("source-label").hidden = !DESKTOP;
  $("info-version").textContent = VERSION;
  $("update-status").textContent = DESKTOP ? (ui.prefs.update_check ? "checking for updates…" : "update check is off (SETTINGS)") : "";
  renderControls();
  renderCredit();
  render();
  await loadLive();
  resolveDest();
  render();
  setInterval(async () => { await loadLive(); resolveDest(); }, 5 * 60_000);   // keeps the standing line current
  try {
    await restoreJournal();
  } catch (err) {
    $("journal-status").textContent = `Couldn't reopen the journal folder (${err.name}). Connect it again.`;
  }
  const r = S.result;
  const fresh = r && sameDest(r.p.dest, S.dest) && (Date.now() - r.at) / 60000 < ui.prefs.cache_fresh_minutes;
  if (S.dest && !fresh && !S.searching) search();
  // Last, so it never delays the first search; failure is silence (update.js).
  if (DESKTOP && ui.prefs.update_check) {
    const v = await checkForUpdate(VERSION, (u) => tauriFetchJson(u, { headers: { Accept: "application/vnd.github+json" } }));
    $("update-status").textContent = v ? "" : "no newer version found";
    if (v) {
      const a = $("update-link");
      a.textContent = `New version ${v} available`;
      a.hidden = false;
      $("tab-info").textContent = "INFO ●";
    }
  }
}

main();
